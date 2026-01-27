const express = require('express');
const router = express.Router();
const reportController = require('../controllers/report.controller');
const { protect } = require('../middleware/auth.middleware');
const { canViewReports } = require('../middleware/permission.middleware');

// All routes require authentication
router.use(protect);

// Report routes
router.get('/dashboard', reportController.getDashboard);
router.get('/sales', canViewReports, reportController.getSalesReport);
router.get('/products', canViewReports, reportController.getProductReport);
router.get('/customers', canViewReports, reportController.getCustomerReport);
router.get('/profit-loss', canViewReports, reportController.getProfitLoss);
router.get('/:type/export/:format', canViewReports, reportController.exportReport);

module.exports = router;
