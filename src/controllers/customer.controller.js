const customerService = require('../services/customer.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

// Get all customers
exports.getCustomers = asyncHandler(async (req, res) => {
  const result = await customerService.getCustomers(req.shop._id, req.query, req);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Customers retrieved successfully',
    messageBn: 'কাস্টমার তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Get single customer
exports.getCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.getCustomerById(req.shop._id, req.params.id, req);
  return ApiResponse.success(res, {
    data: customer,
    message: 'Customer retrieved successfully',
    messageBn: 'কাস্টমার সফলভাবে লোড হয়েছে',
  });
});

// Get customer by phone
exports.getCustomerByPhone = asyncHandler(async (req, res) => {
  const customer = await customerService.getCustomerByPhone(req.shop._id, req.params.phone, req);
  return ApiResponse.success(res, {
    data: customer,
    message: customer ? 'Customer found' : 'Customer not found',
    messageBn: customer ? 'কাস্টমার পাওয়া গেছে' : 'কাস্টমার পাওয়া যায়নি',
  });
});

// Create customer
exports.createCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.createCustomer(req.shop._id, req.user._id, req.body, req);
  return ApiResponse.success(res, {
    data: customer,
    message: 'Customer created successfully',
    messageBn: 'কাস্টমার সফলভাবে যোগ করা হয়েছে',
    statusCode: 201,
  });
});

// Update customer
exports.updateCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.updateCustomer(req.shop._id, req.user._id, req.params.id, req.body, req);
  return ApiResponse.success(res, {
    data: customer,
    message: 'Customer updated successfully',
    messageBn: 'কাস্টমার সফলভাবে আপডেট করা হয়েছে',
  });
});

// Delete customer
exports.deleteCustomer = asyncHandler(async (req, res) => {
  await customerService.deleteCustomer(req.shop._id, req.user._id, req.params.id, req);
  return ApiResponse.success(res, {
    message: 'Customer deleted successfully',
    messageBn: 'কাস্টমার সফলভাবে মুছে ফেলা হয়েছে',
  });
});

// Collect due payment
exports.collectDue = asyncHandler(async (req, res) => {
  const result = await customerService.collectDuePayment(req.shop._id, req.user._id, req.params.id, req.body, req);
  return ApiResponse.success(res, {
    data: result,
    message: 'Due payment collected successfully',
    messageBn: 'বাকি সফলভাবে আদায় করা হয়েছে',
  });
});

// Set a customer's opening (pre-software) due — owner only, see route
exports.setOpeningDue = asyncHandler(async (req, res) => {
  const result = await customerService.setOpeningDue(
    req.shop._id, req.user._id, req.params.id, req.body, req
  );
  return ApiResponse.success(res, {
    data: result,
    message: 'Opening due updated successfully',
    messageBn: 'পূর্বের বাকি আপডেট হয়েছে',
  });
});

// Full account statement — sales, payments, returns and adjustments in one
// running-balance ledger
exports.getCustomerLedger = asyncHandler(async (req, res) => {
  const result = await customerService.getCustomerLedger(req.shop._id, req.params.id, req.query, req);
  return ApiResponse.success(res, {
    data: result,
    message: 'Customer ledger retrieved successfully',
    messageBn: 'কাস্টমার খতিয়ান লোড হয়েছে',
  });
});

// Dry-run an import batch so the preview screen can show what will happen
exports.validateImport = asyncHandler(async (req, res) => {
  const result = await customerService.validateImportRows(req.shop._id, req.body.customers, req);
  return ApiResponse.success(res, {
    data: result,
    message: 'Import validated',
    messageBn: 'ফাইল যাচাই সম্পন্ন',
  });
});

// Get customer purchase history
exports.getCustomerHistory = asyncHandler(async (req, res) => {
  const result = await customerService.getCustomerHistory(req.shop._id, req.params.id, req.query, req);
  return ApiResponse.success(res, {
    data: result,
    message: 'Customer history retrieved successfully',
    messageBn: 'কাস্টমার ইতিহাস সফলভাবে লোড হয়েছে',
  });
});

// Get customers with due
exports.getCustomersWithDue = asyncHandler(async (req, res) => {
  const result = await customerService.getCustomersWithDue(req.shop._id, req.query, req);
  return ApiResponse.success(res, {
    data: result,
    message: 'Customers with due retrieved successfully',
    messageBn: 'বাকি আছে এমন কাস্টমার সফলভাবে লোড হয়েছে',
  });
});

// Get top customers
exports.getTopCustomers = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const customers = await customerService.getTopCustomers(req.shop._id, limit, req);
  return ApiResponse.success(res, {
    data: customers,
    message: 'Top customers retrieved successfully',
    messageBn: 'শীর্ষ কাস্টমার সফলভাবে লোড হয়েছে',
  });
});

// Get customer leaderboard
exports.getCustomerLeaderboard = asyncHandler(async (req, res) => {
  const result = await customerService.getCustomerLeaderboard(req.shop._id, req.query, req);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Customer leaderboard retrieved successfully',
    messageBn: 'কাস্টমার লিডারবোর্ড সফলভাবে লোড হয়েছে',
  });
});

// Bulk import customers
exports.bulkImport = asyncHandler(async (req, res) => {
  const results = await customerService.bulkImportCustomers(req.shop._id, req.user._id, req.body.customers, req);
  return ApiResponse.success(res, {
    data: results,
    message: 'Bulk import completed',
    messageBn: 'বাল্ক ইম্পোর্ট সম্পন্ন হয়েছে',
  });
});
