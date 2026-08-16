const mongoose = require('mongoose');
const reportService = require('../services/report.service');
const detailedReportService = require('../services/detailedReport.service');
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

// ─────────────────────────────────────────────────────────────────────────────
// Printable documents (customer statement, stock valuation, supplier statement)
//
// All three go through `sanitizeReport` like every other report on this
// controller. That is not belt-and-braces on the stock one: the valuation
// carries `buyingPrice`/`totalCost`/`totalBuyingValue`/`totalProfit` for every
// line in the catalogue, which is the most concentrated cost disclosure the API
// produces. The route grants access; the sanitiser decides which columns come
// back.
// ─────────────────────────────────────────────────────────────────────────────

/** Reject a malformed party id rather than silently widening the statement. */
function invalidId(res, id, labelBn) {
  if (!id || mongoose.Types.ObjectId.isValid(id)) return false;
  ApiResponse.error(res, {
    message: 'Invalid id',
    messageBn: labelBn,
    statusCode: 400,
  });
  return true;
}

// Customer statement of account
exports.getCustomerStatement = asyncHandler(async (req, res) => {
  // A bad `customerId` must not fall through to "every customer" — asking for
  // one person's statement and being handed the whole shop's is both a leak and
  // a several-hundred-page PDF.
  if (invalidId(res, req.query.customerId, 'কাস্টমার সঠিক নয়')) return;

  const report = await detailedReportService.getCustomerStatements(
    req.shop._id,
    {
      ...req.query,
      withDueOnly: req.query.withDueOnly === 'true',
      includeEmpty: req.query.includeEmpty === 'true',
    },
    req
  );

  return ApiResponse.success(res, {
    data: sanitizeReport(report, req),
    message: 'Customer statement generated successfully',
    messageBn: 'কাস্টমার স্টেটমেন্ট তৈরি হয়েছে',
  });
});

// Supplier statement of account
exports.getSupplierStatement = asyncHandler(async (req, res) => {
  if (invalidId(res, req.query.supplierId, 'সরবরাহকারী সঠিক নয়')) return;

  const report = await detailedReportService.getSupplierStatements(
    req.shop._id,
    {
      ...req.query,
      withDueOnly: req.query.withDueOnly === 'true',
      includeEmpty: req.query.includeEmpty === 'true',
    },
    req
  );

  return ApiResponse.success(res, {
    data: sanitizeReport(report, req),
    message: 'Supplier statement generated successfully',
    messageBn: 'সরবরাহকারী স্টেটমেন্ট তৈরি হয়েছে',
  });
});

// Stock valuation report
exports.getStockReport = asyncHandler(async (req, res) => {
  if (invalidId(res, req.query.categoryId, 'ক্যাটাগরি সঠিক নয়')) return;
  if (invalidId(res, req.query.brandId, 'ব্র্যান্ড সঠিক নয়')) return;

  const report = await detailedReportService.getStockReport(
    req.shop._id,
    { ...req.query, includeInactive: req.query.includeInactive === 'true' },
    req
  );

  return ApiResponse.success(res, {
    data: sanitizeReport(report, req),
    message: 'Stock report generated successfully',
    messageBn: 'স্টক রিপোর্ট তৈরি হয়েছে',
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
