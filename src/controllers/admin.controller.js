const adminService = require('../services/admin.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { setAdminTokenCookie, clearAdminTokenCookie, clearUserTokenCookie } = require('../utils/cookie.util');

// Admin login
exports.login = asyncHandler(async (req, res) => {
  const { phone, password } = req.body;
  const result = await adminService.login(phone, password);

  // Clear user token cookie if exists (prevent cookie conflict)
  clearUserTokenCookie(res);

  // Set admin token cookie for browser authentication
  setAdminTokenCookie(res, result.token);

  return ApiResponse.success(res, {
    data: result,
    message: 'Login successful',
    messageBn: 'লগইন সফল হয়েছে',
  });
});

// Admin logout
exports.logout = asyncHandler(async (req, res) => {
  clearAdminTokenCookie(res);
  return ApiResponse.success(res, {
    message: 'Logout successful',
    messageBn: 'লগআউট সফল হয়েছে',
  });
});

// Get admin stats
exports.getStats = asyncHandler(async (req, res) => {
  const stats = await adminService.getStats();
  return ApiResponse.success(res, {
    data: stats,
    message: 'Stats retrieved successfully',
    messageBn: 'পরিসংখ্যান সফলভাবে লোড হয়েছে',
  });
});

// Get all shops
exports.getShops = asyncHandler(async (req, res) => {
  const result = await adminService.getAllShops(req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Shops retrieved successfully',
    messageBn: 'দোকান তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Get shop details
exports.getShopDetails = asyncHandler(async (req, res) => {
  const shop = await adminService.getShopDetails(req.params.id);
  return ApiResponse.success(res, {
    data: shop,
    message: 'Shop details retrieved successfully',
    messageBn: 'দোকানের বিবরণ সফলভাবে লোড হয়েছে',
  });
});

// Update shop status
exports.updateShopStatus = asyncHandler(async (req, res) => {
  const { status, reason } = req.body;
  const shop = await adminService.updateShopStatus(req.admin._id, req.params.id, status, reason);
  return ApiResponse.success(res, {
    data: shop,
    message: 'Shop status updated successfully',
    messageBn: 'দোকানের স্ট্যাটাস সফলভাবে আপডেট হয়েছে',
  });
});

// Update shop subscription
exports.updateShopSubscription = asyncHandler(async (req, res) => {
  const { plan, expiresAt } = req.body;
  const shop = await adminService.updateShopSubscription(req.admin._id, req.params.id, plan, expiresAt);
  return ApiResponse.success(res, {
    data: shop,
    message: 'Subscription updated successfully',
    messageBn: 'সাবস্ক্রিপশন সফলভাবে আপডেট হয়েছে',
  });
});

// Get subscription payments
exports.getPayments = asyncHandler(async (req, res) => {
  const result = await adminService.getSubscriptionPayments(req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Payments retrieved successfully',
    messageBn: 'পেমেন্ট তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Record subscription payment
exports.recordPayment = asyncHandler(async (req, res) => {
  const result = await adminService.recordSubscriptionPayment(req.admin._id, req.body);
  return ApiResponse.success(res, {
    data: result,
    message: 'Payment recorded successfully',
    messageBn: 'পেমেন্ট সফলভাবে রেকর্ড হয়েছে',
    statusCode: 201,
  });
});

// Allocate SMS quota
exports.allocateSMS = asyncHandler(async (req, res) => {
  const quota = await adminService.allocateSMSQuota(req.admin._id, req.body);
  return ApiResponse.success(res, {
    data: quota,
    message: 'SMS quota allocated successfully',
    messageBn: 'এসএমএস কোটা সফলভাবে বরাদ্দ হয়েছে',
  });
});

// Get audit logs
exports.getAuditLogs = asyncHandler(async (req, res) => {
  const result = await adminService.getAuditLogs(req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Audit logs retrieved successfully',
    messageBn: 'অডিট লগ সফলভাবে লোড হয়েছে',
  });
});

// Create admin
exports.createAdmin = asyncHandler(async (req, res) => {
  const admin = await adminService.createAdmin(req.admin._id, req.body);
  return ApiResponse.success(res, {
    data: admin,
    message: 'Admin created successfully',
    messageBn: 'অ্যাডমিন সফলভাবে তৈরি হয়েছে',
    statusCode: 201,
  });
});
