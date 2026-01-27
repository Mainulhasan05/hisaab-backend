const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { canViewSales, canEditSales } = require('../middleware/permission.middleware');
const salesReturnController = require('../controllers/salesReturn.controller');

// All routes require authentication
router.use(protect);

// Returns list & create
router.get('/', canViewSales, salesReturnController.getReturns);
router.post('/', canEditSales, salesReturnController.createReturn);

// Summary
router.get('/summary', canViewSales, salesReturnController.getReturnsSummary);

// Sale-specific returns
router.get('/sale/:saleId', canViewSales, salesReturnController.getReturnsBySale);
router.get('/sale/:saleId/returnable', canViewSales, salesReturnController.getReturnableItems);

// Single return
router.get('/:id', canViewSales, salesReturnController.getReturn);

module.exports = router;
