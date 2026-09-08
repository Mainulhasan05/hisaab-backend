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

/**
 * The worklist's filters.
 *
 * ── DATES ARE CALENDAR DAYS, NOT INSTANTS ───────────────────────────────────
 *
 * `from` and `to` are `YYYY-MM-DD` in BANGLADESH local time, converted to UTC
 * instants by `bdTime.util` inside the service. They are deliberately not ISO
 * timestamps: the browser would then be the one deciding where a day starts,
 * and a shopkeeper opening "আজকের অর্ডার" at 3am Dhaka would be shown
 * yesterday's — the identical six-hour error `getBangladeshTodayRange` exists
 * to prevent everywhere else (AGENT_WORKFLOW §6, bdTime.util's header).
 *
 * ── `late` ──────────────────────────────────────────────────────────────────
 *
 * "আটকে আছে" — an order that has sat in one non-terminal state longer than that
 * state deserves. The thresholds live in the service beside the state machine
 * they describe, not here.
 */
const listQuery = Joi.object({
  status: Joi.string().valid('pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'returned'),
  q: Joi.string().trim().max(60).allow(''),
  from: Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('')
    .messages({ 'string.pattern.base': 'তারিখ সঠিক নয়' }),
  to: Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('')
    .messages({ 'string.pattern.base': 'তারিখ সঠিক নয়' }),
  source: Joi.string().valid('storefront', 'manual'),
  // A zone KEY off the shop's own table, or the literal 'pickup' for orders
  // the customer is collecting. One control on screen, so one parameter here —
  // pickup is not a zone, but "which delivery arrangement" is one question.
  zone: Joi.string().trim().max(60).allow(''),
  late: Joi.boolean(),
  sort: Joi.string().valid('newest', 'oldest', 'amount'),
  page: Joi.number().integer().min(1).max(10000),
  limit: Joi.number().integer().min(1).max(50),
}).unknown(false);

/**
 * The export takes the same filters and no paging.
 *
 * Sharing the shape is the point: "download what I am looking at" is only true
 * if the two reads are filtered identically, and a second schema is how they
 * drift. The row ceiling is the service's, not a `limit` the caller picks.
 */
const exportQuery = listQuery.keys({
  page: Joi.forbidden(),
  limit: Joi.forbidden(),
});

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
  /**
   * The locality below thana level — free text, and never consulted when
   * deriving the zone (`Order.delivery.area`). It is what lets staff record
   * "Mollapara" for a Rajshahi customer whose mahalla is in no dataset.
   */
  area: Joi.string().trim().max(80).allow(null, ''),
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

/**
 * Price a basket without placing it — the manual form's live total.
 *
 * `create`, not `view`: it runs the same resolver `create` will, over a basket
 * only someone who may place an order has reason to assemble. Writes nothing,
 * so it carries none of the write mitigations and is safe to call on every
 * keystroke that changes the order.
 */
router.post(
  '/quote',
  rbac('online_orders', 'create'),
  validate(
    Joi.object({
      items: Joi.array().items(
        Joi.object({
          productId: Joi.string().trim().pattern(/^[0-9a-fA-F]{24}$/).required(),
          variantSku: Joi.string().trim().max(60).allow(null, ''),
          quantity: Joi.number().integer().min(1).max(999).required(),
        }).unknown(false)
      ).min(1).max(50).required(),
      district: Joi.string().trim().max(80).allow(null, ''),
      subdistrict: Joi.string().trim().max(80).allow(null, ''),
      area: Joi.string().trim().max(80).allow(null, ''),
      pickup: Joi.boolean().default(false),
    }).unknown(false),
    'body'
  ),
  orderController.quote
);

router.get('/', rbac('online_orders', 'view'), validate(listQuery, 'query'), orderController.list);
router.get('/summary', rbac('online_orders', 'view'), orderController.summary);

/**
 * The current view as a CSV — `ECOMMERCE_PLAN.md` §7.2 asks the list view to
 * ship with one, and `BACKLOG.md` N4 wants exports everywhere.
 *
 * `view` permission and nothing more: it is the same rows the screen already
 * renders, in a file. It carries customer phone numbers and addresses, which
 * is the shop's own data about its own customers — the same data the worklist
 * shows — so there is no wider disclosure here than on the screen it mirrors.
 */
router.get(
  '/export',
  rbac('online_orders', 'view'),
  validate(exportQuery, 'query'),
  orderController.exportCsv
);
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
 * quota.
 *
 * There is no settings flag in front of this any more. There used to be two
 * (`smsOnConfirm` / `smsOnShip`), and they were the wrong shape: the decision a
 * shopkeeper actually makes is per ORDER, at the moment they change its status,
 * looking at the exact text and the exact segment cost. The order screen shows
 * both before this route is called, which is a stronger guard than a switch set
 * once months ago and forgotten.
 */
router.post(
  '/:id/notify',
  rbac('online_orders', 'update'),
  validate(idParam, 'params'),
  validate(
    Joi.object({
      // Every announceable transition. `pending` is absent: an order that has
      // only arrived has not been looked at by anybody, and the confirmation
      // page already told the customer it landed.
      kind: Joi.string()
        .valid('confirmed', 'packed', 'shipped', 'delivered', 'cancelled')
        .required(),
    }).unknown(false),
    'body'
  ),
  orderController.notify
);

/**
 * RTO — the parcel shipped and came back refused.
 *
 * On `cancel` rather than `update`, and that is the deliberate call: this voids
 * an invoice, restores stock and reverses a customer's due, which is precisely
 * the consequence the `cancel` permission exists to gate. That it is a
 * different BUTTON from cancelling does not make it a lesser act — whoever may
 * not cancel a confirmed order may not unwind a shipped one either.
 */
router.post(
  '/:id/return',
  rbac('online_orders', 'cancel'),
  validate(idParam, 'params'),
  validate(
    Joi.object({
      reason: Joi.string().trim().max(500).allow(''),
    }).unknown(false),
    'body'
  ),
  orderController.markReturned
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
