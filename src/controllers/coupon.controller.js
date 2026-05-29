const couponService = require('../services/coupon.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

// Create coupon
exports.createCoupon = asyncHandler(async (req, res) => {
  const coupon = await couponService.createCoupon(req.shop._id, req.user._id, req.body);
  return ApiResponse.success(res, {
    data: coupon,
    message: 'Coupon created successfully',
    messageBn: 'কুপন সফলভাবে তৈরি করা হয়েছে',
    statusCode: 201,
  });
});

// Get all coupons
exports.getCoupons = asyncHandler(async (req, res) => {
  const result = await couponService.getCoupons(req.shop._id, req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Coupons retrieved successfully',
    messageBn: 'কুপন তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Get single coupon
exports.getCoupon = asyncHandler(async (req, res) => {
  const coupon = await couponService.getCouponById(req.shop._id, req.params.id);
  return ApiResponse.success(res, {
    data: coupon,
    message: 'Coupon retrieved successfully',
    messageBn: 'কুপন সফলভাবে লোড হয়েছে',
  });
});

// Update coupon
exports.updateCoupon = asyncHandler(async (req, res) => {
  const coupon = await couponService.updateCoupon(req.shop._id, req.user._id, req.params.id, req.body);
  return ApiResponse.success(res, {
    data: coupon,
    message: 'Coupon updated successfully',
    messageBn: 'কুপন সফলভাবে আপডেট করা হয়েছে',
  });
});

// Delete coupon
exports.deleteCoupon = asyncHandler(async (req, res) => {
  await couponService.deleteCoupon(req.shop._id, req.user._id, req.params.id);
  return ApiResponse.success(res, {
    message: 'Coupon deactivated successfully',
    messageBn: 'কুপন সফলভাবে নিষ্ক্রিয় করা হয়েছে',
  });
});

// Validate coupon
exports.validateCoupon = asyncHandler(async (req, res) => {
  const { code, cartTotal } = req.body;
  const result = await couponService.validateCoupon(req.shop._id, code, cartTotal);
  return ApiResponse.success(res, {
    data: result,
    message: 'Coupon validated successfully',
    messageBn: 'কুপন যাচাই সফল',
  });
});
