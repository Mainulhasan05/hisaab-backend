/**
 * ShopAiUsage — how many AI messages one BRANCH has spent today.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE KEY IS {shop, branch} AND NOT {shop}
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The allowance is negotiated once with the shop (`Shop.ai.dailyMessageLimit`)
 * and applied to EACH branch independently. A three-branch shop on the default
 * gets five messages at each of three counters, not five shared between them.
 *
 * A shop-wide pool looks tidier and is worse in the only way that matters: the
 * busy branch spends the quiet branches' allowance before they open, and the
 * quiet branch's screen has nothing to say about why its AI stopped working —
 * the cause is a machine in another town. Branch-wise, the number on the screen
 * is about the person reading it.
 *
 * `branch` is `null` for single-branch shops (that is what `req.branchId` is for
 * them), so they have exactly one counter and never notice the distinction. The
 * `{shop, branch}` unique index treats that null as an ordinary value, which is
 * precisely the behaviour needed — one document, not none and not many.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY ONE DOCUMENT PER BRANCH, ROLLED OVER, AND NOT ONE PER DAY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A row per branch per day grows forever and needs a TTL to stay honest, and
 * nothing in this feature reads yesterday. History that IS worth keeping — which
 * key served it, how long it took, how many of the drafted lines the shopkeeper
 * actually accepted — belongs in the request log, not in the counter.
 *
 * So `dayKey` is a field that gets overwritten, and the rollover happens lazily
 * on the first request of a new day rather than in a cron job. A scheduled reset
 * would have to know every shop's branches and would silently stop working the
 * day it was disabled; this cannot drift because the day is re-derived on every
 * single reservation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE DAY IS DHAKA'S
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `getBangladeshTodayStr()`, never `toISOString()`. On a UTC host those differ
 * for the first six hours of every Bangladeshi day: a shopkeeper's five messages
 * would visibly refresh at 6am and then again at midnight, which reads as the
 * counter being broken. The Gemini POOL's own counters stay on the UTC date —
 * they track Google's quota, not the shopkeeper's day, and conflating the two
 * would make one of them wrong.
 */

const mongoose = require('mongoose');

const shopAiUsageSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true
  },
  // null = single-branch shop, or the shop-wide counter for a multi-branch shop
  // whose request arrived without a branch selected.
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  // 'YYYY-MM-DD' in Asia/Dhaka. A string, not a Date, so the equality check in
  // `reserve` is an exact index hit and never a timezone question.
  dayKey: {
    type: String,
    required: true
  },
  usedToday: {
    type: Number,
    default: 0,
    min: 0
  },
  // Never reset. Answers "is this shop actually using the feature?" without
  // needing the request log, which ages out at 90 days.
  totalRequests: {
    type: Number,
    default: 0,
    min: 0
  },
  lastUsedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// One counter per branch. Unique so the three-step `reserve` below cannot end
// up racing two documents into existence for the same branch — the duplicate
// key error IS the concurrency control on the create path.
shopAiUsageSchema.index({ shop: 1, branch: 1 }, { unique: true });

/**
 * Take one message from this branch's allowance.
 *
 * ── WHY THIS IS THREE UPDATES AND NOT ONE UPSERT ────────────────────────────
 *
 * "Same day and under the limit" and "a new day has started" are different
 * filters over the same document, and no single `findOneAndUpdate` can express
 * both — the first has to `$inc`, the second has to `$set` back to 1. Trying it
 * as one upsert with a `$setOnInsert` either never rolls the day over or resets
 * the counter on every call, depending on which way the filter is written.
 *
 * So: same-day increment, else day rollover, else create. Each is atomic on its
 * own, and each one's filter makes it a no-op if another request got there
 * first. A null after all three means the branch is genuinely out.
 *
 * ── WHY THE CEILING IS IN THE FILTER ────────────────────────────────────────
 *
 * `usedToday: { $lt: limit }` is evaluated by the database under the document
 * lock, inside the same update that increments. Read-then-check-then-write in
 * the service is the race that lets two taps on a slow connection both decide
 * the branch can afford its fifth message. Copied deliberately from
 * `SMSQuota.reserve`, which had to learn the same lesson about a shop sending
 * more SMS than it paid for.
 *
 * @param {ObjectId|string} shopId
 * @param {ObjectId|string|null} branchId
 * @param {number} limit   resolved allowance; 0 means "allowed nothing"
 * @param {string} dayKey  'YYYY-MM-DD' in Asia/Dhaka
 * @returns {Promise<Object|null>} the updated counter, or null when out
 */
shopAiUsageSchema.statics.reserve = async function reserve(shopId, branchId, limit, dayKey) {
  if (!Number.isFinite(limit) || limit <= 0) return null;

  const branch = branchId || null;
  const now = new Date();

  // 1. Same Bangladesh day, still under the ceiling.
  const sameDay = await this.findOneAndUpdate(
    { shop: shopId, branch, dayKey, usedToday: { $lt: limit } },
    { $inc: { usedToday: 1, totalRequests: 1 }, $set: { lastUsedAt: now } },
    { new: true }
  );
  if (sameDay) return sameDay;

  // 2. A new day. Reset to exactly 1 — this request is the first of it.
  const rolled = await this.findOneAndUpdate(
    { shop: shopId, branch, dayKey: { $ne: dayKey } },
    { $set: { dayKey, usedToday: 1, lastUsedAt: now }, $inc: { totalRequests: 1 } },
    { new: true }
  );
  if (rolled) return rolled;

  // 3. This branch has never used the feature.
  try {
    return await this.create({
      shop: shopId,
      branch,
      dayKey,
      usedToday: 1,
      totalRequests: 1,
      lastUsedAt: now
    });
  } catch (err) {
    // Lost the create race against a concurrent first request. The document now
    // exists at usedToday: 1, so retry step 1 once rather than reporting the
    // branch as out of messages on the very first one it ever sent.
    if (err?.code === 11000) {
      return this.findOneAndUpdate(
        { shop: shopId, branch, dayKey, usedToday: { $lt: limit } },
        { $inc: { usedToday: 1, totalRequests: 1 }, $set: { lastUsedAt: now } },
        { new: true }
      );
    }
    throw err;
  }
};

/**
 * Give a message back.
 *
 * Called when the failure was OURS — the key pool was exhausted, the model
 * timed out, Google returned a 5xx. A shopkeeper must never lose one of their
 * five to a platform problem (AI_EXPENSE_PLAN.md I-3).
 *
 * Clamped at zero and pinned to the same `dayKey` that was charged: a refund
 * arriving after midnight must not hand tomorrow a free message.
 */
shopAiUsageSchema.statics.refund = async function refund(shopId, branchId, dayKey) {
  return this.updateOne(
    { shop: shopId, branch: branchId || null, dayKey, usedToday: { $gt: 0 } },
    { $inc: { usedToday: -1 } }
  );
};

/**
 * Read the counter without spending anything.
 *
 * Returns a synthetic zero for a branch that has never used the feature, and
 * for one whose stored `dayKey` is stale — from the caller's point of view an
 * untouched branch and a branch that last used it yesterday are the same thing,
 * and materialising a document just to answer a GET would create rows for every
 * branch that ever opened the expenses page.
 */
shopAiUsageSchema.statics.peek = async function peek(shopId, branchId, dayKey) {
  const doc = await this.findOne({ shop: shopId, branch: branchId || null }).lean();
  if (!doc || doc.dayKey !== dayKey) {
    return { usedToday: 0, dayKey, totalRequests: doc?.totalRequests || 0, lastUsedAt: doc?.lastUsedAt || null };
  }
  return {
    usedToday: doc.usedToday,
    dayKey: doc.dayKey,
    totalRequests: doc.totalRequests,
    lastUsedAt: doc.lastUsedAt
  };
};

const ShopAiUsage = mongoose.model('ShopAiUsage', shopAiUsageSchema);

module.exports = ShopAiUsage;
