const express = require('express');
const router = express.Router();
const saleController = require('../controllers/sale.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const idempotency = require('../middleware/idempotency.middleware');

router.use(protect);

router.get('/', rbac('sales', 'view'), saleController.getSales);
router.post('/', idempotency(), rbac('sales', 'create'), saleController.createSale);
router.get('/summary', rbac('sales', 'view'), saleController.getSalesSummary);
router.get('/today-summary', rbac('sales', 'view'), saleController.getTodaySummary);
router.get('/recent', rbac('sales', 'view'), saleController.getRecentSales);
router.get('/:id/payments', rbac('sales', 'view'), saleController.getSalePayments);
router.get('/:id', rbac('sales', 'view'), saleController.getSale);
router.patch('/:id/payment', idempotency(), rbac('sales', 'update'), saleController.recordPayment);
router.post('/:id/cancel', rbac('sales', 'delete'), saleController.cancelSale);

module.exports = router;
