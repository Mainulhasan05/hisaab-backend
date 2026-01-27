const express = require('express');
const router = express.Router();
const purchaseController = require('../controllers/purchase.controller');
const { protect } = require('../middleware/auth.middleware');
const { canViewPurchases, canCreatePurchases, canDeletePurchases } = require('../middleware/permission.middleware');

// All routes require authentication
router.use(protect);

// Purchase summary (before /:id to avoid conflict)
router.get('/summary', canViewPurchases, purchaseController.getSummary);

// Purchase CRUD
router.get('/', canViewPurchases, purchaseController.getPurchases);
router.post('/', canCreatePurchases, purchaseController.createPurchase);
router.get('/:id/payments', canViewPurchases, purchaseController.getPurchasePayments);
router.get('/:id', canViewPurchases, purchaseController.getPurchase);
router.patch('/:id/payment', canCreatePurchases, purchaseController.recordPayment);
router.patch('/:id/cancel', canDeletePurchases, purchaseController.cancelPurchase);

module.exports = router;
