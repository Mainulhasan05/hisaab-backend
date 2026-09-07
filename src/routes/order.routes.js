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

/**
 * Manual order entry — §6.1a.
 *
 * `create` has been in `config/permissions.js` and granted to manager and
 * cashier since P0 with nothing reading it. This is what reads it.
 *
 * No price fields, exactly as on the public checkout: `unknown(false)` refuses
 * a body carrying one rather than ignoring it. Staff choose products and
 * quantities; the server decides what they cost (I-10). A shop assistant is not
 * an attacker, but a client-supplied price is still a client-supplied discount,
 * and the two doors must price identically or the shopkeeper cannot tell which
 * total is right.
 */
const createBody = Joi.object({
  customer: Joi.object({
    name: Joi.string().trim().min(2).max(120).required()
      .messages({ 'string.empty': 'নাম দিন', 'any.required': 'নাম দিন' }),
    phone: Joi.string().trim().min(10).max(20).required()
      .messages({ 'string.empty': 'মোবাইল নম্বর দিন', 'any.required': 'মোবাইল নম্বর দিন' }),
    address: Joi.string().trim().max(500).allow('').default(''),
    note: Joi.string().trim().max(500).allow('').default(''),
  }).required(),

  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().trim().pattern(/^[0-9a-fA-F]{24}$/).required()
        .messages({ 'string.pattern.base': 'পণ্য সঠিক নয়' }),
      variantSku: Joi.string().trim().max(60).allow(null, ''),
      quantity: Joi.number().integer().min(1).max(999).required(),
    }).unknown(false)
  ).min(1).max(50).required(),

  district: Joi.string().trim().max(80).allow(null, ''),
  subdistrict: Joi.string().trim().max(80).allow(null, ''),
  pickup: Joi.boolean().default(false),
  // Free text, not an enum: the channels a small shop sells through change
  // faster than a deploy. Matches `Order.sourceNote`.
  sourceNote: Joi.string().trim().max(120).allow('', null),
}).unknown(false);

router.post(
  '/',
  rbac('online_orders', 'create'),
  validate(createBody, 'body'),
  orderController.create
);

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

/**
 * Tell the customer, once, by SMS.
 *
 * `update` rather than a permission of its own — whoever may move an order is
 * whoever announces it — and never `view`, because this spends the shop's SMS
 * quota. `Storefront.notifications` decides whether it is offered at all; see
 * `order.service.notifyCustomer` on why sending is a tap and not a setting.
 */
router.post(
  '/:id/notify',
  rbac('online_orders', 'update'),
  validate(idParam, 'params'),
  validate(
    Joi.object({
      kind: Joi.string().valid('confirmed', 'shipped').required(),
    }).unknown(false),
    'body'
  ),
  orderController.notify
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
