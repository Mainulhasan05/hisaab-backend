const orderService = require('../services/order.service');
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
