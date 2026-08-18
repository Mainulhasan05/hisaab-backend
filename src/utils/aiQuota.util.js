/**
 * AI message allowance — the one sanctioned way to ask "how many, and how many
 * are left?"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE, IN ONE PLACE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Shop.ai.dailyMessageLimit is a number  →  that number, per branch
 *   Shop.ai.dailyMessageLimit is null      →  PlatformSetting.defaultAiDailyMessageLimit
 *   PlatformSetting unreadable             →  AI_DAILY_MESSAGE_LIMIT (5)
 *
 * Three layers, and the fallback at the bottom is a CONSTANT rather than a
 * literal `5` typed here. That matters: the number 5 is written down exactly
 * once, in `config/constants.js`, and every other reference points at it. A
 * second literal in this file is how "the default is 5" quietly becomes "the
 * default is 5 in two places and 3 in one of them" six months from now.
 *
 * The `.catch(() => null)` on the settings read is deliberate and matches every
 * other `PlatformSetting.current()` caller in this codebase: a Mongo hiccup must
 * never be the thing that breaks a shop's request. Falling back to 5 is the
 * conservative answer — it can only ever be MORE restrictive than a raised
 * platform default, never less.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `typeof === 'number'` AND NOT A TRUTHY CHECK
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `shop.ai?.dailyMessageLimit || platformDefault` reads a deliberate **0** —
 * "this shop has the feature and an allowance of nothing" — as "not set, use the
 * default", and hands five messages a day to the one shop an operator
 * specifically switched off. That is the same three-state trap `Shop.storage`
 * documents at length, and it is worth the extra line to not fall into it.
 */

const PlatformSetting = require('../models/PlatformSetting.model');
const ShopAiUsage = require('../models/ShopAiUsage.model');
const { AI_DAILY_MESSAGE_LIMIT } = require('../config/constants');
const { getBangladeshTodayStr } = require('./bdTime.util');

/**
 * How many AI messages one branch of this shop may send per Bangladesh day.
 *
 * @param {Object} shop a Shop document or plain object
 * @returns {Promise<number>}
 */
async function resolveDailyLimit(shop) {
  const own = shop?.ai?.dailyMessageLimit;
  if (typeof own === 'number' && Number.isFinite(own)) return own;

  const settings = await PlatformSetting.current().catch(() => null);
  const platformDefault = settings?.defaultAiDailyMessageLimit;

  return typeof platformDefault === 'number' && Number.isFinite(platformDefault)
    ? platformDefault
    : AI_DAILY_MESSAGE_LIMIT;
}

/**
 * The full allowance picture for one branch, spending nothing.
 *
 * What the shop-facing pill and the admin panel both render. `isOverridden`
 * is what lets the admin UI show "following the platform default (5)" instead
 * of a bare number the operator cannot tell apart from one they typed.
 *
 * @param {Object} shop
 * @param {ObjectId|string|null} branchId
 */
async function getUsage(shop, branchId) {
  const [limit, snapshot] = await Promise.all([
    resolveDailyLimit(shop),
    ShopAiUsage.peek(shop._id, branchId, getBangladeshTodayStr()),
  ]);

  return {
    limit,
    usedToday: snapshot.usedToday,
    remaining: Math.max(0, limit - snapshot.usedToday),
    dayKey: snapshot.dayKey,
    lastUsedAt: snapshot.lastUsedAt,
    totalRequests: snapshot.totalRequests,
    isOverridden: typeof shop?.ai?.dailyMessageLimit === 'number',
  };
}

/**
 * Spend one message from this branch's allowance.
 *
 * Returns `{ ok: false, ... }` rather than throwing, because the caller has to
 * decide the copy — "আজকের ৫টি বার্তা শেষ" and "এই দোকানে এআই বার্তা বরাদ্দ নেই"
 * are different sentences for a shopkeeper and only the caller knows which
 * screen is asking.
 *
 * @returns {Promise<{ok: boolean, limit: number, usedToday: number, remaining: number, dayKey: string}>}
 */
async function spend(shop, branchId) {
  const limit = await resolveDailyLimit(shop);
  const dayKey = getBangladeshTodayStr();

  const reserved = await ShopAiUsage.reserve(shop._id, branchId, limit, dayKey);

  if (!reserved) {
    return { ok: false, limit, usedToday: limit, remaining: 0, dayKey };
  }

  return {
    ok: true,
    limit,
    usedToday: reserved.usedToday,
    remaining: Math.max(0, limit - reserved.usedToday),
    dayKey,
  };
}

/**
 * Hand a spent message back. Never throws — a refund that fails must not turn
 * a recoverable error into a 500 on top of it, so it is logged by the caller
 * and the shopkeeper loses one message rather than the whole response.
 */
async function refund(shop, branchId, dayKey) {
  return ShopAiUsage.refund(shop._id, branchId, dayKey);
}

module.exports = {
  resolveDailyLimit,
  getUsage,
  spend,
  refund,
};
