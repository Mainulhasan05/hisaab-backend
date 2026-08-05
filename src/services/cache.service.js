/**
 * Cache Service
 * Unified caching interface with Redis primary and in-memory fallback
 * Designed for high-scale SaaS with millions of users
 */

const { isConnected, getClient, memoryCache, memoryCacheTTL, enforceMemoryCacheCap } = require('../config/redis.config');
const logger = require('../utils/logger.util');

// Every memory-fallback write MUST carry a TTL and respect the size cap —
// TTL-less entries were invisible to the janitor and leaked until restart.
const MEMORY_FALLBACK_DEFAULT_TTL_SECONDS = 24 * 60 * 60;
function memWrite(key, stringValue, ttlSeconds = MEMORY_FALLBACK_DEFAULT_TTL_SECONDS) {
  memoryCache.set(key, stringValue);
  memoryCacheTTL.set(key, Date.now() + (ttlSeconds * 1000));
  enforceMemoryCacheCap();
}

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
    memWrite(key, stringValue, ttlSeconds);
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
   * Uses SCAN instead of KEYS to avoid blocking Redis.
   * WARNING: SCAN MATCH still iterates the ENTIRE keyspace — cost is O(total keys),
   * not O(matches). Do NOT call this on hot paths (checkout, auth). Use versioned
   * keys (bumpShopCacheVersion) or explicit key deletes instead. This remains only
   * for admin tooling and rare administrative invalidations.
   * @param {string} pattern - Pattern to match (e.g., 'user:*')
   */
  async deletePattern(pattern) {
    if (isConnected()) {
      try {
        const client = getClient();
        // Use SCAN cursor to find matching keys without blocking Redis
        const keysToDelete = [];
        for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 1000 })) {
          keysToDelete.push(key);
        }
        if (keysToDelete.length > 0) {
          await client.del(keysToDelete);
        }
      } catch (error) {
        logger.error('Redis DEL pattern error:', error.message);
      }
    }

    // For memory cache, iterate and delete matching keys
    const regex = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    for (const key of memoryCache.keys()) {
      if (regex.test(key)) {
        memoryCache.delete(key);
        memoryCacheTTL.delete(key);
      }
    }
    return true;
  }

  /**
   * Set a value only if the key does not already exist (atomic).
   * @param {string} key - Cache key
   * @param {any} value - Value to store
   * @param {number} ttlSeconds - Time to live in seconds
   * @returns {boolean} true if the key was set, false if it already existed
   */
  async setNX(key, value, ttlSeconds) {
    if (isConnected()) {
      try {
        const client = getClient();
        const result = await client.set(key, JSON.stringify(value), { NX: true, EX: ttlSeconds });
        return result === 'OK';
      } catch (error) {
        logger.error('Redis SETNX error, falling back to memory:', error.message);
      }
    }

    // Memory fallback
    const expiry = memoryCacheTTL.get(key);
    if (memoryCache.has(key) && (!expiry || expiry > Date.now())) {
      return false;
    }
    memWrite(key, JSON.stringify(value), ttlSeconds);
    return true;
  }

  /**
   * Current cache version for a shop. Readers embed this in their cache keys
   * (e.g. `shop:{id}:dashboard:v{ver}`) so invalidation is a single O(1) INCR
   * instead of a keyspace SCAN; superseded entries simply age out via TTL.
   * @param {string} shopId
   * @returns {number} current version
   */
  async getShopCacheVersion(shopId) {
    const key = `shop:${shopId}:cachev`;
    let version = await this.get(key);
    if (version == null) {
      version = await this.incr(key);
    }
    return version;
  }

  /**
   * Invalidate all versioned cache entries for a shop by bumping its version.
   * Debounced: bumps at most once per `debounceSeconds` so report caches survive
   * bursts of writes (dashboards tolerate ≤30s staleness).
   * @param {string} shopId
   * @param {number} debounceSeconds - minimum interval between bumps (default 30)
   * @returns {boolean} true if the version was bumped, false if debounced
   */
  async bumpShopCacheVersion(shopId, debounceSeconds = 30) {
    const guardKey = `shop:${shopId}:cachev:guard`;
    const acquired = await this.setNX(guardKey, 1, debounceSeconds);
    if (!acquired) return false;
    await this.incr(`shop:${shopId}:cachev`);
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
    for (const [key, value] of entries) {
      memWrite(key, JSON.stringify(value), ttlSeconds);
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
    const existingExpiry = memoryCacheTTL.get(key);
    memoryCache.set(key, String(newValue));
    memoryCacheTTL.set(key, existingExpiry || (Date.now() + MEMORY_FALLBACK_DEFAULT_TTL_SECONDS * 1000));
    enforceMemoryCacheCap();
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
    memWrite(setKey, JSON.stringify(set));
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
      memWrite(setKey, JSON.stringify(set));
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
   * Remove member(s) from set
   * @param {string} key - Set key
   * @param {string|string[]} members - Member or array of members to remove
   */
  async sRem(key, members) {
    const memberArray = Array.isArray(members) ? members : [members];
    if (memberArray.length === 0) return true;

    if (isConnected()) {
      try {
        const client = getClient();
        await client.sRem(key, memberArray);
        return true;
      } catch (error) {
        logger.error('Redis SREM error:', error.message);
      }
    }

    // Memory fallback
    const setKey = `set:${key}`;
    const existing = memoryCache.get(setKey);
    if (existing) {
      let set = JSON.parse(existing);
      set = set.filter(item => !memberArray.includes(item));
      memoryCache.set(setKey, JSON.stringify(set));
    }
    return true;
  }

  /**
   * Non-blocking delete of one or more keys using UNLINK in Redis.
   * Async reclamation of memory without blocking the main event thread.
   * @param {string|string[]} keys - Key or array of keys to unlink
   */
  async unlink(keys) {
    const keyArray = Array.isArray(keys) ? keys : [keys];
    if (keyArray.length === 0) return true;

    if (isConnected()) {
      try {
        const client = getClient();
        if (typeof client.unlink === 'function') {
          await client.unlink(keyArray);
        } else {
          await client.del(keyArray);
        }
      } catch (error) {
        logger.error('Redis UNLINK error:', error.message);
      }
    }

    // Memory fallback cleanup
    for (const key of keyArray) {
      memoryCache.delete(key);
      memoryCacheTTL.delete(key);
    }
    return true;
  }

  /**
   * Get cache statistics for admin dashboard
   */
  async getStats() {
    const { getCacheInfo } = require('../config/redis.config');
    const cacheInfo = getCacheInfo();

    const stats = {
      backend: cacheInfo.backend,
      redisEnabled: cacheInfo.redisEnabled,
      redisConnected: cacheInfo.redisConnected,
      memoryCacheSize: cacheInfo.memoryCacheSize,
      timestamp: Date.now(),
    };

    if (isConnected()) {
      try {
        const client = getClient();

        // Get comprehensive Redis info
        const [infoStats, infoMemory, infoClients, dbSize] = await Promise.all([
          client.info('stats'),
          client.info('memory'),
          client.info('clients'),
          client.dbSize(),
        ]);

        // Parse Redis info sections
        const parseInfo = (info) => {
          const result = {};
          info.split('\r\n').forEach(line => {
            if (line && !line.startsWith('#')) {
              const [key, value] = line.split(':');
              if (key && value) {
                result[key] = isNaN(value) ? value : parseFloat(value);
              }
            }
          });
          return result;
        };

        const statsData = parseInfo(infoStats);
        const memoryData = parseInfo(infoMemory);
        const clientsData = parseInfo(infoClients);

        stats.redis = {
          // Key stats
          totalKeys: dbSize,

          // Memory
          usedMemory: memoryData.used_memory,
          usedMemoryHuman: memoryData.used_memory_human,
          usedMemoryPeak: memoryData.used_memory_peak,
          usedMemoryPeakHuman: memoryData.used_memory_peak_human,

          // Connections
          connectedClients: clientsData.connected_clients,

          // Operations
          totalCommandsProcessed: statsData.total_commands_processed,
          opsPerSec: statsData.instantaneous_ops_per_sec,

          // Cache hits/misses
          keyspaceHits: statsData.keyspace_hits,
          keyspaceMisses: statsData.keyspace_misses,
          hitRate: statsData.keyspace_hits && statsData.keyspace_misses
            ? ((statsData.keyspace_hits / (statsData.keyspace_hits + statsData.keyspace_misses)) * 100).toFixed(2)
            : 0,

          // Uptime
          uptimeInSeconds: statsData.uptime_in_seconds,
          uptimeInDays: statsData.uptime_in_days,
        };
      } catch (error) {
        logger.error('Error getting Redis stats:', error.message);
        stats.redisError = error.message;
      }
    }

    return stats;
  }

  /**
   * Test Redis connection
   */
  async ping() {
    if (isConnected()) {
      try {
        const client = getClient();
        const result = await client.ping();
        return { success: true, response: result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Redis not connected' };
  }

  /**
   * List all keys with optional pattern filtering
   * @param {string} pattern - Pattern to match (default: '*')
   * @param {number} limit - Max keys to return (default: 100)
   */
  async listKeys(pattern = '*', limit = 100) {
    const keys = [];

    if (isConnected()) {
      try {
        const client = getClient();
        const allKeys = await client.keys(pattern);

        // Get TTL for each key (limited)
        for (const key of allKeys.slice(0, limit)) {
          const ttl = await client.ttl(key);
          const type = await client.type(key);
          keys.push({
            key,
            type,
            ttl: ttl === -1 ? 'no expiry' : ttl === -2 ? 'expired' : `${ttl}s`,
            ttlSeconds: ttl,
          });
        }

        return {
          backend: 'redis',
          total: allKeys.length,
          showing: keys.length,
          keys,
        };
      } catch (error) {
        logger.error('Error listing keys:', error.message);
        throw error;
      }
    }

    // Memory cache fallback
    for (const [key] of memoryCache.entries()) {
      if (pattern === '*' || key.includes(pattern.replace(/\*/g, ''))) {
        const expiry = memoryCacheTTL.get(key);
        const ttlMs = expiry ? expiry - Date.now() : -1;
        keys.push({
          key,
          type: 'string',
          ttl: ttlMs <= 0 ? 'expired' : `${Math.round(ttlMs / 1000)}s`,
          ttlSeconds: Math.round(ttlMs / 1000),
        });
        if (keys.length >= limit) break;
      }
    }

    return {
      backend: 'memory',
      total: memoryCache.size,
      showing: keys.length,
      keys,
    };
  }

  /**
   * Get details of a specific key
   * @param {string} key - Cache key
   */
  async getKeyDetails(key) {
    if (isConnected()) {
      try {
        const client = getClient();
        const [type, ttl, value] = await Promise.all([
          client.type(key),
          client.ttl(key),
          client.get(key),
        ]);

        let parsedValue = value;
        let size = value ? Buffer.byteLength(value, 'utf8') : 0;

        try {
          parsedValue = JSON.parse(value);
        } catch {
          // Keep as string if not JSON
        }

        return {
          key,
          type,
          ttl: ttl === -1 ? 'no expiry' : ttl === -2 ? 'not found' : `${ttl}s`,
          ttlSeconds: ttl,
          size: this._formatBytes(size),
          sizeBytes: size,
          value: parsedValue,
        };
      } catch (error) {
        logger.error('Error getting key details:', error.message);
        throw error;
      }
    }

    // Memory cache fallback
    const value = memoryCache.get(key);
    const expiry = memoryCacheTTL.get(key);
    const ttlMs = expiry ? expiry - Date.now() : -1;

    let parsedValue = value;
    try {
      parsedValue = JSON.parse(value);
    } catch {
      // Keep as string
    }

    return {
      key,
      type: 'string',
      ttl: ttlMs <= 0 ? 'expired' : `${Math.round(ttlMs / 1000)}s`,
      ttlSeconds: Math.round(ttlMs / 1000),
      size: value ? this._formatBytes(Buffer.byteLength(value, 'utf8')) : '0 B',
      sizeBytes: value ? Buffer.byteLength(value, 'utf8') : 0,
      value: parsedValue,
    };
  }

  /**
   * Flush all cache data
   */
  async flushAll() {
    if (isConnected()) {
      try {
        const client = getClient();
        await client.flushDb();
        logger.info('Redis cache flushed');
        return { success: true, backend: 'redis', message: 'Cache flushed successfully' };
      } catch (error) {
        logger.error('Error flushing Redis:', error.message);
        throw error;
      }
    }

    // Memory cache fallback
    memoryCache.clear();
    memoryCacheTTL.clear();
    logger.info('Memory cache flushed');
    return { success: true, backend: 'memory', message: 'Memory cache flushed successfully' };
  }

  /**
   * Get grouped cache summary by key prefix
   */
  async getCacheSummary() {
    const summary = {
      byPrefix: {},
      totalKeys: 0,
      totalSize: 0,
    };

    if (isConnected()) {
      try {
        const client = getClient();
        const allKeys = await client.keys('*');
        summary.totalKeys = allKeys.length;

        // Group by prefix (first part before ':')
        for (const key of allKeys) {
          const prefix = key.split(':')[0];
          if (!summary.byPrefix[prefix]) {
            summary.byPrefix[prefix] = { count: 0, keys: [] };
          }
          summary.byPrefix[prefix].count++;
          if (summary.byPrefix[prefix].keys.length < 5) {
            summary.byPrefix[prefix].keys.push(key);
          }
        }

        // Get memory info
        const memInfo = await client.info('memory');
        const memMatch = memInfo.match(/used_memory:(\d+)/);
        if (memMatch) {
          summary.totalSize = parseInt(memMatch[1], 10);
          summary.totalSizeHuman = this._formatBytes(summary.totalSize);
        }
      } catch (error) {
        logger.error('Error getting cache summary:', error.message);
        throw error;
      }
    } else {
      // Memory cache
      summary.totalKeys = memoryCache.size;
      for (const [key, value] of memoryCache.entries()) {
        const prefix = key.split(':')[0];
        if (!summary.byPrefix[prefix]) {
          summary.byPrefix[prefix] = { count: 0, keys: [] };
        }
        summary.byPrefix[prefix].count++;
        if (summary.byPrefix[prefix].keys.length < 5) {
          summary.byPrefix[prefix].keys.push(key);
        }
        summary.totalSize += Buffer.byteLength(value, 'utf8');
      }
      summary.totalSizeHuman = this._formatBytes(summary.totalSize);
    }

    return summary;
  }

  /**
   * Helper to format bytes
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

module.exports = new CacheService();
