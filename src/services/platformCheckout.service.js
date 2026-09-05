/**
 * Self-serve checkout — the shop paying us without an operator in the loop.
 *
 * ── The one rule this file exists to enforce ────────────────────────────────
 *
 * **A browser can never be the reason money is recognised.**
 *
 * PayStation has no signed IPN. Its `callback_url` is a plain redirect with no
 * signature, no hash and undocumented parameters — anyone who learns the URL can
 * request it, as many times as they like, with whatever they like in the body.
 * So the callback's ONLY power in this system is to make us go and ask the
 * gateway a question. The answer to that question — a server-to-server
 * `transaction-status` reply, keyed on an invoice number we minted ourselves —
 * is the only thing that moves an order to `paid`.
 *
 * Everything else here follows from that. The order is written before the
 * customer leaves, so the callback never has to tell us what was bought. The
 * amount is derived here, so a request body can never contain a price. And a
 * reconciliation sweep re-asks the same question on a timer, because in
 * Bangladesh the common path is: tap Renew, pay in the bKash app, never return
 * to the browser tab. For those customers the callback never fires at all, and
 * the sweep is not a backstop — it is how they get their subscription.
 *
 * ── Fulfilment is idempotent twice over ─────────────────────────────────────
 *
 * The customer's browser returning and the sweep can collide on one order. So:
 *
 *   1. `fulfilOrder` claims the order with an atomic `findOneAndUpdate` before
 *      doing anything. The loser gets null and stops.
 *   2. `billing.applySubscriptionPayment` and `billing.recordSmsPurchase`
 *      independently refuse a second payment carrying the same
 *      `gateway.paymentId`, backed by a partial-unique index.
 *
 * Both, not one. The claim alone would strand an order whose fulfilment threw
 * after the claim landed; the paymentId check alone would let two workers do
 * redundant work and race on the shop document.
 */

const crypto = require('crypto');
const PlatformOrder = require('../models/PlatformOrder.model');
const { PLATFORM_ORDER_STATUS, PLATFORM_ORDER_KIND } = require('../models/PlatformOrder.model');
const PlatformSetting = require('../models/PlatformSetting.model');
const PlatformPayment = require('../models/PlatformPayment.model');
const Shop = require('../models/Shop.model');
const SMSQuota = require('../models/SMSQuota.model');
const billingService = require('./billing.service');
/* Required as a MODULE, not destructured, so `getAdapter` is resolved at call
 * time rather than at require time. That is what lets a test substitute a
 * gateway stub — a destructured reference is captured once at load and can
 * never be replaced, which would leave every test here talking to the real
 * PayStation. `TRX_STATUS` is a frozen constant and is safe to pull out. */
const paystation = require('./payment/paystation.adapter');
const { TRX_STATUS } = paystation;
const getAdapter = () => paystation.getAdapter();
const { AppError } = require('../middleware/error.middleware');
const { PLATFORM_PAYMENT_METHODS, PLATFORM_PAYMENT_TYPES, SUBSCRIPTION_PRICE } = require('../config/constants');
const { resolveSubscription } = require('../utils/subscriptionState.util');
const logger = require('../utils/logger.util');

/**
 * How long an order may sit unresolved before the sweep stops asking.
 *
 * Long enough that a customer who wandered off mid-payment and came back an hour
 * later is still served; short enough that the sweep's working set stays small.
 */
const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * How long to leave a fresh order alone before the sweep first asks about it.
 *
 * Below this the customer is probably still typing their PIN, and asking
 * achieves nothing but a `processing` reply. The customer's own return trip
 * covers this window.
 */
const SWEEP_MIN_AGE_MS = 10 * 60 * 1000;

/**
 * Mint an invoice number.
 *
 * Must be unique forever, per merchant: PayStation refuses a reused one with
 * `1008 Duplicate invoice number` (verified against sandbox), so every ATTEMPT
 * needs a fresh one — a retry after a failed payment cannot reuse the old
 * order's number.
 *
 * Time-ordered prefix so a human scanning the PayStation dashboard sees them in
 * order, plus random bytes so two workers minting in the same millisecond do not
 * collide. The unique index on the column is the real guarantee; this just makes
 * hitting it vanishingly unlikely. Alphanumeric is confirmed accepted.
 */
function mintInvoiceNumber() {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `HSB${stamp}${rand}`;
}

/**
 * Map PayStation's instrument name onto our own ledger vocabulary.
 *
 * Falls back to ONLINE rather than guessing. `PLATFORM_PAYMENT_METHODS` is an
 * enum on the model, so an unmapped value would throw a validation error AFTER
 * the money had arrived — the worst possible moment.
 */
function mapPaymentMethod(raw) {
  const value = String(raw || '').trim().toLowerCase();
  const known = {
    bkash: PLATFORM_PAYMENT_METHODS.BKASH,
    nagad: PLATFORM_PAYMENT_METHODS.NAGAD,
    rocket: PLATFORM_PAYMENT_METHODS.ROCKET,
    visa: PLATFORM_PAYMENT_METHODS.CARD,
    mastercard: PLATFORM_PAYMENT_METHODS.CARD,
    amex: PLATFORM_PAYMENT_METHODS.CARD,
    card: PLATFORM_PAYMENT_METHODS.CARD,
  };
  return known[value] || PLATFORM_PAYMENT_METHODS.ONLINE;
}

const round2 = (n) => Number((Number(n) || 0).toFixed(2));

class PlatformCheckoutService {
  /**
   * Is self-serve checkout actually usable right now?
   *
   * Two conditions, and both matter. `billingProvider` is the operator's switch;
   * `isConfigured()` is whether there are credentials behind it. A provider
   * selected with no credentials looks armed on the settings screen and 502s on
   * the first customer who taps Renew — so the owner-facing page asks this, and
   * hides the buttons rather than showing ones that cannot work.
   */
  async isCheckoutAvailable() {
    const settings = await billingService.getSettings();
    const provider = settings?.billingProvider || 'none';
    if (provider !== 'paystation') {
      return { available: false, provider, reason: 'provider_disabled' };
    }
    if (!getAdapter().isConfigured()) {
      logger.warn('[checkout] billingProvider is paystation but its credentials are missing');
      return { available: false, provider, reason: 'not_configured' };
    }
    return { available: true, provider, env: getAdapter().env };
  }

  /**
   * What this shop is offered, and at what price.
   *
   * ── The negotiated-rate rule ────────────────────────────────────────────
   *
   * A shop that bargained its monthly rate down must keep BOTH its bargain and
   * the ladder's volume discount. So each package's discount is expressed as a
   * FACTOR against the list monthly price, and that factor is applied to
   * whatever this shop actually pays per month:
   *
   *     factor = pkg.price / (pkg.months × listMonthly)
   *     price  = round(pkg.months × shopMonthly × factor)
   *
   * At list (৳800/mo): 1→৳800, 6→৳4000, 12→৳8000, unchanged.
   * At ৳700/mo:        1→৳700, 6→৳3500, 12→৳7000.
   *
   * The naive alternative — `months × shopMonthly` — would quote that ৳700 shop
   * ৳8,400 for a year against a ৳8,000 list price, i.e. punish it for having
   * negotiated. That is the bug this arithmetic exists to prevent.
   */
  async quote(shop) {
    const settings = await billingService.getSettings();

    const listMonthly = Number(settings?.defaultMonthlyPrice) || SUBSCRIPTION_PRICE;
    const negotiatedMonthly = shop?.billing?.monthlyPrice;
    const shopMonthly = negotiatedMonthly == null ? listMonthly : Number(negotiatedMonthly);

    const configured = settings?.subscriptionPackages?.length
      ? settings.subscriptionPackages
      : [{ months: 1, price: listMonthly, label: '১ মাস' }];

    const packages = configured
      .map((pkg) => {
        const months = Number(pkg.months) || 0;
        const listPrice = Number(pkg.price) || 0;
        if (months <= 0) return null;

        const baseline = months * listMonthly;
        const factor = baseline > 0 ? listPrice / baseline : 1;
        const price = round2(months * shopMonthly * factor);

        return {
          months,
          price,
          label: pkg.label || `${months} মাস`,
          badge: pkg.badge || null,
          perMonth: round2(price / months),
          // What the same time would cost bought one month at a time. The
          // owner's page renders the gap as the reason to buy the longer one.
          listTotal: round2(months * shopMonthly),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.months - b.months);

    const negotiatedSmsRate = shop?.billing?.smsUnitPrice;
    const smsRate = negotiatedSmsRate == null
      ? (Number(settings?.defaultSmsUnitPrice) || 0.4)
      : Number(negotiatedSmsRate);

    return {
      currency: shop?.billing?.currency || 'BDT',
      packages,
      sms: {
        unitPrice: smsRate,
        minAmount: Number(settings?.minSmsPurchaseAmount ?? 100),
        maxAmount: Number(settings?.maxSelfServeAmount ?? 50000),
        // What the minimum actually buys, so the page can say "৳100 = 250টি"
        // without doing the arithmetic itself and disagreeing with the server.
        minQuantity: smsRate > 0
          ? Math.floor(Number(settings?.minSmsPurchaseAmount ?? 100) / smsRate)
          : 0,
      },
      isNegotiated: negotiatedMonthly != null && Number(negotiatedMonthly) !== listMonthly,
    };
  }

  /** Guard shared by both checkout paths. */
  async _assertCanCheckout(shop) {
    const availability = await this.isCheckoutAvailable();
    if (!availability.available) {
      throw new AppError(
        'Online payment is not available right now. Please call support.',
        'অনলাইন পেমেন্ট এখন বন্ধ আছে। সাপোর্টে কল করুন।',
        503
      );
    }

    // A blocked shop must never be able to pay us. Not because the money is
    // unwelcome, but because taking it would imply the block is negotiable —
    // and a block is a deliberate operator decision with a reason attached,
    // which no amount of money should silently undo. An EXPIRED shop, by
    // contrast, is exactly who this feature is for.
    const access = resolveSubscription(shop);
    if (access.isBlocked) {
      throw new AppError(
        'This shop is suspended. Please contact support on 01757995016.',
        'এই দোকানটি বন্ধ করা হয়েছে। যোগাযোগ করুন — ০১৭৫৭৯৯৫০১৬',
        403
      );
    }
  }

  /**
   * Where PayStation sends the customer's browser back to.
   *
   * Points at our own API, not at the frontend, so verification happens even if
   * the customer closes the tab the instant it loads. The API then redirects on
   * to the app. `API_PUBLIC_URL` must be the externally reachable origin —
   * PayStation resolves this from the public internet, not from inside our
   * network.
   */
  _callbackUrl(orderId) {
    const base = (process.env.API_PUBLIC_URL || '').replace(/\/+$/, '');
    if (!base) {
      throw new AppError(
        'Payment callback URL is not configured',
        'পেমেন্ট কনফিগারেশন অসম্পূর্ণ',
        500
      );
    }
    return `${base}/api/public/payments/paystation/return/${orderId}`;
  }

  async _createOrder(shop, user, fields, ip) {
    const order = await PlatformOrder.create({
      shop: shop._id,
      invoiceNumber: mintInvoiceNumber(),
      currency: shop?.billing?.currency || 'BDT',
      status: PLATFORM_ORDER_STATUS.INITIATED,
      gateway: { provider: 'paystation', env: getAdapter().env },
      createdBy: { user: user?._id || null, ip: ip || null },
      ...fields,
    });

    let session;
    try {
      session = await getAdapter().initiatePayment({
        invoiceNumber: order.invoiceNumber,
        amount: order.amount,
        callbackUrl: this._callbackUrl(order._id),
        customer: {
          name: shop.name,
          phone: shop?.billing?.billingContact?.phone || shop.phone,
          address: shop.address || undefined,
        },
        reference: `${order.kind}:${shop._id}`,
        checkoutItems: order.kind === PLATFORM_ORDER_KIND.SUBSCRIPTION
          ? `Subscription ${order.months} month(s)`
          : `${order.smsQuantity} SMS`,
        optA: String(order._id),
      });
    } catch (err) {
      // The order stays, marked failed. Deleting it would erase the only record
      // that a shop tried to pay us and could not — which is the single most
      // useful thing to see when an owner phones to say "it didn't work".
      order.status = PLATFORM_ORDER_STATUS.FAILED;
      order.failureReason = String(err.message || 'Gateway error').slice(0, 500);
      order.gateway.raw = err.gatewayResponse || null;
      await order.save().catch(() => {});
      logger.error(`[checkout] initiate failed for order ${order._id}: ${err.message}`);
      throw new AppError(
        'Could not start the payment. Please try again in a moment.',
        'পেমেন্ট শুরু করা যায়নি। একটু পর আবার চেষ্টা করুন।',
        502
      );
    }

    order.gateway.paymentUrl = session.paymentUrl;
    order.gateway.raw = session.raw;
    await order.save();

    logger.info(
      `[checkout] order ${order._id} (${order.kind}, ৳${order.amount}) opened for shop ${shop._id}`
    );

    return { orderId: order._id, paymentUrl: session.paymentUrl, amount: order.amount };
  }

  /**
   * Start a subscription renewal.
   *
   * The caller sends `months` and NEVER a price. The package list is the set of
   * legal answers, and anything outside it is refused rather than honoured at a
   * computed rate — the same rule the public storefront applies to product
   * prices (`services/order.service.js`: "the request body is a list of wishes,
   * not a list of prices").
   */
  async createSubscriptionOrder({ shop, user, months, ip }) {
    await this._assertCanCheckout(shop);

    const wanted = Number(months);
    const { packages } = await this.quote(shop);
    const pkg = packages.find((p) => p.months === wanted);

    if (!pkg) {
      throw new AppError(
        `No subscription package for ${months} month(s)`,
        'এই মেয়াদের কোনো প্যাকেজ নেই',
        400
      );
    }

    // A ৳0 package would create a gateway session for nothing and come back
    // unpayable. A free extension is an admin action with a reason attached.
    if (pkg.price <= 0) {
      throw new AppError(
        'This package has no price set. Please call support.',
        'এই প্যাকেজের মূল্য নির্ধারণ করা নেই। সাপোর্টে কল করুন।',
        400
      );
    }

    return this._createOrder(shop, user, {
      kind: PLATFORM_ORDER_KIND.SUBSCRIPTION,
      amount: pkg.price,
      months: pkg.months,
    }, ip);
  }

  /**
   * Start an SMS top-up.
   *
   * Here the caller DOES name an amount — that is the input, a shopkeeper
   * deciding how much to spend. What they cannot name is the rate or the
   * quantity: both are derived, so no request can buy 5,000 messages for ৳100.
   */
  async createSmsOrder({ shop, user, amount, ip }) {
    await this._assertCanCheckout(shop);

    const { sms } = await this.quote(shop);
    const taka = Number(amount);

    if (!Number.isFinite(taka) || taka <= 0) {
      throw new AppError('Amount is not valid', 'টাকার পরিমাণ সঠিক নয়', 400);
    }
    if (taka < sms.minAmount) {
      throw new AppError(
        `The minimum SMS purchase is ৳${sms.minAmount}`,
        `সর্বনিম্ন ৳${sms.minAmount} টাকার এসএমএস কিনতে হবে`,
        400
      );
    }
    if (taka > sms.maxAmount) {
      throw new AppError(
        `The maximum online purchase is ৳${sms.maxAmount}. Please call support for more.`,
        `অনলাইনে সর্বোচ্চ ৳${sms.maxAmount} টাকার কেনা যায়। বেশি লাগলে সাপোর্টে কল করুন।`,
        400
      );
    }
    if (!(sms.unitPrice > 0)) {
      throw new AppError(
        'SMS pricing is not configured',
        'এসএমএস মূল্য নির্ধারণ করা নেই',
        503
      );
    }

    // Floor, never round: handing out a message that was not paid for is a leak
    // that compounds across every top-up on the platform.
    const quantity = Math.floor(taka / sms.unitPrice);
    if (quantity < 1) {
      throw new AppError('That amount buys no SMS', 'এই টাকায় কোনো এসএমএস হয় না', 400);
    }

    return this._createOrder(shop, user, {
      kind: PLATFORM_ORDER_KIND.SMS,
      amount: round2(taka),
      smsQuantity: quantity,
      smsUnitPrice: sms.unitPrice,
    }, ip);
  }

  /**
   * Ask the gateway what happened, and act on the answer. The ONLY path to
   * `paid`.
   *
   * Never throws for an ordinary outcome — a failed payment, a still-processing
   * one and an unreachable gateway are all answers this returns rather than
   * errors, because every caller (a browser redirect, a poll, a background
   * sweep) needs to carry on regardless.
   *
   * @param {object} opts
   * @param {string} opts.reason  who asked — 'return' | 'poll' | 'sweep' | 'admin'
   */
  async verifyOrder(orderId, { reason = 'poll' } = {}) {
    const order = await PlatformOrder.findById(orderId);
    if (!order) return { ok: false, reason: 'not_found' };

    // Terminal already. Re-asking a fulfilled order would spend a gateway call
    // to be told what we already know, and a poll that keeps calling verify is
    // how a hot loop starts.
    if (order.status === PLATFORM_ORDER_STATUS.FULFILLED) {
      return { ok: true, order, alreadyFulfilled: true };
    }

    let result;
    try {
      result = await getAdapter().getTransactionStatus(order.invoiceNumber);
    } catch (err) {
      logger.error(`[checkout] status lookup failed for ${order.invoiceNumber} (${reason}): ${err.message}`);
      await PlatformOrder.updateOne(
        { _id: order._id },
        { $set: { 'gateway.lastCheckedAt': new Date() }, $inc: { 'gateway.checkCount': 1 } }
      ).catch(() => {});
      return { ok: false, reason: 'lookup_failed', order };
    }

    order.gateway.lastCheckedAt = new Date();
    order.gateway.checkCount = (order.gateway.checkCount || 0) + 1;
    order.gateway.raw = result.raw;
    if (result.trxId) order.gateway.trxId = result.trxId;
    if (result.payerMobile) order.gateway.payerMobile = result.payerMobile;
    if (result.paymentMethod) order.gateway.paymentMethod = result.paymentMethod;

    if (!result.found || result.status === TRX_STATUS.PROCESSING) {
      await order.save();
      return { ok: true, order, pending: true };
    }

    if (result.status === TRX_STATUS.FAILED) {
      order.status = PLATFORM_ORDER_STATUS.FAILED;
      order.failureReason = 'Gateway reported the transaction failed';
      await order.save();
      return { ok: true, order, failed: true };
    }

    if (result.status === TRX_STATUS.REFUND) {
      // Refunded at the gateway. Never fulfil; an operator decides what a
      // refunded-after-fulfilment order means for the shop's expiry.
      order.status = PLATFORM_ORDER_STATUS.FAILED;
      order.failureReason = 'Gateway reported the transaction was refunded';
      await order.save();
      logger.warn(`[checkout] order ${order._id} came back refunded`);
      return { ok: true, order, failed: true };
    }

    /* ── success ───────────────────────────────────────────────────────────
     *
     * `trx_status === 'success'` is the ENTIRE basis for believing the money
     * arrived. The amount below is a sanity check, not a second gate: on this
     * gateway `payment_amount` echoes the REQUESTED amount while a transaction
     * is still processing (verified against sandbox), so it can confirm a
     * mismatch but can never confirm a payment.
     */
    const paid = result.paidAmount;
    const short = Number.isFinite(paid) && paid < order.amount - 0.01;

    if (short) {
      order.status = PLATFORM_ORDER_STATUS.UNDERPAID;
      order.paidAt = new Date();
      order.failureReason = `Gateway reported ৳${paid} against ৳${order.amount}`;
      await order.save();
      logger.error(
        `[checkout] UNDERPAID order ${order._id}: ৳${paid} received against ৳${order.amount} — not fulfilled`
      );
      return { ok: true, order, underpaid: true };
    }

    if (order.status !== PLATFORM_ORDER_STATUS.PAID) {
      order.status = PLATFORM_ORDER_STATUS.PAID;
      order.paidAt = order.paidAt || new Date();
    }
    await order.save();

    logger.info(`[checkout] order ${order._id} confirmed paid via ${reason} (trx ${result.trxId})`);

    const fulfilled = await this.fulfilOrder(order);
    return { ok: true, order: fulfilled || order, paid: true, fulfilled: Boolean(fulfilled) };
  }

  /**
   * Turn a paid order into the thing it bought. Idempotent.
   *
   * Returns the fulfilled order, or null if there was nothing to do — which
   * includes losing the claim race, and is not an error.
   */
  async fulfilOrder(order) {
    if (!order || order.status !== PLATFORM_ORDER_STATUS.PAID) return null;

    // Atomic claim. Two things routinely arrive at once here: the customer's
    // browser coming back from the checkout, and the sweep. The loser gets null.
    const claimed = await PlatformOrder.findOneAndUpdate(
      { _id: order._id, status: PLATFORM_ORDER_STATUS.PAID, fulfilmentClaimedAt: null },
      { $set: { fulfilmentClaimedAt: new Date() } },
      { new: true }
    );
    if (!claimed) return null;

    const shop = await Shop.findById(claimed.shop);
    if (!shop) {
      logger.error(`[checkout] order ${claimed._id} is paid but its shop is gone`);
      return null;
    }

    const gateway = {
      provider: 'paystation',
      paymentId: claimed.gateway?.trxId || claimed.invoiceNumber,
      raw: claimed.gateway?.raw || null,
    };
    const method = mapPaymentMethod(claimed.gateway?.paymentMethod);
    const actor = { kind: 'system', name: 'PayStation' };

    try {
      if (claimed.kind === PLATFORM_ORDER_KIND.SUBSCRIPTION) {
        await billingService.applySubscriptionPayment({
          shopId: shop._id,
          amount: claimed.amount,
          mode: 'months',
          value: claimed.months,
          method,
          transactionId: claimed.gateway?.trxId || null,
          reference: claimed.invoiceNumber,
          receivedAt: claimed.paidAt || new Date(),
          notes: `Self-serve renewal — ${claimed.months} month(s)`,
          source: 'gateway',
          gateway,
          actor,
        });
      } else {
        await billingService.recordSmsPurchase(actor, {
          shopId: shop._id,
          quantity: claimed.smsQuantity,
          amount: claimed.amount,
          unitPrice: claimed.smsUnitPrice,
          method,
          transactionId: claimed.gateway?.trxId || null,
          receivedAt: claimed.paidAt || new Date(),
          notes: `Self-serve top-up — ${claimed.smsQuantity} SMS`,
          source: 'gateway',
          gateway,
        });
      }
    } catch (err) {
      /* The money is ours and the goods were not delivered. The claim STAYS —
       * releasing it would let the sweep retry a failure that is almost
       * certainly deterministic, once every five minutes forever. The order
       * sits at `paid` with a reason, which is exactly what the admin orders
       * screen exists to surface, and "Fulfil manually" is one click. */
      logger.error(`[checkout] order ${claimed._id} is PAID but fulfilment failed: ${err.message}`);
      claimed.failureReason = `Paid, but fulfilment failed: ${err.message}`.slice(0, 500);
      await claimed.save().catch(() => {});
      return null;
    }

    // Link the ledger row back, so an operator reading the order can jump to
    // the money and vice versa.
    const payment = await PlatformPayment.findOne({
      shop: shop._id,
      source: 'gateway',
      'gateway.paymentId': gateway.paymentId,
    }).select('_id').lean();

    claimed.status = PLATFORM_ORDER_STATUS.FULFILLED;
    claimed.fulfilledAt = new Date();
    claimed.failureReason = undefined;
    if (payment) claimed.platformPayment = payment._id;
    await claimed.save();

    logger.info(
      `[checkout] order ${claimed._id} fulfilled for shop ${shop._id} (${claimed.kind})`
    );
    return claimed;
  }

  /**
   * Re-open a paid-but-unfulfilled order so it can be retried.
   *
   * The admin "Fulfil manually" path. Releasing the claim is the whole point,
   * and it is deliberately a human action: whatever made fulfilment fail is
   * usually still true, and a person should have looked at it before it is
   * tried again.
   */
  async refulfilOrder(orderId) {
    const order = await PlatformOrder.findById(orderId);
    if (!order) throw new AppError('Order not found', 'অর্ডার পাওয়া যায়নি', 404);

    if (order.status === PLATFORM_ORDER_STATUS.FULFILLED) {
      return { order, alreadyFulfilled: true };
    }
    if (order.status !== PLATFORM_ORDER_STATUS.PAID) {
      throw new AppError(
        `Only a paid order can be fulfilled (this one is ${order.status})`,
        'শুধু পেমেন্ট সম্পন্ন অর্ডার পূরণ করা যায়',
        400
      );
    }

    order.fulfilmentClaimedAt = null;
    await order.save();

    const fulfilled = await this.fulfilOrder(order);
    if (!fulfilled) {
      throw new AppError(
        'Fulfilment failed again — check the server log',
        'পূরণ করা যায়নি — সার্ভার লগ দেখুন',
        500
      );
    }
    return { order: fulfilled, alreadyFulfilled: false };
  }

  /**
   * The reconciliation pass. Never throws.
   *
   * NOT a backstop. For a customer who paid in the bKash app and never came
   * back to the browser, no callback ever fires and this is the only thing that
   * gives them what they bought.
   */
  async reconcile({ now = new Date() } = {}) {
    const summary = { checked: 0, fulfilled: 0, failed: 0, abandoned: 0, pending: 0 };

    const availability = await this.isCheckoutAvailable();
    if (!availability.available) return summary;

    const cutoffYoung = new Date(now.getTime() - SWEEP_MIN_AGE_MS);
    const cutoffOld = new Date(now.getTime() - ABANDON_AFTER_MS);

    // Paid-but-unfulfilled first: that is a shop we already owe. Usually empty.
    const stranded = await PlatformOrder.find({
      status: PLATFORM_ORDER_STATUS.PAID,
      fulfilmentClaimedAt: null,
    }).limit(50);

    for (const order of stranded) {
      const done = await this.fulfilOrder(order).catch((err) => {
        logger.error(`[checkout] sweep could not fulfil ${order._id}: ${err.message}`);
        return null;
      });
      if (done) summary.fulfilled += 1;
    }

    const open = await PlatformOrder.find({
      status: PLATFORM_ORDER_STATUS.INITIATED,
      createdAt: { $lt: cutoffYoung, $gt: cutoffOld },
    }).sort({ createdAt: 1 }).limit(100);

    for (const order of open) {
      summary.checked += 1;
      const result = await this.verifyOrder(order._id, { reason: 'sweep' }).catch((err) => {
        logger.error(`[checkout] sweep verify failed for ${order._id}: ${err.message}`);
        return null;
      });
      if (!result) continue;
      if (result.fulfilled) summary.fulfilled += 1;
      else if (result.failed) summary.failed += 1;
      else if (result.pending) summary.pending += 1;
    }

    // Old and still unresolved. Marked rather than deleted — "this shop tried to
    // pay us and walked away" is a fact worth keeping.
    const aged = await PlatformOrder.updateMany(
      { status: PLATFORM_ORDER_STATUS.INITIATED, createdAt: { $lte: cutoffOld } },
      { $set: { status: PLATFORM_ORDER_STATUS.ABANDONED, failureReason: 'Never completed' } }
    );
    summary.abandoned = aged.modifiedCount || 0;

    return summary;
  }

  /** The owner's billing page, in one call. */
  async getOwnerBilling(shop) {
    const [availability, quote, quotaDoc, orders, payments] = await Promise.all([
      this.isCheckoutAvailable(),
      this.quote(shop),
      SMSQuota.findOne({ shop: shop._id }).select('totalQuota usedQuota remainingQuota isEnabled').lean(),
      PlatformOrder.find({ shop: shop._id })
        .select('kind amount months smsQuantity status createdAt fulfilledAt gateway.paymentUrl')
        .sort({ createdAt: -1 }).limit(10).lean(),
      PlatformPayment.find({ shop: shop._id, status: { $in: ['paid', 'waived'] } })
        .select('type amount method receivedAt months smsQuantity')
        .sort({ receivedAt: -1 }).limit(12).lean(),
    ]);

    return {
      // The same resolver the banner and the API's own write guard read, so the
      // page can never tell an owner something the next request contradicts.
      subscription: resolveSubscription(shop),
      checkout: availability,
      quote,
      smsQuota: quotaDoc
        ? {
          total: quotaDoc.totalQuota,
          used: quotaDoc.usedQuota,
          remaining: quotaDoc.remainingQuota,
          isEnabled: quotaDoc.isEnabled,
        }
        : { total: 0, used: 0, remaining: 0, isEnabled: false },
      recentOrders: orders,
      payments,
      supportPhone: resolveSubscription(shop).supportPhone,
    };
  }

  /** One order, scoped to its shop. Used by the return page's poll. */
  async getOrderForShop(shopId, orderId) {
    const order = await PlatformOrder.findOne({ _id: orderId, shop: shopId })
      .select('kind amount months smsQuantity status createdAt paidAt fulfilledAt failureReason gateway.paymentUrl gateway.paymentMethod')
      .lean();
    if (!order) throw new AppError('Order not found', 'অর্ডার পাওয়া যায়নি', 404);
    return order;
  }

  /** The admin worklist. */
  async listOrders({ page = 1, limit = 25, status, shopId, kind } = {}) {
    const query = {};
    if (status) query.status = status;
    if (shopId) query.shop = shopId;
    if (kind) query.kind = kind;

    const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
    const [rows, total] = await Promise.all([
      PlatformOrder.find(query)
        .populate('shop', 'name phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      PlatformOrder.countDocuments(query),
    ]);

    return { data: rows, page: Number(page), limit: Number(limit), total };
  }

  /** Counts per status, for the admin filter badges. */
  async orderCounts() {
    const rows = await PlatformOrder.aggregate([
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]);
    return rows.reduce((acc, r) => ({ ...acc, [r._id]: r.n }), {});
  }
}

module.exports = new PlatformCheckoutService();
module.exports.mintInvoiceNumber = mintInvoiceNumber;
module.exports.mapPaymentMethod = mapPaymentMethod;
module.exports.SWEEP_MIN_AGE_MS = SWEEP_MIN_AGE_MS;
module.exports.ABANDON_AFTER_MS = ABANDON_AFTER_MS;
