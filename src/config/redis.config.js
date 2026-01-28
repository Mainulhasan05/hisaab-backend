/**
 * Redis Configuration
 * Provides Redis client with automatic fallback to in-memory cache
 *
 * Environment Variables:
 * - USE_REDIS=true/false (enable/disable Redis, default: false)
 * - REDIS_HOST=your-redis-host.com
 * - REDIS_PORT=6379 (default: 6379)
 * - REDIS_USERNAME=default (optional)
 * - REDIS_PASSWORD=your-password
 */

const logger = require('../utils/logger.util');

let redisClient = null;
let isRedisConnected = false;

// In-memory cache as fallback
const memoryCache = new Map();
const memoryCacheTTL = new Map(); // Store TTL expiry timestamps

/**
 * Check if Redis is enabled via environment variable
 */
function isRedisEnabled() {
  const useRedis = process.env.USE_REDIS;
  return useRedis === 'true' || useRedis === '1';
}

/**
 * Build Redis connection config from environment variables
 */
function getRedisConfig() {
  const host = process.env.REDIS_HOST;
  const port = parseInt(process.env.REDIS_PORT, 10) || 6379;
  const username = process.env.REDIS_USERNAME;
  const password = process.env.REDIS_PASSWORD;

  if (!host) {
    return null;
  }

  return {
    socket: {
      host,
      port,
      reconnectStrategy: (retries) => {
        if (retries > 10) {
          logger.warn('Redis max reconnection attempts reached, falling back to memory');
          return false;
        }
        return Math.min(retries * 100, 3000);
      },
      connectTimeout: 10000
    },
    username: username || undefined,
    password: password || undefined
  };
}

/**
 * Initialize Redis connection
 * Falls back to in-memory if Redis is unavailable or disabled
 */
async function initializeRedis() {
  // Check if Redis is enabled
  if (!isRedisEnabled()) {
    logger.info('Redis disabled (USE_REDIS=false), using in-memory cache');
    return false;
  }

  const config = getRedisConfig();

  if (!config) {
    logger.warn('Redis enabled but REDIS_HOST not configured, using in-memory cache');
    return false;
  }

  try {
    const redis = require('redis');

    logger.info(`Connecting to Redis at ${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}...`);

    redisClient = redis.createClient(config);

    redisClient.on('error', (err) => {
      logger.error('Redis error:', err.message);
      isRedisConnected = false;
    });

    redisClient.on('connect', () => {
      logger.info('Redis connected successfully');
      isRedisConnected = true;
    });

    redisClient.on('ready', () => {
      logger.info('Redis ready to accept commands');
    });

    redisClient.on('reconnecting', () => {
      logger.warn('Redis reconnecting...');
    });

    redisClient.on('end', () => {
      logger.warn('Redis connection ended, falling back to memory');
      isRedisConnected = false;
    });

    await redisClient.connect();
    isRedisConnected = true;

    // Test connection with PING
    const pong = await redisClient.ping();
    if (pong === 'PONG') {
      logger.info('Redis PING successful');
    }

    return true;
  } catch (error) {
    logger.error('Redis connection failed:', error.message);
    logger.info('Falling back to in-memory cache');
    isRedisConnected = false;
    redisClient = null;
    return false;
  }
}

/**
 * Clean expired entries from memory cache
 */
function cleanExpiredMemoryCache() {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, expiry] of memoryCacheTTL.entries()) {
    if (expiry && expiry < now) {
      memoryCache.delete(key);
      memoryCacheTTL.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.debug(`Cleaned ${cleaned} expired entries from memory cache`);
  }
}

// Clean memory cache periodically (every 5 minutes)
setInterval(cleanExpiredMemoryCache, 5 * 60 * 1000);

/**
 * Get Redis client status
 */
function isConnected() {
  return isRedisConnected && redisClient?.isOpen;
}

/**
 * Get the Redis client (or null if not connected)
 */
function getClient() {
  return isConnected() ? redisClient : null;
}

/**
 * Get memory cache reference (for direct access if needed)
 */
function getMemoryCache() {
  return memoryCache;
}

/**
 * Get current cache backend info
 */
function getCacheInfo() {
  return {
    backend: isConnected() ? 'redis' : 'memory',
    redisEnabled: isRedisEnabled(),
    redisConnected: isConnected(),
    memoryCacheSize: memoryCache.size
  };
}

/**
 * Graceful shutdown
 */
async function closeConnection() {
  if (redisClient) {
    try {
      await redisClient.quit();
      logger.info('Redis connection closed');
      redisClient = null;
      isRedisConnected = false;
    } catch (error) {
      logger.error('Error closing Redis connection:', error.message);
    }
  }
}

module.exports = {
  initializeRedis,
  isConnected,
  isRedisEnabled,
  getClient,
  getMemoryCache,
  getCacheInfo,
  closeConnection,
  memoryCache,
  memoryCacheTTL
};
