const express = require('express');
const router = express.Router();
const publicStorefrontController = require('../controllers/publicStorefront.controller');
const { storefrontLimiter } = require('../middleware/rateLimiter.middleware');
const { validate, Joi } = require('../middleware/validate.middleware');

/**
 * PUBLIC ROUTES — the only unauthenticated surface in this API.
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
 *
 * There is no `router.use(protect)` here, and that is the entire point of the
 * file existing separately rather than as a branch inside `storefront.routes`.
 * A guard that is applied by default and skipped by exception eventually gets
 * skipped by accident; a router with no guard at all cannot lose one.
 *
 * For the same reason nothing here is a write. Every verb is GET. When checkout
 * arrives it is an unauthenticated POST — a genuinely different risk with a
 * different set of mitigations (idempotency key, honeypot, per-phone caps,
 * server-derived prices — §13) — and it should arrive as its own reviewed
 * change, not as one more line appended to this list.
 *
 * ── RATE LIMITING ───────────────────────────────────────────────────────────
 *
 * `storefrontLimiter` INSTEAD of `apiLimiter`, not in addition to it: `app.js`
 * skips the global limiter for this prefix. One request, one bucket, so a
 * storefront being hammered by a viral Facebook post cannot spend the allowance
 * the shop's till depends on.
 *
 * ── VALIDATION ──────────────────────────────────────────────────────────────
 *
 * Every parameter is validated even though `express-mongo-sanitize` and `hpp`
 * already run globally. Those two stop injection; they do not stop a 10,000-
 * character slug reaching a regex, or `limit=100000` turning one request into a
 * full collection scan. §13 notes the validations directory has five files and
 * that public routes must not be the sixth omission.
 */

router.use(storefrontLimiter);

/**
 * A shop slug as `Shop.model.js` generates it: lowercase, hyphenated, with a
 * random suffix. Bounded at 80 characters because it is interpolated into a
 * query and, on the frontend, into a URL.
 */
const slugParam = Joi.object({
  slug: Joi.string().trim().lowercase().max(80).pattern(/^[a-z0-9-]+$/).required()
    .messages({ 'string.pattern.base': 'দোকানের ঠিকানা সঠিক নয়' }),
});

const productParams = slugParam.keys({
  // Product codes are ASCII by construction (`lib/productCode.js` romanises
  // Bengali names before generating one) precisely so they survive a URL, a
  // barcode label and being read out over the phone.
  code: Joi.string().trim().max(60).pattern(/^[A-Za-z0-9._-]+$/).required()
    .messages({ 'string.pattern.base': 'পণ্যের কোড সঠিক নয়' }),
});

const listQuery = Joi.object({
  // Accepts a slug or a 24-char id — the block editor stores ids, URLs carry
  // slugs, and the service resolves either.
  category: Joi.string().trim().max(80).allow(''),
  q: Joi.string().trim().max(60).allow(''),
  // Price sorts are absent on purpose. The effective price is
  // `onlinePrice ?? sellingPrice`, which no single index can order, so it needs
  // an aggregation — a SECOND projection path on the one read where a mistake
  // publishes cost data. Not worth it for P1; the reference layout has no sort
  // control at all.
  sort: Joi.string().valid('newest', 'popular', 'featured', 'name'),
  tag: Joi.string().trim().max(40),
  offers: Joi.string().valid('true', 'false'),
  page: Joi.number().integer().min(1).max(500),
  // Ceiling matches the service's own clamp. Validated here as well so an
  // oversized request is refused before it reaches a query, rather than being
  // quietly reinterpreted.
  limit: Joi.number().integer().min(1).max(48),
}).unknown(false);

router.get(
  '/storefront/:slug',
  validate(slugParam, 'params'),
  publicStorefrontController.getHome
);

router.get(
  '/storefront/:slug/products',
  validate(slugParam, 'params'),
  validate(listQuery, 'query'),
  publicStorefrontController.listProducts
);

router.get(
  '/storefront/:slug/products/:code',
  validate(productParams, 'params'),
  publicStorefrontController.getProduct
);

router.get(
  '/storefront/:slug/sitemap',
  validate(slugParam, 'params'),
  publicStorefrontController.getSitemap
);

module.exports = router;
