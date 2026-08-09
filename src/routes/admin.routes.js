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
// Whether the shop's branches share one customer book. Admin-only for the same
// reason branch create/delete is: it changes what every branch can see.
router.patch('/shops/:id/customer-scope', adminController.setCustomerScope);
// Opt-in capabilities (Shop.features). ONE generic pair for every feature —
// resist adding /enable-<feature> routes, which is how multi-branch ended up
// with a method per verb. New capabilities need no route change at all.
router.get('/shops/:id/features', adminController.getShopFeatures);
router.patch('/shops/:id/features/:key', adminController.setShopFeature);
router.get('/shops/:id/branches', adminController.getShopBranches);
router.post('/shops/:id/branches', adminController.addShopBranch);
router.patch('/shops/:id/branches/:branchId', adminController.updateShopBranch);
// Deactivation, not deletion — flips isActive after an impact check.
router.delete('/shops/:id/branches/:branchId', adminController.deleteShopBranch);

// DELETE /shops/:id (purgeShop) is deliberately NOT mounted. Hard deletion is
// disabled panel-wide and returns later behind step-up auth; suspend the shop
// via PATCH /shops/:id/status instead. See utils/deletionDisabled.util.js.

// Users (all shops) — list + impersonation
router.get('/users', adminController.getAllUsers);
router.post('/users/:id/impersonate', adminController.impersonateUser);

// Customers (all shops)
router.get('/customers', adminController.getAllCustomers);

// Sales (all shops)
router.get('/sales', adminController.getAllSales);

// Products (all shops)
router.get('/products', adminController.getAllProducts);
// Read-only: what these products are still attached to. Safe to call freely.
router.post('/products/inspect-links', adminController.inspectProductLinks);
// Destructive and irreversible — soft-deleted products only, and the service
// re-verifies every id against live invoices before erasing anything.
router.post('/products/purge', adminController.purgeProducts);

// Online users (from heartbeat)
router.get('/online-users', adminController.getOnlineUsers);
// Dashboard activity: active users (from lastActiveAt, not the heartbeat set)
// + catalogue totals + recent product changes, in one call.
router.get('/activity-overview', adminController.getActivityOverview);

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

// Telegram — read-only. Retention is the collection's 90-day TTL index, not a
// clear button: hard deletion from the admin panel is disabled platform-wide.
router.get('/telegram/logs', adminController.getTelegramLogs);
router.get('/telegram/links', adminController.getTelegramLinks);
router.get('/telegram/stats', adminController.getTelegramStats);

const shopCategoryController = require('../controllers/shopCategory.controller');

const geminiKeyController = require('../controllers/geminiKey.controller');

// Audit logs
router.get('/audit-logs', adminController.getAuditLogs);

// Shop Categories Management (Admin)
router.get('/shop-categories', shopCategoryController.getAllShopCategories);
router.get('/shop-categories/:id', shopCategoryController.getShopCategoryById);
router.post('/shop-categories', shopCategoryController.createShopCategory);
router.put('/shop-categories/:id', shopCategoryController.updateShopCategory);
// No DELETE — retire a category with PUT { isActive: false }.

// Gemini AI Keys Management & Usage Tracking (Admin)
router.get('/gemini-keys', geminiKeyController.getAllKeys);
router.post('/gemini-keys', geminiKeyController.createKey);
router.put('/gemini-keys/:id', geminiKeyController.updateKey);
// No DELETE — retire a key with PUT { isActive: false }.
router.post('/gemini-keys/:id/test', geminiKeyController.testKey);
router.post('/gemini-keys/:id/reset', geminiKeyController.resetUsage);
router.post('/gemini-keys/test-prompt', geminiKeyController.testPrompt);

// Admin management (super admin only)
router.post('/admins', adminController.createAdmin);

module.exports = router;


