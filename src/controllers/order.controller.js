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

/**
 * Everything on the query string that describes WHICH orders, as one object.
 *
 * Read once, here, and handed unchanged to all three service calls below. When
 * the list read `req.query` and the counts read nothing, the tab badges and the
 * rows under them were answers to two different questions — see
 * `order.service._worklistFilter`.
 */
const criteriaOf = (query) => ({
  status: query.status,
  q: query.q,
  from: query.from,
  to: query.to,
  source: query.source,
  zone: query.zone,
  late: query.late,
  sort: query.sort,
});

exports.list = asyncHandler(async (req, res) => {
  const criteria = criteriaOf(req.query);
  const { page, limit } = req.query;

  /**
   * Three reads, one filter, in parallel.
   *
   * `totals` is a separate aggregation rather than a sum of the page, because
   * the page is twenty rows and the number the shopkeeper wants is over the
   * whole filtered set — "আজ কত টাকার অর্ডার এসেছে" is not answerable from
   * whichever twenty happen to be on screen.
   */
  const [{ orders, pagination }, counts, totals] = await Promise.all([
    orderService.listOrders(req, { ...criteria, page, limit }),
    orderService.countsByStatus(req, criteria),
    orderService.worklistTotals(req, criteria),
  ]);

  return ApiResponse.success(res, {
    data: { orders, counts, totals },
    pagination,
    message: 'Orders retrieved',
    messageBn: 'অর্ডার তালিকা লোড হয়েছে',
  });
});

/**
 * The current view as a CSV file.
 *
 * ── THE BOM IS LOAD-BEARING ────────────────────────────────────────────────
 *
 * Excel on Windows opens a UTF-8 CSV as the system ANSI codepage unless the
 * file starts with a byte-order mark, so every Bengali name, every Bangla zone
 * label and the ৳ sign arrive as mojibake. The shopkeeper's conclusion is that
 * the export is broken, and they are right. Three bytes fix it.
 *
 * ── AND THE LEADING APOSTROPHE ON PHONE NUMBERS ────────────────────────────
 *
 * `01712345678` is read by Excel as the number 1712345678 — the leading zero
 * is dropped and the customer becomes uncallable. Prefixing a tab character
 * forces the cell to text. This is the sort of detail that decides whether an
 * export is used twice.
 */
exports.exportCsv = asyncHandler(async (req, res) => {
  const criteria = criteriaOf(req.query);
  const { orders, truncated, limit } = await orderService.exportRows(req, criteria);

  const header = [
    'অর্ডার নং', 'তারিখ', 'অবস্থা', 'উৎস', 'কাস্টমার', 'মোবাইল',
    'জেলা', 'থানা/উপজেলা', 'এলাকা', 'ঠিকানা', 'ডেলিভারি এলাকা',
    'পণ্য সংখ্যা', 'পণ্যের দাম', 'ডেলিভারি চার্জ', 'মোট', 'ইনভয়েস',
  ];

  const STATUS_BN = {
    pending: 'নতুন', confirmed: 'নিশ্চিত', packed: 'প্যাক',
    shipped: 'পাঠানো', delivered: 'ডেলিভারি', cancelled: 'বাতিল',
  };

  const rows = orders.map((o) => [
    o.orderNo,
    new Date(o.createdAt).toISOString(),
    STATUS_BN[o.status] || o.status,
    o.source === 'manual' ? (o.sourceNote || 'ম্যানুয়াল') : 'ওয়েবসাইট',
    o.customer?.name || '',
    `\t${o.customer?.phone || ''}`,
    o.delivery?.district || '',
    o.delivery?.subdistrict || '',
    o.delivery?.area || '',
    o.customer?.address || '',
    o.delivery?.isPickup ? 'পিকআপ' : (o.delivery?.zoneName || ''),
    o.items?.length || 0,
    o.subtotal,
    o.deliveryCharge,
    o.total,
    o.sale ? String(o.sale) : '',
  ]);

  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${stamp}.csv"`);
  // Says so in a header rather than as a row in the file: a warning row would
  // be parsed as data by whatever the shopkeeper opens it in.
  if (truncated) res.setHeader('X-Export-Truncated', String(limit));

  return res.send(`﻿${csv}`);
});

/** One CSV cell: quoted, with embedded quotes doubled, per RFC 4180. */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

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
 * The parcel came back (RTO).
 *
 * One call that releases the courier's money, voids the invoice and marks the
 * order `returned` — see `orderService.returnOrder` for why it has to be one
 * call and not three screens.
 */
exports.markReturned = asyncHandler(async (req, res) => {
  const order = await orderService.returnOrder(req, req.params.id, req.user._id, req.body.reason);
  return ApiResponse.success(res, {
    data: order,
    message: 'Parcel returned',
    messageBn: 'পার্সেল ফেরত রেকর্ড হয়েছে — স্টক ফিরেছে, ইনভয়েস বাতিল হয়েছে',
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

  const { customer = {}, items, district, subdistrict, area, pickup, sourceNote } = req.body;

  const order = await orderService.placeOrder({
    shop: req.shop,
    storefront,
    branch: requireBranch(req),
    customer,
    items,
    address: { district, subdistrict, area },
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

/**
 * Price a manual order before creating it.
 *
 * ── WHY THE FORM NEEDED THIS ────────────────────────────────────────────────
 *
 * `/online/orders/new` used to show a subtotal it computed in the browser from
 * the product-search results, labelled "আনুমানিক", with the delivery charge
 * simply absent until after the order was created. A shop assistant on the
 * phone to a customer asking "সব মিলিয়ে কত?" had nothing to read out — the one
 * number the conversation is about was the one number the screen did not have.
 *
 * The alternative was to resolve the zone client-side from the shop's zone
 * table, which is a second implementation of `resolveDelivery` and therefore a
 * second opinion about what a customer is charged. The public checkout already
 * refused that trade and got `POST /quote` instead; this is the same answer for
 * the same reason, on the authenticated door.
 *
 * WRITES NOTHING. Safe to call on every change to the form.
 *
 * `create` rather than `view` permission: it prices a basket that only someone
 * allowed to place an order has any business assembling, and it is the same
 * resolver `create` will run.
 */
exports.quote = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.getStorefront(req.shop._id);
  const { items, district, subdistrict, area, pickup } = req.body;

  const quote = await orderService.quoteOrder({
    shopId: req.shop._id,
    storefront,
    items,
    address: { district, subdistrict, area },
    pickup: pickup === true,
    // Both match `create` exactly. A quote produced under different rules from
    // the order it precedes is worse than no quote: it is a number the shop
    // reads out to a customer and then cannot honour.
    onlineOnly: false,
    requireSubdistrict: false,
  });

  return ApiResponse.success(res, {
    data: quote,
    message: 'Quote calculated',
    messageBn: 'হিসাব করা হয়েছে',
  });
});
