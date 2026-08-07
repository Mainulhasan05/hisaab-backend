/**
 * Scoped auth-cache invalidation.
 *
 * The auth middleware caches user+shop docs under `auth:user:{id}` (TTL 300s).
 * Invalidation must be scoped: the previous deletePattern('auth:user:*') wiped
 * the cache for every user of every tenant AND performed a full Redis keyspace
 * SCAN each time — a platform-wide thundering herd on any settings save.
 */
const cacheService = require('../services/cache.service');

/**
 * Invalidate cached auth entries for every user of one shop.
 * One indexed query + a handful of point deletes (staff counts are small).
 */
async function invalidateShopAuthCache(shopId) {
  // Lazy require to avoid model/service require cycles at module load
  const User = require('../models/User.model');
  const users = await User.find({ shop: shopId }, { _id: 1 }).lean();
  await Promise.all(users.map((u) => cacheService.delete(`auth:user:${u._id}`)));
}

/** Invalidate one user's cached auth entry. */
async function invalidateUserAuthCache(userId) {
  await cacheService.delete(`auth:user:${userId}`);
}

/**
 * Invalidate cached branch data for a shop.
 *
 * The branch list now rides inside `auth:user:{id}` (see auth.middleware
 * getCachedUser), so invalidating branches means invalidating that shop's users.
 * The previous dedicated keys (`shop:{id}:branch:{bid}:own`,
 * `shop:{id}:default_branch`) no longer exist.
 *
 * Must be called on every branch create / edit / activate / deactivate.
 */
async function invalidateBranchCache(shopId) {
  await invalidateShopAuthCache(shopId);
}

module.exports = {
  invalidateShopAuthCache,
  invalidateUserAuthCache,
  invalidateBranchCache,
};
