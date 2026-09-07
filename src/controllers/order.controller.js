const orderService = require('../services/order.service');
const storefrontService = require('../services/storefront.service');
const { requireBranch } = require('../utils/branchScope.util');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

/**
 * The merchant side of online orders — the worklist, the detail screen and the
 * lifecycle transitions. Every route sits behind `protect`,
 * `requireFeature('onlineOrders')` and `rbac('online_orders', …)` — see
 * routes/order.routes.js.
 *
 * The one thing worth restating here: `confirm` is the single door into the
 * ledger (I-9). It runs `createSale` — stock deducts, the invoice exists, the
 * COD amount becomes a due on the customer. Every other transition is
 * fulfilment metadata.
 */

exports.list = asyncHandler(async (req, res) => {
  const { status, q, page, limit } = req.query;
  const { orders, pagination } = await orderService.listOrders(req, { status, q, page, limit });
  const counts = await orderService.countsByStatus(req);

  return ApiResponse.success(res, {
    data: { orders, counts },
    pagination,
    message: 'Orders retrieved',
    messageBn: 'অর্ডার তালিকা লোড হয়েছে',
  });
});

exports.summary = asyncHandler(async (req, res) => {
  const summary = await orderService.summary(req);
  return ApiResponse.success(res, {
    data: summary,
    message: 'Order summary retrieved',
    messageBn: 'অর্ডারের সারসংক্ষেপ লোড হয়েছে',
  });
});

exports.getOne = asyncHandler(async (req, res) => {
  const order = await orderService.getById(req, req.params.id);
  return ApiResponse.success(res, {
    data: order,
    message: 'Order retrieved',
    messageBn: 'অর্ডার লোড হয়েছে',
  });
});

exports.confirm = asyncHandler(async (req, res) => {
  const { order, sale } = await orderService.confirmOrder(req, req.params.id, req.user._id);
  return ApiResponse.success(res, {
    data: { order, sale },
    message: 'Order confirmed',
    messageBn: `অর্ডার নিশ্চিত হয়েছে — ইনভয়েস ${sale.invoiceNo}`,
  });
});

exports.updateStatus = asyncHandler(async (req, res) => {
  const order = await orderService.updateStatus(req, req.params.id, req.body.status, {
    userId: req.user._id,
    note: req.body.note,
  });

  const labels = {
    packed: 'অর্ডার প্যাক হয়েছে',
    shipped: 'অর্ডার পাঠানো হয়েছে',
    delivered: 'অর্ডার ডেলিভারি সম্পন্ন',
  };
  return ApiResponse.success(res, {
    data: order,
    message: 'Order status updated',
    messageBn: labels[order.status] || 'অর্ডারের অবস্থা বদলেছে',
  });
});

exports.cancel = asyncHandler(async (req, res) => {
  const order = await orderService.cancelOrder(req, req.params.id, req.user._id, req.body.reason);
  return ApiResponse.success(res, {
    data: order,
    message: 'Order cancelled',
    messageBn: 'অর্ডারটি বাতিল করা হয়েছে',
  });
});

/**
 * Send the customer one SMS about this order.
 *
 * `online_orders.update` rather than a permission of its own: whoever may move
 * an order forward is whoever announces that it moved. It spends the shop's SMS
 * quota, so it is deliberately NOT open to a view-only role.
 *
 * A send that the gateway refused comes back 200 with `ok: false` — the order
 * is unchanged either way, and the shopkeeper needs to read why rather than get
 * a bare failure.
 */
exports.notify = asyncHandler(async (req, res) => {
  const result = await orderService.notifyCustomer(req, req.params.id, req.body.kind, {
    userId: req.user?._id || null,
  });
  return ApiResponse.success(res, {
    data: result.order,
    message: result.ok ? 'SMS sent' : 'SMS not sent',
    messageBn: result.ok ? 'SMS পাঠানো হয়েছে' : `SMS যায়নি — ${result.error || 'আবার চেষ্টা করুন'}`,
  });
});

/**
 * Create an order by hand — the Facebook/WhatsApp/phone door.
 *
 * ── WHY THIS IS NOT OPTIONAL ───────────────────────────────────────────────
 *
 * `ECOMMERCE_PLAN.md` §6.1a calls manual creation "a requirement, not a
 * nice-to-have", and it is right: in Bangladesh most online orders arrive in a
 * Facebook inbox, not through a checkout. Until this existed, `Order.source`
 * carried a `'manual'` value nothing could produce, the worklist rendered a
 * badge nothing could earn, and `online_orders.create` was granted to roles
 * that had no way to use it — so the worklist showed a fraction of the shop's
 * real online trade and `Storefront.stats` under-reported it.
 *
 * ── WHAT IS THE SAME AS THE PUBLIC DOOR, AND WHAT IS NOT ───────────────────
 *
 * The same: `order.service.placeOrder`, so prices are server-derived, stock is
 * checked the same way, numbering is shared and the lifecycle is identical. A
 * staff typo is not malicious but it is still wrong, and the same resolver
 * catches both.
 *
 * Different, and deliberately:
 *   · `onlineOnly: false` — staff legitimately sell things the website does
 *     not list, which is most of what a Facebook conversation is about;
 *   · `requireSubdistrict: false` — someone taking a phone order often does
 *     not know the thana yet, and refusing to record the order would be worse
 *     than pricing it by district;
 *   · no honeypot, no per-phone cap, no idempotency middleware — this arrives
 *     on an authenticated route with a permission check, and a shop assistant
 *     entering a regular customer's eleventh order of the day is doing their
 *     job.
 */
exports.create = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.getStorefront(req.shop._id);

  const { customer = {}, items, district, subdistrict, pickup, sourceNote } = req.body;

  const order = await orderService.placeOrder({
    shop: req.shop,
    storefront,
    branch: requireBranch(req),
    customer,
    items,
    address: { district, subdistrict },
    pickup: pickup === true,
    requireSubdistrict: false,
    source: 'manual',
    sourceNote: sourceNote || null,
    createdBy: req.user?._id || null,
    onlineOnly: false,
  });

  return ApiResponse.success(res, {
    data: orderService.toMerchantOrder(order.toObject ? order.toObject() : order),
    message: 'Order created',
    messageBn: 'অর্ডার তৈরি হয়েছে',
    statusCode: 201,
  });
});
