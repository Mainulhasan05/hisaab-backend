/**
 * Landing page orders — placement and the shop's worklist.
 *
 * ── THIS MODULE MUST NEVER TOUCH THE SHOP'S BOOKS (I-17) ────────────────────
 *
 * No `Customer`, no `Sale`, no `StockTransaction`, no `Payment`, no
 * `InvoiceCounter`, no shared `Order`. `confirmed` here means "I rang them and
 * they are real", not "post this to the ledger". `landingLedgerIsolation.test.js`
 * enforces this by scanning for the imports.
 *
 * ── EVERY FIGURE IS DERIVED SERVER-SIDE (I-13) ──────────────────────────────
 *
 * The submitted body carries `offer` keys, a `zone` key and quantities. It does
 * NOT carry prices, and any it does carry are ignored. Prices come from
 * `LandingPage.offers[]` at the moment the order is written, and are snapshotted
 * onto the order so a later edit cannot rewrite what a customer agreed to.
 *
 * This matters more here than on the storefront. There the untrusted input was a
 * stranger's browser; here the PAGE ITSELF is authored input — possibly by a
 * language model — and the number printed next to the button was never checked
 * by anyone.
 */

const mongoose = require('mongoose');

const LandingOrder = require('../models/LandingOrder.model');
const LandingPage = require('../models/LandingPage.model');
const LandingOrderCounter = require('../models/LandingOrderCounter.model');
const { resolveLandingPage } = require('../utils/landingPageState.util');
const { getBangladeshTodayStr } = require('../utils/bdTime.util');
const { normalizePhone, isValidPhone } = require('../utils/phone.util');
const { toBengaliNumber } = require('../utils/bengali.util');
const { AppError } = require('../middleware/error.middleware');

const { LANDING_ORDER_STATUSES } = LandingOrder;

/** Most of one offer a single order may take. A hedge against a fat finger and a bot. */
const MAX_QUANTITY = 99;

/** How far back the duplicate check looks. */
const DUPLICATE_WINDOW_HOURS = 24;

class LandingOrderService {
  // ── Placement ─────────────────────────────────────────────────────────────

  /**
   * Write one order from a public form submission.
   *
   * @param {Object} page      a LandingPage document
   * @param {Object} body      the submitted form
   * @param {Object} [meta]    { ip, userAgent, attribution }
   */
  async place(page, body, { ip = null, userAgent = null, attribution = {} } = {}) {
    const state = resolveLandingPage(page);
    if (!state.canAcceptOrders) {
      // 410 rather than 404: the page exists and the customer is looking at it.
      // The advertisement may still be running, and "gone" is the honest answer.
      const error = new AppError(
        `This page is not accepting orders (${state.state})`,
        'এই অফারটি শেষ হয়েছে — নতুন অর্ডার নেওয়া হচ্ছে না',
        410
      );
      error.code = 'PAGE_CLOSED';
      throw error;
    }

    const customer = this._resolveCustomer(body);
    const items = this._resolveItems(page, body);

    // ── The order of these four steps is the pricing rule ────────────────────
    //
    //   goods  →  coupon comes off the goods  →  delivery is quoted against
    //   what is left  →  the advance is quoted against the delivery.
    //
    // Every one of them depends on the one before it, and reading them in this
    // order is the only explanation of the arithmetic anyone needs.
    const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
    const discount = this._resolveDiscount(page, body, subtotal);
    const payableGoods = subtotal - discount.amount;
    const delivery = this._resolveDelivery(page, body, payableGoods);
    const payment = this._resolvePayment(page, body, delivery.charge);

    const total = payableGoods + delivery.charge;

    // Reserved BEFORE the order is written, because the guard that enforces
    // `usageLimit` is the atomic update itself. Writing the order first would
    // mean a "limit 100" code could be redeemed 130 times on a good evening and
    // nothing would notice until the shop counted.
    const reserved = await this._reserveCoupon(page, discount);

    let order;
    try {
      const orderNo = await this._nextOrderNo(page);

      order = await LandingOrder.create({
        shop: page.shop,
        page: page._id,
        orderNo,
        customer,
        items,
        delivery,
        discount: discount.amount > 0 ? discount : undefined,
        paymentMethod: payment.method,
        advance: payment.advance,
        subtotal,
        deliveryCharge: delivery.charge,
        total,
        codAmount: Math.max(0, total - (payment.advance?.amount || 0)),
        status: 'pending',
        statusHistory: [{ status: 'pending', at: new Date() }],
        attribution: this._cleanAttribution(attribution),
        meta: {
          ip: ip ? String(ip).slice(0, 64) : null,
          userAgent: userAgent ? String(userAgent).slice(0, 300) : null,
        },
      });
    } catch (err) {
      // Hand the redemption back. Not awaited for correctness — the customer's
      // error must not wait on bookkeeping — but a leaked reservation only ever
      // makes a code run out slightly early, never lets it overrun.
      if (reserved) this._releaseCoupon(page, discount).catch(() => {});
      throw err;
    }

    return order;
  }

  /**
   * Name, phone and address — a SNAPSHOT, not a `Customer` (I-17).
   *
   * The phone is normalised on the way in so that the duplicate check and the
   * customers view group one person together whether they typed `01712…`,
   * `+8801712…` or `8801712…`. Storing it raw would make every one of those look
   * like a different buyer.
   */
  _resolveCustomer(body) {
    const name = String(body?.customerName || '').trim();
    const rawPhone = String(body?.phone || '').trim();
    const address = String(body?.address || '').trim();

    if (!name) throw new AppError('Name is required', 'আপনার নাম দিন', 400);
    if (!isValidPhone(rawPhone)) {
      throw new AppError('A valid phone number is required', 'সঠিক মোবাইল নম্বর দিন', 400);
    }
    if (!address) throw new AppError('Address is required', 'ঠিকানা দিন', 400);

    return {
      name: name.slice(0, 120),
      phone: normalizePhone(rawPhone),
      address: address.slice(0, 500),
      note: String(body?.note || '').trim().slice(0, 500) || undefined,
    };
  }

  /**
   * Turn the posted offer keys into priced lines.
   *
   * The whole of I-13 lives in this method. A key that is not an ACTIVE offer on
   * this page is refused rather than skipped: silently dropping it would write
   * an order for less than the customer chose, and they would find out at the
   * door.
   */
  _resolveItems(page, body) {
    const active = page.activeOffers();
    if (active.length === 0) {
      throw new AppError('This page has nothing to order', 'এই পেজে অর্ডার করার মতো কিছু নেই', 409);
    }

    // A single-offer page needs no picker in its HTML, so an absent `offer` is
    // not an error there — it is the only thing it could have been.
    const requested = this._requestedOffers(body, active);

    const items = [];
    for (const { key, quantity } of requested) {
      const offer = page.findOffer(key);
      if (!offer) {
        throw new AppError(
          `Unknown offer "${key}"`,
          'নির্বাচিত অফারটি আর পাওয়া যাচ্ছে না — পেজটি রিফ্রেশ করুন',
          409
        );
      }

      const qty = clampQuantity(quantity);
      items.push({
        offerKey: offer.key,
        // Snapshotted so editing the offer tomorrow cannot rewrite what this
        // customer saw and agreed to today.
        label: offer.label,
        unitPrice: offer.price,
        quantity: qty,
        lineTotal: offer.price * qty,
      });
    }

    if (items.length === 0) {
      throw new AppError('Please choose an option', 'একটি অপশন নির্বাচন করুন', 400);
    }
    return items;
  }

  /** Normalise the several shapes a form can post an offer selection in. */
  _requestedOffers(body, active) {
    const quantity = body?.quantity;

    // `offer` as an array — a form with checkboxes rather than radios.
    //
    // A parallel `quantity` array is honoured position by position, which is
    // what a checkbox list with a number box beside each row actually posts.
    // The first version hardcoded 1 here, so a customer who ticked two packs
    // and typed "3" against one of them was silently sold one of each — and
    // found out at the door, which is the failure this whole module is built
    // to avoid. A scalar `quantity` alongside an array is ambiguous and is
    // deliberately NOT spread across the rows; it means one each.
    if (Array.isArray(body?.offer)) {
      const quantities = Array.isArray(quantity) ? quantity : [];
      return body.offer
        .filter(Boolean)
        .map((key, idx) => ({ key, quantity: quantities[idx] }));
    }

    // `items: [{ offer, quantity }]` — a form that lets one customer take two
    // of one pack and one of another.
    if (Array.isArray(body?.items) && body.items.length > 0) {
      return body.items
        .filter((i) => i && i.offer)
        .map((i) => ({ key: String(i.offer), quantity: i.quantity }));
    }

    if (body?.offer) return [{ key: String(body.offer), quantity }];

    // No selection on a single-offer page: unambiguous.
    if (active.length === 1) return [{ key: active[0].key, quantity }];

    throw new AppError('Please choose an option', 'একটি অপশন নির্বাচন করুন', 400);
  }

  /**
   * Resolve the delivery zone, its charge, and whether the threshold made it free.
   *
   * ── ABSENT IS FINE. WRONG IS NOT. ────────────────────────────────────────
   *
   * An ABSENT zone falls back to the first active one: the page may legitimately
   * have no zone picker (one charge for everyone), and refusing an order over a
   * field the form never rendered is the wrong trade against a lost sale.
   *
   * An UNKNOWN zone key is now refused with a 409, and it used to fall back the
   * same way. That was wrong in a way nobody would have caught: a customer who
   * picked "ঢাকার বাইরে" on a cached page whose zone keys had since been renamed
   * was charged the Dhaka rate and shipped 300km, and the order looked perfectly
   * ordinary in the worklist. Refusing tells them to refresh; falling back tells
   * nobody anything and costs the shop ৳120 a parcel.
   */
  _resolveDelivery(page, body, payableSubtotal = 0) {
    const zones = page.activeZones();
    if (zones.length === 0) {
      return { zoneKey: null, zoneName: null, charge: 0, freeByThreshold: false, freeAbove: 0 };
    }

    let chosen;
    if (body?.zone) {
      chosen = page.findZone(body.zone);
      if (!chosen) {
        throw new AppError(
          `Unknown delivery zone "${body.zone}"`,
          'ডেলিভারি এলাকাটি আর পাওয়া যাচ্ছে না — পেজটি রিফ্রেশ করুন',
          409
        );
      }
    } else {
      chosen = zones[0];
    }

    const quote = page.quoteDelivery(chosen, payableSubtotal);
    return {
      zoneKey: chosen.key,
      zoneName: chosen.name,
      charge: quote.charge,
      freeByThreshold: Boolean(quote.isFree && quote.freeAbove > 0 && quote.charge === 0),
      freeAbove: quote.freeAbove,
    };
  }

  /**
   * Resolve the coupon the customer typed, if any.
   *
   * A bad code is REFUSED rather than ignored. Quietly dropping it would write
   * an order at full price against a customer who believes they got ৳200 off,
   * and the argument happens at the door — the same failure `_resolveItems`
   * refuses an unknown offer to avoid.
   *
   * The Bengali message is the same for unknown, expired and exhausted codes.
   * Distinguishing them would let a stranger walk the code space and learn which
   * strings are real, which is the only thing an attacker wants from this
   * endpoint.
   */
  _resolveDiscount(page, body, subtotal) {
    const raw = String(body?.coupon || '').trim();
    if (!raw) return { code: undefined, label: undefined, amount: 0 };

    const coupon = page.findCoupon(raw);
    const quote = page.quoteCoupon(coupon, subtotal);

    if (!coupon || quote.amount <= 0) {
      // The one case worth explaining, because the customer can act on it: the
      // code is real and they are simply short of the minimum.
      if (coupon && quote.reason === 'min-subtotal') {
        throw new AppError(
          `Coupon requires a subtotal of at least ${quote.minSubtotal}`,
          // Bengali numerals, like every other customer-facing amount on this
          // platform. A message reading "৳2000" in the middle of a Bengali
          // sentence is the one thing on the page that looks machine-written.
          `এই কুপনটি ৳${toBengaliNumber(quote.minSubtotal)} বা তার বেশি অর্ডারে ব্যবহার করা যাবে`,
          400
        );
      }
      throw new AppError('Invalid coupon', 'কুপন কোডটি সঠিক নয়', 400);
    }

    return {
      code: coupon.code,
      label: coupon.type === 'percent'
        ? `${toBengaliNumber(coupon.value)}% ছাড়`
        : `৳${toBengaliNumber(coupon.value)} ছাড়`,
      amount: quote.amount,
    };
  }

  /**
   * Guarded, atomic redemption.
   *
   * The `usedCount: { $lt: usageLimit }` predicate in the filter is the entire
   * enforcement — two customers submitting the last redemption in the same
   * millisecond both pass `findCoupon`, and only one of them matches here.
   *
   * Returns false when the code was already exhausted, and the order is refused
   * rather than written at a discount the shop capped on purpose.
   */
  async _reserveCoupon(page, discount) {
    if (!discount?.code || discount.amount <= 0) return false;

    const coupon = page.findCoupon(discount.code);
    if (!coupon) return false;

    // An unlimited code still counts redemptions — the shop wants the number —
    // but has no ceiling to race against.
    const filter = { _id: page._id, 'coupons.code': coupon.code };
    if (coupon.usageLimit > 0) filter['coupons.usedCount'] = { $lt: coupon.usageLimit };

    const res = await LandingPage.updateOne(filter, { $inc: { 'coupons.$.usedCount': 1 } });
    const claimed = (res.modifiedCount || res.nModified || 0) > 0;

    if (!claimed && coupon.usageLimit > 0) {
      throw new AppError('Coupon exhausted', 'কুপনটির সীমা শেষ হয়ে গেছে', 409);
    }
    return claimed;
  }

  /** Undo a reservation whose order never got written. */
  async _releaseCoupon(page, discount) {
    if (!discount?.code) return;
    await LandingPage.updateOne(
      { _id: page._id, 'coupons.code': discount.code, 'coupons.usedCount': { $gt: 0 } },
      { $inc: { 'coupons.$.usedCount': -1 } }
    );
  }

  /**
   * Decide how this order gets paid for.
   *
   * ── AN ADVANCE OF ZERO IS COD ────────────────────────────────────────────
   *
   * When the page asks for the delivery charge up front and the order earned
   * free delivery, there is nothing to send. Demanding a TrxID for ৳0 would lose
   * the order over a form field, so the method quietly settles back to `cod`.
   *
   * ── THE TrxID IS NEVER CHECKED HERE ──────────────────────────────────────
   *
   * It is required to be PRESENT, and that is all. Nothing in this system talks
   * to bKash; a human compares it against a statement and marks the order
   * verified. Validating its shape would only teach a prankster what shape to
   * type.
   */
  _resolvePayment(page, body, deliveryCharge) {
    const offered = page.paymentMethods();
    const asked = String(body?.paymentMethod || '').trim().toLowerCase();

    // Nothing asked for, or a page that only does one thing: take the first
    // method it offers. `cod` for every page that has not opted in.
    const method = offered.includes(asked) ? asked : offered[0];

    if (method !== 'advance') {
      return { method: 'cod', advance: undefined };
    }

    const amount = page.advanceDue(deliveryCharge);
    if (amount <= 0) return { method: 'cod', advance: undefined };

    const trxId = String(body?.trxId || '').trim();
    if (!trxId) {
      throw new AppError(
        'A transaction id is required for advance payment',
        'অগ্রিম পেমেন্টের ট্রানজেকশন আইডি (TrxID) দিন',
        400
      );
    }

    return {
      method: 'advance',
      advance: {
        amount,
        senderNumber: String(body?.senderNumber || '').trim().slice(0, 40) || undefined,
        trxId: trxId.slice(0, 60),
        verified: false,
      },
    };
  }

  /**
   * A public price quote — what the form shows before anything is submitted.
   *
   * Exists so the browser never has to reimplement the arithmetic above. The
   * runtime can add up offers and a flat delivery charge on its own, but the
   * moment a threshold and a coupon are in play, two implementations of the same
   * rule start disagreeing and the customer sees one number and is charged
   * another.
   *
   * Writes nothing — a coupon is validated here, never redeemed. Redemption
   * happens once, inside `place`.
   */
  quote(page, body) {
    const items = this._resolveItems(page, body);
    const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);

    let discount = { code: undefined, label: undefined, amount: 0 };
    let couponError = null;
    if (body?.coupon) {
      try {
        discount = this._resolveDiscount(page, body, subtotal);
      } catch (err) {
        // A quote must not fail over a mistyped code — it must PRICE the order
        // without it and say why, so the customer can fix it or order anyway.
        couponError = err.messageBn || err.message;
      }
    }

    const payableGoods = subtotal - discount.amount;
    const delivery = this._resolveDelivery(page, body, payableGoods);
    const total = payableGoods + delivery.charge;
    const advanceAmount = page.paymentMethods().includes('advance')
      ? page.advanceDue(delivery.charge)
      : 0;

    return {
      subtotal,
      discount: discount.amount,
      discountLabel: discount.label || null,
      couponError,
      deliveryCharge: delivery.charge,
      freeByThreshold: delivery.freeByThreshold,
      total,
      advanceAmount,
      codAmount: Math.max(0, total - advanceAmount),
    };
  }

  /** UTM and click ids only, bounded. Never trusted, never used for anything but reporting. */
  _cleanAttribution(attribution) {
    const take = (v) => (v ? String(v).slice(0, 200) : undefined);
    return {
      utmSource: take(attribution.utmSource),
      utmMedium: take(attribution.utmMedium),
      utmCampaign: take(attribution.utmCampaign),
      utmContent: take(attribution.utmContent),
      fbclid: take(attribution.fbclid),
      referrer: attribution.referrer ? String(attribution.referrer).slice(0, 500) : undefined,
    };
  }

  /**
   * `AAM-0007`. The prefix is the page's, the sequence is the SHOP's.
   *
   * Keyed on (shop, day) so a shop running three campaigns gets one continuous
   * daily series it can read, told apart by prefix rather than by three number
   * series colliding at 0001.
   */
  async _nextOrderNo(page) {
    const today = getBangladeshTodayStr();
    const seq = await LandingOrderCounter.nextSeq(page.shop, today, () =>
      LandingOrder.countDocuments({
        shop: page.shop,
        createdAt: { $gte: new Date(`${today}T00:00:00+06:00`) },
      })
    );
    const prefix = String(page.orderPrefix || 'LP').toUpperCase();
    return `${prefix}-${String(seq).padStart(4, '0')}`;
  }

  // ── The shop's worklist ───────────────────────────────────────────────────

  async listForShop(shopId, { page = null, status = null, search = null, limit = 50, skip = 0 } = {}) {
    const query = { shop: shopId };
    if (page) query.page = page;
    if (status) query.status = status;
    if (search) {
      const rx = new RegExp(escapeRegex(String(search).trim()), 'i');
      query.$or = [{ orderNo: rx }, { 'customer.name': rx }, { 'customer.phone': rx }];
    }

    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

    const [items, total] = await Promise.all([
      LandingOrder.find(query).sort({ createdAt: -1 }).skip(Number(skip) || 0).limit(safeLimit),
      LandingOrder.countDocuments(query),
    ]);

    return { items, total, limit: safeLimit };
  }

  /**
   * Fetch one order, scoped to the shop that owns it.
   *
   * A 404 rather than a 403 for a foreign order: a shop must not be able to
   * discover that an order id exists by the shape of the error.
   */
  async getForShop(orderId, shopId) {
    const order = await LandingOrder.findOne({ _id: orderId, shop: shopId });
    if (!order) throw new AppError('Order not found', 'অর্ডারটি পাওয়া যায়নি', 404);
    return order;
  }

  /**
   * Move an order along.
   *
   * Only forward, plus `cancelled` from anywhere before `delivered`. Reversing a
   * status is refused: `statusHistory` is what the shop reads to answer "when
   * did this ship", and letting it go backwards makes that record a guess.
   *
   * Nothing here writes outside this collection (I-17). `confirmed` in
   * particular does NOT create a Sale.
   */
  async updateStatus(orderId, shopId, nextStatus, { userId = null, note = null } = {}) {
    const order = await this.getForShop(orderId, shopId);

    if (!LANDING_ORDER_STATUSES.includes(nextStatus)) {
      throw new AppError(`Unknown status "${nextStatus}"`, 'অজানা স্ট্যাটাস', 400);
    }
    if (order.status === nextStatus) return order;

    const allowed = order.nextStatuses();
    if (!allowed.includes(nextStatus)) {
      throw new AppError(
        `Cannot move an order from ${order.status} to ${nextStatus}`,
        `"${order.status}" থেকে "${nextStatus}"-এ নেওয়া যাবে না`,
        409
      );
    }

    order.status = nextStatus;
    order.statusHistory.push({
      status: nextStatus,
      at: new Date(),
      by: userId,
      note: note ? String(note).slice(0, 300) : undefined,
    });

    await order.save();

    // The customer's confirmation SMS. Metered, opt-in per page, and never
    // awaited — a spent SMS balance must not fail a status change the shop has
    // already made and is looking at.
    if (nextStatus === 'confirmed') {
      this._notifyConfirmed(order, userId).catch(() => {});
    }

    return order;
  }

  /** Load the page the order came through, then hand off to the notifier. */
  async _notifyConfirmed(order, userId) {
    const page = await LandingPage.findById(order.page).select('notifications title');
    if (!page) return;
    // Lazy: keeps the SMS gateway and the Telegram client out of the module
    // graph of the public placement path.
    await require('./landingNotify.service').orderConfirmed(page, order, { userId });
  }

  /**
   * Mark a prank or a refused parcel.
   *
   * Kept apart from `cancelled` because the two answer different questions. A
   * cancellation is often the customer changing their mind, which is ordinary;
   * this feeds the duplicate check. Lumping them together makes the confirmation
   * rate — the number a trader judges a campaign by — meaningless.
   */
  async setFake(orderId, shopId, isFake) {
    const order = await this.getForShop(orderId, shopId);
    order.isFake = Boolean(isFake);
    await order.save();
    return order;
  }

  /**
   * Mark an advance payment as seen in the shop's own bKash/Nagad statement.
   *
   * A human act, recorded as one — `verifiedBy` is who looked. Nothing here
   * contacts a payment provider, and the day this method starts claiming to is
   * the day the shop stops checking.
   *
   * Un-verifying is allowed: the ordinary correction is a staff member ticking
   * the wrong row, and a one-way flag would leave them editing the database.
   */
  async verifyAdvance(orderId, shopId, isVerified, { userId = null } = {}) {
    const order = await this.getForShop(orderId, shopId);

    if (order.paymentMethod !== 'advance') {
      throw new AppError(
        'This order has no advance payment',
        'এই অর্ডারে কোনো অগ্রিম পেমেন্ট নেই',
        409
      );
    }

    order.advance.verified = Boolean(isVerified);
    order.advance.verifiedAt = isVerified ? new Date() : undefined;
    order.advance.verifiedBy = isVerified ? userId : undefined;

    await order.save();
    return order;
  }

  /**
   * Recent orders from the same phone — flagged in the worklist, never blocked.
   *
   * COD landing pages in Bangladesh take a meaningful share of duplicate and
   * prank orders. Refusing automatically would also refuse the ordinary case of
   * someone ordering twice in a day, so this informs the human who is about to
   * ring them rather than deciding for them.
   */
  async duplicatesFor(order, { hours = DUPLICATE_WINDOW_HOURS } = {}) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    return LandingOrder.find({
      shop: order.shop,
      'customer.phone': order.customer.phone,
      _id: { $ne: order._id },
      createdAt: { $gte: since },
    }).select('orderNo status total createdAt isFake').sort({ createdAt: -1 }).limit(10);
  }
}

/** 1..MAX_QUANTITY, defaulting to 1. A blank, a word or a negative all mean one. */
function clampQuantity(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_QUANTITY);
}

function escapeRegex(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = new LandingOrderService();
module.exports.MAX_QUANTITY = MAX_QUANTITY;
module.exports.DUPLICATE_WINDOW_HOURS = DUPLICATE_WINDOW_HOURS;
module.exports.clampQuantity = clampQuantity;
