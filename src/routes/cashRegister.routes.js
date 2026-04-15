const express = require('express');
const router = express.Router();
const { protect, ownerOnly } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const cashRegisterController = require('../controllers/cashRegister.controller');

router.use(protect);

router.get('/today', rbac('cash_register', 'view'), cashRegisterController.getToday);
router.post('/open', rbac('cash_register', 'create'), cashRegisterController.openDay);
router.put('/today', rbac('cash_register', 'update'), cashRegisterController.updateDay);
router.post('/close', rbac('cash_register', 'update'), cashRegisterController.closeDay);
router.post('/:id/close', rbac('cash_register', 'update'), cashRegisterController.closePreviousDay);
router.post('/reopen', ownerOnly, cashRegisterController.reopenDay);
router.get('/history', rbac('cash_register', 'view'), cashRegisterController.getHistory);

module.exports = router;
