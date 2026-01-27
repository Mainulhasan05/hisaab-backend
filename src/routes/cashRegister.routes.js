const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { canViewPurchases, canCreatePurchases, canEditPurchases } = require('../middleware/permission.middleware');
const cashRegisterController = require('../controllers/cashRegister.controller');

// All routes require authentication
router.use(protect);

// Get today's register
router.get('/today', canViewPurchases, cashRegisterController.getToday);

// Open today's register
router.post('/open', canCreatePurchases, cashRegisterController.openDay);

// Update today's register (manual entries)
router.put('/today', canEditPurchases, cashRegisterController.updateDay);

// Close today's register
router.post('/close', canEditPurchases, cashRegisterController.closeDay);

// Get history
router.get('/history', canViewPurchases, cashRegisterController.getHistory);

module.exports = router;
