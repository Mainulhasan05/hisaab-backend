/**
 * User Activity & Last Active Time Tracking Service
 *
 * Provides a high-performance, rate-limited tracking system using Redis and MongoDB:
 * - Rate-limited 60-second window per user to reduce write load.
 * - In-memory Redis caching with 24-hour TTL and a dirty tracking SET.
 * - Scheduled write-behind batch DB synchronization using pipelined mGet and bulkWrite.
 * - Non-blocking memory reclamation via UNLINK and sRem.
 * - Multi-user querying with Redis acceleration and MongoDB fallback.
 * - Automatic direct DB update fallback when Redis is offline.
 */

const cacheService = require('./cache.service');
const redisConfig = require('../config/redis.config');
const User = require('../models/User.model');
const logger = require('../utils/logger.util');

// Configuration Constants
const RATE_LIMIT_TTL = 60; // 60 seconds rate limit window per user
const LAST_ACTIVE_TTL = 24 * 60 * 60; // 24 hours Redis TTL
const DIRTY_SET_KEY = 'user:lastActive:dirty';
const USER_ACTIVE_PREFIX = 'user:lastActive:';
const USER_UPDATE_PREFIX = 'user:lastUpdate:';
const SESSION_ACTIVE_PREFIX = 'session:lastActive:';

class UserActivityService {
  /**
   * Non-blocking background call to record user activity.
   * Throttles updates per user (60s window) and updates Redis cache + dirty SET.
   * Falls back to direct DB update if Redis is disconnected.
   *
   * @param {string} userId - ID of the authenticated user
   * @param {string} [sessionId] - Optional JWT token jti / session ID
   */
  async recordActivity(userId, sessionId = null) {
    if (!userId) return;

    const strUserId = userId.toString();
    const nowIso = new Date().toISOString();
    const rateLimitKey = `${USER_UPDATE_PREFIX}${strUserId}`;

    try {
      if (redisConfig.isConnected()) {
        // 1. Rate-Limit Check: Throttle updates using a 60-second window
        // setNX returns true ONLY if the key was set (i.e., didn't exist)
        const acquired = await cacheService.setNX(rateLimitKey, 1, RATE_LIMIT_TTL);
        if (!acquired) {
          // Throttled: Update attempt within 60s of previous attempt -> Exit early
          return;
        }

        // 2-4. Timestamp, optional session timestamp, and dirty-set membership.
        //
        // One pipelined round trip instead of three sequential ones. The rate
        // limit above stays a separate call because its return value decides
        // whether we get here at all — that is the one result we branch on.
        const ops = [
          { type: 'set', key: `${USER_ACTIVE_PREFIX}${strUserId}`, value: nowIso, ttl: LAST_ACTIVE_TTL },
          { type: 'sAdd', key: DIRTY_SET_KEY, member: strUserId },
        ];
        if (sessionId) {
          ops.push({
            type: 'set',
            key: `${SESSION_ACTIVE_PREFIX}${sessionId}`,
            value: nowIso,
            ttl: LAST_ACTIVE_TTL,
          });
        }
        await cacheService.pipeline(ops);
      } else {
        // Redis Fallback: Direct database write if Redis is unreachable
        logger.warn(`Redis unavailable. Performing direct DB lastActiveAt update for user ${strUserId}`);
        await this._fallbackDirectDbUpdate(strUserId, new Date(nowIso));
      }
    } catch (error) {
      logger.error(`Error in UserActivityService.recordActivity for user ${strUserId}: ${error.message}`);
      // Safety net: Try direct DB update on Redis error to maintain consistency
      this._fallbackDirectDbUpdate(strUserId, new Date(nowIso)).catch(dbErr => {
        logger.error(`Failed fallback DB update for user ${strUserId}: ${dbErr.message}`);
      });
    }
  }

  /**
   * Scheduled Batch Database Sync (Write-Behind Pattern).
   * Intended to run every 5 minutes via cron/job scheduler.
   *
   * 1. Fetches dirty user IDs from Redis SET `user:lastActive:dirty`.
   * 2. Pipelined mGet for timestamps in 1 network roundtrip.
   * 3. Flushes timestamps to MongoDB using a single bulkWrite.
   * 4. Reclaims memory non-blockingly via UNLINK & cleans up dirty SET via sRem.
   *
   * @returns {Promise<{ syncedCount: number, errorCount: number }>}
   */
  async syncToDatabase() {
    try {
      if (!redisConfig.isConnected()) {
        logger.warn('Redis is disconnected. Skipping scheduled lastActive sync to database.');
        return { syncedCount: 0, errorCount: 0 };
      }

      // 1. Fetch all user IDs from the dirty set
      const dirtyUserIds = await cacheService.sMembers(DIRTY_SET_KEY);
      if (!dirtyUserIds || dirtyUserIds.length === 0) {
        logger.debug('No dirty user activity keys to sync to database.');
        return { syncedCount: 0, errorCount: 0 };
      }

      logger.info(`Starting batch lastActive database sync for ${dirtyUserIds.length} dirty users.`);

      // 2. Batch-fetch timestamps using a single pipelined mGet
      const keys = dirtyUserIds.map(id => `${USER_ACTIVE_PREFIX}${id}`);
      const timestamps = await cacheService.mGet(keys);

      const bulkOps = [];
      const keysToUnlink = [];
      const syncedUserIds = [];

      for (let i = 0; i < dirtyUserIds.length; i++) {
        const userId = dirtyUserIds[i];
        const rawTimestamp = timestamps[i];

        if (rawTimestamp) {
          const parsedDate = new Date(rawTimestamp);
          if (!isNaN(parsedDate.getTime())) {
            bulkOps.push({
              updateOne: {
                filter: { _id: userId },
                update: { $set: { lastActiveAt: parsedDate } }
              }
            });
            keysToUnlink.push(`${USER_ACTIVE_PREFIX}${userId}`);
            syncedUserIds.push(userId);
          }
        } else {
          // Key expired in Redis before sync; mark for cleanup from dirty set
          syncedUserIds.push(userId);
        }
      }

      let syncedCount = 0;
      let errorCount = 0;

      // 3. Perform a single MongoDB bulkWrite operation
      if (bulkOps.length > 0) {
        try {
          const bulkResult = await User.bulkWrite(bulkOps, { ordered: false });
          syncedCount = bulkResult.modifiedCount || bulkResult.nModified || bulkOps.length;
          logger.info(`Batch lastActive sync completed. Updated ${syncedCount} users in database.`);
        } catch (bulkError) {
          logger.error(`Error during User.bulkWrite in syncToDatabase: ${bulkError.message}`);
          errorCount = bulkOps.length;
        }
      }

      // 4. Memory Reclamation & Cleanup
      // Non-blocking UNLINK for updated keys and remove processed user IDs from dirty set via sRem
      if (keysToUnlink.length > 0) {
        await cacheService.unlink(keysToUnlink);
      }

      if (syncedUserIds.length > 0) {
        await cacheService.sRem(DIRTY_SET_KEY, syncedUserIds);
      }

      return { syncedCount, errorCount };
    } catch (error) {
      logger.error(`Unhandled error in UserActivityService.syncToDatabase: ${error.message}`);
      return { syncedCount: 0, errorCount: 1 };
    }
  }

  /**
   * Optimized Multi-User Querying.
   * Accepts an array of user IDs, checks Redis first via mGet, and queries MongoDB for cache misses.
   *
   * @param {string[]} userIds - Array of user IDs
   * @returns {Promise<Record<string, Date|null>>} Map of userId -> lastActiveAt (Date or null)
   */
  async getMultipleLastActive(userIds) {
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return {};
    }

    // Deduplicate and stringify user IDs
    const uniqueUserIds = [...new Set(userIds.map(id => id.toString()))];
    const resultMap = {};
    const missingUserIds = [];

    try {
      if (redisConfig.isConnected()) {
        // Fetch timestamps from Redis via mGet
        const keys = uniqueUserIds.map(id => `${USER_ACTIVE_PREFIX}${id}`);
        const cachedTimestamps = await cacheService.mGet(keys);

        uniqueUserIds.forEach((userId, index) => {
          const rawValue = cachedTimestamps[index];
          if (rawValue) {
            const dateVal = new Date(rawValue);
            if (!isNaN(dateVal.getTime())) {
              resultMap[userId] = dateVal;
            } else {
              missingUserIds.push(userId);
            }
          } else {
            missingUserIds.push(userId);
          }
        });
      } else {
        // If Redis is offline, all user IDs are cache misses
        missingUserIds.push(...uniqueUserIds);
      }

      // For cache misses, query MongoDB in a single query
      if (missingUserIds.length > 0) {
        const dbUsers = await User.find(
          { _id: { $in: missingUserIds } },
          { _id: 1, lastActiveAt: 1 }
        ).lean();

        const dbUserMap = {};
        dbUsers.forEach(u => {
          dbUserMap[u._id.toString()] = u.lastActiveAt ? new Date(u.lastActiveAt) : null;
        });

        // Merge DB results into the result map & backfill Redis for non-null dates
        const backfillPairs = {};
        for (const userId of missingUserIds) {
          const lastActive = dbUserMap[userId] || null;
          resultMap[userId] = lastActive;

          if (lastActive && redisConfig.isConnected()) {
            backfillPairs[`${USER_ACTIVE_PREFIX}${userId}`] = lastActive.toISOString();
          }
        }

        // Backfill Redis in bulk if there were missing hits found in DB
        if (Object.keys(backfillPairs).length > 0) {
          cacheService.mSet(backfillPairs, LAST_ACTIVE_TTL).catch(err => {
            logger.warn(`Failed to backfill Redis lastActive cache: ${err.message}`);
          });
        }
      }

      return resultMap;
    } catch (error) {
      logger.error(`Error in getMultipleLastActive: ${error.message}`);
      return resultMap;
    }
  }

  /**
   * Helper: Fallback direct DB write when Redis is down or unavailable.
   * @private
   */
  async _fallbackDirectDbUpdate(userId, dateObj) {
    try {
      await User.updateOne(
        { _id: userId },
        { $set: { lastActiveAt: dateObj } }
      );
    } catch (error) {
      logger.error(`Direct DB fallback update failed for user ${userId}: ${error.message}`);
    }
  }
}

module.exports = new UserActivityService();
