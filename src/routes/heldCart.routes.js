const express = require('express');
const router = express.Router();
const heldCartController = require('../controllers/heldCart.controller');
const { protect } = require('../middleware/auth.middleware');

// All routes require authentication
router.use(protect);

router.post('/', heldCartController.holdCart);
router.get('/', heldCartController.getHeldCarts);
router.get('/:id', heldCartController.getHeldCart);
router.post('/:id/resume', heldCartController.resumeCart);
router.delete('/:id', heldCartController.discardCart);
router.post('/expire', heldCartController.expireOldCarts);

module.exports = router;
