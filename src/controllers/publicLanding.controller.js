/**
 * The public landing page — read and submit.
 *
 * THE UNTRUSTED SIDE. Everything arriving here comes from a stranger who
 * clicked an advertisement, so:
 *
 *   · no price, total or delivery charge is read from the request (I-13);
 *   · the response carries no shop internals — no ids, no counts, no settings
 *     beyond what the page must render;
 *   · rate limiting and abuse guards are applied at the route, not here.
 *
 * ── AN EXPIRED PAGE STILL ANSWERS (I-14) ────────────────────────────────────
 *
 * A closed page returns 200 with `canOrder: false` rather than a 404. The
 * advertisement may still be running, and a dead link is worse than an honest
 * "this offer has ended" with the shop's phone number on it.
 */

const asyncHandler = require('../utils/asyncHandler.util');
const ApiResponse = require('../utils/response.util');
const landingPageService = require('../services/landingPage.service');
const landingOrderService = require('../services/landingOrder.service');
const { describeLandingState } = require('../utils/landingPageState.util');
const { markSuspicious } = require('../middleware/orderAbuse.middleware');
const { AppError } = require('../middleware/error.middleware');

/**
 * Everything needed to render one page.
 *
 * The HTML is served as authored (already sanitised on write — I-15), plus the
 * offer and zone config the runtime writes into the marked nodes. That config is
 * the AUTHORITY for every number on the page: a price typed into the HTML is
 * decorative and is overwritten before first paint.
 */
exports.getPage = asyncHandler(async (req, res) => {
  const found = await landingPageService.getPublicBySlug(req.params.slug);
  if (!found) {
    throw new AppError('Landing page not found', 'পেজটি পাওয়া যায়নি', 404);
  }

  const { page, state } = found;

  return ApiResponse.success(res, {
    data: {
      slug: page.slug,
      title: page.title,
      html: page.html,
      content: page.content || {},
      seo: page.seo || {},
      // Only what the page renders. `compareAtPrice` is included because it is
      // shown; `sortOrder` and `isActive` are not, because they are authoring
      // concerns and this response is public.
      offers: page.activeOffers().map((o) => ({
        key: o.key,
        label: o.label,
        sublabel: o.sublabel,
        price: o.price,
        compareAtPrice: o.compareAtPrice,
        stockNote: o.stockNote,
      })),
      zones: (page.delivery?.zones || [])
        .filter((z) => z.isActive !== false)
        .map((z) => ({ key: z.key, name: z.name, charge: z.charge })),
      analytics: {
        // The client pixel only. The CAPI token is `select: false` on the model
        // and must never reach a browser.
        fbPixelId: page.analytics?.fbPixelId || null,
        gaId: page.analytics?.gaId || null,
        tiktokPixelId: page.analytics?.tiktokPixelId || null,
      },
      canOrder: state.canAcceptOrders,
      // Bengali copy for the closed notice, so the page does not have to know
      // the state names.
      closed: state.canAcceptOrders ? null : describeLandingState(state),
    },
    message: 'Landing page retrieved successfully',
  });
});

/**
 * Place an order.
 *
 * The route in front of this applies the per-IP order ceiling and the escalating
 * block; `markSuspicious` here adds a strike for a body that could not possibly
 * have come from the rendered form, which is what separates a bot sweeping the
 * endpoint from a customer with a slow connection.
 */
exports.placeOrder = asyncHandler(async (req, res) => {
  const found = await landingPageService.getPublicBySlug(req.params.slug);
  if (!found) {
    throw new AppError('Landing page not found', 'পেজটি পাওয়া যায়নি', 404);
  }

  const { page } = found;

  let order;
  try {
    order = await landingOrderService.place(page, req.body, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      attribution: req.body?.attribution || {},
    });
  } catch (err) {
    // A 400 here means the body did not match the form this page renders. One
    // is a mistake; a stream of them is a script. Never awaited — the customer's
    // error must not wait on bookkeeping.
    if (err?.statusCode === 400 || err?.statusCode === 409) {
      markSuspicious(req, `malformed landing order: ${err.message}`).catch(() => {});
    }
    throw err;
  }

  return ApiResponse.created(res, {
    // Deliberately minimal. The customer needs their order number and what they
    // agreed to pay; everything else is the shop's business.
    data: {
      orderNo: order.orderNo,
      total: order.total,
      subtotal: order.subtotal,
      deliveryCharge: order.deliveryCharge,
      items: order.items.map((i) => ({
        label: i.label,
        quantity: i.quantity,
        lineTotal: i.lineTotal,
      })),
    },
    message: 'Order placed',
    messageBn: 'আপনার অর্ডারটি জমা হয়েছে',
  });
});
