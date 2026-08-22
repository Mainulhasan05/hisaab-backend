/**
 * The SHOP's side of the seasonal landing pages — `/api/landing/*`.
 *
 * ── WHAT THIS SURFACE IS NOT ────────────────────────────────────────────────
 *
 * It is not the admin's editor with a different guard. Under D1/D11 the
 * platform authors a page and assigns it; a shop cannot create one, cannot
 * delete one, cannot change its slug, its offers, its prices, its delivery
 * charges or its expiry. What it CAN do is work the orders and edit the handful
 * of text and image slots the admin marked editable.
 *
 * That asymmetry is the product decision, not a permissions oversight: the page
 * is running against advertising money, and a shop editing its own price
 * mid-campaign is a support call nobody wants.
 *
 * ── EVERY READ IS SHOP-SCOPED, AND A FOREIGN ID IS A 404 ────────────────────
 *
 * Not a 403. A shop must not be able to learn that a page or an order id exists
 * by the shape of the error it gets back. The scoping lives in the services
 * (`getForShop`), never in an ad-hoc ownership check here.
 *
 * ── NOTHING HERE TOUCHES THE LEDGER (I-17) ──────────────────────────────────
 *
 * `confirmed` on this worklist means "I rang them and they are real". It writes
 * no Sale, moves no stock and creates no Customer, and the structural guard in
 * `landingLedgerIsolation.test.js` covers this file too.
 */

const asyncHandler = require('../utils/asyncHandler.util');
const ApiResponse = require('../utils/response.util');
const landingPageService = require('../services/landingPage.service');
const landingOrderService = require('../services/landingOrder.service');

/** The shop's own id, from the token. Never from the body or the query. */
const shopOf = (req) => req.user?.shop;

// ── Pages ───────────────────────────────────────────────────────────────────

/** Every campaign assigned to this shop, newest first, each with its live state. */
exports.listPages = asyncHandler(async (req, res) => {
  const pages = await landingPageService.listForShop(shopOf(req));

  return ApiResponse.success(res, {
    data: pages,
    message: 'Landing pages retrieved successfully',
  });
});

/**
 * One campaign: the page, its resolved state, its editable slots and its
 * headline numbers.
 *
 * The stats come back with the page rather than from a second endpoint because
 * the panel shows them in the header of the same screen, and a shop opening a
 * campaign on a phone should not pay two round trips for one view.
 */
exports.getPage = asyncHandler(async (req, res) => {
  const shopId = shopOf(req);
  const { page, state, fields } = await landingPageService.getForShop(req.params.id, shopId);
  const stats = await landingPageService.statsForPage(page._id);

  return ApiResponse.success(res, {
    data: {
      _id: page._id,
      title: page.title,
      slug: page.slug,
      status: page.status,
      state,
      startsAt: page.startsAt,
      expiresAt: page.expiresAt,
      orderPrefix: page.orderPrefix,
      offers: page.activeOffers().map((o) => ({
        key: o.key, label: o.label, price: o.price, stockNote: o.stockNote,
      })),
      zones: page.activeZones().map((z) => ({
        key: z.key, name: z.name, charge: z.charge, freeAbove: z.freeAbove || 0,
      })),
      payment: {
        methods: page.paymentMethods(),
        advanceMode: page.payment?.advanceMode || 'delivery',
        advanceAmount: page.payment?.advanceAmount || 0,
        advanceInstructions: page.payment?.advanceInstructions || null,
      },
      notifications: page.notifications,
      fields,
      stats,
    },
    message: 'Landing page retrieved successfully',
  });
});

/**
 * Edit the slots the admin opened up.
 *
 * The whitelist is applied in the service, and a key outside it is dropped
 * silently rather than refused (I-16). `applied` comes back so the panel can
 * say what actually changed instead of claiming everything did.
 */
exports.patchContent = asyncHandler(async (req, res) => {
  const { applied } = await landingPageService.patchShopContent(
    req.params.id,
    shopOf(req),
    { content: req.body?.content || {} }
  );

  return ApiResponse.success(res, {
    data: { applied },
    message: 'Content updated',
    messageBn: applied.length ? 'পরিবর্তন সংরক্ষণ করা হয়েছে' : 'পরিবর্তনযোগ্য কিছু পাওয়া যায়নি',
  });
});

/** Distinct buyers on one campaign, aggregated over the phone number. */
exports.pageCustomers = asyncHandler(async (req, res) => {
  // Scoped first — `customersForPage` takes a page id and would happily
  // aggregate somebody else's campaign if handed one.
  const { page } = await landingPageService.getForShop(req.params.id, shopOf(req));
  const customers = await landingPageService.customersForPage(page._id);

  return ApiResponse.success(res, {
    data: customers,
    message: 'Customers retrieved successfully',
  });
});

// ── Orders ──────────────────────────────────────────────────────────────────

/** The worklist. Filterable by campaign, status and a name/phone/order-no search. */
exports.listOrders = asyncHandler(async (req, res) => {
  const { page, status, q, limit, skip } = req.query;

  const result = await landingOrderService.listForShop(shopOf(req), {
    page: page || null,
    status: status || null,
    search: q || null,
    limit,
    skip,
  });

  return ApiResponse.success(res, {
    data: result.items,
    meta: { total: result.total, limit: result.limit },
    message: 'Orders retrieved successfully',
  });
});

/**
 * One order, with the recent orders from the same phone beside it.
 *
 * The duplicates are part of the DETAIL rather than a separate call because
 * they exist to inform the person about to pick up the phone, and something
 * fetched on a second click is something nobody sees.
 */
exports.getOrder = asyncHandler(async (req, res) => {
  const order = await landingOrderService.getForShop(req.params.id, shopOf(req));
  const duplicates = await landingOrderService.duplicatesFor(order);

  return ApiResponse.success(res, {
    data: { order, duplicates, nextStatuses: order.nextStatuses() },
    message: 'Order retrieved successfully',
  });
});

/**
 * Move an order along.
 *
 * `cancelled` is deliberately not reachable here — it has its own route and its
 * own permission, matching the online-orders worklist so an owner does not have
 * to learn two different rules.
 */
exports.updateOrderStatus = asyncHandler(async (req, res) => {
  const order = await landingOrderService.updateStatus(
    req.params.id,
    shopOf(req),
    req.body?.status,
    { userId: req.user?._id, note: req.body?.note }
  );

  return ApiResponse.success(res, {
    data: order,
    message: 'Order updated',
    messageBn: 'অর্ডারের অবস্থা পরিবর্তন করা হয়েছে',
  });
});

exports.cancelOrder = asyncHandler(async (req, res) => {
  const order = await landingOrderService.updateStatus(
    req.params.id,
    shopOf(req),
    'cancelled',
    { userId: req.user?._id, note: req.body?.reason }
  );

  return ApiResponse.success(res, {
    data: order,
    message: 'Order cancelled',
    messageBn: 'অর্ডারটি বাতিল করা হয়েছে',
  });
});

/** Prank or refused parcel. Kept apart from `cancelled` — see `setFake`. */
exports.markFake = asyncHandler(async (req, res) => {
  const order = await landingOrderService.setFake(
    req.params.id,
    shopOf(req),
    req.body?.isFake !== false
  );

  return ApiResponse.success(res, {
    data: order,
    message: 'Order flagged',
    messageBn: order.isFake ? 'ভুয়া অর্ডার হিসেবে চিহ্নিত' : 'চিহ্ন সরানো হয়েছে',
  });
});

/**
 * Mark the advance payment as seen in the shop's own bKash/Nagad statement.
 *
 * A human act, recorded as one. Nothing here contacts a payment provider, and
 * the day this endpoint starts claiming to is the day the shop stops checking.
 */
exports.verifyAdvance = asyncHandler(async (req, res) => {
  const order = await landingOrderService.verifyAdvance(
    req.params.id,
    shopOf(req),
    req.body?.verified !== false,
    { userId: req.user?._id }
  );

  return ApiResponse.success(res, {
    data: order,
    message: 'Advance payment updated',
    messageBn: order.advance?.verified ? 'অগ্রিম পেমেন্ট যাচাই করা হয়েছে' : 'যাচাই সরানো হয়েছে',
  });
});
