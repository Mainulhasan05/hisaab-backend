const express = require('express');
const router = express.Router();
const couponController = require('../controllers/coupon.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');

router.use(protect);

router.get('/', rbac('sales', 'view'), couponController.getCoupons);
router.post('/', rbac('sales', 'create'), couponController.createCoupon);
router.post('/validate', rbac('sales', 'view'), couponController.validateCoupon);
router.get('/:id', rbac('sales', 'view'), couponController.getCoupon);
router.put('/:id', rbac('sales', 'update'), couponController.updateCoupon);
router.delete('/:id', rbac('sales', 'delete'), couponController.deleteCoupon);

module.exports = router;
