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

// Audit logs
router.get('/audit-logs', adminController.getAuditLogs);

// Admin management (super admin only)
router.post('/admins', adminController.createAdmin);

module.exports = router;
