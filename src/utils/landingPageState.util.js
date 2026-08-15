/**
 * Landing page state — the ONE place that decides whether a page serves.
 *
 * Modelled directly on `subscriptionState.util`, and that is deliberate: the two
 * answer the same shape of question (is this thing inside its paid window, and
 * what do we say about it), and a second, subtly different implementation of
 * "has it expired" is how two screens end up disagreeing about the same date.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXPIRY DARKENS THE PAGE. IT NEVER DARKENS THE ORDERS. (I-14)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This module answers `canAcceptOrders` — whether the PUBLIC page may take a new
 * order. It deliberately does NOT answer "may the shop see its orders", because
 * that question has no interesting answer: the shop may always see them.
 *
 * The failure being prevented is concrete. A mango season ends on the 31st,
 * forty parcels are with the courier, ৳৭০,০০০ is uncollected — and the shop is
 * locked out of the only list that says who owes what. Expiry is a billing
 * boundary, not a data boundary.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RESOLVED ON READ, NOT WRITTEN BY A JOB
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A page is correct the instant the clock passes its expiry, whether or not any
 * job has run. The nightly sweep only writes `status: 'expired'` so the admin's
 * renewal worklist can be a query, and sends the 7-day and 1-day notices — it is
 * never what makes expiry take effect. A job that WAS the mechanism would mean a
 * page still selling at 3am because the worker died at midnight.
 */

const {
  toBangladeshDateStr,
  addBangladeshDays,
  bangladeshDaysBetween,
} = require('./bdTime.util');
const { toBengaliNumber } = require('./bengali.util');

/**
 * ── THE STATES ──────────────────────────────────────────────────────────────
 *
 *   draft      never published — the public URL 404s
 *   scheduled  `startsAt` is in the future — 404 until then
 *   active     serving, comfortably inside the window
 *   expiring   <= WARNING_DAYS left — still serving, loud banner in the panel
 *   grace      past `expiresAt`, inside the granted grace days — still serving
 *   expired    past expiry and grace — the closed page, no new orders
 *   paused     the shop switched it off
 *   blocked    an admin switched it off; the shop cannot clear it
 */
const STATES = Object.freeze({
  DRAFT: 'draft',
  SCHEDULED: 'scheduled',
  ACTIVE: 'active',
  EXPIRING: 'expiring',
  GRACE: 'grace',
  EXPIRED: 'expired',
  PAUSED: 'paused',
  BLOCKED: 'blocked',
});

/**
 * How far ahead the shop is warned. SEVEN days, not the subscription's three.
 *
 * A shop behind on its subscription can pay and be unblocked within the hour. A
 * campaign cannot: the trader has ad spend committed and has to decide whether
 * to renew or let the season end, and that is not a decision to spring on
 * someone with 72 hours' notice.
 */
const WARNING_DAYS = 7;

/**
 * Resolve one page's position.
 *
 * @param {Object} page  a LandingPage document or lean object
 * @param {Date} [now]
 * @param {Object} [opts] { warningDays }
 * @returns {{
 *   state: string,
 *   canAcceptOrders: boolean,
 *   canEdit: boolean,
 *   isServable: boolean,
 *   expiresAt: Date|null, expiresOn: string|null,
 *   startsAt: Date|null,
 *   daysRemaining: number|null,
 *   graceDays: number, graceEndsAt: Date|null,
 *   severity: 'none'|'info'|'warning'|'critical',
 *   reason: string|null,
 * }}
 */
function resolveLandingPage(page, now = new Date(), opts = {}) {
  const warningDays = Number.isFinite(opts.warningDays) ? opts.warningDays : WARNING_DAYS;

  const graceDays = Math.max(0, Number(page?.graceDays) || 0);
  const expiresAt = page?.expiresAt ? new Date(page.expiresAt) : null;
  const startsAt = page?.startsAt ? new Date(page.startsAt) : null;

  const base = {
    expiresAt,
    expiresOn: expiresAt ? toBangladeshDateStr(expiresAt) : null,
    startsAt,
    daysRemaining: null,
    graceDays,
    graceEndsAt: null,
    reason: null,
    // The public page renders (as a real page or as the closed notice) for every
    // state except the two where it must not exist at all.
    isServable: false,
  };

  if (!page) {
    return { ...base, state: STATES.DRAFT, canAcceptOrders: false, canEdit: false, severity: 'none' };
  }

  // ── States that ignore the calendar ───────────────────────────────────────

  // An admin's kill switch. Checked FIRST: a page an admin took down for abuse
  // must not come back because its dates happen to be fine.
  if (page.pausedByAdmin) {
    return {
      ...base,
      state: STATES.BLOCKED,
      canAcceptOrders: false,
      // The shop may still edit content — the block is on serving, not on
      // working — but only an admin can clear it.
      canEdit: true,
      severity: 'critical',
      reason: page.pauseReason || null,
    };
  }

  if (page.status === 'draft') {
    return { ...base, state: STATES.DRAFT, canAcceptOrders: false, canEdit: true, severity: 'none' };
  }

  if (page.status === 'paused') {
    return { ...base, state: STATES.PAUSED, canAcceptOrders: false, canEdit: true, severity: 'info' };
  }

  if (startsAt && now < startsAt) {
    return { ...base, state: STATES.SCHEDULED, canAcceptOrders: false, canEdit: true, severity: 'info' };
  }

  // ── The calendar ──────────────────────────────────────────────────────────

  /**
   * No expiry date = never expires.
   *
   * The service requires one before a page may go live, so in practice this is
   * reached only by a document written by hand or by a migration. Treating it as
   * "never expires" rather than "expired" is the same choice
   * `Shop.subscription.expiresAt` makes, and for the same reason: a bad
   * migration must not take live pages down.
   */
  if (!expiresAt) {
    return {
      ...base,
      state: STATES.ACTIVE,
      canAcceptOrders: true,
      canEdit: true,
      isServable: true,
      severity: 'none',
    };
  }

  const graceEndsAt = graceDays > 0 ? addBangladeshDays(expiresAt, graceDays) : expiresAt;
  const daysRemaining = bangladeshDaysBetween(now, expiresAt);

  const common = {
    ...base,
    daysRemaining,
    graceEndsAt: graceDays > 0 ? graceEndsAt : null,
    isServable: true,
  };

  if (now > expiresAt) {
    if (graceDays > 0 && now <= graceEndsAt) {
      return {
        ...common,
        state: STATES.GRACE,
        canAcceptOrders: true,
        canEdit: true,
        severity: 'critical',
        daysRemaining: bangladeshDaysBetween(now, graceEndsAt),
      };
    }

    /**
     * Expired. The page still SERVES — as the closed notice — and that is the
     * point: the advertisement may still be running, and a dead link is worse
     * than an honest "this offer has ended" with the shop's phone number on it.
     *
     * `canEdit` is false so content is preserved for next season; renewal is an
     * admin action that moves `expiresAt` and brings everything back.
     */
    return {
      ...common,
      state: STATES.EXPIRED,
      canAcceptOrders: false,
      canEdit: false,
      severity: 'critical',
    };
  }

  if (daysRemaining !== null && daysRemaining <= warningDays) {
    return {
      ...common,
      state: STATES.EXPIRING,
      canAcceptOrders: true,
      canEdit: true,
      // 0 = today, 1 = tomorrow. Those are not a heads-up, they are "decide
      // now", so they get the same red as an expired page.
      severity: daysRemaining <= 1 ? 'critical' : 'warning',
    };
  }

  return {
    ...common,
    state: STATES.ACTIVE,
    canAcceptOrders: true,
    canEdit: true,
    severity: 'none',
  };
}

/**
 * Bengali-first copy for a resolved state. Bangla is what the shop reads.
 *
 * Day counts go through `toBengaliNumber` — "৭ দিন" mid-sentence in Bangla reads
 * as a finished product; "7 দিন" reads as a half-translated one, and this is a
 * message the shop is guaranteed to look at closely.
 */
function describeLandingState(resolved) {
  const days = resolved?.daysRemaining;
  const bn = (n) => toBengaliNumber(Math.max(0, Number(n) || 0));

  switch (resolved?.state) {
    case STATES.DRAFT:
      return { title: 'খসড়া', detail: 'পেজটি এখনো প্রকাশ করা হয়নি।' };
    case STATES.SCHEDULED:
      return { title: 'নির্ধারিত', detail: 'নির্দিষ্ট তারিখে পেজটি চালু হবে।' };
    case STATES.PAUSED:
      return { title: 'বন্ধ', detail: 'পেজটি আপাতত বন্ধ রাখা হয়েছে।' };
    case STATES.BLOCKED:
      return {
        title: 'স্থগিত',
        detail: resolved.reason
          ? `প্ল্যাটফর্ম থেকে বন্ধ করা হয়েছে — ${resolved.reason}`
          : 'প্ল্যাটফর্ম থেকে বন্ধ করা হয়েছে। যোগাযোগ করুন।',
      };
    case STATES.EXPIRING:
      return {
        title: `${bn(days)} দিন বাকি`,
        detail: days <= 1
          ? 'মেয়াদ প্রায় শেষ — নবায়ন না করলে পেজটি বন্ধ হয়ে যাবে।'
          : 'মেয়াদ শেষ হওয়ার আগে নবায়ন করুন।',
      };
    case STATES.GRACE:
      return {
        title: 'মেয়াদ শেষ — অতিরিক্ত সময়',
        detail: `আর ${bn(days)} দিন অর্ডার নেওয়া যাবে।`,
      };
    case STATES.EXPIRED:
      return {
        title: 'মেয়াদ শেষ',
        detail: 'নতুন অর্ডার নেওয়া বন্ধ। আগের অর্ডারগুলো আগের মতোই পরিচালনা করা যাবে।',
      };
    default:
      return { title: 'চালু', detail: 'পেজটি অর্ডার নিচ্ছে।' };
  }
}

/**
 * The banner payload, or null when there is nothing to say.
 *
 * Same shape as `buildSubscriptionNotice`: the frontend renders on truthiness
 * alone and never has to know the state names.
 */
function buildLandingNotice(page, now = new Date()) {
  const resolved = resolveLandingPage(page, now);
  if (resolved.severity === 'none') return null;

  const copy = describeLandingState(resolved);
  return {
    state: resolved.state,
    severity: resolved.severity,
    title: copy.title,
    detail: copy.detail,
    daysRemaining: resolved.daysRemaining,
    expiresOn: resolved.expiresOn,
  };
}

module.exports = {
  STATES,
  WARNING_DAYS,
  resolveLandingPage,
  describeLandingState,
  buildLandingNotice,
};
