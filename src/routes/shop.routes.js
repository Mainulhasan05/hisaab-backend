const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { asyncHandler, AppError } = require('../middleware/error.middleware');
const ApiResponse = require('../utils/response.util');
const Shop = require('../models/Shop.model');

router.use(protect);

/**
 * @route   GET /api/shop/config
 * @desc    Get current shop's configuration (enabledModules, terminology, etc.)
 */
router.get('/config', asyncHandler(async (req, res) => {
  const shop = await Shop.findById(req.shop._id)
    .select('name enabledModules terminology businessType shopCategory')
    .lean();

  if (!shop) {
    throw new AppError('Shop not found', 'দোকান পাওয়া যায়নি', 404);
  }

  return ApiResponse.success(res, { data: shop });
}));

/**
 * @route   PUT /api/shop/modules
 * @desc    Update enabled modules for the shop (owner only)
 */
router.put('/modules', asyncHandler(async (req, res) => {
  // Only shop owner can toggle modules
  if (!req.user.isOwner) {
    throw new AppError('Only shop owner can change modules', 'শুধু দোকান মালিক মডিউল পরিবর্তন করতে পারবেন', 403);
  }

  const { enabledModules } = req.body;
  if (!enabledModules || typeof enabledModules !== 'object') {
    throw new AppError('Invalid modules data', 'অবৈধ মডিউল ডেটা', 400);
  }

  const validModules = ['services', 'appointments', 'treatments', 'equipment', 'inventory'];
  const sanitized = {};
  for (const key of validModules) {
    if (enabledModules[key] !== undefined) {
      sanitized[key] = Boolean(enabledModules[key]);
    }
  }
  // Inventory is always on
  sanitized.inventory = true;

  const shop = await Shop.findByIdAndUpdate(
    req.shop._id,
    { $set: { enabledModules: sanitized } },
    { new: true, runValidators: true }
  ).select('enabledModules');

  return ApiResponse.success(res, {
    data: shop,
    message: 'মডিউল সেটিংস আপডেট হয়েছে',
  });
}));

/**
 * @route   PUT /api/shop/terminology
 * @desc    Update custom terminology for the shop
 */
router.put('/terminology', asyncHandler(async (req, res) => {
  if (!req.user.isOwner) {
    throw new AppError('Only shop owner can change terminology', 'শুধু দোকান মালিক টার্মিনোলজি পরিবর্তন করতে পারবেন', 403);
  }

  const { terminology } = req.body;
  if (!terminology || typeof terminology !== 'object') {
    throw new AppError('Invalid terminology data', 'অবৈধ টার্মিনোলজি ডেটা', 400);
  }

  const shop = await Shop.findByIdAndUpdate(
    req.shop._id,
    { $set: { terminology } },
    { new: true, runValidators: true }
  ).select('terminology');

  return ApiResponse.success(res, {
    data: shop,
    message: 'টার্মিনোলজি আপডেট হয়েছে',
  });
}));

module.exports = router;
