const crypto = require('crypto');
const cacheService = require('../services/cache.service');
const ApiResponse = require('../utils/response.util');
const logger = require('../utils/logger.util');

/**
 * Idempotency Middleware
 * Prevents duplicate requests (e.g. double checkouts or double payments)
 * 
 * Non-blocking guarantee: If client sends no header, or if caching fails, 
 * the request proceeds normally without blocking the user.
 */
function idempotency(options = {}) {
  const { ttlSeconds = 86400, lockTtlSeconds = 60 } = options;

  return async (req, res, next) => {
    // Only check mutating requests (POST, PUT, PATCH, DELETE)
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    const idempotencyKey = req.headers['x-idempotency-key'] || req.headers['idempotency-key'];

    // If client didn't supply an idempotency key, skip idempotency handling
    if (!idempotencyKey) {
      return next();
    }

    // ── Scoping the key to a tenant ──────────────────────────────────────────
    //
    // `req.shopId` is read first for historical reasons and is never set by
    // anything in this codebase, so this always fell through to `req.user.shop`
    // — which, for a normal user, is the POPULATED Shop document that
    // `getCachedUser` hydrates, not an id. Interpolated into a template string
    // that stringifies a whole Mongoose document into the Redis key.
    //
    // `req.shop` is the resolved shop on every authenticated request, so take
    // the id from there and coerce it explicitly. `_id` covers a document,
    // `toString` covers a bare ObjectId (the shape a platform admin gets).
    const shopScope = req.shop?._id || req.shop || req.user?.shop?._id || req.user?.shop;
    const shopId = shopScope ? String(shopScope) : 'global';

    // ── Unauthenticated requests: bind the key to the BODY ───────────────────
    //
    // On the public checkout there is no `req.shop`, so every key on one
    // storefront path shares the 'global' scope — and the cached response is a
    // customer's name, phone and address. A client-chosen key alone must not be
    // the whole address of that cache entry: anyone replaying a guessed key
    // within the TTL would read someone else's order back.
    //
    // Folding a hash of the body into the key closes that: the same double-tap
    // (same body) still collapses to one cached response, while a different
    // customer's request with the same key simply misses the cache and is
    // processed normally — where the DB unique index judges it on its own
    // merits. Authenticated routes keep their shop scope and skip this.
    const bodyScope = !shopScope && req.body
      ? `:${crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex').slice(0, 16)}`
      : '';
    const lockKey = `idempotency:${shopId}:${req.method}:${req.baseUrl}${req.path}:${idempotencyKey}${bodyScope}`;
    let isCompleted = false;

    try {
      // ── Reserve the key ATOMICALLY ─────────────────────────────────────────
      //
      // This was a `get` followed by a `set`. Two genuinely simultaneous
      // requests — the double-tap this middleware exists to stop — both saw an
      // empty cache, both wrote 'processing', and both went through to create
      // two sales. It only ever caught the sequential retry, which is the case
      // that was never really the problem.
      //
      // `setNX` makes the reservation the same operation as the check: exactly
      // one caller gets `true`. The loser falls into the branch below and reads
      // whatever the winner has recorded so far.
      const acquired = await cacheService.setNX(
        lockKey,
        { status: 'processing', timestamp: Date.now() },
        lockTtlSeconds
      );

      const cached = acquired ? null : await cacheService.get(lockKey);

      if (cached) {
        if (cached.status === 'processing') {
          logger.warn(`[Idempotency] Active duplicate request detected for key: ${idempotencyKey}`);
          // `ApiResponse.error` takes an OPTIONS OBJECT. This was called with
          // positional arguments — `(res, 'A request…', 409)` — so the string
          // was destructured for `message`/`statusCode`, both came out
          // undefined, the defaults applied, and the 409 was ignored entirely.
          // The client got a 500 reading "Something went wrong" for what is a
          // perfectly ordinary in-flight duplicate. Nothing surfaced it because
          // no client sent the header, so this branch had never once run.
          return ApiResponse.error(res, {
            message: 'A request with this idempotency key is currently being processed.',
            messageBn: 'এই অনুরোধটি এখনো প্রক্রিয়াধীন। একটু পরে আবার চেষ্টা করুন।',
            statusCode: 409,
          });
        }

        if (cached.status === 'completed') {
          logger.info(`[Idempotency] Returning cached response for key: ${idempotencyKey}`);
          res.setHeader('X-Cache-Lookup', 'HIT-IDEMPOTENT');
          return res.status(cached.statusCode).json(cached.body);
        }
      }

      // A key that exists but is neither 'processing' nor 'completed' is a
      // corrupt or truncated entry. `setNX` above declined to claim it, and
      // neither branch handled it, so the request would proceed with no
      // reservation at all. Re-stamp it rather than leaving the window open.
      if (cached) {
        await cacheService.set(lockKey, { status: 'processing', timestamp: Date.now() }, lockTtlSeconds);
      }

      // Clean up lock if connection closes abruptly or encounters server error (5xx)
      res.on('finish', () => {
        if (!isCompleted && res.statusCode >= 500) {
          cacheService.delete(lockKey).catch(() => {});
        }
      });

      res.on('close', () => {
        if (!isCompleted && !res.writableEnded) {
          cacheService.delete(lockKey).catch(() => {});
        }
      });

      // Intercept res.json to cache response payload on completion
      const originalJson = res.json.bind(res);

      res.json = function (body) {
        isCompleted = true;
        // Cache success responses (2xx) and client errors (4xx) for idempotency
        if (res.statusCode >= 200 && res.statusCode < 500) {
          cacheService.set(
            lockKey,
            {
              status: 'completed',
              statusCode: res.statusCode,
              body,
            },
            ttlSeconds
          ).catch((err) => {
            logger.error(`[Idempotency] Failed to store cache for key ${idempotencyKey}: ${err.message}`);
          });
        } else {
          // On server error (5xx), clear the lock so client can safely retry
          cacheService.delete(lockKey).catch(() => {});
        }

        return originalJson(body);
      };

      next();
    } catch (err) {
      logger.error(`[Idempotency Middleware Error]: ${err.message}`);
      // Fallback: proceed without blocking request if idempotency check fails
      next();
    }
  };
}

module.exports = idempotency;
