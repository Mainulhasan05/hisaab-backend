const storefrontService = require('../services/storefront.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

/**
 * The shop's own storefront surface. Every route here is behind
 * `requireFeature('storefront')` — see routes/storefront.routes.js.
 */

// The storefront document plus the gallery the picker renders from. One call,
// because the panel's first screen needs both and a second round trip on a
// 3G connection is a second spinner.
exports.getStorefront = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.getStorefront(req.shop._id);
  const templates = await storefrontService.getTemplateGallery(req.shop);

  return ApiResponse.success(res, {
    data: {
      storefront,
      templates,
      hasUnpublishedChanges: storefront.hasUnpublishedChanges(),
      // The public address. Built here rather than in the client so the client
      // never has to know how storefront URLs are shaped — that changes when
      // subdomains land (ECOMMERCE_PLAN.md §8.5) and this is the one place it
      // should change.
      publicPath: `/s/${req.shop.slug}`,
    },
    message: 'Storefront retrieved successfully',
    messageBn: 'অনলাইন দোকানের তথ্য লোড হয়েছে',
  });
});

exports.getTemplates = asyncHandler(async (req, res) => {
  const templates = await storefrontService.getTemplateGallery(req.shop);
  return ApiResponse.success(res, {
    data: templates,
    message: 'Templates retrieved successfully',
    messageBn: 'টেমপ্লেট তালিকা লোড হয়েছে',
  });
});

exports.applyTemplate = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.applyTemplate(
    req.shop,
    req.user._id,
    req.body.template
  );
  return ApiResponse.success(res, {
    data: storefront,
    message: 'Template applied',
    messageBn: 'টেমপ্লেট প্রয়োগ করা হয়েছে — প্রিভিউ দেখে প্রকাশ করুন',
  });
});

exports.updateDraft = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.updateDraft(req.shop._id, req.body);
  return ApiResponse.success(res, {
    data: storefront,
    message: 'Draft saved',
    messageBn: 'ড্রাফট সংরক্ষণ করা হয়েছে',
  });
});

exports.publish = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.publish(req.shop._id, req.user._id);
  return ApiResponse.success(res, {
    data: storefront,
    message: 'Storefront published',
    messageBn: 'ওয়েবসাইট প্রকাশ করা হয়েছে',
  });
});

exports.rollback = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.rollback(
    req.shop._id,
    req.user._id,
    req.params.version
  );
  return ApiResponse.success(res, {
    data: storefront,
    message: 'Version restored into draft',
    messageBn: 'সংস্করণটি ড্রাফটে ফেরানো হয়েছে',
  });
});

exports.setStatus = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.setStatus(
    req.shop._id,
    req.user._id,
    req.body.status
  );
  return ApiResponse.success(res, {
    data: storefront,
    message: 'Storefront status updated',
    messageBn: storefront.status === 'live'
      ? 'অনলাইন দোকান চালু করা হয়েছে'
      : 'অনলাইন দোকান সাময়িকভাবে বন্ধ করা হয়েছে',
  });
});

exports.updateSettings = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.updateSettings(req.shop._id, req.body);
  return ApiResponse.success(res, {
    data: storefront,
    message: 'Settings updated',
    messageBn: 'সেটিংস সংরক্ষণ করা হয়েছে',
  });
});
