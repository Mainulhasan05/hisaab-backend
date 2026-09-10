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

/**
 * Add whole months and land on the shop's billing day.
 *
 * The difference from `addBangladeshMonths` is which day survives. That
 * function carries the ANCHOR's day forward, so a clamp is permanent:
 *
 *     31 Jan +1mo -> 28 Feb   (correct for February)
 *     28 Feb +1mo -> 28 Mar   (wrong — the 31st is now gone for good)
 *
 * This one carries the shop's STORED day forward and re-clamps it fresh each
 * time, so the day comes back the moment the month is long enough again:
 *
 *     billingDay 31
 *     31 Jan +1mo -> 28 Feb
 *     28 Feb +1mo -> 31 Mar   (the anchor is 31, not 28)
 *
 * `billingDay` is never rewritten by this — a 31 stays a 31 through every
 * February. That is the entire mechanism; everything else about the feature is
 * plumbing to get the right day in here.
 *
 * ── The transition case, stated rather than hidden ──────────────────────────
 *
 * Aligning a shop whose expiry is NOT yet on its billing day can hand it fewer
 * days than a plain calendar month. A shop paid through 20 March with a billing
 * day of 5 buying one month lands on 5 April: sixteen days for a month's money.
 *
 * This is a one-time transition — once the expiry sits on the billing day every
 * later renewal is a clean month — but it is real, so it is never applied
 * silently. `computeExpiry` returns `naiveExpiresAt` and `shortened` beside the
 * result, the admin sheet previews both before anything is saved, and
 * `cycleAlignment: 'from_anchor'` turns alignment off for a shop or for one
 * extension. `_applyExtension` additionally refuses any alignment that would
 * not advance past the current expiry, so paid time can never be taken back.
 *
 * @param {Date|string} from        the anchor to count months from
 * @param {number} months
 * @param {number} billingDay       1–31
 * @returns {Date|null} end of the resulting Bangladesh day
 */
function alignToBillingDay(from, months, billingDay) {
  // `new Date(null)` is the epoch, not an invalid date, so `toBangladeshDateStr`
  // answers "1970-01-01" for a missing anchor rather than null. Without this
  // line a null anchor would quietly produce a 1970 expiry — a lockout wearing
  // an arithmetic bug's clothes. Checked here rather than relying on the
  // falsy-string guard below, which never fires for that input.
  if (from === null || from === undefined || from === '') return null;

  const dateStr = toBangladeshDateStr(from);
  if (!dateStr) return null;

  const day = Math.round(Number(billingDay));
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;

  const [y, m] = dateStr.split('-').map(Number);
  const targetMonthIndex = m - 1 + months;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  // Day 0 of the following month is the last day of this one. Clamped for THIS
  // month only; the stored `billingDay` is untouched.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const landedDay = Math.min(day, lastDay);
  const iso = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(landedDay).padStart(2, '0')}`;
  return endOfBangladeshDay(iso);
}

/**
 * A billing day, or null.
 *
 * Null-safe and range-checked in ONE place so no caller has to decide what a
 * `0`, a `"5"` or a `99` means. Anything outside 1–31 is treated as "no
 * anchor", which degrades to the pre-existing plain-calendar-month behaviour
 * rather than to an exception — the failure mode for a bad anchor must be a
 * slightly different renewal date, never a request that throws.
 */
function normalizeBillingDay(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const day = Math.round(Number(raw));
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  return day;
}

/** The billing day this shop is anchored to, or null. */
function billingDayOf(shop) {
  return normalizeBillingDay(shop?.billing?.billingDay);
}

/**
 * Where "now" moves to for a backdated payment, or null for no backdating.
 *
 * Only a `receivedAt` that is actually in the PAST is honoured. A future one
 * would push the period start forward and hand out days nobody has paid for
 * yet, which is a typo in a date field turning into free access.
 *
 * Shared by the payment funnel and the preview so the date the operator is
 * shown is computed by the same rule as the date that gets written. A preview
 * that anchored differently from the write would be worse than no preview.
 */
function resolveAnchorAt({ backdate, receivedAt, now }) {
  if (!backdate) return null;
  const paidOn = receivedAt ? new Date(receivedAt) : now;
  if (Number.isNaN(paidOn.getTime())) return null;
  return paidOn < now ? paidOn : null;
}

/**
 * Does this shop want month-mode extensions snapped to its billing day?
 *
 * Defaults to yes on an absent value, matching the schema default, so a shop
 * document written before this field existed aligns once it has a billing day.
 * That is safe because a shop written before this field existed also has no
 * billing day, and alignment is inert without one.
 */
function alignmentOf(shop) {
  return shop?.billing?.cycleAlignment === 'from_anchor' ? 'from_anchor' : 'billing_day';
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
   * ── The billing day ─────────────────────────────────────────────────────
   *
   * `billingDay` only ever affects MONTH mode, and only when `alignment` is
   * 'billing_day'. Days-mode and until-mode ignore it entirely: an explicitly
   * typed date or day count is the operator saying exactly what they want, and
   * an anchor that quietly moved it somewhere else would be the bug this whole
   * feature exists to prevent, pointed the other way.
   *
   * `naiveExpiresAt` is what the un-aligned arithmetic would have produced, and
   * `shortened` says whether alignment cost the shop days against it. Both are
   * returned rather than logged so the admin sheet can show the operator the
   * trade before they commit to it.
   *
   * @returns {{
   *   expiresAt: Date, anchor: Date, days: number|null,
   *   naiveExpiresAt: Date, aligned: boolean, shortened: boolean,
   *   billingDay: number|null,
   * }}
   */
  computeExpiry({
    currentExpiresAt,
    mode,
    value,
    now = new Date(),
    anchorAt = null,
    billingDay = null,
    alignment = 'billing_day',
  }) {
    if (mode === 'until') {
      const expiresAt = endOfBangladeshDay(value);
      if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
        throw new AppError('Invalid expiry date', 'অবৈধ তারিখ দেওয়া হয়েছে', 400);
      }
      return {
        expiresAt,
        anchor: currentExpiresAt || now,
        days: bangladeshDaysBetween(currentExpiresAt || now, expiresAt),
        naiveExpiresAt: expiresAt,
        aligned: false,
        shortened: false,
        billingDay: null,
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
      return {
        expiresAt,
        anchor,
        days: bangladeshDaysBetween(currentExpiresAt, expiresAt),
        naiveExpiresAt: expiresAt,
        aligned: false,
        shortened: false,
        billingDay: null,
      };
    }

    if (mode === 'months') {
      if (amount > MAX_EXTEND_MONTHS) {
        throw new AppError(
          `Cannot extend by more than ${MAX_EXTEND_MONTHS} months at once. Use an explicit end date instead.`,
          `একবারে ${MAX_EXTEND_MONTHS} মাসের বেশি বাড়ানো যাবে না। সরাসরি তারিখ নির্বাচন করুন।`,
          400
        );
      }

      // What the arithmetic did before this feature existed. Still computed
      // even when aligning, because it is the baseline the operator is shown
      // and the only way `shortened` can mean anything.
      const naiveExpiresAt = addBangladeshMonths(anchor, amount);

      const day = alignment === 'from_anchor' ? null : normalizeBillingDay(billingDay);
      // Whole months only. A fractional "1.5 months" has no billing day to land
      // on, so it falls through to the plain arithmetic rather than silently
      // rounding someone's period.
      const alignable = day !== null && Number.isInteger(amount);
      const alignedExpiresAt = alignable ? alignToBillingDay(anchor, amount, day) : null;

      // A null back from the aligner means it could not produce a date. Fall
      // back to the plain month rather than throwing: a bad anchor must cost a
      // shop the alignment, never the renewal.
      const expiresAt = alignedExpiresAt || naiveExpiresAt;

      return {
        expiresAt,
        anchor,
        days: bangladeshDaysBetween(currentExpiresAt, expiresAt),
        naiveExpiresAt,
        aligned: !!alignedExpiresAt,
        shortened: !!alignedExpiresAt && alignedExpiresAt < naiveExpiresAt,
        billingDay: alignedExpiresAt ? day : null,
      };
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
   *
   * `alignment` overrides the shop's stored preference for THIS extension only.
   * It is never written back — a one-off "don't snap this one" must not quietly
   * change what the shop's next renewal does.
   */
  async _applyExtension(shop, {
    mode, value, now = new Date(), anchorAt = null, becomesPaid, alignment = null,
  }) {
    const before = {
      expiresAt: shop.subscription?.expiresAt || null,
      plan: shop.subscription?.plan,
      state: resolveSubscription(shop, now).state,
      billingDay: billingDayOf(shop),
    };

    const currentExpiresAt = shop.subscription?.expiresAt || null;

    const computed = this.computeExpiry({
      currentExpiresAt,
      mode,
      value,
      now,
      anchorAt,
      billingDay: before.billingDay,
      alignment: alignment || alignmentOf(shop),
    });

    let { expiresAt, days } = computed;

    /**
     * Alignment may never take back paid time. A BACKSTOP, not a live branch.
     *
     * As the arithmetic currently stands this cannot fire, and the reason is
     * worth writing down because it is the thing that makes the feature safe:
     * the anchor is `max(currentExpiresAt, from)`, months are whole and at
     * least one, and day 1 of any month is later than every day of the month
     * before it. So an aligned date always lands in a strictly later month than
     * the anchor, and is therefore always past the current expiry. The
     * invariant holds structurally, not because of this check.
     *
     * It stays because the anchor rule is the kind of thing that gets revised —
     * a proration feature, a half-month package, a different backdating rule —
     * and the failure it would introduce is silent: a renewal that quietly
     * shortens a subscription looks exactly like a renewal. If that day comes,
     * the shop gets its plain calendar month and the log says why, rather than
     * losing days nobody meant to take. `billingDay.test.js` asserts the
     * property directly, so a change that breaks it fails there first.
     *
     * Deliberately here and not in `computeExpiry`, which is pure and is also
     * what the preview calls: the preview must be able to SHOW an alignment
     * that would shorten against a plain month, which is a real and common
     * case (see `alignToBillingDay`) and a different thing from this one.
     */
    if (computed.aligned && currentExpiresAt && expiresAt <= currentExpiresAt) {
      logger.warn(
        `[billing] billing-day alignment for shop ${shop._id} would not advance past ` +
        `${toBangladeshDateStr(currentExpiresAt)}; falling back to a plain month.`
      );
      expiresAt = computed.naiveExpiresAt;
      days = bangladeshDaysBetween(currentExpiresAt, expiresAt);
    }

    shop.subscription.expiresAt = expiresAt;
    // `status` is a denormalised label the resolver ignores, kept current so
    // the existing admin list filters keep working.
    shop.subscription.status = 'active';
    if (becomesPaid) {
      shop.subscription.plan = 'paid';
      if (before.plan === 'trial') shop.subscription.trialEndedAt = now;
    }

    /**
     * The feature installs itself on the first PAID month-mode renewal.
     *
     * No migration guesses a billing day on anyone's behalf, and no operator
     * has to set one before the system starts holding a date steady — the day
     * the shop actually renewed on becomes the day it is billed on.
     *
     * Three conditions, each load-bearing:
     *   · `becomesPaid` — a trial ends on a day count, and treating that as a
     *     billing anniversary anchors the shop to a date that meant nothing to
     *     it. Free extensions are excluded for the same reason.
     *   · month mode — a days-mode or until-mode extension is the operator
     *     naming a date, not establishing a cycle.
     *   · no day already — this stamps once and never overwrites. A stored day
     *     is either an operator's decision or the shop's own history, and a
     *     renewal is not the place to revise either.
     */
    if (becomesPaid && mode === 'months' && before.billingDay === null) {
      const stamped = normalizeBillingDay(Number(toBangladeshDateStr(expiresAt)?.split('-')[2]));
      if (stamped !== null) {
        shop.billing = shop.billing || {};
        shop.billing.billingDay = stamped;
        shop.billing.billingDaySetAt = now;
      }
    }

    await shop.save();
    await invalidateShopAuthCache(shop._id);

    const after = {
      expiresAt,
      plan: shop.subscription.plan,
      state: resolveSubscription(shop, now).state,
      billingDay: billingDayOf(shop),
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
   * Where an extension WOULD land. Reads only; writes nothing.
   *
   * This exists so the billing day can never surprise anyone. Alignment can
   * hand a not-yet-aligned shop a short first period (see
   * `alignToBillingDay`), and the difference between that being a decision and
   * being a discovery is entirely whether the operator saw the date before
   * they saved. The admin extend sheet calls this as the form is filled in.
   *
   * It is a thin wrapper over `computeExpiry` on purpose: a preview that
   * computed the date a second way would eventually disagree with the thing it
   * is previewing, which is the failure this whole subsystem is written to
   * avoid.
   *
   * `shortened` here reports what the arithmetic did. `_applyExtension` will
   * additionally decline an alignment that fails to advance past the current
   * expiry, so a preview can legitimately show an alignment that the write
   * then falls back from — `willAlign` is the honest answer and is computed
   * with the same rule the writer uses.
   */
  async previewExtension(shopId, {
    mode, value, alignment = null, backdate = false, receivedAt = null,
  } = {}) {
    const shop = await this._loadShop(shopId);
    const now = new Date();
    const currentExpiresAt = shop.subscription?.expiresAt || null;
    const anchorAt = resolveAnchorAt({ backdate, receivedAt, now });

    const computed = this.computeExpiry({
      currentExpiresAt,
      mode,
      value,
      now,
      anchorAt,
      billingDay: billingDayOf(shop),
      alignment: alignment || alignmentOf(shop),
    });

    const willAlign =
      computed.aligned && (!currentExpiresAt || computed.expiresAt > currentExpiresAt);
    const expiresAt = willAlign ? computed.expiresAt : computed.naiveExpiresAt;

    return {
      expiresAt,
      expiresOn: toBangladeshDateStr(expiresAt),
      naiveExpiresAt: computed.naiveExpiresAt,
      naiveExpiresOn: toBangladeshDateStr(computed.naiveExpiresAt),
      days: bangladeshDaysBetween(currentExpiresAt || now, expiresAt),
      currentExpiresAt,
      currentExpiresOn: currentExpiresAt ? toBangladeshDateStr(currentExpiresAt) : null,
      billingDay: billingDayOf(shop),
      alignment: alignment || alignmentOf(shop),
      backdatedTo: anchorAt,
      aligned: willAlign,
      // True only when alignment is actually being applied AND costs days
      // against the plain month. A fallback is not a shortening.
      shortened: willAlign && computed.shortened,
    };
  }

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
   * @param {'billing_day'|'from_anchor'} [opts.alignment] override the shop's billing-day
   *        preference for this extension only
   */
  async extendSubscription(actor, shopId, { mode, value, payment = null, reason, note, alignment = null } = {}) {
    const shop = await this._loadShop(shopId);
    const now = new Date();

    // Preview the landing point before writing anything, so both guards below
    // can refuse without having half-applied the change. Reads the same billing
    // day and alignment `_applyExtension` will, or the guards would be judging
    // a date that is not the one about to be written.
    const preview = this.computeExpiry({
      currentExpiresAt: shop.subscription?.expiresAt || null,
      mode,
      value,
      now,
      billingDay: billingDayOf(shop),
      alignment: alignment || alignmentOf(shop),
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
        alignment,
        source: 'manual',
        ...payment,
      });
    }

    const { before, after, days, expiresAt } = await this._applyExtension(shop, {
      mode,
      value,
      now,
      alignment,
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
    // One-off override of the shop's billing-day preference. The gateway path
    // never sends it — a self-serve renewal always follows the shop's standing
    // setting, because there is no operator on that path to judge the trade.
    alignment = null,
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
    const anchorAt = resolveAnchorAt({ backdate, receivedAt, now });
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
      alignment,
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
   * Correct a payment that happened but was keyed in wrong.
   *
   * The case this exists for: the money arrived on the 3rd, it was entered with
   * today's date, and now the month's revenue is wrong. That is one mistake
   * about one real payment — reversing and re-entering would leave three rows
   * (+৳800, −৳800, +৳800) in a shop's history to describe a mistyped date.
   *
   * Only the fields below may change. `amount` and `shop` are deliberately not
   * among them: anything that moves money between shops or changes how much was
   * taken is a reversal, so the ledger's totals can never be quietly rewritten.
   * Every correction is stamped with who, when, and the previous values.
   *
   * The subscription expiry is NOT recomputed. The days were granted when the
   * payment was recorded and the shop has been trading on them; correcting the
   * paperwork must not silently move the date they stop working. Adjust it
   * explicitly with an extension if it is genuinely wrong.
   */
  async amendPayment(actor, paymentId, patch = {}) {
    const AMENDABLE = ['receivedAt', 'transactionId', 'reference', 'method', 'notes'];

    const payment = await PlatformPayment.findById(paymentId);
    if (!payment) {
      throw new AppError('Payment not found', 'পেমেন্ট পাওয়া যায়নি', 404);
    }
    if (payment.reversalOf) {
      throw new AppError(
        'A reversal row cannot be edited',
        'বাতিল এন্ট্রি সম্পাদনা করা যায় না',
        400
      );
    }

    const before = {};
    const after = {};
    for (const field of AMENDABLE) {
      if (patch[field] === undefined) continue;
      const next = field === 'receivedAt' ? new Date(patch[field]) : patch[field];
      if (field === 'receivedAt' && Number.isNaN(next.getTime())) {
        throw new AppError('Received date is not valid', 'তারিখ সঠিক নয়', 400);
      }
      // A received date in the future would date revenue to a month that has
      // not happened yet.
      if (field === 'receivedAt' && next > new Date()) {
        throw new AppError(
          'The received date cannot be in the future',
          'টাকা পাওয়ার তারিখ ভবিষ্যতে হতে পারে না',
          400
        );
      }
      if (String(payment[field] ?? '') === String(next ?? '')) continue;
      before[field] = payment[field];
      after[field] = next;
      payment[field] = next;
    }

    if (!Object.keys(after).length) {
      throw new AppError('Nothing to change', 'পরিবর্তন করার কিছু নেই', 400);
    }

    payment.amendments.push({
      at: new Date(),
      by: { kind: actor?.kind || 'admin', id: actor?.id, name: actor?.name },
      before,
      after,
      reason: patch.reason,
    });
    await payment.save();

    const shop = await Shop.findById(payment.shop);
    if (shop) {
      // `lastPaymentAt` mirrors the newest payment's date, so a corrected date
      // has to be mirrored too or the shop's billing card keeps the wrong one.
      if (after.receivedAt) {
        const newest = await PlatformPayment.findOne({
          shop: shop._id,
          type: PLATFORM_PAYMENT_TYPES.SUBSCRIPTION,
          reversalOf: null,
        }).sort({ receivedAt: -1 }).lean();
        if (newest) {
          shop.subscription.lastPaymentAt = newest.receivedAt;
          await shop.save();
          await invalidateShopAuthCache(shop._id);
        }
      }

      await this._recordEvent({
        shop,
        type: 'payment_amended',
        actor,
        payment,
        amount: payment.amount,
        reason: patch.reason,
        note: Object.keys(after).join(', '),
        audit: {
          action: 'platform_payment_amended',
          actionBn: 'পেমেন্ট সংশোধন',
          description:
            `Corrected ${Object.keys(after).join(', ')} on a ৳${payment.amount} payment for ` +
            `${shop.name}.` +
            (after.receivedAt
              ? ` Received date ${toBangladeshDateStr(before.receivedAt)} → ` +
                `${toBangladeshDateStr(after.receivedAt)}.`
              : '') +
            (patch.reason ? ` Reason: ${patch.reason}` : ''),
          descriptionBn: `${shop.name} এর ৳${payment.amount} পেমেন্টের তথ্য সংশোধন করা হয়েছে`,
        },
      });
    }

    return payment;
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
      billingDay: billingDayOf(shop),
      cycleAlignment: alignmentOf(shop),
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

    /**
     * The billing day. `null` is a meaningful value here and clearing it must
     * be possible — it puts the shop back on plain calendar months — so an
     * explicit `null` or `''` clears, and only an ABSENT key leaves it alone.
     * That is why this cannot go through `numeric()` above, which folds those
     * three cases together.
     */
    if (patch.billingDay !== undefined) {
      const wanted = patch.billingDay === null || patch.billingDay === ''
        ? null
        : normalizeBillingDay(patch.billingDay);
      if (patch.billingDay !== null && patch.billingDay !== '' && wanted === null) {
        throw new AppError(
          'Billing day must be a day of the month between 1 and 31',
          'বিলিং তারিখ ১ থেকে ৩১ এর মধ্যে হতে হবে',
          400
        );
      }
      if (wanted !== before.billingDay) {
        shop.billing.billingDay = wanted;
        shop.billing.billingDaySetAt = wanted === null ? null : new Date();
      }
    }

    if (patch.cycleAlignment !== undefined) {
      if (!['billing_day', 'from_anchor'].includes(patch.cycleAlignment)) {
        throw new AppError(
          'Cycle alignment must be billing_day or from_anchor',
          'বিলিং সাইকেলের ধরন সঠিক নয়',
          400
        );
      }
      shop.billing.cycleAlignment = patch.cycleAlignment;
    }

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
      billingDay: billingDayOf(shop),
      cycleAlignment: alignmentOf(shop),
    };

    const graceChanged = before.graceDays !== after.graceDays;
    const priceChanged = before.monthlyPrice !== after.monthlyPrice
      || before.smsUnitPrice !== after.smsUnitPrice;
    const billingDayChanged = before.billingDay !== after.billingDay
      || before.cycleAlignment !== after.cycleAlignment;

    /**
     * One event type, chosen most-specific-first.
     *
     * `billing_day_changed` only wins when the price did NOT move, so a form
     * that changes both still files under `price_changed` — the money is what
     * an operator scans the timeline for, and burying a price change under a
     * date change is how "why is this shop on ৳800?" stops being answerable.
     */
    let eventType = 'price_changed';
    if (!priceChanged && billingDayChanged) eventType = 'billing_day_changed';
    else if (!priceChanged && graceChanged) eventType = 'grace_changed';

    const dayCopy = after.billingDay === null
      ? 'no fixed billing day'
      : `billed on day ${after.billingDay} (${after.cycleAlignment})`;

    await this._recordEvent({
      shop,
      type: eventType,
      actor,
      before,
      after,
      reason: patch.reason,
      audit: {
        action: 'billing_profile_update',
        actionBn: 'বিলিং তথ্য পরিবর্তন',
        description:
          `Updated billing for ${shop.name}: ৳${after.monthlyPrice}/month, ` +
          `৳${after.smsUnitPrice}/SMS, ${after.graceDays} grace day(s), ${dayCopy}.` +
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
   *
   * Manual entry passes `source: 'manual'`; a verified gateway payment passes
   * `source: 'gateway'` with `gateway.paymentId`, exactly as
   * `applySubscriptionPayment` does. The gateway branch is idempotent on that
   * id — without it this path had NO dedupe at all, and a customer's browser
   * returning at the same moment as the reconciliation sweep would have handed
   * out the credits twice.
   */
  async recordSmsPurchase(actor, {
    shopId, quantity, amount, unitPrice, method = 'cash', transactionId,
    receivedAt, notes, source = 'manual', gateway,
  } = {}) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new AppError('SMS quantity must be a positive number', 'এসএমএস সংখ্যা সঠিক নয়', 400);
    }

    // Idempotency: a re-verified payment must not buy a second pack.
    if (source === 'gateway' && gateway?.paymentId) {
      const existing = await PlatformPayment.findOne({
        source: 'gateway',
        type: PLATFORM_PAYMENT_TYPES.SMS,
        'gateway.paymentId': gateway.paymentId,
      });
      if (existing) {
        logger.warn(`[billing] duplicate gateway SMS purchase ignored: ${gateway.paymentId}`);
        const quota = await SMSQuota.findOne({ shop: existing.shop });
        return { quota, payment: existing, duplicate: true };
      }
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

    /* Ledger row FIRST, credits second.
     *
     * This used to run the other way round, and the failure it allowed was
     * silent: `PlatformPayment` has a `method` enum and a required `shop`, so a
     * rejected write left the shop holding credits it had no record of paying
     * for — free SMS, invisible in every revenue report.
     *
     * Both orderings can fail halfway. The difference is the DIRECTION of the
     * damage. This way the bad case is "the shop paid and has not got its
     * credits yet", which the gateway order sits at `paid` describing, the
     * reconciliation sweep retries, and the admin orders screen shows. That is a
     * recoverable, visible debt we owe them. The other way the bad case was an
     * invisible gift, and nothing in the system was ever going to notice it. */
    const payment = await PlatformPayment.create({
      shop: shop._id,
      type: PLATFORM_PAYMENT_TYPES.SMS,
      amount: total,
      currency: shop.billing?.currency || 'BDT',
      method,
      transactionId,
      receivedAt: receivedAt ? new Date(receivedAt) : new Date(),
      smsQuantity: qty,
      smsUnitPrice: effectiveUnit,
      status: total === 0 ? 'waived' : 'paid',
      source,
      gateway,
      recordedBy: { kind: actor?.kind || 'admin', id: actor?.id, name: actor?.name },
      notes,
    });

    const quota = await SMSQuota.getOrCreate(shop._id);
    await quota.addAllocation({
      quantity: qty,
      price: total,
      allocatedBy: actor?.id,
      paymentMethod: method,
      transactionId,
      notes,
    });

    /* Drop the cached blended sell rate for this shop.
     *
     * `sms/earnings.sellRateFor` derives revenue-per-segment from the shop's own
     * top-up history and caches it for 60s, and nothing used to bust that cache.
     * With manual allocation that was a rare minute of slightly wrong margin;
     * with self-serve top-ups it is every purchase, and the first messages a
     * shop sends after buying credit are exactly the ones it sends immediately. */
    try {
      require('./sms/earnings').invalidate();
    } catch (err) {
      // Cache invalidation must never be the thing that fails a completed sale.
      logger.warn(`[billing] could not invalidate SMS rate cache: ${err.message}`);
    }

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

    // Flag the originals that have since been reversed. Without this a reversed
    // ৳800 and a live ৳800 look identical in the list, and the operator has to
    // scan for the offsetting row to tell them apart. One query for the page,
    // not one per row — and it looks across pages, since a reversal written
    // months later will not sit next to its original.
    const originalIds = data.filter((p) => !p.reversalOf).map((p) => p._id);
    if (originalIds.length) {
      const reversals = await PlatformPayment.find({ reversalOf: { $in: originalIds } })
        .select('reversalOf receivedAt notes')
        .lean();
      const byOriginal = new Map(reversals.map((r) => [String(r.reversalOf), r]));
      for (const row of data) {
        const reversal = byOriginal.get(String(row._id));
        if (reversal) {
          row.reversedAt = reversal.receivedAt;
          row.reversalReason = reversal.notes || null;
        }
      }
    }

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
        monthlyPrice: shop.billing?.monthlyPrice ?? 0,
        // The operator's call list is organised by date, so the day this shop
        // is billed on belongs in the list itself rather than one click away.
        billingDay: billingDayOf(shop),
        cycleAlignment: alignmentOf(shop),
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
        .select('billing.monthlyPrice subscription.plan')
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
    // `billing.monthlyPrice` only. `subscription.monthlyPrice` is a deprecated
    // twin that also defaults to 800, and reading it as a fallback meant two
    // fields could disagree about one shop's price with nothing to say which
    // won — the defect SUBSCRIPTION_PLAN.md §2.5 recorded. The overdue
    // aggregation above already reads the live field alone; this now matches it.
    const mrr = paidShops.reduce((sum, s) => sum + (s.billing?.monthlyPrice ?? 0), 0);

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
// Exported for the month-arithmetic tests and the backfill script; not part of
// the service contract.
module.exports.addBangladeshMonths = addBangladeshMonths;
module.exports.alignToBillingDay = alignToBillingDay;
module.exports.normalizeBillingDay = normalizeBillingDay;
module.exports.billingDayOf = billingDayOf;
module.exports.alignmentOf = alignmentOf;
