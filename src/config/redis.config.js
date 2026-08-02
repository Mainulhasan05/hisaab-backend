/**
 * Redis Configuration
 * Provides Redis client with automatic fallback to in-memory cache
 *
 * Environment Variables:
 * - USE_REDIS=true/false (enable/disable Redis, default: false)
 *
 * Connection Modes (checked in order):
 * 1. Unix Socket (for shared hosting):
 *    - REDIS_SOCKET=/home/user/.redis/redis.sock
 *
 * 2. Host:Port (for VPS/Redis Cloud):
 *    - REDIS_HOST=your-redis-host.com
 *    - REDIS_PORT=6379 (default: 6379)
 *    - REDIS_USERNAME=default (optional)
 *    - REDIS_PASSWORD=your-password
 */

const logger = require('../utils/logger.util');

let redisClient = null;
let isRedisConnected = false;
let connectionMode = 'none'; // 'socket', 'tcp', or 'none'

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
 * Supports both Unix socket and TCP (host:port) connections
 */
function getRedisConfig() {
  const socketPath = process.env.REDIS_SOCKET;
  const host = process.env.REDIS_HOST;
  const port = parseInt(process.env.REDIS_PORT, 10) || 6379;
  const username = process.env.REDIS_USERNAME;
  const password = process.env.REDIS_PASSWORD;

  // Reconnect indefinitely with capped backoff. Returning false here would
  // destroy the client permanently — a >20s Redis blip would silently downgrade
  // the process to per-process memory cache (breaking idempotency locks and
  // token revocation across processes) until someone restarts Node.
  const reconnectStrategy = (retries) => {
    if (retries > 5 && retries % 10 === 0) {
      logger.warn(`Redis still reconnecting (attempt ${retries}); serving from memory cache meanwhile`);
    }
    return Math.min(retries * 200, 10000);
  };

  // Priority 1: Unix Socket (for shared hosting)
  if (socketPath) {
    const fs = require('fs');
    if (!fs.existsSync(socketPath)) {
      logger.warn(`Redis socket file not found at ${socketPath}. Falling back to memory.`);
      connectionMode = 'none';
      return null;
    }
    connectionMode = 'socket';
    return {
      socket: {
        path: socketPath,
        reconnectStrategy,
        connectTimeout: 10000
      },
      disableOfflineQueue: true
    };
  }

  // Priority 2: TCP connection (for VPS/Redis Cloud)
  if (host) {
    connectionMode = 'tcp';
    return {
      socket: {
        host,
        port,
        reconnectStrategy,
        connectTimeout: 10000
      },
      username: username || undefined,
      password: password || undefined,
      disableOfflineQueue: true
    };
  }

  // No valid config
  connectionMode = 'none';
  return null;
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
    logger.warn('Redis enabled but no REDIS_SOCKET or REDIS_HOST configured, using in-memory cache');
    return false;
  }

  try {
    const redis = require('redis');

    const connectionInfo = connectionMode === 'socket'
      ? `Unix socket: ${process.env.REDIS_SOCKET}`
      : `TCP: ${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`;
    logger.info(`Connecting to Redis via ${connectionInfo}...`);

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

// Clean memory cache periodically (every 5 minutes).
// unref() so this timer never keeps the process alive after server.close().
const memoryCacheJanitor = setInterval(cleanExpiredMemoryCache, 5 * 60 * 1000);
memoryCacheJanitor.unref();

// Hard cap on the fallback cache: it must never grow unbounded (it holds
// idempotency bodies, auth entries, presence sets while Redis is down).
// Evicts oldest-inserted entries first — Map preserves insertion order.
const MEMORY_CACHE_MAX_ENTRIES = parseInt(process.env.MEMORY_CACHE_MAX_ENTRIES, 10) || 20000;
function enforceMemoryCacheCap() {
  if (memoryCache.size <= MEMORY_CACHE_MAX_ENTRIES) return;
  const excess = memoryCache.size - MEMORY_CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const key of memoryCache.keys()) {
    memoryCache.delete(key);
    memoryCacheTTL.delete(key);
    if (++removed >= excess) break;
  }
  logger.warn(`Memory cache cap reached — evicted ${removed} oldest entries`);
}

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
    connectionMode, // 'socket', 'tcp', or 'none'
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
  memoryCacheTTL,
  enforceMemoryCacheCap
};
