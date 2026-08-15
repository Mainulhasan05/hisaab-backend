const express = require('express');
const router = express.Router();
const orderController = require('../controllers/order.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const { requireFeature } = require('../utils/features.util');
const { validate, Joi, commonSchemas } = require('../middleware/validate.middleware');

/**
 * The merchant order worklist — the READ half of the pipeline whose WRITE half
 * is the public checkout (`public.routes.js`).
 *
 * Behind `requireFeature('onlineOrders')`, same 404-not-403 shape as the
 * storefront router: to a shop without the capability this resource does not
 * exist. The permission split follows config/permissions.js exactly:
 *
 *   view    — the worklist and the detail screen
 *   update  — every forward transition INCLUDING confirm, which writes a Sale
 *             and is therefore materially `sales.create`
 *   cancel  — separate, because cancelling a confirmed order cancels a Sale
 */

router.use(protect);
router.use(requireFeature('onlineOrders'));

const idParam = Joi.object({
  id: commonSchemas.objectId.required(),
});

const listQuery = Joi.object({
  status: Joi.string().valid('pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'),
  q: Joi.string().trim().max(60).allow(''),
  page: Joi.number().integer().min(1).max(10000),
  limit: Joi.number().integer().min(1).max(50),
}).unknown(false);

router.get('/', rbac('online_orders', 'view'), validate(listQuery, 'query'), orderController.list);
router.get('/summary', rbac('online_orders', 'view'), orderController.summary);
router.get('/:id', rbac('online_orders', 'view'), validate(idParam, 'params'), orderController.getOne);

router.post(
  '/:id/confirm',
  rbac('online_orders', 'update'),
  validate(idParam, 'params'),
  orderController.confirm
);

router.patch(
  '/:id/status',
  rbac('online_orders', 'update'),
  validate(idParam, 'params'),
  validate(
    Joi.object({
      // `confirmed` and `cancelled` are deliberately not valid here — they are
      // their own routes with their own permissions and their own consequences.
      status: Joi.string().valid('packed', 'shipped', 'delivered').required(),
      note: Joi.string().trim().max(300).allow(''),
    }).unknown(false),
    'body'
  ),
  orderController.updateStatus
);

router.post(
  '/:id/cancel',
  rbac('online_orders', 'cancel'),
  validate(idParam, 'params'),
  validate(
    Joi.object({
      reason: Joi.string().trim().max(500).allow(''),
    }).unknown(false),
    'body'
  ),
  orderController.cancel
);

module.exports = router;
