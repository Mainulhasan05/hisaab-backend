const express = require('express');
const router = express.Router();
const shopLandingController = require('../controllers/shopLanding.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const { requireFeature } = require('../utils/features.util');
const { validate, Joi, commonSchemas } = require('../middleware/validate.middleware');

/**
 * The shop's seasonal-page panel — the READ half of the pipeline whose WRITE
 * half is the public form in `public.routes.js`.
 *
 * Behind `requireFeature('landingPages')`, the same 404-not-403 shape the
 * storefront and online-order routers use: to a shop without the capability
 * this resource does not exist.
 *
 * ── WHY THERE IS NO POST AND NO DELETE ──────────────────────────────────────
 *
 * Under D1/D11 the platform authors a landing page and assigns it to a shop.
 * The shop never creates one and never removes one, so there is no route for
 * either — not a hidden one, not a permission-gated one. A verb that exists and
 * always refuses is worse than a verb that does not exist: it invites someone
 * to "fix" the permission.
 *
 * The permission split follows config/permissions.js exactly:
 *
 *   landing_pages.view    — the campaign list and its detail
 *   landing_pages.update  — editing the marked content slots, and nothing else
 *   landing_orders.view   — the worklist, an order, the customers view
 *   landing_orders.update — forward transitions, the fake flag, advance verify
 *   landing_orders.cancel — cancelling, on its own permission
 */

router.use(protect);
router.use(requireFeature('landingPages'));

const idParam = Joi.object({
  id: commonSchemas.objectId.required(),
});

// ── Pages ───────────────────────────────────────────────────────────────────

router.get('/pages', rbac('landing_pages', 'view'), shopLandingController.listPages);

router.get(
  '/pages/:id',
  rbac('landing_pages', 'view'),
  validate(idParam, 'params'),
  shopLandingController.getPage
);

router.get(
  '/pages/:id/customers',
  rbac('landing_orders', 'view'),
  validate(idParam, 'params'),
  shopLandingController.pageCustomers
);

/**
 * Edit the marked slots.
 *
 * `content` is an open map of key → value because the keys are whatever the
 * admin marked in the page's HTML, and they differ per page. It is NOT
 * unvalidated: the service drops every key outside `editableKeys` (I-16), so
 * the whitelist is the schema and it lives where it can be enforced.
 */
router.patch(
  '/pages/:id/content',
  rbac('landing_pages', 'update'),
  validate(idParam, 'params'),
  validate(
    Joi.object({
      content: Joi.object()
        .pattern(
          Joi.string().max(60),
          Joi.string().allow('').max(20000)
        )
        .required(),
    }).unknown(false),
    'body'
  ),
  shopLandingController.patchContent
);

// ── Orders ──────────────────────────────────────────────────────────────────

const orderListQuery = Joi.object({
  page: commonSchemas.objectId,
  status: Joi.string().valid('pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'),
  q: Joi.string().trim().max(60).allow(''),
  limit: Joi.number().integer().min(1).max(200),
  skip: Joi.number().integer().min(0).max(100000),
}).unknown(false);

router.get(
  '/orders',
  rbac('landing_orders', 'view'),
  validate(orderListQuery, 'query'),
  shopLandingController.listOrders
);

router.get(
  '/orders/:id',
  rbac('landing_orders', 'view'),
  validate(idParam, 'params'),
  shopLandingController.getOrder
);

router.patch(
  '/orders/:id/status',
  rbac('landing_orders', 'update'),
  validate(idParam, 'params'),
  validate(
    Joi.object({
      // `cancelled` is deliberately not valid here — it is its own route with
      // its own permission, exactly as on the online-order worklist.
      status: Joi.string().valid('confirmed', 'packed', 'shipped', 'delivered').required(),
      note: Joi.string().trim().max(300).allow(''),
    }).unknown(false),
    'body'
  ),
  shopLandingController.updateOrderStatus
);

router.post(
  '/orders/:id/cancel',
  rbac('landing_orders', 'cancel'),
  validate(idParam, 'params'),
  validate(
    Joi.object({ reason: Joi.string().trim().max(500).allow('') }).unknown(false),
    'body'
  ),
  shopLandingController.cancelOrder
);

router.patch(
  '/orders/:id/fake',
  rbac('landing_orders', 'update'),
  validate(idParam, 'params'),
  validate(Joi.object({ isFake: Joi.boolean() }).unknown(false), 'body'),
  shopLandingController.markFake
);

/**
 * Confirming an advance payment is `update`, not `cancel` and not a permission
 * of its own. It is the same act as ringing the customer: someone checked
 * something and moved the order on.
 */
router.patch(
  '/orders/:id/advance',
  rbac('landing_orders', 'update'),
  validate(idParam, 'params'),
  validate(Joi.object({ verified: Joi.boolean() }).unknown(false), 'body'),
  shopLandingController.verifyAdvance
);

module.exports = router;
