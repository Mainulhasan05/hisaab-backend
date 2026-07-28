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

    const shopId = req.shopId || req.user?.shop || 'global';
    const lockKey = `idempotency:${shopId}:${req.method}:${req.baseUrl}${req.path}:${idempotencyKey}`;
    let isCompleted = false;

    try {
      const cached = await cacheService.get(lockKey);

      if (cached) {
        if (cached.status === 'processing') {
          logger.warn(`[Idempotency] Active duplicate request detected for key: ${idempotencyKey}`);
          return ApiResponse.error(res, 'A request with this idempotency key is currently being processed.', 409);
        }

        if (cached.status === 'completed') {
          logger.info(`[Idempotency] Returning cached response for key: ${idempotencyKey}`);
          res.setHeader('X-Cache-Lookup', 'HIT-IDEMPOTENT');
          return res.status(cached.statusCode).json(cached.body);
        }
      }

      // Mark request as processing
      await cacheService.set(lockKey, { status: 'processing', timestamp: Date.now() }, lockTtlSeconds);

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
