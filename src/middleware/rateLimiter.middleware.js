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
    this.redisStore = new RedisStore({
      prefix,
      sendCommand: (...args) => getClient().sendCommand(args),
    });
    this.memoryStore = new MemoryStore();
  }

  init(options) {
    if (this.redisStore.init) this.redisStore.init(options);
    if (this.memoryStore.init) this.memoryStore.init(options);
  }

  async increment(key) {
    if (isConnected()) {
      try {
        return await this.redisStore.increment(key);
      } catch (err) { /* fall through to memory */ }
    }
    return this.memoryStore.increment(key);
  }

  async decrement(key) {
    if (isConnected()) {
      try {
        return await this.redisStore.decrement(key);
      } catch (err) { /* fall through */ }
    }
    return this.memoryStore.decrement(key);
  }

  async resetKey(key) {
    if (isConnected()) {
      try {
        await this.redisStore.resetKey(key);
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

module.exports = {
  apiLimiter,
  authLimiter,
  smsLimiter
};
