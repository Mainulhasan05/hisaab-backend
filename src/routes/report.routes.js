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
// `view_profit`, matching the capability registry on the client. The payload is
// the day's profit picture — net earnings plus the figures it decomposes into —
// so the route is gated on the profit permission rather than plain report
// access. `sanitizeReport` below is still applied: the route decides who may
// ask, the sanitiser decides what comes back.
router.get('/daily-summary', rbac('reports', 'view_profit'), reportController.getDailySummary);
router.get('/staff', rbac('reports', 'view'), reportController.getStaffReport);
router.get('/staff-detailed', rbac('reports', 'view'), reportController.getDetailedStaffReport);
router.get('/date-wise', rbac('reports', 'view'), reportController.getDateWiseSummary);
router.get('/date-wise/:date', rbac('reports', 'view'), reportController.getSalesByDate);
router.get('/trending-products', rbac('reports', 'view'), reportController.getTrendingProducts);
router.get('/due-aging', rbac('reports', 'view'), reportController.getDueAging);
router.get('/:type/export/:format', rbac('reports', 'view'), reportController.exportReport);

module.exports = router;
