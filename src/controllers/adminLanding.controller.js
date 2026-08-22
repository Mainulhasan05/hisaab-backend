/**
 * Admin landing page endpoints — thin wrappers. All policy is in the services.
 *
 * Everything here is mounted behind `protect, adminOnly`. Under D1/D11 the
 * platform authors these pages and assigns them; a shop never reaches this
 * controller.
 */

const asyncHandler = require('../utils/asyncHandler.util');
const ApiResponse = require('../utils/response.util');
const landingPageService = require('../services/landingPage.service');
const landingOrderService = require('../services/landingOrder.service');
const LandingPage = require('../models/LandingPage.model');
const Shop = require('../models/Shop.model');
const { resolveLandingPage } = require('../utils/landingPageState.util');
const { hasBlockingIssues } = require('../utils/landingContract.util');
const { AppError } = require('../middleware/error.middleware');

/** Every page across the platform — the admin's renewal worklist. */
exports.list = asyncHandler(async (req, res) => {
  const { shop, status, search } = req.query;

  const query = {};
  if (shop) query.shop = shop;
  if (status) query.status = status;
  if (search) {
    const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ title: rx }, { slug: rx }];
  }

  const pages = await LandingPage.find(query)
    .select('-html -htmlHistory -manifest -content')
    .populate('shop', 'name slug')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  return ApiResponse.success(res, {
    // Resolved on read so "expiring in 3 days" is correct the moment it is true,
    // whether or not the nightly sweep has run.
    data: pages.map((p) => ({ ...p, state: resolveLandingPage(p) })),
    message: 'Landing pages retrieved successfully',
  });
});

exports.create = asyncHandler(async (req, res) => {
  const shop = await Shop.findById(req.body?.shop).select('_id name').lean();
  if (!shop) throw new AppError('Shop not found', 'দোকানটি পাওয়া যায়নি', 404);

  const page = await landingPageService.create(
    {
      shop: shop._id,
      title: req.body?.title,
      slug: req.body?.slug,
      orderPrefix: req.body?.orderPrefix,
    },
    req.admin?._id || null
  );

  return ApiResponse.created(res, {
    data: page,
    message: 'Landing page created',
    messageBn: 'পেজ তৈরি হয়েছে',
  });
});

/**
 * One page, with everything the authoring screen needs in a single call.
 *
 * The contract report rides along on the GET as well as the save, so an admin
 * opening a page they left half-finished sees immediately why it will not
 * publish — rather than having to press Save to find out.
 */
exports.detail = asyncHandler(async (req, res) => {
  const page = await landingPageService.getById(req.params.id);
  // The same list `publish` gates on — including the missing expiry date, which
  // the HTML contract cannot see.
  const issues = landingPageService.publishIssues(page);

  return ApiResponse.success(res, {
    data: {
      page,
      state: resolveLandingPage(page),
      issues,
      canPublish: !hasBlockingIssues(issues),
      stats: await landingPageService.statsForPage(page._id),
    },
    message: 'Landing page retrieved successfully',
  });
});

/**
 * Save. Reports contract problems; does NOT refuse them.
 *
 * An author working through generated HTML has to be able to save a page that
 * is not finished yet — `publish` is where the same issues become a refusal.
 */
exports.save = asyncHandler(async (req, res) => {
  const result = await landingPageService.saveContent(req.params.id, req.admin?._id || null, {
    html: req.body?.html,
    offers: req.body?.offers,
    delivery: req.body?.delivery,
    seo: req.body?.seo,
    orderPrefix: req.body?.orderPrefix,
    notifications: req.body?.notifications,
    analytics: req.body?.analytics,
    editableKeys: req.body?.editableKeys,
    payment: req.body?.payment,
    // Rules only — `usedCount` is live state and the service preserves it. See
    // the merge in `saveContent`.
    coupons: req.body?.coupons,
  });

  return ApiResponse.success(res, {
    data: {
      page: result.page,
      issues: result.issues,
      canPublish: result.canPublish,
      // What the sanitiser dropped. Content that vanishes without explanation is
      // how an author concludes the editor is broken.
      sanitizeNotes: result.sanitizeNotes,
    },
    message: 'Saved',
    messageBn: 'সংরক্ষিত হয়েছে',
  });
});

exports.publish = asyncHandler(async (req, res) => {
  const { page } = await landingPageService.publish(req.params.id, req.admin?._id || null);

  return ApiResponse.success(res, {
    data: { page, state: resolveLandingPage(page) },
    message: 'Landing page published',
    messageBn: 'পেজটি চালু হয়েছে',
  });
});

exports.schedule = asyncHandler(async (req, res) => {
  const page = await landingPageService.setSchedule(req.params.id, req.admin?._id || null, {
    startsAt: req.body?.startsAt,
    expiresAt: req.body?.expiresAt,
    graceDays: req.body?.graceDays,
  });

  return ApiResponse.success(res, {
    data: { page, state: resolveLandingPage(page) },
    message: 'Schedule updated',
    messageBn: 'মেয়াদ আপডেট হয়েছে',
  });
});

exports.renew = asyncHandler(async (req, res) => {
  const page = await landingPageService.renew(req.params.id, req.admin?._id || null, {
    expiresAt: req.body?.expiresAt,
    graceDays: req.body?.graceDays,
  });

  return ApiResponse.success(res, {
    data: { page, state: resolveLandingPage(page) },
    message: 'Landing page renewed',
    messageBn: 'পেজটি নবায়ন হয়েছে',
  });
});

/** The platform kill switch. The shop cannot clear this one. */
exports.setPause = asyncHandler(async (req, res) => {
  const page = await landingPageService.setAdminPause(req.params.id, req.admin?._id || null, {
    paused: Boolean(req.body?.paused),
    reason: req.body?.reason,
  });

  return ApiResponse.success(res, {
    data: { page, state: resolveLandingPage(page) },
    message: req.body?.paused ? 'Landing page paused' : 'Landing page resumed',
    messageBn: req.body?.paused ? 'পেজটি বন্ধ করা হয়েছে' : 'পেজটি চালু করা হয়েছে',
  });
});

/** Orders for one page — the admin's support view of what the shop is working. */
exports.orders = asyncHandler(async (req, res) => {
  const page = await landingPageService.getById(req.params.id);
  const result = await landingOrderService.listForShop(page.shop, {
    page: page._id,
    status: req.query?.status || null,
    limit: req.query?.limit,
  });

  return ApiResponse.success(res, {
    data: {
      items: result.items,
      total: result.total,
      stats: await landingPageService.statsForPage(page._id),
    },
    message: 'Orders retrieved successfully',
  });
});
