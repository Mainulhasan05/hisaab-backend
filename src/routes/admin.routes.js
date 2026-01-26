const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { adminOnly } = require('../middleware/auth.middleware');

// Public admin routes
router.post('/login', adminController.login);

// Protected admin routes (require admin authentication)
router.use(adminOnly);

// Stats
router.get('/stats', adminController.getStats);

// Shops management
router.get('/shops', adminController.getShops);
router.get('/shops/:id', adminController.getShopDetails);
router.patch('/shops/:id/status', adminController.updateShopStatus);
router.patch('/shops/:id/subscription', adminController.updateShopSubscription);

// Payments
router.get('/payments', adminController.getPayments);
router.post('/payments', adminController.recordPayment);

// SMS
router.post('/sms/allocate', adminController.allocateSMS);

// Audit logs
router.get('/audit-logs', adminController.getAuditLogs);

// Admin management (super admin only)
router.post('/admins', adminController.createAdmin);

module.exports = router;
