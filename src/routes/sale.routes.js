const express = require('express');
const router = express.Router();
const saleController = require('../controllers/sale.controller');
const { protect } = require('../middleware/auth.middleware');
const { canViewSales, canCreateSales, canEditSales, canDeleteSales } = require('../middleware/permission.middleware');

// All routes require authentication
router.use(protect);

// Sale routes
router.get('/', canViewSales, saleController.getSales);
router.post('/', canCreateSales, saleController.createSale);
router.get('/today-summary', canViewSales, saleController.getTodaySummary);
router.get('/recent', canViewSales, saleController.getRecentSales);
router.get('/:id', canViewSales, saleController.getSale);
router.patch('/:id/payment', canEditSales, saleController.recordPayment);
router.post('/:id/cancel', canDeleteSales, saleController.cancelSale);

module.exports = router;
