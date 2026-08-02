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

/** Invalidate cached branch-ownership lookups for a branch. */
async function invalidateBranchCache(shopId, branchId) {
  await Promise.all([
    cacheService.delete(`shop:${shopId}:branch:${branchId}:own`),
    cacheService.delete(`shop:${shopId}:default_branch`),
  ]);
}

module.exports = {
  invalidateShopAuthCache,
  invalidateUserAuthCache,
  invalidateBranchCache,
};
