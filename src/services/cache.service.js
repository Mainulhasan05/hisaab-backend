/**
 * Cache Service
 * Unified caching interface with Redis primary and in-memory fallback
 * Designed for high-scale SaaS with millions of users
 */

const { isConnected, getClient, memoryCache, memoryCacheTTL } = require('../config/redis.config');
const logger = require('../utils/logger.util');

class CacheService {
  /**
   * Set a value in cache
   * @param {string} key - Cache key
   * @param {any} value - Value to store (will be JSON stringified)
   * @param {number} ttlSeconds - Time to live in seconds (default: 3600 = 1 hour)
   */
  async set(key, value, ttlSeconds = 3600) {
    const stringValue = JSON.stringify(value);

    if (isConnected()) {
      try {
        const client = getClient();
        await client.setEx(key, ttlSeconds, stringValue);
        return true;
      } catch (error) {
        logger.error('Redis SET error, falling back to memory:', error.message);
      }
    }

    // Fallback to in-memory
    memoryCache.set(key, stringValue);
    memoryCacheTTL.set(key, Date.now() + (ttlSeconds * 1000));
    return true;
  }

  /**
   * Get a value from cache
   * @param {string} key - Cache key
   * @returns {any|null} - Parsed value or null if not found
   */
  async get(key) {
    if (isConnected()) {
      try {
        const client = getClient();
        const value = await client.get(key);
        return value ? JSON.parse(value) : null;
      } catch (error) {
        logger.error('Redis GET error, falling back to memory:', error.message);
      }
    }

    // Fallback to in-memory
    const expiry = memoryCacheTTL.get(key);
    if (expiry && expiry < Date.now()) {
      memoryCache.delete(key);
      memoryCacheTTL.delete(key);
      return null;
    }

    const value = memoryCache.get(key);
    return value ? JSON.parse(value) : null;
  }

  /**
   * Delete a key from cache
   * @param {string} key - Cache key
   */
  async delete(key) {
    if (isConnected()) {
      try {
        const client = getClient();
        await client.del(key);
      } catch (error) {
        logger.error('Redis DEL error:', error.message);
      }
    }

    // Always delete from memory too
    memoryCache.delete(key);
    memoryCacheTTL.delete(key);
    return true;
  }

  /**
   * Delete keys matching a pattern
   * @param {string} pattern - Pattern to match (e.g., 'user:*')
   */
  async deletePattern(pattern) {
    if (isConnected()) {
      try {
        const client = getClient();
        const keys = await client.keys(pattern);
        if (keys.length > 0) {
          await client.del(keys);
        }
      } catch (error) {
        logger.error('Redis DEL pattern error:', error.message);
      }
    }

    // For memory cache, iterate and delete matching keys
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    for (const key of memoryCache.keys()) {
      if (regex.test(key)) {
        memoryCache.delete(key);
        memoryCacheTTL.delete(key);
      }
    }
    return true;
  }

  /**
   * Check if a key exists
   * @param {string} key - Cache key
   */
  async exists(key) {
    if (isConnected()) {
      try {
        const client = getClient();
        return await client.exists(key);
      } catch (error) {
        logger.error('Redis EXISTS error:', error.message);
      }
    }

    // Fallback to memory
    const expiry = memoryCacheTTL.get(key);
    if (expiry && expiry < Date.now()) {
      memoryCache.delete(key);
      memoryCacheTTL.delete(key);
      return false;
    }
    return memoryCache.has(key);
  }

  /**
   * Set multiple key-value pairs
   * @param {Object} keyValuePairs - Object with key-value pairs
   * @param {number} ttlSeconds - TTL for all keys
   */
  async mSet(keyValuePairs, ttlSeconds = 3600) {
    const entries = Object.entries(keyValuePairs);

    if (isConnected()) {
      try {
        const client = getClient();
        const pipeline = client.multi();
        for (const [key, value] of entries) {
          pipeline.setEx(key, ttlSeconds, JSON.stringify(value));
        }
        await pipeline.exec();
        return true;
      } catch (error) {
        logger.error('Redis MSET error, falling back to memory:', error.message);
      }
    }

    // Fallback to in-memory
    const expiryTime = Date.now() + (ttlSeconds * 1000);
    for (const [key, value] of entries) {
      memoryCache.set(key, JSON.stringify(value));
      memoryCacheTTL.set(key, expiryTime);
    }
    return true;
  }

  /**
   * Get multiple values
   * @param {string[]} keys - Array of cache keys
   */
  async mGet(keys) {
    if (isConnected()) {
      try {
        const client = getClient();
        const values = await client.mGet(keys);
        return values.map(v => v ? JSON.parse(v) : null);
      } catch (error) {
        logger.error('Redis MGET error, falling back to memory:', error.message);
      }
    }

    // Fallback to memory
    return keys.map(key => {
      const expiry = memoryCacheTTL.get(key);
      if (expiry && expiry < Date.now()) {
        memoryCache.delete(key);
        memoryCacheTTL.delete(key);
        return null;
      }
      const value = memoryCache.get(key);
      return value ? JSON.parse(value) : null;
    });
  }

  /**
   * Increment a numeric value
   * @param {string} key - Cache key
   * @param {number} amount - Amount to increment (default: 1)
   */
  async incr(key, amount = 1) {
    if (isConnected()) {
      try {
        const client = getClient();
        return await client.incrBy(key, amount);
      } catch (error) {
        logger.error('Redis INCR error, falling back to memory:', error.message);
      }
    }

    // Fallback to memory
    const current = parseInt(memoryCache.get(key) || '0', 10);
    const newValue = current + amount;
    memoryCache.set(key, String(newValue));
    return newValue;
  }

  /**
   * Add to a sorted set (useful for leaderboards, time-series)
   * @param {string} key - Set key
   * @param {number} score - Score for ranking
   * @param {string} member - Member value
   */
  async zAdd(key, score, member) {
    if (isConnected()) {
      try {
        const client = getClient();
        await client.zAdd(key, { score, value: member });
        return true;
      } catch (error) {
        logger.error('Redis ZADD error:', error.message);
      }
    }

    // For memory fallback, store as simple set (no sorting)
    const setKey = `zset:${key}`;
    const existing = memoryCache.get(setKey);
    const set = existing ? JSON.parse(existing) : {};
    set[member] = score;
    memoryCache.set(setKey, JSON.stringify(set));
    return true;
  }

  /**
   * Get members from sorted set with scores
   * @param {string} key - Set key
   * @param {number} start - Start index
   * @param {number} stop - Stop index
   */
  async zRange(key, start, stop) {
    if (isConnected()) {
      try {
        const client = getClient();
        return await client.zRange(key, start, stop);
      } catch (error) {
        logger.error('Redis ZRANGE error:', error.message);
      }
    }

    // Memory fallback
    const setKey = `zset:${key}`;
    const existing = memoryCache.get(setKey);
    if (!existing) return [];
    const set = JSON.parse(existing);
    return Object.keys(set).slice(start, stop + 1);
  }

  /**
   * Remove from sorted set
   * @param {string} key - Set key
   * @param {string} member - Member to remove
   */
  async zRem(key, member) {
    if (isConnected()) {
      try {
        const client = getClient();
        await client.zRem(key, member);
        return true;
      } catch (error) {
        logger.error('Redis ZREM error:', error.message);
      }
    }

    // Memory fallback
    const setKey = `zset:${key}`;
    const existing = memoryCache.get(setKey);
    if (existing) {
      const set = JSON.parse(existing);
      delete set[member];
      memoryCache.set(setKey, JSON.stringify(set));
    }
    return true;
  }

  /**
   * Add to a set
   * @param {string} key - Set key
   * @param {string} member - Member to add
   */
  async sAdd(key, member) {
    if (isConnected()) {
      try {
        const client = getClient();
        await client.sAdd(key, member);
        return true;
      } catch (error) {
        logger.error('Redis SADD error:', error.message);
      }
    }

    // Memory fallback
    const setKey = `set:${key}`;
    const existing = memoryCache.get(setKey);
    const set = existing ? JSON.parse(existing) : [];
    if (!set.includes(member)) {
      set.push(member);
      memoryCache.set(setKey, JSON.stringify(set));
    }
    return true;
  }

  /**
   * Get all members of a set
   * @param {string} key - Set key
   */
  async sMembers(key) {
    if (isConnected()) {
      try {
        const client = getClient();
        return await client.sMembers(key);
      } catch (error) {
        logger.error('Redis SMEMBERS error:', error.message);
      }
    }

    // Memory fallback
    const setKey = `set:${key}`;
    const existing = memoryCache.get(setKey);
    return existing ? JSON.parse(existing) : [];
  }

  /**
   * Remove from set
   * @param {string} key - Set key
   * @param {string} member - Member to remove
   */
  async sRem(key, member) {
    if (isConnected()) {
      try {
        const client = getClient();
        await client.sRem(key, member);
        return true;
      } catch (error) {
        logger.error('Redis SREM error:', error.message);
      }
    }

    // Memory fallback
    const setKey = `set:${key}`;
    const existing = memoryCache.get(setKey);
    if (existing) {
      const set = JSON.parse(existing);
      const index = set.indexOf(member);
      if (index > -1) {
        set.splice(index, 1);
        memoryCache.set(setKey, JSON.stringify(set));
      }
    }
    return true;
  }

  /**
   * Get cache statistics
   */
  async getStats() {
    const stats = {
      backend: isConnected() ? 'redis' : 'memory',
      memorySize: memoryCache.size
    };

    if (isConnected()) {
      try {
        const client = getClient();
        const info = await client.info('stats');
        stats.redisInfo = info;
      } catch (error) {
        logger.error('Error getting Redis stats:', error.message);
      }
    }

    return stats;
  }
}

module.exports = new CacheService();
