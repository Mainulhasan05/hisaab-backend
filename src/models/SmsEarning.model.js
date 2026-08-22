/**
 * SmsEarning — the permanent money trail for SMS.
 *
 * ── Why this is a separate collection and not a field on SMSLog ──────────────
 *
 * SMSLog carries a 60-day TTL index. It has to: a busy month is hundreds of
 * thousands of rows and the operational detail on them stops being useful long
 * before it stops being expensive. But that makes it exactly the wrong place to
 * keep earnings — last year's margin would delete itself, quietly, sixty days at
 * a time, and nobody would notice until someone asked what the SMS line made in
 * Q2 and the answer was "nothing before June".
 *
 * So the detail expires and the money does not. This collection never expires.
 *
 * ── Why a rollup and not one row per message ─────────────────────────────────
 *
 * One permanent row per message re-creates the growth problem the TTL exists to
 * solve. A month × shop × provider grain answers every question the operator
 * actually asks — what did we make, on which gateway, from whom — at a few rows
 * per shop per month.
 *
 * ── Why it is written incrementally, not by a monthly job ────────────────────
 *
 * Every send `$inc`s its own contribution in one atomic upsert. That means the
 * figures are correct at all times rather than correct after the job last ran,
 * there is no window in which a crash loses a month, and a rollup job that
 * silently stops does not silently stop the accounting. The cost is one extra
 * write per send, which is nothing next to the HTTP call that just happened.
 *
 * ── The accounting ───────────────────────────────────────────────────────────
 *
 * Revenue is recognised ON CONSUMPTION, not on purchase. A shop buying a 5,000
 * SMS pack has handed over cash, but the platform still owes them 5,000
 * messages — that is deferred revenue, and booking it all in the month of sale
 * overstates that month and understates every month the pack is actually used.
 * Each send therefore recognises its own slice, at the rate the shop actually
 * paid for that quota.
 *
 * Cost is incurred at SEND time, at the rate of the gateway that actually
 * carried it — which, after failover, is not always the gateway the settings
 * name. See SMSLog.gateway.
 */

const mongoose = require('mongoose');

const smsEarningSchema = new mongoose.Schema({
  /**
   * Billing period as 'YYYY-MM', in Asia/Dhaka.
   *
   * A string rather than a Date because it is a bucket label, not an instant —
   * storing it as a Date invites a timezone shift to move a send from one
   * month's earnings to another's, which is the kind of drift that is noticed
   * only when two reports disagree by a few hundred taka.
   */
  period: {
    type: String,
    required: true,
    match: [/^\d{4}-\d{2}$/, 'period must be YYYY-MM'],
  },

  /**
   * The shop that consumed the quota. `null` for the platform's own broadcasts,
   * which are pure cost with no revenue behind them — and which would otherwise
   * be invisible in a margin report that only counted shops.
   */
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    default: null,
  },

  /** Registry name of the gateway that carried these segments. */
  provider: {
    type: String,
    required: true,
  },

  /** Messages (log rows), as distinct from segments. */
  messages: { type: Number, default: 0, min: 0 },

  /** Segments actually billed at the gateway. The unit everything else is per. */
  segments: { type: Number, default: 0, min: 0 },

  /** ৳ of prepaid quota consumed, at the rate the shop bought it for. */
  revenue: { type: Number, default: 0 },

  /** ৳ paid to the gateway for these segments. */
  gatewayCost: { type: Number, default: 0 },

  /**
   * Segments sent on a gateway we had no rate for.
   *
   * Tracked separately so `gatewayCost` is never quietly understated. A period
   * with unpriced segments is a period whose margin is a FLOOR, not a figure,
   * and the report says so rather than rounding the gap to zero.
   */
  unpricedSegments: { type: Number, default: 0, min: 0 },

  /**
   * Segments that only got through because the primary refused.
   *
   * The number that answers "is failover costing us money, and how much" — if
   * the backup is the pricier gateway, this is where that shows up.
   */
  failedOverSegments: { type: Number, default: 0, min: 0 },

  /** Segments the platform paid for on sends that ultimately failed. */
  failedSegments: { type: Number, default: 0, min: 0 },

  firstAt: { type: Date, default: null },
  lastAt: { type: Date, default: null },
}, {
  timestamps: true,
});

/**
 * The grain, enforced. One row per period per shop per provider.
 *
 * Unique so the upsert below can be a pure `$inc` with no read: two concurrent
 * sends both upserting the same bucket is the normal case, not the edge case,
 * and without the unique index they would create two rows that each hold half
 * the month.
 */
smsEarningSchema.index({ period: 1, shop: 1, provider: 1 }, { unique: true });
// "What did we make this month, across everyone" — the operator's first question.
smsEarningSchema.index({ period: 1, provider: 1 });
// "What has this shop cost and earned us, over time."
smsEarningSchema.index({ shop: 1, period: -1 });

/** Bucket label for an instant, in the timezone the business actually runs in. */
smsEarningSchema.statics.periodFor = function periodFor(date = new Date()) {
  // en-CA renders as YYYY-MM-DD, which slices cleanly to the bucket label.
  const dhaka = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  return dhaka.slice(0, 7);
};

/**
 * Record one send's contribution.
 *
 * Atomic and idempotent-per-call: it adds this send's numbers to the bucket and
 * never reads first, so concurrent sends cannot lose each other's increments.
 *
 * Never throws. Accounting is downstream of delivery — a failure to book the
 * margin must not be what turns a delivered message into a failed one. The
 * caller logs and moves on; drift is repairable from SMSLog for as long as the
 * TTL keeps it, which is what `reconcile` in the service is for.
 */
smsEarningSchema.statics.record = async function record({
  shop = null,
  provider,
  segments = 0,
  revenue = 0,
  gatewayCost = 0,
  unpriced = false,
  failedOver = false,
  failed = false,
  at = new Date(),
} = {}) {
  if (!provider || !segments || segments <= 0) return null;

  const period = this.periodFor(at);

  const inc = {
    messages: 1,
    segments,
    revenue: Number(revenue) || 0,
    gatewayCost: Number(gatewayCost) || 0,
  };
  if (unpriced) inc.unpricedSegments = segments;
  if (failedOver) inc.failedOverSegments = segments;
  if (failed) inc.failedSegments = segments;

  return this.findOneAndUpdate(
    { period, shop, provider },
    {
      $inc: inc,
      $set: { lastAt: at },
      $setOnInsert: { period, shop, provider, firstAt: at },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

const SmsEarning = mongoose.model('SmsEarning', smsEarningSchema);

module.exports = SmsEarning;
