/**
 * Subscription state — the ONE place that decides what a shop may do.
 *
 * Auth middleware, the login/session payload, the admin shop list, the admin
 * worklist and the owner's banner all call `resolveSubscription`. That is the
 * point: the moment a second place computes "is this expired?", the chip the
 * operator sees and the banner the owner sees start to drift, and the drift is
 * discovered during a payment dispute. See SUBSCRIPTION_PLAN.md §3.
 *
 * Two independent axes go in:
 *
 *   billing  — `shop.subscription.plan` × `expiresAt` (+ per-shop `graceDays`)
 *   access   — `shop.access.blockedAt`, set ONLY by an explicit admin action
 *
 * and one decision comes out. Access wins over billing: a blocked shop is
 * blocked whatever its expiry says, and an expiry can never produce a block.
 *
 * `subscription.status` is NOT an input beyond the legacy 'suspended' read
 * below. It is a cached label that the old code let drift from the date — a
 * shop could sit at status 'expired' with a future `expiresAt` and be denied
 * writes it had paid for. The date is the truth; the label follows it.
 *
 * Pure and I/O-free — it runs on every authenticated request.
 */

const {
  toBangladeshDateStr,
  bangladeshDaysBetween,
  addBangladeshDays,
} = require('./bdTime.util');
const { toBengaliNumber } = require('./bengali.util');

/** Warn the shop this many calendar days before expiry. */
const WARNING_DAYS = 3;

/**
 * States, worst first. `blocked` and `expired` deny writes; everything else
 * allows them.
 *
 *   blocked   manual admin lockout — no login, no read, no write
 *   expired   past expiry (and past grace) — reads allowed, writes 402
 *   grace     past expiry but inside the shop's granted grace days — full access
 *   expiring  <= WARNING_DAYS left — full access, loud banner
 *   trial     on trial, comfortably inside it
 *   active    paid and comfortably inside it (or no expiry at all)
 */
const STATES = Object.freeze({
  BLOCKED: 'blocked',
  EXPIRED: 'expired',
  GRACE: 'grace',
  EXPIRING: 'expiring',
  TRIAL: 'trial',
  ACTIVE: 'active',
});

const SUPPORT_PHONE = '01757995016';

/**
 * Is this shop under a manual admin block?
 *
 * `access.blockedAt` is the field this system sets. The two legacy conditions
 * are read as blocks so that cutting enforcement over to this resolver is a
 * no-op for shops already switched off the old way:
 *
 *   · `isActive === false`             — what `updateShopStatus` writes today
 *   · `subscription.status === 'suspended'` — its companion
 *
 * Both are still honoured on the way IN. Nothing in this system writes them on
 * the way out; new blocks go to `access.blockedAt`, where they carry an actor
 * and a reason.
 */
function isBlocked(shop) {
  return (
    !!shop?.access?.blockedAt ||
    shop?.isActive === false ||
    shop?.subscription?.status === 'suspended'
  );
}

/**
 * Resolve a shop's subscription into a decision.
 *
 * @param {Object} shop  a Shop document or lean object (may be null)
 * @param {Date}   [now]
 * @param {Object} [opts]
 * @param {number} [opts.warningDays] override the 3-day warning threshold
 * @returns {{
 *   state: string, plan: string, expiresAt: Date|null, expiresOn: string|null,
 *   daysRemaining: number|null, graceDays: number, graceEndsAt: Date|null,
 *   canRead: boolean, canWrite: boolean, isBlocked: boolean,
 *   severity: 'none'|'info'|'warning'|'critical', reason: string|null,
 *   supportPhone: string,
 * }}
 */
function resolveSubscription(shop, now = new Date(), opts = {}) {
  const warningDays = Number.isFinite(opts.warningDays) ? opts.warningDays : WARNING_DAYS;
  const sub = shop?.subscription || {};
  const plan = sub.plan === 'trial' ? 'trial' : 'paid';

  const base = {
    plan,
    expiresAt: null,
    expiresOn: null,
    daysRemaining: null,
    graceDays: Math.max(0, Number(sub.graceDays) || 0),
    graceEndsAt: null,
    isBlocked: false,
    reason: null,
    supportPhone: SUPPORT_PHONE,
  };

  // No shop on the request at all (platform admin, unauthenticated route).
  // Nothing to bill, nothing to restrict — this must never be the thing that
  // denies a request.
  if (!shop) {
    return { ...base, state: STATES.ACTIVE, canRead: true, canWrite: true, severity: 'none' };
  }

  if (isBlocked(shop)) {
    return {
      ...base,
      state: STATES.BLOCKED,
      isBlocked: true,
      canRead: false,
      canWrite: false,
      severity: 'critical',
      reason: shop?.access?.blockReason || null,
      expiresAt: sub.expiresAt || null,
      expiresOn: sub.expiresAt ? toBangladeshDateStr(sub.expiresAt) : null,
    };
  }

  // No expiry date = never expires. Perpetual and internal shops depend on
  // this, and it is also what stops a bad migration from taking the whole
  // platform offline. INVARIANT 4 in SUBSCRIPTION_PLAN.md §8.
  if (!sub.expiresAt) {
    return {
      ...base,
      state: plan === 'trial' ? STATES.TRIAL : STATES.ACTIVE,
      canRead: true,
      canWrite: true,
      severity: 'none',
    };
  }

  const expiresAt = sub.expiresAt instanceof Date ? sub.expiresAt : new Date(sub.expiresAt);
  const graceEndsAt = base.graceDays > 0 ? addBangladeshDays(expiresAt, base.graceDays) : expiresAt;
  const daysRemaining = bangladeshDaysBetween(now, expiresAt);

  const common = {
    ...base,
    expiresAt,
    expiresOn: toBangladeshDateStr(expiresAt),
    daysRemaining,
    graceEndsAt: base.graceDays > 0 ? graceEndsAt : null,
    canRead: true,
  };

  if (now > expiresAt) {
    // Inside the grace the operator granted this shop: still fully working, but
    // told loudly. Grace is per shop and defaults to 0, so for most shops this
    // branch never runs and expiry behaves exactly as it does today.
    if (base.graceDays > 0 && now <= graceEndsAt) {
      return {
        ...common,
        state: STATES.GRACE,
        canWrite: true,
        severity: 'critical',
        daysRemaining: bangladeshDaysBetween(now, graceEndsAt),
      };
    }
    // Expired: reads stay open, writes stop. Deliberately not a lockout —
    // an unpaid shop can still get yesterday's numbers and its due list out.
    return { ...common, state: STATES.EXPIRED, canWrite: false, severity: 'critical' };
  }

  if (daysRemaining !== null && daysRemaining <= warningDays) {
    return {
      ...common,
      state: STATES.EXPIRING,
      canWrite: true,
      // 0 = expires today, 1 = tomorrow. Those two are not a "heads up", they
      // are "do it now", so they get the same red as an expired shop.
      severity: daysRemaining <= 1 ? 'critical' : 'warning',
    };
  }

  return {
    ...common,
    state: plan === 'trial' ? STATES.TRIAL : STATES.ACTIVE,
    canWrite: true,
    severity: plan === 'trial' ? 'info' : 'none',
  };
}

/**
 * Bengali-first copy for a resolved state. Bangla is what the shop reads.
 *
 * Day counts go through `toBengaliNumber` — a banner that says "3 দিন" in the
 * middle of a Bangla sentence reads as a half-translated app, and this is the
 * one message a shop is guaranteed to look at closely.
 */
function describeState(resolved) {
  const days = resolved.daysRemaining;
  const bnDays = days === null ? '' : toBengaliNumber(days);
  switch (resolved.state) {
    case STATES.BLOCKED:
      return {
        title: 'আপনার দোকানের অ্যাক্সেস বন্ধ করা হয়েছে',
        titleEn: 'Access to your shop has been suspended',
        body: `বিস্তারিত জানতে যোগাযোগ করুন — ${SUPPORT_PHONE}`,
        bodyEn: `Please contact support — ${SUPPORT_PHONE}`,
      };
    case STATES.EXPIRED:
      return {
        title: 'সাবস্ক্রিপশনের মেয়াদ শেষ হয়েছে',
        titleEn: 'Your subscription has expired',
        body: `আপনি পুরনো তথ্য দেখতে পারবেন, কিন্তু নতুন বিক্রয় বা পরিবর্তন করতে পারবেন না। রিনিউ করতে কল করুন — ${SUPPORT_PHONE}`,
        bodyEn: `You can still view your data but cannot make changes. Call ${SUPPORT_PHONE} to renew.`,
      };
    case STATES.GRACE:
      return {
        title: `মেয়াদ শেষ — আর ${bnDays} দিন ছাড় দেওয়া হয়েছে`,
        titleEn: `Expired — ${days} grace day(s) remaining`,
        body: `এই সময়ের মধ্যে রিনিউ না করলে নতুন এন্ট্রি বন্ধ হয়ে যাবে। কল করুন — ${SUPPORT_PHONE}`,
        bodyEn: `Renew before the grace period ends or new entries will stop. Call ${SUPPORT_PHONE}.`,
      };
    case STATES.EXPIRING:
      return {
        title:
          days === 0
            ? 'সাবস্ক্রিপশনের মেয়াদ আজই শেষ হচ্ছে'
            : `সাবস্ক্রিপশনের মেয়াদ ${bnDays} দিন পর শেষ হবে`,
        titleEn:
          days === 0 ? 'Your subscription expires today' : `Your subscription expires in ${days} day(s)`,
        body: `সেবা চালু রাখতে আজই রিনিউ করুন — ${SUPPORT_PHONE}`,
        bodyEn: `Renew today to avoid interruption — ${SUPPORT_PHONE}`,
      };
    case STATES.TRIAL:
      return {
        title: days === null ? 'ট্রায়াল চলছে' : `ট্রায়াল — ${bnDays} দিন বাকি`,
        titleEn: days === null ? 'Trial active' : `Trial — ${days} day(s) left`,
        body: `পুরো সুবিধা চালু রাখতে যোগাযোগ করুন — ${SUPPORT_PHONE}`,
        bodyEn: `Contact us to continue after the trial — ${SUPPORT_PHONE}`,
      };
    default:
      return null;
  }
}

/**
 * What the frontend gets on login / `/auth/me` / refresh.
 *
 * Returns null when there is nothing to say, so the client can render the
 * banner on truthiness alone and never has to know the state names or the
 * 3-day rule. `dismissible` is part of the contract, not a client decision:
 * an amber "3 days left" can be waved away for the day, a red one cannot.
 */
function buildSubscriptionNotice(shop, now = new Date(), opts = {}) {
  const resolved = resolveSubscription(shop, now, opts);
  if (resolved.severity === 'none') return null;

  const copy = describeState(resolved);
  if (!copy) return null;

  return {
    state: resolved.state,
    plan: resolved.plan,
    severity: resolved.severity,
    expiresAt: resolved.expiresAt,
    expiresOn: resolved.expiresOn,
    daysRemaining: resolved.daysRemaining,
    canWrite: resolved.canWrite,
    dismissible: resolved.severity === 'info' || resolved.severity === 'warning',
    supportPhone: SUPPORT_PHONE,
    ...copy,
  };
}

module.exports = {
  STATES,
  WARNING_DAYS,
  SUPPORT_PHONE,
  isBlocked,
  resolveSubscription,
  buildSubscriptionNotice,
  describeState,
};
