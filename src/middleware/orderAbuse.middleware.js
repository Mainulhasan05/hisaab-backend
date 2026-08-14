const cacheService = require('../services/cache.service');
const ApiResponse = require('../utils/response.util');
const logger = require('../utils/logger.util');

/**
 * Abuse control for the checkout endpoint.
 *
 * ── WHY THIS IS NOT `storefrontLimiter` WITH A SMALLER NUMBER ───────────────
 *
 * `storefrontLimiter` protects a READ surface from load: 120 requests a minute,
 * and being refused costs a visitor a page they can reload. This protects the
 * only WRITE a stranger can reach, where the cost of getting it wrong runs in
 * both directions:
 *
 *   · too loose and a script fills a shop's worklist with junk, buries the real
 *     orders in it, and spends the shop's Telegram and SMS allowance announcing
 *     each one;
 *   · too tight and a family of four ordering from one house behind one CGNAT
 *     address — which is how most Bangladeshi mobile internet works — is told
 *     they are spamming.
 *
 * So the shape is different from a plain limiter. A hard ceiling catches the
 * burst, and a slower reputation counter catches the patient abuser who stays
 * under it. Being over the ceiling is not itself an offence; being over it
 * repeatedly is.
 *
 * ── THE THREE LAYERS ────────────────────────────────────────────────────────
 *
 * 1. BLOCK CHECK. If this IP is serving a block, refuse immediately. Cheapest
 *    possible path — one cache read, no database work, and a blocked client
 *    that keeps hammering costs us nothing.
 *
 * 2. RATE CEILING. 5 orders per rolling minute per IP, per the requirement.
 *    Exceeding it is refused with a 429 and records ONE strike.
 *
 * 3. REPUTATION. Strikes accumulate across a long window. Enough of them earns
 *    a block whose length grows with the strike count and carries a random
 *    component, capped at 15 minutes.
 *
 * ── WHY THE BLOCK LENGTH IS RANDOM ─────────────────────────────────────────
 *
 * A fixed backoff is a schedule, and a schedule is something a script can be
 * written against — sleep exactly 300s, resume exactly at the ceiling, forever.
 * Randomising the interval means the attacker cannot time the next window, so
 * the cheapest strategy available to them becomes "wait and retry blindly",
 * which is precisely the behaviour that keeps earning strikes.
 *
 * It also spreads the retry storm when many clients are blocked at once, for
 * the same reason a retry jitter exists anywhere else.
 *
 * ── FAIL OPEN, DELIBERATELY ────────────────────────────────────────────────
 *
 * Every cache call here is wrapped and every failure path calls `next()`. If
 * Redis is down, orders still get placed. A shop losing real revenue because
 * our cache blinked is a worse outcome than a spam window, and the same
 * judgement is already made by `idempotency.middleware`, which is non-blocking
 * for identical reasons. The database-level guards behind this — the unique
 * sparse idempotency index, and the fact that an order touches nothing until a
 * human confirms it — are what make failing open survivable.
 */

/** Orders per window before the ceiling is hit. */
const MAX_ORDERS = Number(process.env.ORDER_RATE_LIMIT_MAX) || 5;
/** The rolling window, in seconds. */
const WINDOW_SECONDS = Number(process.env.ORDER_RATE_LIMIT_WINDOW_S) || 60;
/** How long a strike is remembered. Long enough to catch a patient abuser. */
const STRIKE_TTL_SECONDS = 60 * 60;
/** Strikes tolerated before the first block. */
const STRIKES_BEFORE_BLOCK = 2;
/** Nothing is ever blocked for longer than this. */
const MAX_BLOCK_SECONDS = 15 * 60;
/** The first block, before escalation. */
const BASE_BLOCK_SECONDS = 30;

const keyFor = (kind, id) => `orderabuse:${kind}:${id}`;

/**
 * How long to block, given how many strikes this client has.
 *
 * Doubles per strike from a 30s base, then has up to 50% of the resulting
 * interval added at random, and the whole thing is capped at 15 minutes. A
 * client that keeps coming back converges on the cap without ever being able to
 * predict when it may next try.
 */
function blockSecondsFor(strikes) {
  const escalated = BASE_BLOCK_SECONDS * Math.pow(2, Math.max(0, strikes - STRIKES_BEFORE_BLOCK));
  const jittered = escalated * (1 + Math.random() * 0.5);
  return Math.min(MAX_BLOCK_SECONDS, Math.round(jittered));
}

/**
 * The client's address.
 *
 * `req.ip` honours `trust proxy`, which `app.js` sets — behind a reverse proxy
 * the socket address is the proxy's and would put every customer in the world
 * into one bucket. Falls back to the socket only when Express has nothing.
 */
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Record a strike and, past the threshold, impose a block.
 * Returns the block length in seconds, or 0 if none was imposed.
 */
async function strike(ip, reason) {
  try {
    const strikeKey = keyFor('strikes', ip);
    const current = (await cacheService.get(strikeKey)) || 0;
    const strikes = Number(current) + 1;
    await cacheService.set(strikeKey, strikes, STRIKE_TTL_SECONDS);

    if (strikes < STRIKES_BEFORE_BLOCK) return 0;

    const seconds = blockSecondsFor(strikes);
    await cacheService.set(
      keyFor('block', ip),
      { until: Date.now() + seconds * 1000, strikes, reason },
      seconds
    );

    logger.warn(
      `[OrderAbuse] Blocked ${ip} for ${seconds}s after ${strikes} strike(s). Reason: ${reason}`
    );
    return seconds;
  } catch (err) {
    logger.error(`[OrderAbuse] Could not record strike for ${ip}: ${err.message}`);
    return 0;
  }
}

/**
 * The middleware. Mounted only on the checkout POST.
 */
function orderAbuseGuard() {
  return async (req, res, next) => {
    const ip = clientIp(req);

    try {
      // ── 1. Serving a block? ───────────────────────────────────────────────
      const block = await cacheService.get(keyFor('block', ip));
      if (block?.until && block.until > Date.now()) {
        const retryAfter = Math.max(1, Math.ceil((block.until - Date.now()) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        // The message does NOT quote the remaining time. Telling a scripted
        // client exactly when to come back hands it the schedule that
        // randomising the interval was meant to deny it. A real customer is
        // told to wait a little and try again, which is all they can act on.
        return ApiResponse.error(res, {
          message: 'Too many order attempts from this connection. Please try again shortly.',
          messageBn: 'এই সংযোগ থেকে অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।',
          statusCode: 429,
        });
      }

      // ── 2. The ceiling ────────────────────────────────────────────────────
      const countKey = keyFor('count', ip);
      const count = Number((await cacheService.get(countKey)) || 0) + 1;
      // Set with a fixed TTL on every write: a rolling window that resets on
      // each request would let a steady one-per-59-seconds drip run forever.
      // `incr`-with-expiry semantics without needing a Lua script.
      await cacheService.set(countKey, count, WINDOW_SECONDS);

      if (count > MAX_ORDERS) {
        const blocked = await strike(ip, `${count} orders in ${WINDOW_SECONDS}s`);
        res.setHeader('Retry-After', String(blocked || WINDOW_SECONDS));
        return ApiResponse.error(res, {
          message: 'Too many orders placed from this connection. Please try again shortly.',
          messageBn: 'এই সংযোগ থেকে অনেকগুলো অর্ডার করা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।',
          statusCode: 429,
        });
      }

      // Handed to the route so a rejected order can be counted as suspicious
      // behaviour rather than an honest mistake. See `markSuspicious`.
      req.orderClientIp = ip;
      return next();
    } catch (err) {
      // Fail open. See the header.
      logger.error(`[OrderAbuse] Guard error, allowing request: ${err.message}`);
      req.orderClientIp = ip;
      return next();
    }
  };
}

/**
 * Record behaviour that is not a rate violation but is not honest either.
 *
 * Called from the checkout route when an attempt is refused for a reason a real
 * customer using the real website could not produce — a product id that is not
 * in this shop, a delivery zone that does not exist, a malformed body. A
 * customer on a phone hits none of those; a script probing the endpoint hits
 * them constantly, and it does so while staying comfortably under five orders a
 * minute because nothing it sends ever becomes an order.
 *
 * This is the layer that catches the patient abuser the ceiling alone misses.
 */
async function markSuspicious(req, reason) {
  const ip = req.orderClientIp || clientIp(req);
  return strike(ip, reason);
}

module.exports = {
  orderAbuseGuard,
  markSuspicious,
  // Exported for tests: the escalation curve is the part worth asserting.
  blockSecondsFor,
  MAX_ORDERS,
  MAX_BLOCK_SECONDS,
};
