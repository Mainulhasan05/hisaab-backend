const rateLimit = require('express-rate-limit');
const { MemoryStore } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const ApiResponse = require('../utils/response.util');
const { isConnected, getClient } = require('../config/redis.config');

/**
 * Redis-backed store with in-process fallback.
 * Redis makes limits shared across processes/restarts (required for clustering);
 * when Redis is unavailable the per-process MemoryStore takes over instead of
 * failing requests.
 */
class HybridStore {
  constructor(prefix) {
    this.prefix = prefix;
    // Created lazily: RedisStore's constructor immediately issues SCRIPT LOAD
    // commands, which would reject (and crash via unhandledRejection) when the
    // client is not connected at module load time.
    this.redisStore = null;
    this.memoryStore = new MemoryStore();
    this.options = null;
  }

  init(options) {
    this.options = options;
    if (this.memoryStore.init) this.memoryStore.init(options);
  }

  getRedisStore() {
    if (!isConnected()) return null;
    if (!this.redisStore) {
      this.redisStore = new RedisStore({
        prefix: this.prefix,
        sendCommand: (...args) => {
          const client = getClient();
          if (!client) return Promise.reject(new Error('Redis not connected'));
          return client.sendCommand(args);
        },
      });
      // The constructor's eager SCRIPT LOAD promises reject unhandled if Redis
      // drops mid-load; attach no-op handlers (awaiting them later still throws
      // into our try/catch fallbacks).
      Promise.resolve(this.redisStore.incrementScriptSha).catch(() => {});
      Promise.resolve(this.redisStore.getScriptSha).catch(() => {});
      if (this.options && this.redisStore.init) this.redisStore.init(this.options);
    }
    return this.redisStore;
  }

  async increment(key) {
    const redisStore = this.getRedisStore();
    if (redisStore) {
      try {
        return await redisStore.increment(key);
      } catch (err) { /* fall through to memory */ }
    }
    return this.memoryStore.increment(key);
  }

  async decrement(key) {
    const redisStore = this.getRedisStore();
    if (redisStore) {
      try {
        return await redisStore.decrement(key);
      } catch (err) { /* fall through */ }
    }
    return this.memoryStore.decrement(key);
  }

  async resetKey(key) {
    const redisStore = this.getRedisStore();
    if (redisStore) {
      try {
        await redisStore.resetKey(key);
      } catch (err) { /* fall through */ }
    }
    return this.memoryStore.resetKey(key);
  }
}

/**
 * General API Rate Limiter
 * 300 requests per minute per IP
 */
const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000, // 1 minute
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 300,
  store: new HybridStore('rl:api:'),
  message: {
    success: false,
    statusCode: 429,
    message: 'Too many requests, please try again later.',
    messageBn: 'অনেক বেশি অনুরোধ, কিছুক্ষণ পর চেষ্টা করুন।'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return ApiResponse.tooManyRequests(res, {
      message: 'Too many requests, please try again later.',
      messageBn: 'অনেক বেশি অনুরোধ, কিছুক্ষণ পর চেষ্টা করুন।'
    });
  }
});

/**
 * Auth Rate Limiter (Stricter)
 * 5 requests per minute for login/register
 */
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 5,
  store: new HybridStore('rl:auth:'),
  message: {
    success: false,
    statusCode: 429,
    message: 'Too many login attempts, please try again after a minute.',
    messageBn: 'অনেক বেশি লগইন প্রচেষ্টা, ১ মিনিট পর চেষ্টা করুন।'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return ApiResponse.tooManyRequests(res, {
      message: 'Too many login attempts, please try again after a minute.',
      messageBn: 'অনেক বেশি লগইন প্রচেষ্টা, ১ মিনিট পর চেষ্টা করুন।'
    });
  }
});

/**
 * SMS Rate Limiter
 * 10 SMS requests per minute
 */
const smsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  store: new HybridStore('rl:sms:'),
  message: {
    success: false,
    statusCode: 429,
    message: 'SMS rate limit exceeded, please try again later.',
    messageBn: 'এসএমএস সীমা অতিক্রম, কিছুক্ষণ পর চেষ্টা করুন।'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return ApiResponse.tooManyRequests(res, {
      message: 'SMS rate limit exceeded, please try again later.',
      messageBn: 'এসএমএস সীমা অতিক্রম, কিছুক্ষণ পর চেষ্টা করুন।'
    });
  }
});

/**
 * Telegram Link Token Limiter
 * 10 deep links per 10 minutes per owner.
 *
 * Each call writes a token row, so this is not a courtesy limit. Keyed on the
 * user rather than the IP: several shops behind one broadband connection is
 * the normal case here, and an IP key would let one owner's retries lock out
 * the whole street.
 */
const telegramLinkLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  store: new HybridStore('rl:tglink:'),
  keyGenerator: (req) => String(req.user?._id || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return ApiResponse.tooManyRequests(res, {
      message: 'Too many link attempts, please try again in a few minutes.',
      messageBn: 'অনেকবার চেষ্টা করা হয়েছে, কিছুক্ষণ পর আবার চেষ্টা করুন।'
    });
  }
});

module.exports = {
  apiLimiter,
  authLimiter,
  smsLimiter,
  telegramLinkLimiter
};
