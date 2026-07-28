const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const salesReturnController = require('../controllers/salesReturn.controller');
const idempotency = require('../middleware/idempotency.middleware');

router.use(protect);

router.get('/', rbac('sales', 'view'), salesReturnController.getReturns);
router.post('/', idempotency(), rbac('sales', 'update'), salesReturnController.createReturn);
router.get('/summary', rbac('sales', 'view'), salesReturnController.getReturnsSummary);
router.get('/sale/:saleId', rbac('sales', 'view'), salesReturnController.getReturnsBySale);
router.get('/sale/:saleId/returnable', rbac('sales', 'view'), salesReturnController.getReturnableItems);
router.get('/:id', rbac('sales', 'view'), salesReturnController.getReturn);

module.exports = router;
