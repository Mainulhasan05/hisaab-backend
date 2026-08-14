const adminStorefrontService = require('../services/adminStorefront.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

/**
 * Platform-admin surface for the online storefront: the template catalogue,
 * per-shop template grants, oversight and the kill switch.
 */

// ── Template catalogue ──────────────────────────────────────────────────────

exports.listTemplates = asyncHandler(async (req, res) => {
  const templates = await adminStorefrontService.listTemplates();
  return ApiResponse.success(res, {
    data: { templates, slots: adminStorefrontService.getSlotVocabulary() },
    message: 'Templates retrieved successfully',
  });
});

exports.createTemplate = asyncHandler(async (req, res) => {
  const template = await adminStorefrontService.createTemplate(req.admin._id, req.body);
  return ApiResponse.success(res, {
    data: template,
    message: 'Template created',
    statusCode: 201,
  });
});

exports.updateTemplate = asyncHandler(async (req, res) => {
  const template = await adminStorefrontService.updateTemplate(
    req.admin._id,
    req.params.id,
    req.body
  );
  return ApiResponse.success(res, { data: template, message: 'Template updated' });
});

exports.publishTemplate = asyncHandler(async (req, res) => {
  const template = await adminStorefrontService.publishTemplate(req.admin._id, req.params.id);
  return ApiResponse.success(res, { data: template, message: 'Template published' });
});

exports.retireTemplate = asyncHandler(async (req, res) => {
  const template = await adminStorefrontService.retireTemplate(req.admin._id, req.params.id);
  return ApiResponse.success(res, {
    data: template,
    message: `Template retired. It is still live on ${template.liveOnShops} shop(s) and keeps rendering for them.`,
  });
});

// ── Per-shop grants ─────────────────────────────────────────────────────────

exports.getShopTemplates = asyncHandler(async (req, res) => {
  const data = await adminStorefrontService.getShopTemplateGrants(req.params.id);
  return ApiResponse.success(res, { data, message: 'Shop template grants retrieved' });
});

exports.setShopTemplates = asyncHandler(async (req, res) => {
  const result = await adminStorefrontService.setShopTemplates(
    req.params.id,
    req.admin._id,
    req.body.templates
  );
  return ApiResponse.success(res, { data: result, message: 'Shop template grants updated' });
});

// ── Oversight & kill switch ─────────────────────────────────────────────────

exports.listStorefronts = asyncHandler(async (req, res) => {
  const data = await adminStorefrontService.listStorefronts({
    page: req.query.page,
    limit: req.query.limit,
    status: req.query.status,
  });
  return ApiResponse.success(res, { data, message: 'Storefronts retrieved' });
});

exports.setStorefrontPause = asyncHandler(async (req, res) => {
  const storefront = await adminStorefrontService.setStorefrontPause(
    req.params.id,
    req.admin._id,
    { paused: req.body.paused === true, reason: req.body.reason }
  );
  return ApiResponse.success(res, {
    data: storefront,
    message: req.body.paused === true ? 'Storefront paused' : 'Storefront resumed',
  });
});
