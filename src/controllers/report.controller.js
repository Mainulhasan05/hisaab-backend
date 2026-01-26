const reportService = require('../services/report.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

// Get dashboard statistics
exports.getDashboard = asyncHandler(async (req, res) => {
  const stats = await reportService.getDashboardStats(req.shop._id);
  return ApiResponse.success(res, {
    data: stats,
    message: 'Dashboard stats retrieved successfully',
    messageBn: 'ড্যাশবোর্ড পরিসংখ্যান সফলভাবে লোড হয়েছে',
  });
});

// Get sales report
exports.getSalesReport = asyncHandler(async (req, res) => {
  const report = await reportService.getSalesReport(req.shop._id, req.query);
  return ApiResponse.success(res, {
    data: report,
    message: 'Sales report retrieved successfully',
    messageBn: 'বিক্রয় রিপোর্ট সফলভাবে লোড হয়েছে',
  });
});

// Get product report
exports.getProductReport = asyncHandler(async (req, res) => {
  const report = await reportService.getProductReport(req.shop._id, req.query);
  return ApiResponse.success(res, {
    data: report,
    message: 'Product report retrieved successfully',
    messageBn: 'পণ্য রিপোর্ট সফলভাবে লোড হয়েছে',
  });
});

// Get customer report
exports.getCustomerReport = asyncHandler(async (req, res) => {
  const report = await reportService.getCustomerReport(req.shop._id, req.query);
  return ApiResponse.success(res, {
    data: report,
    message: 'Customer report retrieved successfully',
    messageBn: 'কাস্টমার রিপোর্ট সফলভাবে লোড হয়েছে',
  });
});

// Export report
exports.exportReport = asyncHandler(async (req, res) => {
  const { type, format } = req.params;
  const report = await reportService.exportReport(req.shop._id, type, format, req.query);

  // For now, return JSON data
  // In production, this would generate actual file downloads
  return ApiResponse.success(res, {
    data: report,
    message: 'Report exported successfully',
    messageBn: 'রিপোর্ট সফলভাবে এক্সপোর্ট হয়েছে',
  });
});
