const mongoose = require('mongoose');
const reportService = require('../services/report.service');
const customerService = require('../services/customer.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { sanitizeReport } = require('../utils/dataSanitizer.util');

// Get dashboard statistics
exports.getDashboard = asyncHandler(async (req, res) => {
  const stats = await reportService.getDashboardStats(req.shop._id, req.branchId, req.shop.multiBranchEnabled === true, req);
  return ApiResponse.success(res, {
    data: sanitizeReport(stats, req),
    message: 'Dashboard stats retrieved successfully',
    messageBn: 'ড্যাশবোর্ড পরিসংখ্যান সফলভাবে লোড হয়েছে',
  });
});

// Get sales report
exports.getSalesReport = asyncHandler(async (req, res) => {
  const report = await reportService.getSalesReport(req.shop._id, req.query, req.branchId);
  return ApiResponse.success(res, {
    data: sanitizeReport(report, req),
    message: 'Sales report retrieved successfully',
    messageBn: 'বিক্রয় রিপোর্ট সফলভাবে লোড হয়েছে',
  });
});

// Get product report
exports.getProductReport = asyncHandler(async (req, res) => {
  const report = await reportService.getProductReport(req.shop._id, req.query, req.branchId);
  return ApiResponse.success(res, {
    data: sanitizeReport(report, req),
    message: 'Product report retrieved successfully',
    messageBn: 'পণ্য রিপোর্ট সফলভাবে লোড হয়েছে',
  });
});

// Get customer report
exports.getCustomerReport = asyncHandler(async (req, res) => {
  const report = await reportService.getCustomerReport(req.shop._id, req.query, req);
  return ApiResponse.success(res, {
    data: sanitizeReport(report, req),
    message: 'Customer report retrieved successfully',
    messageBn: 'কাস্টমার রিপোর্ট সফলভাবে লোড হয়েছে',
  });
});

// Get Daily Business Summary
exports.getDailySummary = asyncHandler(async (req, res) => {
  const report = await reportService.getDailySummary(req.shop._id, req.query, req.branchId);
  return ApiResponse.success(res, {
    data: sanitizeReport(report, req),
    message: 'Daily summary retrieved successfully',
    messageBn: 'দৈনিক সারাংশ সফলভাবে লোড হয়েছে',
  });
});

// Get staff-wise sales report
exports.getStaffReport = asyncHandler(async (req, res) => {
  const report = await reportService.getStaffReport(req.shop._id, req.query, req.branchId);
  return ApiResponse.success(res, {
    data: sanitizeReport(report, req),
    message: 'Staff sales report retrieved successfully',
    messageBn: 'স্টাফ বিক্রয় রিপোর্ট সফলভাবে লোড হয়েছে',
  });
});

// Get detailed staff-wise date-wise itemized sales report
exports.getDetailedStaffReport = asyncHandler(async (req, res) => {
  const report = await reportService.getDetailedStaffReport(req.shop._id, req.query, req.branchId);
  return ApiResponse.success(res, {
    data: sanitizeReport(report, req),
    message: 'Detailed staff sales report retrieved successfully',
    messageBn: 'বিস্তারিত স্টাফ বিক্রয় রিপোর্ট সফলভাবে লোড হয়েছে',
  });
});

// Get Profit & Loss statement
exports.getProfitLoss = asyncHandler(async (req, res) => {
  const report = await reportService.getProfitLoss(req.shop._id, req.query, req.branchId);
  return ApiResponse.success(res, {
    data: sanitizeReport(report, req),
    message: 'Profit & Loss report retrieved successfully',
    messageBn: 'লাভ-ক্ষতি রিপোর্ট সফলভাবে লোড হয়েছে',
  });
});

// Get Date-wise Summary (monthly table)
exports.getDateWiseSummary = asyncHandler(async (req, res) => {
  const report = await reportService.getDateWiseSummary(req.shop._id, req.query, req.branchId);
  return ApiResponse.success(res, {
    data: sanitizeReport(report, req),
    message: 'Date-wise summary retrieved successfully',
    messageBn: 'তারিখ অনুসারে সারাংশ সফলভাবে লোড হয়েছে',
  });
});

// Get sales for a specific date (drill-down)
exports.getSalesByDate = asyncHandler(async (req, res) => {
  const { date } = req.params;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return ApiResponse.error(res, {
      message: 'Invalid date format. Use YYYY-MM-DD',
      messageBn: 'তারিখের ফরম্যাট সঠিক নয়। YYYY-MM-DD ব্যবহার করুন',
      statusCode: 400,
    });
  }
  // A malformed staffId is rejected rather than ignored: silently dropping it
  // would answer "what did Ravi sell today" with the whole shop's day.
  const { staffId } = req.query;
  if (staffId && !mongoose.Types.ObjectId.isValid(staffId)) {
    return ApiResponse.error(res, {
      message: 'Invalid staff id',
      messageBn: 'কর্মচারী সঠিক নয়',
      statusCode: 400,
    });
  }

  const report = await reportService.getSalesByDate(req.shop._id, date, req.branchId, { staffId });
  return ApiResponse.success(res, {
    data: sanitizeReport(report, req),
    message: 'Sales for date retrieved successfully',
    messageBn: 'নির্দিষ্ট তারিখের বিক্রি সফলভাবে লোড হয়েছে',
  });
});

// Get trending products
exports.getTrendingProducts = asyncHandler(async (req, res) => {
  const report = await reportService.getTrendingProducts(req.shop._id, req.query, req.branchId);
  return ApiResponse.success(res, {
    data: sanitizeReport(report, req),
    message: 'Trending products retrieved successfully',
    messageBn: 'ট্রেন্ডিং পণ্য সফলভাবে লোড হয়েছে',
  });
});

// Export report
exports.exportReport = asyncHandler(async (req, res) => {
  const { type, format } = req.params;
  const report = await reportService.exportReport(req.shop._id, type, format, req.query, req.branchId);

  // For now, return JSON data
  // In production, this would generate actual file downloads
  return ApiResponse.success(res, {
    data: sanitizeReport(report, req),
    message: 'Report exported successfully',
    messageBn: 'রিপোর্ট সফলভাবে এক্সপোর্ট হয়েছে',
  });
});

// Due Aging Analysis
exports.getDueAging = asyncHandler(async (req, res) => {
  const result = await customerService.getDueAging(req.shop._id, req);
  return ApiResponse.success(res, {
    data: sanitizeReport(result, req),
    message: 'Due aging report generated',
    messageBn: 'বাকি এজিং রিপোর্ট তৈরি হয়েছে',
  });
});
