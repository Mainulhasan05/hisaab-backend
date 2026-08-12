/**
 * Online Tracking Service
 * Tracks user online status using Redis/memory cache
 * Designed for millions of users with minimal database impact
 */

const cacheService = require('./cache.service');
const logger = require('../utils/logger.util');

// Constants
const ONLINE_TTL = 90; // 90 seconds - slightly longer than 1 minute heartbeat
const ONLINE_USERS_KEY = 'online:users'; // Set of all online user IDs
const SHOP_ONLINE_PREFIX = 'online:shop:'; // Set of online users per shop

class OnlineTrackingService {
  /**
   * Record user heartbeat (called every minute from frontend)
   * @param {string} userId - User ID
   * @param {string} shopId - Shop ID
   * @param {Object} metadata - Additional tracking data
   */
  async recordHeartbeat(userId, shopId, metadata = {}) {
    try {
      const now = Date.now();
      const userKey = `online:user:${userId}`;

      // Store user online data with TTL
      const userData = {
        userId,
        shopId,
        lastSeen: now,
        ...metadata
      };

      // Presence record + both set memberships in ONE round trip. These were
      // three sequential awaits, on a path every client hits once a minute.
      const ops = [
        { type: 'set', key: userKey, value: userData, ttl: ONLINE_TTL },
        { type: 'sAdd', key: ONLINE_USERS_KEY, member: userId },
      ];
      if (shopId) {
        ops.push({ type: 'sAdd', key: `${SHOP_ONLINE_PREFIX}${shopId}`, member: userId });
      }
      await cacheService.pipeline(ops);

      return { success: true, timestamp: now };
    } catch (error) {
      logger.error('Error recording heartbeat:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if a user is online
   * @param {string} userId - User ID
   */
  async isUserOnline(userId) {
    try {
      const userKey = `online:user:${userId}`;
      const userData = await cacheService.get(userKey);
      return !!userData;
    } catch (error) {
      logger.error('Error checking user online status:', error.message);
      return false;
    }
  }

  /**
   * Get user's last seen data
   * @param {string} userId - User ID
   */
  async getUserStatus(userId) {
    try {
      const userKey = `online:user:${userId}`;
      const userData = await cacheService.get(userKey);

      if (userData) {
        return {
          isOnline: true,
          ...userData
        };
      }

      return {
        isOnline: false,
        userId,
        lastSeen: null
      };
    } catch (error) {
      logger.error('Error getting user status:', error.message);
      return { isOnline: false, userId };
    }
  }

  /**
   * Get all online users for a shop
   * @param {string} shopId - Shop ID
   */
  async getShopOnlineUsers(shopId) {
    try {
      const setKey = `${SHOP_ONLINE_PREFIX}${shopId}`;
      const onlineUserIds = await cacheService.sMembers(setKey);
      if (!onlineUserIds || onlineUserIds.length === 0) return [];

      // One pipelined MGET instead of one round trip per member. This was a
      // sequential `await cacheService.get(...)` inside the loop, so the call
      // cost one Redis RTT per online user and grew with adoption — on an
      // endpoint the admin dashboard polls.
      const userDataList = await cacheService.mGet(
        onlineUserIds.map((id) => `online:user:${id}`)
      );

      const onlineUsers = [];
      const staleIds = [];
      onlineUserIds.forEach((userId, i) => {
        const userData = userDataList[i];
        if (userData) onlineUsers.push(userData);
        else staleIds.push(userId); // TTL expired — drop from the shop set
      });

      // Single SREM with the whole batch; sRem already accepts an array.
      if (staleIds.length > 0) {
        await cacheService.sRem(setKey, staleIds);
      }

      return onlineUsers;
    } catch (error) {
      logger.error('Error getting shop online users:', error.message);
      return [];
    }
  }

  /**
   * Get online user count for a shop
   * @param {string} shopId - Shop ID
   */
  async getShopOnlineCount(shopId) {
    try {
      const onlineUsers = await this.getShopOnlineUsers(shopId);
      return onlineUsers.length;
    } catch (error) {
      logger.error('Error getting shop online count:', error.message);
      return 0;
    }
  }

  /**
   * Get total online users count (system-wide)
   */
  async getTotalOnlineCount() {
    try {
      const allUserIds = await cacheService.sMembers(ONLINE_USERS_KEY);
      if (!allUserIds || allUserIds.length === 0) return 0;

      // Was one `isUserOnline()` call — and therefore one Redis round trip —
      // per user, PLATFORM-WIDE, on a polled admin endpoint. At 500 concurrent
      // users that is 500 serialized round trips per poll. One MGET instead.
      const presence = await cacheService.mGet(
        allUserIds.map((id) => `online:user:${id}`)
      );

      const staleIds = [];
      let count = 0;
      presence.forEach((data, i) => {
        if (data) count++;
        else staleIds.push(allUserIds[i]); // expired — drop from the global set
      });

      if (staleIds.length > 0) {
        await cacheService.sRem(ONLINE_USERS_KEY, staleIds);
      }

      return count;
    } catch (error) {
      logger.error('Error getting total online count:', error.message);
      return 0;
    }
  }

  /**
   * Mark user as offline (e.g., on logout)
   * @param {string} userId - User ID
   * @param {string} shopId - Shop ID (optional)
   */
  async markOffline(userId, shopId = null) {
    try {
      const userKey = `online:user:${userId}`;

      // Get user data to find shopId if not provided
      if (!shopId) {
        const userData = await cacheService.get(userKey);
        shopId = userData?.shopId;
      }

      // Remove from all tracking
      await cacheService.delete(userKey);
      await cacheService.sRem(ONLINE_USERS_KEY, userId);

      if (shopId) {
        await cacheService.sRem(`${SHOP_ONLINE_PREFIX}${shopId}`, userId);
      }

      return { success: true };
    } catch (error) {
      logger.error('Error marking user offline:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get online statistics for admin dashboard
   */
  async getOnlineStats() {
    try {
      const totalOnline = await this.getTotalOnlineCount();

      return {
        totalOnline,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error('Error getting online stats:', error.message);
      return { totalOnline: 0, timestamp: Date.now() };
    }
  }

  /**
   * Get multiple users' online status
   * @param {string[]} userIds - Array of user IDs
   */
  async bulkGetStatus(userIds) {
    try {
      const results = {};

      // Batch get all user data
      const keys = userIds.map(id => `online:user:${id}`);
      const userData = await cacheService.mGet(keys);

      userIds.forEach((userId, index) => {
        const data = userData[index];
        results[userId] = data ? { isOnline: true, ...data } : { isOnline: false };
      });

      return results;
    } catch (error) {
      logger.error('Error bulk getting user status:', error.message);
      return {};
    }
  }

  /**
   * Track user activity type (page views, actions)
   * Stores aggregated counts, not individual events
   * @param {string} userId - User ID
   * @param {string} activity - Activity type (e.g., 'sale_create', 'product_view')
   */
  async trackActivity(userId, activity) {
    try {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const key = `activity:${userId}:${today}`;

      // Increment activity count
      const currentData = await cacheService.get(key) || {};
      currentData[activity] = (currentData[activity] || 0) + 1;
      currentData.lastActivity = Date.now();

      // Keep for 7 days
      await cacheService.set(key, currentData, 7 * 24 * 60 * 60);

      return true;
    } catch (error) {
      logger.error('Error tracking activity:', error.message);
      return false;
    }
  }

  /**
   * Get user's activity summary for a day
   * @param {string} userId - User ID
   * @param {string} date - Date in YYYY-MM-DD format (optional, defaults to today)
   */
  async getUserActivitySummary(userId, date = null) {
    try {
      const targetDate = date || new Date().toISOString().split('T')[0];
      const key = `activity:${userId}:${targetDate}`;
      return await cacheService.get(key) || {};
    } catch (error) {
      logger.error('Error getting activity summary:', error.message);
      return {};
    }
  }
}

module.exports = new OnlineTrackingService();
