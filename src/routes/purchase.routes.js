const express = require('express');
const router = express.Router();
const purchaseController = require('../controllers/purchase.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const idempotency = require('../middleware/idempotency.middleware');
const { smsLimiter } = require('../middleware/rateLimiter.middleware');

router.use(protect);

router.get('/summary', rbac('purchases', 'view'), purchaseController.getSummary);
router.get('/', rbac('purchases', 'view'), purchaseController.getPurchases);
router.post('/', idempotency(), rbac('purchases', 'create'), purchaseController.createPurchase);
router.get('/:id/payments', rbac('purchases', 'view'), purchaseController.getPurchasePayments);
router.get('/:id', rbac('purchases', 'view'), purchaseController.getPurchase);
router.patch('/:id/payment', idempotency(), rbac('purchases', 'update'), purchaseController.recordPayment);
router.patch('/:id/cancel', rbac('purchases', 'delete'), purchaseController.cancelPurchase);

/**
 * Text the supplier what this challan says.
 *
 * `sms.create` and not a purchases permission: the thing being authorised is
 * spending the shop's SMS quota, which is what that permission governs
 * everywhere else. Rate-limited like every other send door.
 */
router.post('/:id/sms', smsLimiter, rbac('sms', 'create'), purchaseController.sendPurchaseSms);

module.exports = router;
