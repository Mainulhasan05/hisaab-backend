const rateLimit = require('express-rate-limit');
const ApiResponse = require('../utils/response.util');

/**
 * General API Rate Limiter
 * 100 requests per minute
 */
const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000, // 1 minute
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
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
