const purchaseService = require('../services/purchase.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

// Get all purchases
exports.getPurchases = asyncHandler(async (req, res) => {
  const result = await purchaseService.getPurchases(req.shop._id, req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Purchases retrieved successfully',
    messageBn: 'ক্রয়ের তালিকা লোড হয়েছে',
  });
});

// Get single purchase
exports.getPurchase = asyncHandler(async (req, res) => {
  const purchase = await purchaseService.getPurchaseById(req.shop._id, req.params.id);
  return ApiResponse.success(res, {
    data: purchase,
    message: 'Purchase retrieved',
    messageBn: 'ক্রয়ের তথ্য লোড হয়েছে',
  });
});

// Create purchase
exports.createPurchase = asyncHandler(async (req, res) => {
  const purchase = await purchaseService.createPurchase(req.shop._id, req.user._id, req.body);
  return ApiResponse.created(res, {
    data: purchase,
    message: 'Purchase recorded successfully',
    messageBn: 'ক্রয় সফলভাবে রেকর্ড হয়েছে',
  });
});

// Cancel purchase
exports.cancelPurchase = asyncHandler(async (req, res) => {
  await purchaseService.cancelPurchase(req.shop._id, req.user._id, req.params.id);
  return ApiResponse.success(res, {
    message: 'Purchase cancelled successfully',
    messageBn: 'ক্রয় সফলভাবে বাতিল হয়েছে',
  });
});

// Get purchase summary
exports.getSummary = asyncHandler(async (req, res) => {
  const summary = await purchaseService.getSummary(req.shop._id, req.query);
  return ApiResponse.success(res, {
    data: summary,
    message: 'Purchase summary retrieved',
    messageBn: 'ক্রয়ের সারাংশ লোড হয়েছে',
  });
});
