const ingredientService = require('../services/ingredient.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

// কাঁচামাল — CLAUDE.md §18. The whole router is behind features.restaurant.

exports.list = asyncHandler(async (req, res) => {
  const data = await ingredientService.list(req, {
    includeInactive: req.query.includeInactive === 'true',
  });
  return ApiResponse.success(res, { data, message: 'Ingredients', messageBn: 'কাঁচামালের তালিকা' });
});

exports.create = asyncHandler(async (req, res) => {
  const data = await ingredientService.create(req, req.user._id, req.body);
  return ApiResponse.success(res, {
    data, statusCode: 201, message: 'Ingredient added', messageBn: 'কাঁচামাল যোগ হয়েছে',
  });
});

exports.update = asyncHandler(async (req, res) => {
  const data = await ingredientService.update(req, req.params.id, req.body);
  return ApiResponse.success(res, { data, message: 'Ingredient updated', messageBn: 'কাঁচামাল আপডেট হয়েছে' });
});

exports.adjust = asyncHandler(async (req, res) => {
  const data = await ingredientService.adjust(req, req.user._id, req.params.id, req.body);
  return ApiResponse.success(res, { data, message: 'Stock corrected', messageBn: 'স্টক ঠিক করা হয়েছে' });
});

exports.issue = asyncHandler(async (req, res) => {
  const data = await ingredientService.issue(req, req.user._id, req.body);
  return ApiResponse.success(res, {
    data, statusCode: 201, message: 'Kitchen issue saved', messageBn: 'রান্নাঘরে দেওয়া সেভ হয়েছে',
  });
});

exports.movements = asyncHandler(async (req, res) => {
  const result = await ingredientService.movements(req, req.query);
  return ApiResponse.success(res, {
    data: result.data, pagination: result.pagination, message: 'Movements', messageBn: 'স্টকের ইতিহাস',
  });
});

exports.costReport = asyncHandler(async (req, res) => {
  const data = await ingredientService.costReport(req, req.query);
  return ApiResponse.success(res, { data, message: 'Ingredient cost', messageBn: 'কাঁচামাল খরচ' });
});
