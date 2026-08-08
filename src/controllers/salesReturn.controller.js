const salesReturnService = require('../services/salesReturn.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

// Create sales return
exports.createReturn = asyncHandler(async (req, res) => {
  const salesReturn = await salesReturnService.createReturn(
    req.shop._id,
    req.user._id,
    req.body,
    req
  );
  return ApiResponse.created(res, {
    data: salesReturn,
    message: 'Sales return created successfully',
    messageBn: 'মাল ফেরত সফলভাবে সম্পন্ন হয়েছে',
  });
});

// Settle a refund that was recorded as "pay later" (store_credit).
exports.settleRefund = asyncHandler(async (req, res) => {
  const salesReturn = await salesReturnService.settleRefund(
    req.shop._id,
    req.user._id,
    req.params.id,
    req.body,
    req
  );
  return ApiResponse.success(res, {
    data: salesReturn,
    message: 'Refund settled successfully',
    messageBn: 'ফেরতের টাকা পরিশোধ হয়েছে',
  });
});

// Get all returns (paginated)
exports.getReturns = asyncHandler(async (req, res) => {
  const options = { ...req.query };
  if (req.branchId) options.branchId = req.branchId;
  const result = await salesReturnService.getReturns(req.shop._id, options);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Returns retrieved successfully',
    messageBn: 'ফেরত তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Get single return
exports.getReturn = asyncHandler(async (req, res) => {
  const salesReturn = await salesReturnService.getReturnById(
    req.shop._id,
    req.params.id,
    req
  );
  return ApiResponse.success(res, {
    data: salesReturn,
    message: 'Return retrieved successfully',
    messageBn: 'ফেরত সফলভাবে লোড হয়েছে',
  });
});

// Get returns for a specific sale
exports.getReturnsBySale = asyncHandler(async (req, res) => {
  const returns = await salesReturnService.getReturnsBySale(
    req.shop._id,
    req.params.saleId,
    req
  );
  return ApiResponse.success(res, {
    data: returns,
    message: 'Sale returns retrieved successfully',
    messageBn: 'বিক্রয়ের ফেরত তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Get returnable items for a sale
exports.getReturnableItems = asyncHandler(async (req, res) => {
  const result = await salesReturnService.getReturnableItems(
    req.shop._id,
    req.params.saleId,
    req
  );
  return ApiResponse.success(res, {
    data: result,
    message: 'Returnable items retrieved successfully',
    messageBn: 'ফেরতযোগ্য আইটেম সফলভাবে লোড হয়েছে',
  });
});

// Get returns summary
exports.getReturnsSummary = asyncHandler(async (req, res) => {
  const summary = await salesReturnService.getReturnsSummary(
    req.shop._id,
    req.query
  );
  return ApiResponse.success(res, {
    data: summary,
    message: 'Returns summary retrieved successfully',
    messageBn: 'ফেরত সারাংশ সফলভাবে লোড হয়েছে',
  });
});
