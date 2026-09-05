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
 * Password Reset Limiter
 * 20 requests per 15 minutes per IP, across all three steps of the flow.
 *
 * ── Why not just reuse `authLimiter` ────────────────────────────────────────
 *
 * `authLimiter` is 5 per MINUTE and is shared by login, register and OTP. A
 * reset costs at least three requests (ask → verify → set), and a shopkeeper
 * who mistypes the code twice is at five before they have finished — so sharing
 * that bucket would 429 the honest case, on the one screen a user reaches
 * precisely because they are already locked out. Worse, it couples the two: a
 * few failed logins would consume the budget for recovering from them.
 *
 * This is the IP-shaped half of the defence only, and deliberately loose: a lot
 * of Bangladeshi mobile traffic leaves through carrier NAT, so a tight per-IP
 * cap punishes a neighbourhood for one person's typing. The half that actually
 * protects a victim from being SMS-bombed is keyed on the PHONE and lives in
 * `AuthService.requestPasswordReset` — a 60-second cooldown and 5 sends an
 * hour, which no amount of IP rotation gets around.
 */
const passwordResetLimiter = rateLimit({
  windowMs: parseInt(process.env.PASSWORD_RESET_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.PASSWORD_RESET_RATE_LIMIT_MAX) || 20,
  store: new HybridStore('rl:pwreset:'),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return ApiResponse.tooManyRequests(res, {
      message: 'Too many password reset attempts. Please try again in a few minutes.',
      messageBn: 'অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।'
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
 * Checkout Limiter — the shop opening a payment session with the gateway.
 * 12 requests per minute, keyed on the SHOP rather than the IP.
 *
 * Keyed on the shop because that is what a gateway session costs us: every
 * `initiate-payment` is an outbound call and a burnt invoice number, and a
 * frustrated owner tapping "Renew" repeatedly on one connection is the exact
 * traffic this bounds. An IP key would also pool every owner behind one
 * carrier NAT into a single bucket.
 *
 * 12 rather than a tighter number because a real renewal legitimately costs
 * several requests — open a session, come back, poll the verification a few
 * times — and a limit that fires during an honest payment is worse than no
 * limit: it strands somebody who has already been charged.
 */
const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.CHECKOUT_RATE_LIMIT_MAX) || 12,
  store: new HybridStore('rl:checkout:'),
  keyGenerator: (req) => String(req.shop?._id || req.user?.shop || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return ApiResponse.tooManyRequests(res, {
      message: 'Too many payment attempts. Please wait a moment and try again.',
      messageBn: 'অনেকবার চেষ্টা করা হয়েছে। একটু পর আবার চেষ্টা করুন।'
    });
  }
});

/**
 * The gateway's return redirect. 60 per minute per IP.
 *
 * Unauthenticated and guessable, so it needs a ceiling — but a generous one,
 * because the cost of a false 429 here is a customer who has PAID being told
 * something went wrong. The handler does no work of its own beyond one
 * server-to-server lookup, and the reconciliation sweep covers anything this
 * turns away, so the limit protects the gateway from us rather than us from
 * the caller.
 */
const paymentReturnLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.PAYMENT_RETURN_RATE_LIMIT_MAX) || 60,
  store: new HybridStore('rl:payret:'),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return ApiResponse.tooManyRequests(res, {
      message: 'Too many requests, please try again in a moment.',
      messageBn: 'কিছুক্ষণ পর আবার চেষ্টা করুন।'
    });
  }
});

/**
 * Public Storefront Limiter
 * 120 requests per minute per IP.
 *
 * ── WHY THIS IS A SEPARATE TIER AND NOT JUST `apiLimiter` ───────────────────
 *
 * `/api/public/*` is the only surface a stranger can reach without a session,
 * and it is the only one whose traffic volume is set by someone other than us —
 * a shop's Facebook post going around, or a bot walking the catalogue. Sharing
 * `apiLimiter`'s bucket would mean a storefront getting hugged to death is
 * accounted against the same counter as the till (ECOMMERCE_PLAN.md §13), and
 * the till is the thing that must never stop.
 *
 * `app.js` therefore SKIPS `apiLimiter` for this prefix rather than stacking
 * the two. One request, one bucket: stacked limiters make a 429 impossible to
 * attribute, and the tighter of the two silently becomes the real limit.
 *
 * 120/min is deliberately below the 300 of `apiLimiter`. A real customer
 * browsing a catalogue on a phone issues a handful of requests per minute; a
 * page that needs more than two per view is a page built wrong. It is per IP,
 * which is imprecise in a country where a lot of mobile traffic leaves through
 * carrier NAT — hence 120 and not 30. When ordering lands, checkout gets its
 * own stricter limit keyed on the PHONE as well as the IP (§13), because that
 * is a write and this is not.
 */
const storefrontLimiter = rateLimit({
  windowMs: parseInt(process.env.STOREFRONT_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: parseInt(process.env.STOREFRONT_RATE_LIMIT_MAX) || 120,
  store: new HybridStore('rl:sf:'),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return ApiResponse.tooManyRequests(res, {
      // Bengali first, and written for a SHOPPER rather than a shopkeeper —
      // this is the one rate-limit message in the app that a customer can see,
      // and "অনুরোধ সীমা" means nothing to someone buying rice.
      message: 'Too many requests, please try again in a moment.',
      messageBn: 'একটু বেশি দ্রুত চাপা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।'
    });
  }
});

/**
 * Does this request belong to the public storefront surface?
 *
 * Read off `originalUrl`, which is the untouched path as it arrived. `req.path`
 * is relative to the current mount point, so inside `app.use('/api', …)` it
 * reads `/public/…` — correct today and quietly wrong the moment the router is
 * mounted somewhere else. The query string is stripped because `originalUrl`
 * carries it and a `?` would break the prefix match.
 */
const isPublicStorefrontPath = (req) =>
  String(req.originalUrl || '').split('?')[0].startsWith('/api/public/');

/**
 * Is this the payment gateway returning a customer's browser to us?
 *
 * Read the same way and for the same reason as the helper above, and used by
 * `app.js` to let this ONE path past the CORS allowlist.
 *
 * ── Why CORS has to be skipped here ─────────────────────────────────────────
 *
 * PayStation's documentation never says whether it returns the customer with a
 * GET redirect or a form POST. A GET navigation carries no `Origin` header and
 * the allowlist waves it through. A cross-site form POST navigation DOES carry
 * one — `https://api.paystation.com.bd` — which is not in `ALLOWED_ORIGINS` and
 * must never be added to it, since that list governs which sites may make
 * credentialed XHR calls against this API.
 *
 * The `cors` callback answers a disallowed origin by calling back with an Error,
 * which the error handler turns into a 500. So on the POST branch a customer
 * whose money had already left their wallet would be shown a server error
 * instead of their renewed subscription — a failure that would only appear in
 * production, only on real payments, and only if PayStation happens to use POST.
 *
 * Skipping CORS here gives nothing away. CORS is a browser-side policy about
 * reading responses; it has never applied to top-level navigations, which is
 * exactly what this request is. The handler itself reads nothing from the
 * request and answers with a redirect, so there is no response body for a
 * hostile origin to want.
 */
const isPaymentReturnPath = (req) =>
  /^\/api\/public\/payments\/[a-z0-9_-]+\/return\//i
    .test(String(req.originalUrl || '').split('?')[0]);

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

/**
 * AI parse limiter — 10 requests per minute.
 *
 * ── THIS IS NOT THE REAL CONTROL ───────────────────────────────────────────
 *
 * The per-branch daily allowance (`Shop.ai.dailyMessageLimit`, default 5) is
 * what actually bounds this feature, and it is enforced in the controller with
 * an atomic reservation. This limiter exists so a client stuck in a retry loop
 * is refused at the door rather than three `findOneAndUpdate`s deep — each of
 * those calls does real work before deciding the branch is out.
 *
 * Set well ABOVE the daily allowance on purpose: a shopkeeper who genuinely has
 * five messages must be able to spend all five in one sitting without meeting a
 * limiter, or the two controls disagree about what the allowance means and the
 * one nobody documented wins.
 */
const aiParseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  store: new HybridStore('rl:ai:'),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return ApiResponse.tooManyRequests(res, {
      message: 'Too many AI requests, please slow down.',
      messageBn: 'একসাথে অনেকবার চেষ্টা করা হয়েছে, একটু পরে আবার করুন।'
    });
  }
});

module.exports = {
  apiLimiter,
  authLimiter,
  passwordResetLimiter,
  smsLimiter,
  aiParseLimiter,
  storefrontLimiter,
  checkoutLimiter,
  paymentReturnLimiter,
  isPublicStorefrontPath,
  isPaymentReturnPath,
  telegramLinkLimiter
};
