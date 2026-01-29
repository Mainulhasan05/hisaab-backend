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

// Shops management
router.get('/shops', adminController.getShops);
router.get('/shops/:id', adminController.getShopDetails);
router.patch('/shops/:id/status', adminController.updateShopStatus);
router.patch('/shops/:id/subscription', adminController.updateShopSubscription);
router.post('/shops/:id/restrict', adminController.restrictShop);

// Customers (all shops)
router.get('/customers', adminController.getAllCustomers);

// Sales (all shops)
router.get('/sales', adminController.getAllSales);

// Online users (from heartbeat)
router.get('/online-users', adminController.getOnlineUsers);

// Cache/Redis stats
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
