const express = require('express');
const router = express.Router();
const heldCartController = require('../controllers/heldCart.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');

// All routes require authentication.
// Held carts are part of the POS flow, so they follow the sales permissions.
router.use(protect);

router.post('/', rbac('sales', 'create'), heldCartController.holdCart);
router.get('/', rbac('sales', 'view'), heldCartController.getHeldCarts);
router.get('/:id', rbac('sales', 'view'), heldCartController.getHeldCart);
router.post('/:id/resume', rbac('sales', 'create'), heldCartController.resumeCart);
router.delete('/:id', rbac('sales', 'create'), heldCartController.discardCart);
router.post('/expire', rbac('sales', 'create'), heldCartController.expireOldCarts);

module.exports = router;
