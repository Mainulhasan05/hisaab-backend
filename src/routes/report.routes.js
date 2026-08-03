const express = require('express');
const router = express.Router();
const reportController = require('../controllers/report.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');

router.use(protect);

router.get('/dashboard', rbac('reports', 'view'), reportController.getDashboard);
router.get('/sales', rbac('reports', 'view'), reportController.getSalesReport);
router.get('/products', rbac('reports', 'view'), reportController.getProductReport);
router.get('/customers', rbac('reports', 'view'), reportController.getCustomerReport);
router.get('/profit-loss', rbac('reports', 'view_profit'), reportController.getProfitLoss);
router.get('/daily-summary', rbac('reports', 'view'), reportController.getDailySummary);
router.get('/staff', rbac('reports', 'view'), reportController.getStaffReport);
router.get('/date-wise', rbac('reports', 'view'), reportController.getDateWiseSummary);
router.get('/date-wise/:date', rbac('reports', 'view'), reportController.getSalesByDate);
router.get('/trending-products', rbac('reports', 'view'), reportController.getTrendingProducts);
router.get('/due-aging', rbac('reports', 'view'), reportController.getDueAging);
router.get('/:type/export/:format', rbac('reports', 'view'), reportController.exportReport);

module.exports = router;
