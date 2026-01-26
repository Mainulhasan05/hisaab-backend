const saleService = require('../services/sale.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

// Get all sales
exports.getSales = asyncHandler(async (req, res) => {
  const result = await saleService.getSales(req.shop._id, req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Sales retrieved successfully',
    messageBn: 'বিক্রয় তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Get single sale
exports.getSale = asyncHandler(async (req, res) => {
  const sale = await saleService.getSaleById(req.shop._id, req.params.id);
  return ApiResponse.success(res, {
    data: sale,
    message: 'Sale retrieved successfully',
    messageBn: 'বিক্রয় সফলভাবে লোড হয়েছে',
  });
});

// Create sale
exports.createSale = asyncHandler(async (req, res) => {
  const sale = await saleService.createSale(req.shop._id, req.user._id, req.body);
  return ApiResponse.success(res, {
    data: sale,
    message: 'Sale created successfully',
    messageBn: 'বিক্রয় সফলভাবে সম্পন্ন হয়েছে',
    statusCode: 201,
  });
});

// Record payment
exports.recordPayment = asyncHandler(async (req, res) => {
  const result = await saleService.recordPayment(req.shop._id, req.user._id, req.params.id, req.body);
  return ApiResponse.success(res, {
    data: result,
    message: 'Payment recorded successfully',
    messageBn: 'পেমেন্ট সফলভাবে রেকর্ড করা হয়েছে',
  });
});

// Cancel sale
exports.cancelSale = asyncHandler(async (req, res) => {
  const sale = await saleService.cancelSale(req.shop._id, req.user._id, req.params.id, req.body.reason);
  return ApiResponse.success(res, {
    data: sale,
    message: 'Sale cancelled successfully',
    messageBn: 'বিক্রয় সফলভাবে বাতিল করা হয়েছে',
  });
});

// Get today's summary
exports.getTodaySummary = asyncHandler(async (req, res) => {
  const summary = await saleService.getTodaySummary(req.shop._id);
  return ApiResponse.success(res, {
    data: summary,
    message: 'Today\'s summary retrieved successfully',
    messageBn: 'আজকের সারাংশ সফলভাবে লোড হয়েছে',
  });
});

// Get recent sales
exports.getRecentSales = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const sales = await saleService.getRecentSales(req.shop._id, limit);
  return ApiResponse.success(res, {
    data: sales,
    message: 'Recent sales retrieved successfully',
    messageBn: 'সাম্প্রতিক বিক্রয় সফলভাবে লোড হয়েছে',
  });
});
