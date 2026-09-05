/**
 * Self-serve checkout — the shop-owner endpoints, plus the gateway return.
 *
 * Thin, like `billing.controller`: every rule (what a package costs, what the
 * minimum top-up is, whether a blocked shop may pay) lives in
 * `platformCheckout.service`, because the browser is not the only caller — the
 * reconciliation sweep calls the same service and must reach the same answers.
 */

const checkoutService = require('../services/platformCheckout.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { AppError } = require('../middleware/error.middleware');
const logger = require('../utils/logger.util');
const { resolveClientIp } = require('../utils/clientIp.util');

/**
 * Only the owner may spend the shop's money.
 *
 * Not an RBAC module of its own: buying a subscription is not a feature of the
 * app, it is the thing that pays for the app, and a permission grid entry for it
 * would eventually be handed to a cashier by accident.
 */
function assertOwner(req) {
  if (!req.user?.isOwner) {
    throw new AppError(
      'Only the shop owner can make a payment',
      'শুধু দোকানের মালিক পেমেন্ট করতে পারবেন',
      403
    );
  }
}

/**
 * Every route here reads `req.shop`, and a platform-admin token has none.
 *
 * `protect` accepts an admin token and leaves `req.shop` undefined, so without
 * this the first property read is a TypeError and a 500 — an operator poking at
 * the owner API from the admin console would get a stack trace instead of an
 * answer. There is deliberately no admin fallback (no acting "as" a shop here):
 * the admin path for taking money is `billing.controller`, which records an
 * actor and writes an audit row. This one is the shop spending its own money.
 */
function assertShopContext(req) {
  if (!req.shop?._id) {
    throw new AppError(
      'This endpoint is for shop accounts',
      'এই ঠিকানাটি দোকান অ্যাকাউন্টের জন্য',
      400
    );
  }
}

exports.getBilling = asyncHandler(async (req, res) => {
  assertShopContext(req);
  const data = await checkoutService.getOwnerBilling(req.shop);
  return ApiResponse.success(res, { data, message: 'Billing details retrieved' });
});

exports.startSubscriptionCheckout = asyncHandler(async (req, res) => {
  assertShopContext(req);
  assertOwner(req);
  // `months` and nothing else. There is deliberately no `amount` in this
  // signature — a price in a request body is a price a customer can choose.
  const data = await checkoutService.createSubscriptionOrder({
    shop: req.shop,
    user: req.user,
    months: req.body.months,
    ip: resolveClientIp(req),
  });
  return ApiResponse.success(res, { data, message: 'Payment session created' });
});

exports.startSmsCheckout = asyncHandler(async (req, res) => {
  assertShopContext(req);
  assertOwner(req);
  const data = await checkoutService.createSmsOrder({
    shop: req.shop,
    user: req.user,
    amount: req.body.amount,
    ip: resolveClientIp(req),
  });
  return ApiResponse.success(res, { data, message: 'Payment session created' });
});

exports.getOrder = asyncHandler(async (req, res) => {
  assertShopContext(req);
  const data = await checkoutService.getOrderForShop(req.shop._id, req.params.id);
  return ApiResponse.success(res, { data, message: 'Order retrieved' });
});

/**
 * "Check on this now" — what the return page calls while it waits.
 *
 * Scoped to the caller's own shop first, so this cannot be used to probe or
 * advance another tenant's orders. The verification itself is the same one the
 * sweep performs; this only makes it happen sooner.
 */
exports.verifyOrder = asyncHandler(async (req, res) => {
  assertShopContext(req);
  await checkoutService.getOrderForShop(req.shop._id, req.params.id);
  await checkoutService.verifyOrder(req.params.id, { reason: 'poll' });
  const data = await checkoutService.getOrderForShop(req.shop._id, req.params.id);
  return ApiResponse.success(res, { data, message: 'Order checked' });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE GATEWAY RETURN — unauthenticated, and untrusted
 *
 * PayStation redirects the customer's BROWSER here after checkout. There is no
 * signature, no shared secret and no documented payload, so anyone who learns
 * this URL can request it with anything they like in it.
 *
 * Accordingly this handler:
 *
 *   · reads NOTHING from the body or query — not the amount, not the status,
 *     not the transaction id. The `:orderId` in the path is a lookup key and
 *     nothing more, and even it grants nothing: it selects which invoice number
 *     we go and ask PayStation about.
 *   · never renders the outcome. It performs the server-to-server verification
 *     and then redirects to the app, which reads the result back from our own
 *     API. A page that told the customer "payment successful" on the strength of
 *     having been requested would be telling them whatever they asked it to say.
 *   · is not the only path to fulfilment. If it never fires — the customer paid
 *     in the bKash app and closed the browser, which is the common case here —
 *     the reconciliation sweep finds the order within minutes and does the same
 *     work. Nothing about a shop getting what it paid for depends on a redirect
 *     completing.
 *
 * Mounted with `router.all` because the docs never say whether the redirect is
 * a GET or a POST, and the answer must not matter.
 * ═══════════════════════════════════════════════════════════════════════════ */
/**
 * How long a paying customer's browser may be held while we confirm.
 *
 * There is a real person watching a blank tab here, seconds after their money
 * left their wallet. The verification usually takes under two — but the gateway
 * call is allowed fifteen and a stalled database buffers for ten, so the
 * unbounded worst case is around twenty-five seconds of nothing, which reads as
 * a failed payment and produces a second one.
 *
 * So: race it. Whoever answers first wins. If the check is slow the customer is
 * redirected with `pending` and the landing page polls; the verification it
 * started is NOT cancelled and usually lands moments later, and the
 * reconciliation sweep covers it regardless. Nothing is lost by not waiting —
 * only the instant confirmation, which is a nice-to-have, and never the money.
 */
const RETURN_VERIFY_BUDGET_MS = Number(process.env.PAYMENT_RETURN_BUDGET_MS) || 8000;

exports.paystationReturn = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const appBase = (process.env.APP_PUBLIC_URL || '').replace(/\/+$/, '');

  let result = null;
  try {
    const verifying = checkoutService
      .verifyOrder(orderId, { reason: 'return' })
      // Attached HERE rather than left to the race: once we stop awaiting this
      // promise, a later rejection would otherwise surface as an unhandled
      // rejection and take the process down with it.
      .catch((err) => {
        logger.error(`[checkout] return verification failed for order ${orderId}: ${err.message}`);
        return null;
      });

    const timeout = new Promise((resolve) => {
      const timer = setTimeout(() => {
        logger.warn(`[checkout] return for order ${orderId} slow — redirecting, sweep will finish it`);
        resolve(null);
      }, RETURN_VERIFY_BUDGET_MS);
      // Must never hold the event loop open, which matters during a pm2 reload.
      if (typeof timer.unref === 'function') timer.unref();
    });

    result = await Promise.race([verifying, timeout]);
  } catch (err) {
    // Never surface a stack to whoever requested this. The sweep will pick the
    // order up regardless, so a failure here delays the outcome; it cannot lose
    // it.
    logger.error(`[checkout] return handler failed for order ${orderId}: ${err.message}`);
  }

  // A status hint for the landing page's first paint only. The page re-reads the
  // real state from `GET /api/billing/orders/:id` before it says anything to the
  // customer, so a tampered value in this URL changes a spinner, not a fact.
  const hint = result?.fulfilled ? 'success'
    : result?.underpaid ? 'underpaid'
      : result?.failed ? 'failed'
        : result?.paid ? 'processing'
          : 'pending';

  if (!appBase) {
    // No app URL configured — say something true rather than redirecting nowhere.
    return ApiResponse.success(res, {
      data: { orderId, status: hint },
      message: 'Payment processed. Please return to the app.',
    });
  }

  return res.redirect(302, `${appBase}/dashboard/billing/return?order=${encodeURIComponent(orderId)}&hint=${hint}`);
});

/* ── admin ────────────────────────────────────────────────────────────────── */

exports.adminListOrders = asyncHandler(async (req, res) => {
  const [result, counts] = await Promise.all([
    checkoutService.listOrders(req.query),
    checkoutService.orderCounts(),
  ]);
  return ApiResponse.paginated(res, {
    ...result,
    counts,
    message: 'Checkout orders retrieved',
  });
});

exports.adminVerifyOrder = asyncHandler(async (req, res) => {
  const result = await checkoutService.verifyOrder(req.params.id, { reason: 'admin' });
  if (!result.ok && result.reason === 'not_found') {
    throw new AppError('Order not found', 'অর্ডার পাওয়া যায়নি', 404);
  }
  return ApiResponse.success(res, {
    data: result.order,
    message: result.ok ? 'Order checked against the gateway' : 'Gateway could not be reached',
  });
});

exports.adminFulfilOrder = asyncHandler(async (req, res) => {
  const { order, alreadyFulfilled } = await checkoutService.refulfilOrder(req.params.id);
  return ApiResponse.success(res, {
    data: order,
    message: alreadyFulfilled ? 'Order was already fulfilled' : 'Order fulfilled',
  });
});

exports.adminGatewayStatus = asyncHandler(async (req, res) => {
  const { getAdapter } = require('../services/payment/paystation.adapter');
  const [availability, counts] = await Promise.all([
    checkoutService.isCheckoutAvailable(),
    checkoutService.orderCounts(),
  ]);
  return ApiResponse.success(res, {
    data: { ...availability, adapter: getAdapter().getProviderInfo(), counts },
    message: 'Gateway status retrieved',
  });
});
