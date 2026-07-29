const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { protect, adminOnly } = require('../middleware/auth.middleware');

// Public admin routes
router.post('/login', adminController.login);
router.post('/logout', adminController.logout);

// Protected admin routes (require admin authentication)
// protect: verifies token and sets req.isAdmin
// adminOnly: checks that user is admin
router.use(protect, adminOnly);

// Stats
router.get('/stats', adminController.getStats);
router.get('/top-performers', adminController.getTopPerformers);
router.get('/system-metrics', adminController.getSystemMetrics);

// Shops management
router.get('/shops', adminController.getShops);
router.get('/shops/:id', adminController.getShopDetails);
router.patch('/shops/:id/status', adminController.updateShopStatus);
router.patch('/shops/:id/subscription', adminController.updateShopSubscription);
router.patch('/shops/:id/settings', adminController.updateShopSettings);
router.post('/shops/:id/restrict', adminController.restrictShop);
router.post('/shops/:id/enable-multi-branch', adminController.enableMultiBranch);
router.post('/shops/:id/disable-multi-branch', adminController.disableMultiBranch);
router.get('/shops/:id/branches', adminController.getShopBranches);
router.post('/shops/:id/branches', adminController.addShopBranch);
router.patch('/shops/:id/branches/:branchId', adminController.updateShopBranch);
router.delete('/shops/:id/branches/:branchId', adminController.deleteShopBranch);
router.delete('/shops/:id', adminController.purgeShop);

// Users (all shops) — list + impersonation
router.get('/users', adminController.getAllUsers);
router.post('/users/:id/impersonate', adminController.impersonateUser);

// Customers (all shops)
router.get('/customers', adminController.getAllCustomers);

// Sales (all shops)
router.get('/sales', adminController.getAllSales);

// Online users (from heartbeat)
router.get('/online-users', adminController.getOnlineUsers);

// Cache/Redis management
router.get('/cache/stats', adminController.getCacheStats);
router.get('/cache/summary', adminController.getCacheSummary);
router.get('/cache/keys', adminController.listCacheKeys);
router.get('/cache/keys/:key(*)', adminController.getCacheKeyDetails);
router.delete('/cache/keys/:key(*)', adminController.deleteCacheKey);
router.post('/cache/delete-pattern', adminController.deleteCachePattern);
router.post('/cache/flush', adminController.flushCache);

// Legacy route (keep for backward compatibility)
router.get('/cache-stats', adminController.getCacheStats);

// Payments
router.get('/payments', adminController.getPayments);
router.post('/payments', adminController.recordPayment);

// SMS
router.post('/sms/allocate', adminController.allocateSMS);
router.get('/sms/logs', adminController.getSMSLogs);
router.get('/sms/allocations', adminController.getSMSAllocations);
router.get('/sms/stats', adminController.getSMSStats);

const shopCategoryController = require('../controllers/shopCategory.controller');

const geminiKeyController = require('../controllers/geminiKey.controller');

// Audit logs
router.get('/audit-logs', adminController.getAuditLogs);

// Shop Categories Management (Admin)
router.get('/shop-categories', shopCategoryController.getAllShopCategories);
router.get('/shop-categories/:id', shopCategoryController.getShopCategoryById);
router.post('/shop-categories', shopCategoryController.createShopCategory);
router.put('/shop-categories/:id', shopCategoryController.updateShopCategory);
router.delete('/shop-categories/:id', shopCategoryController.deleteShopCategory);

// Gemini AI Keys Management & Usage Tracking (Admin)
router.get('/gemini-keys', geminiKeyController.getAllKeys);
router.post('/gemini-keys', geminiKeyController.createKey);
router.put('/gemini-keys/:id', geminiKeyController.updateKey);
router.delete('/gemini-keys/:id', geminiKeyController.deleteKey);
router.post('/gemini-keys/:id/test', geminiKeyController.testKey);
router.post('/gemini-keys/:id/reset', geminiKeyController.resetUsage);
router.post('/gemini-keys/test-prompt', geminiKeyController.testPrompt);

// Admin management (super admin only)
router.post('/admins', adminController.createAdmin);

module.exports = router;


