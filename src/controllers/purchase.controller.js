const purchaseService = require('../services/purchase.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

// Get all purchases
exports.getPurchases = asyncHandler(async (req, res) => {
  const options = { ...req.query };
  if (req.branchId) options.branchId = req.branchId;
  const result = await purchaseService.getPurchases(req.shop._id, options);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Purchases retrieved successfully',
    messageBn: 'ক্রয়ের তালিকা লোড হয়েছে',
  });
});

// Get single purchase
exports.getPurchase = asyncHandler(async (req, res) => {
  const purchase = await purchaseService.getPurchaseById(req.shop._id, req.params.id, req);
  return ApiResponse.success(res, {
    data: purchase,
    message: 'Purchase retrieved',
    messageBn: 'ক্রয়ের তথ্য লোড হয়েছে',
  });
});

// Create purchase
exports.createPurchase = asyncHandler(async (req, res) => {
  const purchase = await purchaseService.createPurchase(req.shop._id, req.user._id, req.body, req);
  return ApiResponse.created(res, {
    data: purchase,
    message: 'Purchase recorded successfully',
    messageBn: 'ক্রয় সফলভাবে রেকর্ড হয়েছে',
  });
});

// Cancel purchase
exports.cancelPurchase = asyncHandler(async (req, res) => {
  await purchaseService.cancelPurchase(req.shop._id, req.user._id, req.params.id, req);
  return ApiResponse.success(res, {
    message: 'Purchase cancelled successfully',
    messageBn: 'ক্রয় সফলভাবে বাতিল হয়েছে',
  });
});

// Get purchase summary
exports.getSummary = asyncHandler(async (req, res) => {
  const summary = await purchaseService.getSummary(req.shop._id, req.query, req);
  return ApiResponse.success(res, {
    data: summary,
    message: 'Purchase summary retrieved',
    messageBn: 'ক্রয়ের সারাংশ লোড হয়েছে',
  });
});

// Record payment for a purchase
exports.recordPayment = asyncHandler(async (req, res) => {
  const result = await purchaseService.recordPayment(
    req.shop._id,
    req.user._id,
    req.params.id,
    req.body,
    req
  );
  return ApiResponse.success(res, {
    data: result,
    message: 'Payment recorded successfully',
    messageBn: 'পেমেন্ট সফলভাবে রেকর্ড হয়েছে',
  });
});

// Get payments for a purchase
exports.getPurchasePayments = asyncHandler(async (req, res) => {
  const payments = await purchaseService.getPurchasePayments(
    req.shop._id,
    req.params.id,
    req
  );
  return ApiResponse.success(res, {
    data: payments,
    message: 'Purchase payments fetched',
    messageBn: 'ক্রয়ের পেমেন্ট সমূহ পাওয়া গেছে',
  });
});
