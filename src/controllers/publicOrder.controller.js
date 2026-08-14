const publicStorefrontService = require('../services/publicStorefront.service');
const orderService = require('../services/order.service');
const { markSuspicious } = require('../middleware/orderAbuse.middleware');
// `shopHasFeature`, NOT `hasFeature`. The latter reads `req.shop.features` and
// there is no authenticated request here — the shop came from a slug in a URL.
// Passing a shop document to it yields `shop.shop.features`, i.e. undefined,
// i.e. every checkout refused with a clean 403 and nothing in the log to say why.
const { shopHasFeature } = require('../utils/features.util');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const logger = require('../utils/logger.util');

/**
 * Guest checkout — the ONLY unauthenticated write in this API.
 *
 * `public.routes.js` says this should arrive as its own reviewed change rather
 * than one more line appended to a list of GETs, and names what it needs:
 * an idempotency key, server-derived prices and per-client caps. All three are
 * here or in front of this file.
 *
 * ── WHAT THIS ENDPOINT TRUSTS FROM THE REQUEST ─────────────────────────────
 *
 * Product ids, variant SKUs, quantities, a delivery zone key, and the
 * customer's own name, phone and address. That is the complete list.
 *
 * It does not trust prices, delivery charges or totals — those are resolved in
 * `order.service` from the shop's own documents. It does not trust the shop id
 * either: that comes from the slug in the URL, through `resolveStorefront`,
 * which is also what decides whether this shop may be served at all.
 *
 * ── A REFUSAL IS EVIDENCE ──────────────────────────────────────────────────
 *
 * A real customer on the real website cannot produce a product id from another
 * shop, a delivery zone that does not exist, or a body the validator rejects —
 * the page only offers them things that work. A script probing the endpoint
 * produces exactly those, and produces them while staying comfortably under the
 * five-orders-a-minute ceiling, because nothing it sends ever becomes an order.
 *
 * So a 4xx from the resolver is reported to the abuse tracker as a strike. That
 * is the layer which catches the patient prober; the ceiling only catches the
 * impatient one. Genuine 409s — out of stock, not enough left — are deliberately
 * NOT counted: a customer racing another customer for the last unit has done
 * nothing wrong.
 */
exports.placeOrder = asyncHandler(async (req, res) => {
  // Resolves the shop, or throws the same indistinguishable 404 every other
  // public route throws. A checkout against a paused or lapsed shop is refused
  // by the same gate that hides its catalogue.
  const { shop, storefront } = await publicStorefrontService.resolveStorefront(req.params.slug);

  // Ordering is a separate capability from having a website. A shop without it
  // has a catalogue with call and WhatsApp buttons, which §13 calls the finished
  // product for a shop that does not run a parcel operation — so this is a
  // legitimate public fact about the shop and gets a real message rather than
  // the dark 404 that hides whether a shop exists at all.
  if (!shopHasFeature(shop, 'onlineOrders')) {
    return ApiResponse.error(res, {
      message: 'This shop does not take online orders',
      messageBn: 'এই দোকানটি অনলাইনে অর্ডার নেয় না — সরাসরি ফোন করুন।',
      statusCode: 403,
    });
  }

  const { customer = {}, items, zoneKey, pickup } = req.body;

  let order;
  try {
    order = await orderService.placeOrder({
      shop,
      storefront,
      customer,
      items,
      zoneKey,
      pickup: pickup === true,
      source: 'storefront',
      onlineOnly: true,
      meta: {
        ip: req.orderClientIp || req.ip,
        userAgent: String(req.get('user-agent') || '').slice(0, 400),
        // The middleware in front is non-blocking by design, so the key is
        // recorded here as well and the unique sparse index on
        // {shop, meta.idempotencyKey} is what actually guarantees one order per
        // key. See Order.model.js.
        idempotencyKey: req.headers['x-idempotency-key'] || req.headers['idempotency-key'] || null,
      },
    });
  } catch (err) {
    // 409 is a race, not an attack — see the header.
    if (err?.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 409) {
      markSuspicious(req, `rejected checkout: ${err.message}`).catch(() => {});
    }
    throw err;
  }

  logger.info(
    `[Order] ${order.orderNo} placed on ${shop.slug} — ${order.items.length} line(s), ৳${order.total}`
  );

  // The projection is an allowlist and does NOT include `items[].buyingPrice`.
  // That field is what the shop paid its supplier and this response goes to a
  // stranger. See `order.service.toPublicOrder`.
  return ApiResponse.success(res, {
    data: orderService.toPublicOrder(order),
    message: 'Order placed',
    messageBn: 'আপনার অর্ডারটি জমা হয়েছে',
    statusCode: 201,
  });
});

/**
 * Look up one order — the "where is my parcel" page.
 *
 * Addressed by order number AND phone together. The order number alone is
 * guessable (`ORD-260814-0001` and its neighbours), and an endpoint that
 * accepted it alone would publish every customer's name, address and shopping
 * list to anyone willing to count. Requiring the phone that placed it turns
 * enumeration into something that has to already know the answer.
 *
 * Still a GET with no session, so it stays behind `storefrontLimiter`.
 */
exports.trackOrder = asyncHandler(async (req, res) => {
  const { shop } = await publicStorefrontService.resolveStorefront(req.params.slug);
  const order = await orderService.findForTracking(
    shop._id,
    req.params.orderNo,
    req.query.phone
  );

  if (!order) {
    // One message for "no such order" and "wrong phone" alike, for the same
    // reason `resolveStorefront` collapses its failures: distinguishing them
    // would confirm which order numbers exist.
    return ApiResponse.error(res, {
      message: 'Order not found',
      messageBn: 'অর্ডারটি পাওয়া যায়নি — নম্বর ও মোবাইল যাচাই করুন',
      statusCode: 404,
    });
  }

  return ApiResponse.success(res, {
    data: orderService.toPublicOrder(order),
    message: 'Order found',
  });
});
