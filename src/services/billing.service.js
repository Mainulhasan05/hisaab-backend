/**
 * Billing — everything that moves a shop's expiry date or records money the
 * shop paid HisaabBD.
 *
 * The rule that shapes this file: **there is one funnel**. Manual entry by an
 * admin and (later) a verified gateway callback both end in
 * `applySubscriptionPayment`, and every path that moves an expiry ends in
 * `_applyExtension`. Phase 2 is then an adapter that calls the first of those,
 * not a second implementation of billing. SUBSCRIPTION_PLAN.md §7.
 *
 * Three rules are enforced here rather than in the UI, because the UI is not
 * the only caller and a scripted fix at 2am is exactly when they matter:
 *
 *   · a free extension REQUIRES a reason — otherwise ৳0 days become
 *     indistinguishable from revenue in the timeline
 *   · extending NEVER touches `access` — a deliberately blocked shop stays
 *     blocked, because the old code's silent `isActive = true` meant renewing a
 *     shop you had switched off quietly switched it back on
 *   · extending a shop that has NO expiry is refused — it would introduce one,
 *     which is a downgrade dressed as a renewal
 */

const Shop = require('../models/Shop.model');
const PlatformPayment = require('../models/PlatformPayment.model');
const PlatformSetting = require('../models/PlatformSetting.model');
const SubscriptionEvent = require('../models/SubscriptionEvent.model');
const SMSQuota = require('../models/SMSQuota.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { invalidateShopAuthCache } = require('../utils/authCache.util');
const { resolveSubscription } = require('../utils/subscriptionState.util');
const {
  endOfBangladeshDay,
  addBangladeshDays,
  bangladeshDaysBetween,
  toBangladeshDateStr,
  getBangladeshTodayStr,
  getBangladeshDayRange,
} = require('../utils/bdTime.util');
const { PLATFORM_PAYMENT_TYPES } = require('../config/constants');
const logger = require('../utils/logger.util');

// A fat-fingered "3000 months" should bounce, not hand out 250 free years.
// Anything genuinely open-ended is expressed with mode 'until', which says so
// explicitly and is confirmed on screen.
const MAX_EXTEND_DAYS = 3650;
const MAX_EXTEND_MONTHS = 120;

/**
 * Add whole calendar months to a Bangladesh date, clamping the day.
 * 31 Jan + 1 month = 28/29 Feb, not 3 March — a month of subscription must
 * never quietly become a month and two days.
 */
function addBangladeshMonths(from, months) {
  const dateStr = toBangladeshDateStr(from);
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const targetMonthIndex = m - 1 + months;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  const iso = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return endOfBangladeshDay(iso);
}

class BillingService {
  /** Platform defaults. Never allowed to be the thing that fails a request. */
  async getSettings() {
    try {
      return await PlatformSetting.current();
    } catch (err) {
      logger.error(`[billing] platform settings unavailable: ${err.message}`);
      return null;
    }
  }

  // ── expiry arithmetic ───────────────────────────────────────────────────

  /**
   * Where an extension lands.
   *
   * The anchor rule, which is the part that quietly decides whether a shop
   * feels cheated:
   *
   *   expiry in the future → extend FROM the expiry. A shop that pays a week
   *                          early keeps that week; it is not punished for
   *                          paying on time.
   *   expiry past or none  → extend FROM today. A shop that pays three weeks
   *                          late does not get three weeks of backdated credit
   *                          it never used.
   *
   * `anchorAt` replaces "today" in that second line. It exists for the common
   * case of money that arrived days before anyone keyed it in: pass the date it
   * was actually received and the month runs from then, so the shop gets the
   * period it paid for rather than a bonus for the operator's backlog. It is
   * opt-in — defaulting to it would silently shorten access every time a
   * payment was entered late.
   *
   * Everything lands on the END of a Bangladesh day, so the date the operator
   * typed is the last date the shop can trade.
   *
   * @returns {{ expiresAt: Date, anchor: Date, days: number|null }}
   */
  computeExpiry({ currentExpiresAt, mode, value, now = new Date(), anchorAt = null }) {
    if (mode === 'until') {
      const expiresAt = endOfBangladeshDay(value);
      if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
        throw new AppError('Invalid expiry date', 'অবৈধ তারিখ দেওয়া হয়েছে', 400);
      }
      return {
        expiresAt,
        anchor: currentExpiresAt || now,
        days: bangladeshDaysBetween(currentExpiresAt || now, expiresAt),
      };
    }

    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new AppError('Extension amount must be a positive number', 'মেয়াদ বাড়ানোর পরিমাণ সঠিক নয়', 400);
    }

    // Extending a never-expiring shop would CREATE an expiry — a downgrade
    // wearing a renewal's clothes. Refuse and make the operator say what they
    // actually mean with an explicit date.
    if (!currentExpiresAt) {
      throw new AppError(
        'This shop has no expiry date (it never expires). Use an explicit end date to set one.',
        'এই দোকানের কোনো মেয়াদ নেই (কখনো শেষ হয় না)। মেয়াদ দিতে হলে সরাসরি তারিখ নির্বাচন করুন।',
        400
      );
    }

    // `anchorAt` is where "now" moves to for a backdated payment. Days already
    // paid for still win over it, so backdating can never cut an active
    // subscription short — only extend a lapsed one from the right date.
    const from = anchorAt ? new Date(anchorAt) : now;
    const anchor = currentExpiresAt > from ? currentExpiresAt : from;

    if (mode === 'days') {
      if (amount > MAX_EXTEND_DAYS) {
        throw new AppError(
          `Cannot extend by more than ${MAX_EXTEND_DAYS} days at once. Use an explicit end date instead.`,
          `একবারে ${MAX_EXTEND_DAYS} দিনের বেশি বাড়ানো যাবে না। সরাসরি তারিখ নির্বাচন করুন।`,
          400
        );
      }
      const expiresAt = addBangladeshDays(anchor, amount);
      return { expiresAt, anchor, days: bangladeshDaysBetween(currentExpiresAt, expiresAt) };
    }

    if (mode === 'months') {
      if (amount > MAX_EXTEND_MONTHS) {
        throw new AppError(
          `Cannot extend by more than ${MAX_EXTEND_MONTHS} months at once. Use an explicit end date instead.`,
          `একবারে ${MAX_EXTEND_MONTHS} মাসের বেশি বাড়ানো যাবে না। সরাসরি তারিখ নির্বাচন করুন।`,
          400
        );
      }
      const expiresAt = addBangladeshMonths(anchor, amount);
      return { expiresAt, anchor, days: bangladeshDaysBetween(currentExpiresAt, expiresAt) };
    }

    throw new AppError(
      `Unknown extension mode "${mode}". Expected days, months or until.`,
      'মেয়াদ বাড়ানোর ধরন সঠিক নয়।',
      400
    );
  }

  // ── internals ───────────────────────────────────────────────────────────

  async _loadShop(shopId) {
    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('Shop not found', 'দোকান পাওয়া যায়নি', 404);
    }
    return shop;
  }

  /**
   * Write the billing timeline entry, and mirror it into the platform audit
   * log for the operator's own trail.
   *
   * Both, not one: `AuditLog` carries a 90-day TTL index and is prose meant for
   * an operator scrolling recent activity, while billing history has to survive
   * for years and be queryable by type ("every free extension this quarter").
   * Neither collection can do the other's job.
   */
  async _recordEvent({ shop, type, actor, before, after, paid, amount, payment, days, reason, note, audit }) {
    const event = await SubscriptionEvent.create({
      shop: shop._id,
      type,
      actor: actor || { kind: 'system' },
      before,
      after,
      paid: !!paid,
      amount,
      payment: payment?._id || payment || undefined,
      days,
      reason,
      note,
      at: new Date(),
    });

    if (audit) {
      // Audit failures must never roll back a billing change that already
      // landed — the timeline entry above is the record that matters.
      await AuditLog.create({
        admin: actor?.kind === 'admin' ? actor.id : undefined,
        action: audit.action,
        actionBn: audit.actionBn,
        description: audit.description,
        descriptionBn: audit.descriptionBn,
        entity: { type: 'shop', id: shop._id, name: shop.name },
        changes: { before, after },
        isSystemAction: actor?.kind === 'system',
      }).catch((err) => logger.error(`[billing] audit log failed: ${err.message}`));
    }

    return event;
  }

  /**
   * Move a shop's expiry and persist it. The single writer of
   * `subscription.expiresAt` — every public method funnels through here.
   *
   * Deliberately does NOT touch `shop.access` or `shop.isActive`. Renewing a
   * blocked shop leaves it blocked; the caller surfaces that instead of
   * silently undoing an operator's decision.
   */
  async _applyExtension(shop, { mode, value, now = new Date(), anchorAt = null, becomesPaid }) {
    const before = {
      expiresAt: shop.subscription?.expiresAt || null,
      plan: shop.subscription?.plan,
      state: resolveSubscription(shop, now).state,
    };

    const { expiresAt, days } = this.computeExpiry({
      currentExpiresAt: shop.subscription?.expiresAt || null,
      mode,
      value,
      now,
      anchorAt,
    });

    shop.subscription.expiresAt = expiresAt;
    // `status` is a denormalised label the resolver ignores, kept current so
    // the existing admin list filters keep working.
    shop.subscription.status = 'active';
    if (becomesPaid) {
      shop.subscription.plan = 'paid';
      if (before.plan === 'trial') shop.subscription.trialEndedAt = now;
    }

    await shop.save();
    await invalidateShopAuthCache(shop._id);

    const after = {
      expiresAt,
      plan: shop.subscription.plan,
      state: resolveSubscription(shop, now).state,
    };

    return { before, after, days, expiresAt };
  }

  // ── trial ───────────────────────────────────────────────────────────────

  /**
   * Put a shop on a trial of any length.
   *
   * Any positive day count is valid — there is no policy cap, because the
   * bargain is struck on the phone and the panel exists to record it, not to
   * argue with it.
   *
   * **Trial and paid never coexist.** `plan` is one field with two values, so a
   * shop is on exactly one of them, and a trial REPLACES the expiry date rather
   * than sitting beside it. That makes starting a trial on a shop with paid
   * time left destructive — a 14-day trial on a shop paid through December
   * throws away four months — so it is refused unless the caller says
   * `force: true`. The discarded date is written to the event either way, so a
   * forced one can be undone from the timeline.
   */
  async startTrial(actor, shopId, { days, reason, force = false } = {}) {
    const count = Number(days);
    if (!Number.isFinite(count) || count <= 0 || count > MAX_EXTEND_DAYS) {
      throw new AppError(
        `Trial length must be between 1 and ${MAX_EXTEND_DAYS} days`,
        `ট্রায়ালের দিন ১ থেকে ${MAX_EXTEND_DAYS} এর মধ্যে হতে হবে`,
        400
      );
    }

    const shop = await this._loadShop(shopId);
    const now = new Date();

    const paidThrough = shop.subscription?.expiresAt;
    const hasLivePaidTime =
      shop.subscription?.plan === 'paid' && paidThrough && new Date(paidThrough) > now;
    if (hasLivePaidTime && !force) {
      const until = toBangladeshDateStr(paidThrough);
      const left = bangladeshDaysBetween(now, paidThrough);
      throw new AppError(
        `This shop is on a paid subscription until ${until} (${left} days left). ` +
        'Starting a trial replaces that date — a shop is on a trial OR a paid plan, never both. ' +
        'Confirm to proceed if that is intended.',
        `এই দোকানের পেইড সাবস্ক্রিপশন ${until} পর্যন্ত চালু আছে (আর ${left} দিন)। ` +
        'ট্রায়াল চালু করলে ওই মেয়াদ মুছে যাবে — একসাথে ট্রায়াল ও সাবস্ক্রিপশন থাকতে পারে না।',
        409
      );
    }
    const before = {
      expiresAt: shop.subscription?.expiresAt || null,
      plan: shop.subscription?.plan,
      state: resolveSubscription(shop, now).state,
    };

    shop.subscription.plan = 'trial';
    shop.subscription.status = 'active';
    shop.subscription.startedAt = now;
    shop.subscription.expiresAt = addBangladeshDays(now, count);
    shop.subscription.trialDays = count;
    shop.subscription.trialEndedAt = undefined;
    await shop.save();
    await invalidateShopAuthCache(shop._id);

    const after = {
      expiresAt: shop.subscription.expiresAt,
      plan: 'trial',
      state: resolveSubscription(shop, now).state,
    };

    await this._recordEvent({
      shop,
      type: 'trial_started',
      actor,
      before,
      after,
      paid: false,
      days: count,
      reason,
      // `before.expiresAt` is the discarded paid date. It is the only record of
      // what a forced trial threw away, and what an operator restores from.
      note: hasLivePaidTime
        ? `Replaced a paid subscription that ran to ${toBangladeshDateStr(paidThrough)}`
        : undefined,
      audit: {
        action: 'subscription_trial',
        actionBn: 'ট্রায়াল চালু',
        description:
          `Started a ${count}-day trial for ${shop.name} (until ${toBangladeshDateStr(after.expiresAt)})` +
          (hasLivePaidTime ? ` — replaced paid time through ${toBangladeshDateStr(paidThrough)}` : ''),
        descriptionBn: `${shop.name} এর জন্য ${count} দিনের ট্রায়াল চালু করা হয়েছে`,
      },
    });

    return this.getShopBilling(shop._id);
  }

  // ── extension ───────────────────────────────────────────────────────────

  /**
   * Extend (or correct) a shop's subscription, with or without payment.
   *
   * `payment: null` is a free extension and demands a reason. That is not
   * bureaucracy: free days and paid days are indistinguishable in the expiry
   * date, and the only place the difference survives is the reason on this
   * event.
   *
   * @param {Object} actor {kind, id, name}
   * @param {string} shopId
   * @param {Object} opts
   * @param {'days'|'months'|'until'} opts.mode
   * @param {number|string} opts.value  days | months | ISO date
   * @param {Object|null} opts.payment  {amount, method, transactionId, receivedAt, notes}
   * @param {string} [opts.reason]      required when payment is null, or when moving expiry backwards
   */
  async extendSubscription(actor, shopId, { mode, value, payment = null, reason, note } = {}) {
    const shop = await this._loadShop(shopId);
    const now = new Date();

    // Preview the landing point before writing anything, so both guards below
    // can refuse without having half-applied the change.
    const preview = this.computeExpiry({
      currentExpiresAt: shop.subscription?.expiresAt || null,
      mode,
      value,
      now,
    });

    if (!payment && !reason) {
      throw new AppError(
        'A reason is required when extending without payment',
        'পেমেন্ট ছাড়া মেয়াদ বাড়াতে হলে কারণ লিখতে হবে',
        400
      );
    }

    // Moving an expiry BACKWARDS takes access away that was already granted.
    // Legitimate as a correction, never as an accident.
    const movesBackwards = preview.days !== null && preview.days < 0;
    if (movesBackwards && !reason) {
      throw new AppError(
        'Moving the expiry date backwards requires a reason',
        'মেয়াদ কমাতে হলে কারণ লিখতে হবে',
        400
      );
    }

    if (payment) {
      // The paid path goes through the one funnel, so a manual entry and a
      // gateway callback cannot drift apart.
      return this.applySubscriptionPayment({
        shopId,
        actor,
        mode,
        value,
        note,
        source: 'manual',
        ...payment,
      });
    }

    const { before, after, days, expiresAt } = await this._applyExtension(shop, {
      mode,
      value,
      now,
      becomesPaid: false, // free days never convert a trial into a paid plan
    });

    await this._recordEvent({
      shop,
      type: shop.subscription.plan === 'trial' ? 'trial_extended' : 'extended',
      actor,
      before,
      after,
      paid: false,
      days,
      reason,
      note,
      audit: {
        action: 'subscription_extend_free',
        actionBn: 'বিনামূল্যে মেয়াদ বৃদ্ধি',
        description:
          `Extended ${shop.name} to ${toBangladeshDateStr(expiresAt)} ` +
          `(${days >= 0 ? '+' : ''}${days} days, no payment). Reason: ${reason}`,
        descriptionBn: `${shop.name} এর মেয়াদ ${toBangladeshDateStr(expiresAt)} পর্যন্ত বাড়ানো হয়েছে (পেমেন্ট ছাড়া)। কারণ: ${reason}`,
      },
    });

    return this.getShopBilling(shop._id);
  }

  // ── the payment funnel ──────────────────────────────────────────────────

  /**
   * Record a subscription payment and extend the shop. THE funnel.
   *
   * Manual entry passes `source: 'manual'`; a future gateway webhook passes
   * `source: 'gateway'` with `gateway.paymentId` after verifying the signature.
   * The gateway branch is idempotent on that id, so a retried webhook returns
   * the original result instead of granting a second month.
   *
   * `receivedAt` is when the money arrived, which is routinely not when it was
   * keyed in. It always dates the LEDGER row. It only moves the subscription
   * period too when `backdate` is set — see the anchor note on `computeExpiry`.
   */
  async applySubscriptionPayment({
    shopId,
    amount,
    mode = 'months',
    value = 1,
    method = 'cash',
    transactionId,
    reference,
    receivedAt,
    backdate = false,
    notes,
    note,
    source = 'manual',
    actor,
    gateway,
  } = {}) {
    const paid = Number(amount);
    if (!Number.isFinite(paid) || paid < 0) {
      throw new AppError('Payment amount is not valid', 'পেমেন্টের পরিমাণ সঠিক নয়', 400);
    }

    // Idempotency: a webhook that fires twice must not extend twice.
    if (source === 'gateway' && gateway?.paymentId) {
      const existing = await PlatformPayment.findOne({
        source: 'gateway',
        'gateway.paymentId': gateway.paymentId,
      });
      if (existing) {
        logger.warn(`[billing] duplicate gateway payment ignored: ${gateway.paymentId}`);
        return this.getShopBilling(existing.shop);
      }
    }

    const shop = await this._loadShop(shopId);
    const now = new Date();
    const paidOn = receivedAt ? new Date(receivedAt) : now;
    // Only honour a backdate that is actually in the past. A future
    // `receivedAt` would otherwise push the period start forward and hand out
    // days nobody has paid for yet.
    const anchorAt = backdate && paidOn < now ? paidOn : null;
    const from = anchorAt || now;
    const periodStart = shop.subscription?.expiresAt > from ? shop.subscription.expiresAt : from;

    // Set before the extension so both land in the one save `_applyExtension`
    // performs — a second save here would be a second cache invalidation and a
    // window where the shop is extended but shows no payment date.
    shop.subscription.lastPaymentAt = paidOn;

    const { before, after, days, expiresAt } = await this._applyExtension(shop, {
      mode,
      value,
      now,
      anchorAt,
      becomesPaid: true,
    });

    const payment = await PlatformPayment.create({
      shop: shop._id,
      type: PLATFORM_PAYMENT_TYPES.SUBSCRIPTION,
      amount: paid,
      currency: shop.billing?.currency || 'BDT',
      method,
      transactionId,
      reference,
      receivedAt: paidOn,
      periodStart,
      periodEnd: expiresAt,
      months: mode === 'months' ? Number(value) : undefined,
      status: paid === 0 ? 'waived' : 'paid',
      source,
      recordedBy: { kind: actor?.kind || 'admin', id: actor?.id, name: actor?.name },
      gateway,
      notes: notes || note,
    });

    await this._recordEvent({
      shop,
      type: 'payment_recorded',
      actor,
      before,
      after,
      paid: true,
      amount: paid,
      payment,
      days,
      note: notes || note,
      audit: {
        action: 'subscription_payment',
        actionBn: 'সাবস্ক্রিপশন পেমেন্ট',
        description:
          `Recorded ৳${paid} from ${shop.name} via ${method}. ` +
          `Extended to ${toBangladeshDateStr(expiresAt)} (+${days} days).`,
        descriptionBn: `${shop.name} থেকে ৳${paid} গ্রহণ করা হয়েছে। মেয়াদ ${toBangladeshDateStr(expiresAt)} পর্যন্ত।`,
      },
    });

    return this.getShopBilling(shop._id);
  }

  /**
   * Book money that buys no time: a setup fee, a hardware charge, an
   * adjustment. Same ledger, no expiry movement.
   *
   * Kept separate from `applySubscriptionPayment` rather than bolted on as an
   * `extend: false` flag inside it, so that the funnel which moves expiry dates
   * has exactly one job and cannot be talked out of doing it.
   */
  async recordCharge(actor, { shopId, type = 'other', amount, method = 'cash', transactionId, reference, receivedAt, notes } = {}) {
    const paid = Number(amount);
    if (!Number.isFinite(paid)) {
      throw new AppError('Payment amount is not valid', 'পেমেন্টের পরিমাণ সঠিক নয়', 400);
    }
    if (!Object.values(PLATFORM_PAYMENT_TYPES).includes(type)) {
      throw new AppError(`Unknown payment type "${type}"`, 'পেমেন্টের ধরন সঠিক নয়', 400);
    }

    const shop = await this._loadShop(shopId);
    const payment = await PlatformPayment.create({
      shop: shop._id,
      type,
      amount: paid,
      currency: shop.billing?.currency || 'BDT',
      method,
      transactionId,
      reference,
      receivedAt: receivedAt ? new Date(receivedAt) : new Date(),
      status: paid === 0 ? 'waived' : 'paid',
      source: 'manual',
      recordedBy: { kind: actor?.kind || 'admin', id: actor?.id, name: actor?.name },
      notes,
    });

    await this._recordEvent({
      shop,
      type: 'payment_recorded',
      actor,
      paid: true,
      amount: paid,
      payment,
      note: notes,
      audit: {
        action: 'platform_charge',
        actionBn: 'প্ল্যাটফর্ম চার্জ',
        description: `Recorded ৳${paid} (${type}) from ${shop.name} via ${method}. No expiry change.`,
        descriptionBn: `${shop.name} থেকে ৳${paid} (${type}) গ্রহণ করা হয়েছে। মেয়াদ পরিবর্তন হয়নি।`,
      },
    });

    return this.getShopBilling(shop._id);
  }

  /**
   * Undo a payment with a reversal row. The original is never edited — the
   * ledger is append-only, so a mistake becomes two visible rows rather than
   * one silently corrected one.
   *
   * The expiry is deliberately NOT rolled back automatically: by the time a
   * payment is found to be wrong the shop has usually been trading on it, and
   * silently yanking access back is worse than an operator deciding what to do.
   * The reversal event says what the days were worth so they can decide.
   */
  async reversePayment(actor, paymentId, reason) {
    if (!reason) {
      throw new AppError('A reason is required to reverse a payment', 'পেমেন্ট বাতিল করতে কারণ লিখতে হবে', 400);
    }

    const original = await PlatformPayment.findById(paymentId);
    if (!original) {
      throw new AppError('Payment not found', 'পেমেন্ট পাওয়া যায়নি', 404);
    }
    if (original.reversalOf) {
      throw new AppError('This row is itself a reversal', 'এটি নিজেই একটি বাতিল এন্ট্রি', 400);
    }
    const already = await PlatformPayment.findOne({ reversalOf: original._id });
    if (already) {
      throw new AppError('This payment has already been reversed', 'এই পেমেন্ট আগেই বাতিল করা হয়েছে', 409);
    }

    const reversal = await PlatformPayment.create({
      shop: original.shop,
      type: original.type,
      amount: -Math.abs(original.amount),
      currency: original.currency,
      method: original.method,
      receivedAt: new Date(),
      status: 'refunded',
      source: 'manual',
      recordedBy: { kind: actor?.kind || 'admin', id: actor?.id, name: actor?.name },
      reversalOf: original._id,
      notes: reason,
    });

    const shop = await Shop.findById(original.shop);
    if (shop) {
      await this._recordEvent({
        shop,
        type: 'payment_reversed',
        actor,
        paid: false,
        amount: -Math.abs(original.amount),
        payment: reversal,
        reason,
        audit: {
          action: 'subscription_payment_reversed',
          actionBn: 'পেমেন্ট বাতিল',
          description: `Reversed ৳${original.amount} for ${shop.name}. Reason: ${reason}`,
          descriptionBn: `${shop.name} এর ৳${original.amount} পেমেন্ট বাতিল করা হয়েছে। কারণ: ${reason}`,
        },
      });
    }

    return reversal;
  }

  // ── access (block / unblock) ────────────────────────────────────────────

  /**
   * Block or unblock a shop, effective on its very next request.
   *
   * A block is total: no login, no read, no write, owner and staff alike.
   * There is no read-only block mode — the expired state already provides
   * softer treatment, and one switch with one meaning is what keeps an
   * operator from having to remember which kind of block a shop is under.
   *
   * Unblock also clears the two legacy switches (`isActive: false`,
   * `status: 'suspended'`), so a shop switched off by the old code path is
   * recoverable through this one endpoint. Invariants §8.1–§8.3: only this
   * method may ever block, and unblocking is never gated on payment.
   */
  async setAccess(actor, shopId, { action, reason } = {}) {
    if (!['block', 'unblock'].includes(action)) {
      throw new AppError('Action must be block or unblock', 'সঠিক অ্যাকশন নির্বাচন করুন', 400);
    }
    if (action === 'block' && !reason) {
      throw new AppError('A reason is required to block a shop', 'দোকান বন্ধ করতে কারণ লিখতে হবে', 400);
    }

    const shop = await this._loadShop(shopId);
    const now = new Date();
    const before = {
      expiresAt: shop.subscription?.expiresAt || null,
      plan: shop.subscription?.plan,
      state: resolveSubscription(shop, now).state,
    };

    if (action === 'block') {
      shop.set('access.blockedAt', now);
      shop.set('access.blockedBy', actor?.id);
      shop.set('access.blockReason', reason);
    } else {
      shop.set('access.blockedAt', null);
      shop.set('access.blockReason', undefined);
      shop.set('access.unblockedAt', now);
      shop.set('access.unblockedBy', actor?.id);
      // Legacy switches, cleared together so there is exactly one way back in.
      shop.isActive = true;
      if (shop.subscription?.status === 'suspended') {
        shop.subscription.status = 'active';
      }
    }

    await shop.save();
    await invalidateShopAuthCache(shop._id);

    const after = {
      expiresAt: shop.subscription?.expiresAt || null,
      plan: shop.subscription?.plan,
      state: resolveSubscription(shop, now).state,
    };

    await this._recordEvent({
      shop,
      type: action === 'block' ? 'blocked' : 'unblocked',
      actor,
      before,
      after,
      reason,
      audit: {
        action: action === 'block' ? 'shop_blocked' : 'shop_unblocked',
        actionBn: action === 'block' ? 'দোকান বন্ধ' : 'দোকান চালু',
        description:
          action === 'block'
            ? `Blocked all access to ${shop.name}. Reason: ${reason}`
            : `Restored access to ${shop.name}.${reason ? ` Reason: ${reason}` : ''}`,
        descriptionBn:
          action === 'block'
            ? `${shop.name} এর অ্যাক্সেস বন্ধ করা হয়েছে। কারণ: ${reason}`
            : `${shop.name} এর অ্যাক্সেস আবার চালু করা হয়েছে`,
      },
    });

    return this.getShopBilling(shop._id);
  }

  // ── negotiated pricing ──────────────────────────────────────────────────

  /**
   * The agreed numbers for one shop: ৳/month, ৳/SMS, usual cycle, grace days.
   *
   * Every shop bargains its own, so this is the figure both the owner's billing
   * card and the admin's payment form read. A change is an audited event —
   * "why is this shop on ৳800?" has to stay answerable.
   */
  async updateBillingProfile(actor, shopId, patch = {}) {
    const shop = await this._loadShop(shopId);
    const before = {
      monthlyPrice: shop.billing?.monthlyPrice,
      smsUnitPrice: shop.billing?.smsUnitPrice,
      cycleMonths: shop.billing?.cycleMonths,
      graceDays: shop.subscription?.graceDays,
    };

    const numeric = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
    const monthlyPrice = numeric(patch.monthlyPrice);
    const smsUnitPrice = numeric(patch.smsUnitPrice);
    const cycleMonths = numeric(patch.cycleMonths);
    const graceDays = numeric(patch.graceDays);

    for (const [label, val] of [
      ['monthlyPrice', monthlyPrice],
      ['smsUnitPrice', smsUnitPrice],
      ['cycleMonths', cycleMonths],
      ['graceDays', graceDays],
    ]) {
      if (val !== undefined && (!Number.isFinite(val) || val < 0)) {
        throw new AppError(`${label} must be a non-negative number`, 'মান সঠিক নয়', 400);
      }
    }

    if (monthlyPrice !== undefined) shop.billing.monthlyPrice = monthlyPrice;
    if (smsUnitPrice !== undefined) shop.billing.smsUnitPrice = smsUnitPrice;
    if (cycleMonths !== undefined) shop.billing.cycleMonths = Math.max(1, Math.round(cycleMonths));
    if (patch.notes !== undefined) shop.billing.notes = patch.notes;
    if (patch.billingContact) shop.billing.billingContact = patch.billingContact;
    // Grace lives on `subscription` because it modifies expiry behaviour, but
    // it is negotiated alongside price, so it is set from the same form.
    if (graceDays !== undefined) shop.subscription.graceDays = Math.round(graceDays);

    await shop.save();
    await invalidateShopAuthCache(shop._id);

    const after = {
      monthlyPrice: shop.billing.monthlyPrice,
      smsUnitPrice: shop.billing.smsUnitPrice,
      cycleMonths: shop.billing.cycleMonths,
      graceDays: shop.subscription.graceDays,
    };

    const graceChanged = before.graceDays !== after.graceDays;
    await this._recordEvent({
      shop,
      type: graceChanged && before.monthlyPrice === after.monthlyPrice ? 'grace_changed' : 'price_changed',
      actor,
      before,
      after,
      reason: patch.reason,
      audit: {
        action: 'billing_profile_update',
        actionBn: 'বিলিং তথ্য পরিবর্তন',
        description:
          `Updated billing for ${shop.name}: ৳${after.monthlyPrice}/month, ` +
          `৳${after.smsUnitPrice}/SMS, ${after.graceDays} grace day(s).` +
          `${patch.reason ? ` Reason: ${patch.reason}` : ''}`,
        descriptionBn: `${shop.name} এর বিলিং তথ্য পরিবর্তন করা হয়েছে`,
      },
    });

    return this.getShopBilling(shop._id);
  }

  // ── SMS purchases ───────────────────────────────────────────────────────

  /**
   * Allocate SMS credits and record what was paid for them.
   *
   * The shop's standing rate (`billing.smsUnitPrice`) only PREFILLS the amount.
   * What gets stored is the rate actually charged on this purchase, frozen onto
   * both the allocation and the ledger row, so a renegotiation next month does
   * not rewrite what last month cost.
   *
   * SMS credits are bought separately from the subscription and are never
   * touched by expiry or block — sending stops, the balance does not.
   */
  async recordSmsPurchase(actor, { shopId, quantity, amount, unitPrice, method = 'cash', transactionId, notes } = {}) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new AppError('SMS quantity must be a positive number', 'এসএমএস সংখ্যা সঠিক নয়', 400);
    }

    const shop = await this._loadShop(shopId);
    const standingRate = Number(shop.billing?.smsUnitPrice) || 0;

    // Whichever of the two the operator supplied wins; the other is derived, so
    // the stored pair is always internally consistent.
    const effectiveUnit = Number.isFinite(Number(unitPrice))
      ? Number(unitPrice)
      : Number.isFinite(Number(amount)) && qty > 0
        ? Number(amount) / qty
        : standingRate;
    const total = Number.isFinite(Number(amount)) ? Number(amount) : Number((effectiveUnit * qty).toFixed(2));

    if (total < 0) {
      throw new AppError('SMS amount cannot be negative', 'এসএমএস মূল্য ঋণাত্মক হতে পারবে না', 400);
    }

    const quota = await SMSQuota.getOrCreate(shop._id);
    await quota.addAllocation({
      quantity: qty,
      price: total,
      allocatedBy: actor?.id,
      paymentMethod: method,
      transactionId,
      notes,
    });

    const payment = await PlatformPayment.create({
      shop: shop._id,
      type: PLATFORM_PAYMENT_TYPES.SMS,
      amount: total,
      currency: shop.billing?.currency || 'BDT',
      method,
      transactionId,
      receivedAt: new Date(),
      smsQuantity: qty,
      smsUnitPrice: effectiveUnit,
      status: total === 0 ? 'waived' : 'paid',
      source: 'manual',
      recordedBy: { kind: actor?.kind || 'admin', id: actor?.id, name: actor?.name },
      notes,
    });

    await this._recordEvent({
      shop,
      type: 'sms_allocated',
      actor,
      paid: total > 0,
      amount: total,
      payment,
      note: notes,
      audit: {
        action: 'sms_allocation',
        actionBn: 'এসএমএস বরাদ্দ',
        description: `Allocated ${qty} SMS to ${shop.name} for ৳${total} (৳${effectiveUnit}/SMS)`,
        descriptionBn: `${shop.name} কে ${qty}টি এসএমএস দেওয়া হয়েছে (৳${total})`,
      },
    });

    return { quota, payment };
  }

  // ── reads ───────────────────────────────────────────────────────────────

  /** Everything the shop's Billing tab needs, in one call. */
  async getShopBilling(shopId) {
    const shop = await Shop.findById(shopId).populate('owner', 'name phone');
    if (!shop) {
      throw new AppError('Shop not found', 'দোকান পাওয়া যায়নি', 404);
    }

    const [quota, payments, events] = await Promise.all([
      SMSQuota.findOne({ shop: shop._id }).lean(),
      PlatformPayment.find({ shop: shop._id }).sort({ receivedAt: -1 }).limit(50).lean(),
      SubscriptionEvent.find({ shop: shop._id }).sort({ at: -1 }).limit(50).lean(),
    ]);

    const resolved = resolveSubscription(shop);
    const lifetimeValue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);

    return {
      shop: {
        _id: shop._id,
        name: shop.name,
        phone: shop.phone,
        owner: shop.owner,
        multiBranchEnabled: shop.multiBranchEnabled,
      },
      subscription: resolved,
      billing: shop.billing,
      access: shop.access,
      smsQuota: quota
        ? {
          total: quota.totalQuota,
          used: quota.usedQuota,
          remaining: quota.remainingQuota,
          isEnabled: quota.isEnabled,
          unitPrice: shop.billing?.smsUnitPrice,
        }
        : null,
      payments,
      events,
      lifetimeValue,
    };
  }

  /** Platform-wide payment history. */
  async listPayments(options = {}) {
    const { page = 1, limit = 20, shopId, type, method, status, from, to } = options;

    const query = {};
    if (shopId) query.shop = shopId;
    if (type) query.type = type;
    if (method) query.method = method;
    if (status) query.status = status;
    if (from || to) {
      query.receivedAt = {};
      if (from) query.receivedAt.$gte = new Date(from);
      if (to) query.receivedAt.$lte = new Date(to);
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [data, total] = await Promise.all([
      PlatformPayment.find(query)
        // The owner rides along because the payments table shows who to call
        // about a row, and a payment without a person attached is a dead end.
        .populate({ path: 'shop', select: 'name phone', populate: { path: 'owner', select: 'name phone' } })
        .sort({ receivedAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      PlatformPayment.countDocuments(query),
    ]);

    return {
      data,
      pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / limit) },
    };
  }

  /**
   * The operator's daily worklist — who to call today.
   *
   * With no outbound reminders (decision §11.5) this list IS the collection
   * process, so it is filtered and sorted server-side rather than left to the
   * client: "expiring" must mean the same thing here as it does in the banner
   * the owner is looking at.
   */
  async getWorklist(options = {}) {
    const { state = 'expiring', days, page = 1, limit = 50, search } = options;
    const now = new Date();
    const warningDays = Number.isFinite(Number(days)) ? Number(days) : 3;

    const query = {};
    const horizon = addBangladeshDays(now, warningDays);
    // A blocked shop is already on the Blocked tab; listing it under "expiring"
    // too would send the operator to call someone they deliberately switched
    // off. Both legacy switches count as blocked here, same as in the resolver.
    const notBlocked = { 'access.blockedAt': null, isActive: { $ne: false } };

    switch (state) {
      case 'blocked':
        // Blocked shops must always be findable, including the legacy switches,
        // or a shop can be locked out with no route back in (invariant §8.3).
        query.$or = [
          { 'access.blockedAt': { $ne: null } },
          { isActive: false },
          { 'subscription.status': 'suspended' },
        ];
        break;
      case 'expired':
        Object.assign(query, notBlocked);
        query['subscription.expiresAt'] = { $lt: now };
        break;
      case 'trial':
        Object.assign(query, notBlocked);
        query['subscription.plan'] = 'trial';
        query['subscription.expiresAt'] = { $gte: now, $lte: horizon };
        break;
      case 'all':
        break;
      case 'expiring':
      default:
        Object.assign(query, notBlocked);
        query['subscription.expiresAt'] = { $gte: now, $lte: horizon };
        break;
    }

    if (search) {
      const rx = new RegExp(String(search).trim(), 'i');
      query.$and = [...(query.$and || []), { $or: [{ name: rx }, { phone: rx }] }];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [shops, total] = await Promise.all([
      Shop.find(query)
        .populate('owner', 'name phone')
        .sort({ 'subscription.expiresAt': 1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Shop.countDocuments(query),
    ]);

    const shopIds = shops.map((s) => s._id);
    // One grouped query, not one per shop: this list is read many times a day.
    const [lastPayments, quotas] = await Promise.all([
      PlatformPayment.aggregate([
        { $match: { shop: { $in: shopIds } } },
        { $sort: { receivedAt: -1 } },
        { $group: { _id: '$shop', lastAt: { $first: '$receivedAt' }, lifetime: { $sum: '$amount' } } },
      ]),
      SMSQuota.find({ shop: { $in: shopIds } }).select('shop remainingQuota').lean(),
    ]);
    const payMap = new Map(lastPayments.map((p) => [String(p._id), p]));
    const quotaMap = new Map(quotas.map((q) => [String(q.shop), q.remainingQuota]));

    const data = shops.map((shop) => {
      const resolved = resolveSubscription(shop, now);
      const pay = payMap.get(String(shop._id));
      return {
        _id: shop._id,
        name: shop.name,
        phone: shop.phone,
        owner: shop.owner,
        plan: resolved.plan,
        state: resolved.state,
        severity: resolved.severity,
        expiresAt: resolved.expiresAt,
        daysRemaining: resolved.daysRemaining,
        monthlyPrice: shop.billing?.monthlyPrice ?? shop.subscription?.monthlyPrice ?? 0,
        smsRemaining: quotaMap.get(String(shop._id)) || 0,
        lastPaymentAt: pay?.lastAt || null,
        lifetimeValue: pay?.lifetime || 0,
        blockReason: shop.access?.blockReason || null,
      };
    });

    return {
      data,
      pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / limit) },
    };
  }

  /** Counts for the worklist tabs — one round trip, not five. */
  async getWorklistCounts(days = 3) {
    const now = new Date();
    const horizon = addBangladeshDays(now, days);
    const notBlocked = { 'access.blockedAt': null, isActive: { $ne: false } };

    const [expiring, expired, blocked, trials] = await Promise.all([
      Shop.countDocuments({ ...notBlocked, 'subscription.expiresAt': { $gte: now, $lte: horizon } }),
      Shop.countDocuments({ ...notBlocked, 'subscription.expiresAt': { $lt: now } }),
      Shop.countDocuments({
        $or: [
          { 'access.blockedAt': { $ne: null } },
          { isActive: false },
          { 'subscription.status': 'suspended' },
        ],
      }),
      Shop.countDocuments({
        ...notBlocked,
        'subscription.plan': 'trial',
        'subscription.expiresAt': { $gte: now, $lte: horizon },
      }),
    ]);

    return { expiring, expired, blocked, trials };
  }

  /**
   * Headline billing numbers.
   *
   * MRR is the sum of the NEGOTIATED monthly price of shops that can currently
   * write — not a flat rate × shop count. Since every shop bargains its own
   * price, a flat-rate figure would be fiction.
   */
  async getSummary() {
    const now = new Date();
    // "This month" is a Bangladesh calendar month. A UTC month boundary would
    // put payments taken on the 1st before 6am into last month's total.
    const monthStart = getBangladeshDayRange(`${getBangladeshTodayStr().slice(0, 7)}-01`).startOfDay;

    const [activeShops, collected, overdue] = await Promise.all([
      Shop.find({
        'access.blockedAt': null,
        isActive: { $ne: false },
        $or: [
          { 'subscription.expiresAt': { $gte: now } },
          { 'subscription.expiresAt': null },
          { 'subscription.expiresAt': { $exists: false } },
        ],
      })
        .select('billing.monthlyPrice subscription.plan subscription.monthlyPrice')
        .lean(),
      PlatformPayment.aggregate([
        { $match: { receivedAt: { $gte: monthStart } } },
        { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Shop.aggregate([
        {
          $match: {
            'access.blockedAt': null,
            isActive: { $ne: false },
            'subscription.expiresAt': { $lt: now },
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            amount: { $sum: { $ifNull: ['$billing.monthlyPrice', 0] } },
          },
        },
      ]),
    ]);

    const paidShops = activeShops.filter((s) => s.subscription?.plan !== 'trial');
    const mrr = paidShops.reduce(
      (sum, s) => sum + (s.billing?.monthlyPrice ?? s.subscription?.monthlyPrice ?? 0),
      0
    );

    const byType = Object.fromEntries(collected.map((c) => [c._id, { total: c.total, count: c.count }]));

    return {
      mrr,
      activeShops: activeShops.length,
      trialShops: activeShops.length - paidShops.length,
      collectedThisMonth: collected.reduce((s, c) => s + c.total, 0),
      subscriptionRevenueThisMonth: byType.subscription?.total || 0,
      smsRevenueThisMonth: byType.sms?.total || 0,
      overdueShops: overdue[0]?.count || 0,
      overdueAmount: overdue[0]?.amount || 0,
      arpu: paidShops.length ? Math.round(mrr / paidShops.length) : 0,
    };
  }
}

const billingService = new BillingService();

module.exports = billingService;
// Exported for the month-arithmetic tests; not part of the service contract.
module.exports.addBangladeshMonths = addBangladeshMonths;
