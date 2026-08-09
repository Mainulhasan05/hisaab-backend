const adminService = require('../services/admin.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { setAdminTokenCookie, clearAdminTokenCookie, clearUserTokenCookie } = require('../utils/cookie.util');
const { refuseDeletion } = require('../utils/deletionDisabled.util');

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

// Update shop subscription (flat rate — admin sets expiry only)
exports.updateShopSubscription = asyncHandler(async (req, res) => {
  const { expiresAt } = req.body;
  const shop = await adminService.updateShopSubscription(req.admin._id, req.params.id, expiresAt);
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

// Get SMS logs (all shops)
exports.getSMSLogs = asyncHandler(async (req, res) => {
  const result = await adminService.getSMSLogs(req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'SMS logs retrieved successfully',
    messageBn: 'এসএমএস লগ সফলভাবে লোড হয়েছে',
  });
});

// Get SMS allocation history
exports.getSMSAllocations = asyncHandler(async (req, res) => {
  const result = await adminService.getSMSAllocations(req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'SMS allocations retrieved successfully',
    messageBn: 'এসএমএস বরাদ্দ তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Get SMS stats
exports.getSMSStats = asyncHandler(async (req, res) => {
  const stats = await adminService.getSMSStats();
  return ApiResponse.success(res, {
    data: stats,
    message: 'SMS stats retrieved successfully',
    messageBn: 'এসএমএস পরিসংখ্যান সফলভাবে লোড হয়েছে',
  });
});

// Get Telegram delivery logs
exports.getTelegramLogs = asyncHandler(async (req, res) => {
  const result = await adminService.getTelegramLogs(req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Telegram logs retrieved successfully',
    messageBn: 'টেলিগ্রাম লগ সফলভাবে লোড হয়েছে',
  });
});

// Get connected Telegram accounts
exports.getTelegramLinks = asyncHandler(async (req, res) => {
  const result = await adminService.getTelegramLinks(req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Telegram links retrieved successfully',
    messageBn: 'সংযুক্ত টেলিগ্রাম তালিকা লোড হয়েছে',
  });
});

// Get Telegram delivery stats
exports.getTelegramStats = asyncHandler(async (req, res) => {
  const stats = await adminService.getTelegramStats();
  return ApiResponse.success(res, {
    data: stats,
    message: 'Telegram stats retrieved successfully',
    messageBn: 'টেলিগ্রাম পরিসংখ্যান লোড হয়েছে',
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

// Get all users across all shops (admin level)
exports.getAllUsers = asyncHandler(async (req, res) => {
  const result = await adminService.getAllUsers(req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Users retrieved successfully',
    messageBn: 'ইউজার তালিকা লোড হয়েছে',
  });
});

// Impersonate a user — sets user cookie so browser logs in as that user
// Intentionally NOT logged in audit logs
exports.impersonateUser = asyncHandler(async (req, res) => {
  const { setUserTokenCookie } = require('../utils/cookie.util');
  const result = await adminService.impersonateUser(req.params.id);
  setUserTokenCookie(res, result.token);
  return ApiResponse.success(res, {
    data: { user: result.user, shop: result.shop },
    message: 'Impersonation token set',
    messageBn: 'ইউজার সেশন সেট হয়েছে',
  });
});

// Get all customers (admin level)
exports.getAllCustomers = asyncHandler(async (req, res) => {
  const result = await adminService.getAllCustomers(req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Customers retrieved successfully',
    messageBn: 'কাস্টমার তালিকা লোড হয়েছে',
  });
});

// Get all sales (admin level)
exports.getAllSales = asyncHandler(async (req, res) => {
  const result = await adminService.getAllSales(req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Sales retrieved successfully',
    messageBn: 'বিক্রয় তালিকা লোড হয়েছে',
  });
});

// Restrict/suspend shop
exports.restrictShop = asyncHandler(async (req, res) => {
  const shop = await adminService.restrictShop(req.admin._id, req.params.id, req.body);
  return ApiResponse.success(res, {
    data: shop,
    message: req.body.action === 'suspend' ? 'Shop suspended' : 'Shop activated',
    messageBn: req.body.action === 'suspend' ? 'দোকান স্থগিত করা হয়েছে' : 'দোকান সক্রিয় করা হয়েছে',
  });
});

// Get online users
exports.getOnlineUsers = asyncHandler(async (req, res) => {
  const result = await adminService.getOnlineUsers(req.query);
  // Flatten response structure - data is the array, count is at top level
  return ApiResponse.success(res, {
    data: result.data,
    count: result.count,
    timestamp: result.timestamp,
    message: 'Online users retrieved',
    messageBn: 'অনলাইন ইউজার তালিকা লোড হয়েছে',
  });
});

// Get Redis/cache stats
exports.getCacheStats = asyncHandler(async (req, res) => {
  const cacheService = require('../services/cache.service');
  const stats = await cacheService.getStats();
  return ApiResponse.success(res, {
    data: stats,
    message: 'Cache stats retrieved',
    messageBn: 'ক্যাশ পরিসংখ্যান লোড হয়েছে',
  });
});

// Get cache summary grouped by prefix
exports.getCacheSummary = asyncHandler(async (req, res) => {
  const cacheService = require('../services/cache.service');
  const summary = await cacheService.getCacheSummary();
  return ApiResponse.success(res, {
    data: summary,
    message: 'Cache summary retrieved',
    messageBn: 'ক্যাশ সারাংশ লোড হয়েছে',
  });
});

// List cache keys with pattern
exports.listCacheKeys = asyncHandler(async (req, res) => {
  const cacheService = require('../services/cache.service');
  const { pattern = '*', limit = 100 } = req.query;
  const result = await cacheService.listKeys(pattern, parseInt(limit));
  return ApiResponse.success(res, {
    data: result,
    message: 'Cache keys retrieved',
    messageBn: 'ক্যাশ কী তালিকা লোড হয়েছে',
  });
});

// Get details of a specific cache key
exports.getCacheKeyDetails = asyncHandler(async (req, res) => {
  const cacheService = require('../services/cache.service');
  const { key } = req.params;
  const details = await cacheService.getKeyDetails(key);
  return ApiResponse.success(res, {
    data: details,
    message: 'Cache key details retrieved',
    messageBn: 'ক্যাশ কী বিস্তারিত লোড হয়েছে',
  });
});

// Delete a specific cache key
exports.deleteCacheKey = asyncHandler(async (req, res) => {
  const cacheService = require('../services/cache.service');
  const { key } = req.params;
  await cacheService.delete(key);
  return ApiResponse.success(res, {
    message: 'Cache key deleted',
    messageBn: 'ক্যাশ কী মুছে ফেলা হয়েছে',
  });
});

// Delete cache keys by pattern
exports.deleteCachePattern = asyncHandler(async (req, res) => {
  const cacheService = require('../services/cache.service');
  const { pattern } = req.body;
  if (!pattern) {
    return ApiResponse.error(res, { message: 'Pattern is required', messageBn: 'প্যাটার্ন প্রয়োজন' }, 400);
  }
  await cacheService.deletePattern(pattern);
  return ApiResponse.success(res, {
    message: `Cache keys matching "${pattern}" deleted`,
    messageBn: `"${pattern}" প্যাটার্নের ক্যাশ কী মুছে ফেলা হয়েছে`,
  });
});

// Flush all cache
exports.flushCache = asyncHandler(async (req, res) => {
  const cacheService = require('../services/cache.service');
  const result = await cacheService.flushAll();
  return ApiResponse.success(res, {
    data: result,
    message: 'Cache flushed successfully',
    messageBn: 'সম্পূর্ণ ক্যাশ মুছে ফেলা হয়েছে',
  });
});

// Get top performers (shops, products, active shops)
exports.getTopPerformers = asyncHandler(async (req, res) => {
  const performers = await adminService.getTopPerformers();
  return ApiResponse.success(res, {
    data: performers,
    message: 'Top performers retrieved',
    messageBn: 'সেরা পারফর্মার তালিকা লোড হয়েছে',
  });
});

// Get system metrics (database, server info)
exports.getSystemMetrics = asyncHandler(async (req, res) => {
  const metrics = await adminService.getSystemMetrics();
  return ApiResponse.success(res, {
    data: metrics,
    message: 'System metrics retrieved',
    messageBn: 'সিস্টেম মেট্রিক্স লোড হয়েছে',
  });
});

// Update shop settings (admin level)
exports.updateShopSettings = asyncHandler(async (req, res) => {
  const shop = await adminService.updateShopSettings(req.admin._id, req.params.id, req.body);
  return ApiResponse.success(res, {
    data: shop,
    message: 'Shop settings updated successfully',
    messageBn: 'দোকানের সেটিংস সফলভাবে আপডেট হয়েছে',
  });
});

// Enable multi-branch for a shop
exports.enableMultiBranch = asyncHandler(async (req, res) => {
  const result = await adminService.enableMultiBranch(req.params.id, req.admin._id, req.body.branchName);
  return ApiResponse.success(res, {
    data: result,
    message: 'Multi-branch enabled successfully',
  });
});

// Disable multi-branch for a shop
exports.disableMultiBranch = asyncHandler(async (req, res) => {
  const result = await adminService.disableMultiBranch(req.params.id, req.admin._id);
  return ApiResponse.success(res, {
    data: result,
    message: 'Multi-branch disabled successfully',
  });
});

// Share or separate customers/dues across a shop's branches (Phase 7)
exports.setCustomerScope = asyncHandler(async (req, res) => {
  const result = await adminService.setCustomerScope(req.params.id, req.admin._id, req.body.scope);
  return ApiResponse.success(res, {
    data: result,
    message: 'Customer scope updated successfully',
    messageBn: result.customerScope === 'branch'
      ? 'কাস্টমার ও বাকি এখন শাখা-ভিত্তিক'
      : 'কাস্টমার ও বাকি এখন সব শাখায় শেয়ার্ড',
  });
});

// Opt-in capability list for a shop, built from the FEATURES registry
exports.getShopFeatures = asyncHandler(async (req, res) => {
  const result = await adminService.getShopFeatures(req.params.id);
  return ApiResponse.success(res, { data: result });
});

// Turn one opt-in capability on or off. One generic route for every feature —
// do not add an enable-X / disable-X pair per capability.
exports.setShopFeature = asyncHandler(async (req, res) => {
  const result = await adminService.setShopFeature(
    req.params.id,
    req.admin._id,
    req.params.key,
    req.body.enabled === true
  );
  return ApiResponse.success(res, {
    data: result,
    message: 'Feature updated successfully',
    messageBn: req.body.enabled === true ? 'ফিচারটি চালু করা হয়েছে' : 'ফিচারটি বন্ধ করা হয়েছে',
  });
});

// Get shop branches
exports.getShopBranches = asyncHandler(async (req, res) => {
  const branches = await adminService.getShopBranches(req.params.id);
  return ApiResponse.success(res, {
    data: branches,
    message: 'Shop branches retrieved successfully',
    messageBn: 'দোকানের শাখাসমূহ সফলভাবে লোড হয়েছে',
  });
});

// Add shop branch
exports.addShopBranch = asyncHandler(async (req, res) => {
  const branch = await adminService.addShopBranch(req.params.id, req.admin._id, req.body);
  return ApiResponse.created(res, {
    data: branch,
    message: 'Shop branch created successfully',
    messageBn: 'দোকানের শাখা সফলভাবে তৈরি হয়েছে',
  });
});

// Update shop branch
exports.updateShopBranch = asyncHandler(async (req, res) => {
  const branch = await adminService.updateShopBranch(req.params.id, req.params.branchId, req.admin._id, req.body);
  return ApiResponse.success(res, {
    data: branch,
    message: 'Shop branch updated successfully',
    messageBn: 'দোকানের শাখা সফলভাবে আপডেট হয়েছে',
  });
});

// Delete/Deactivate shop branch
exports.deleteShopBranch = asyncHandler(async (req, res) => {
  const branch = await adminService.deleteShopBranch(req.params.id, req.params.branchId, req.admin._id);
  return ApiResponse.success(res, {
    data: branch,
    message: 'Shop branch deactivated successfully',
    messageBn: 'দোকানের শাখা সফলভাবে নিষ্ক্রিয় করা হয়েছে',
  });
});

// Shop purge — disabled. Route is not mounted; this fails closed if it ever is.
exports.purgeShop = asyncHandler(async () => {
  refuseDeletion('a shop', 'Suspend it instead: PATCH /api/admin/shops/:id/status.');
});

// Get all products across all shops
exports.getAllProducts = asyncHandler(async (req, res) => {
  const result = await adminService.getAllProducts(req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Products retrieved successfully',
    messageBn: 'পণ্য তালিকা সফলভাবে লোড হয়েছে',
  });
});

// What a set of products is still referenced by — read-only, writes nothing.
// The purge screen calls this before offering the button.
exports.inspectProductLinks = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.productIds) ? req.body.productIds : [];
  const links = await adminService.inspectProductLinks(ids);
  return ApiResponse.success(res, {
    data: links,
    message: 'Product links inspected',
    messageBn: 'পণ্যের সংযোগ যাচাই সম্পন্ন',
  });
});

// Permanently erase soft-deleted products that nothing references.
// The service re-verifies every id; this endpoint grants no exemptions.
exports.purgeProducts = asyncHandler(async (req, res) => {
  const result = await adminService.purgeProducts(req.admin._id, {
    productIds: req.body.productIds,
    purgeCancelledInvoices: req.body.purgeCancelledInvoices === true,
  });
  return ApiResponse.success(res, {
    data: result,
    message: 'Purge completed',
    messageBn: 'স্থায়ীভাবে মুছে ফেলা সম্পন্ন',
  });
});
