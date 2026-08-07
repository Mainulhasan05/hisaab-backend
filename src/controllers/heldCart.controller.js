const heldCartService = require('../services/heldCart.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

// Hold current cart
exports.holdCart = asyncHandler(async (req, res) => {
  const cart = await heldCartService.holdCart(req.shop._id, req.user._id, req.body, req);
  return ApiResponse.success(res, {
    data: cart,
    message: 'Cart held successfully',
    messageBn: 'কার্ট সফলভাবে হোল্ড করা হয়েছে',
    statusCode: 201,
  });
});

// Get all held carts
exports.getHeldCarts = asyncHandler(async (req, res) => {
  const carts = await heldCartService.getHeldCarts(req.shop._id, {
    branchId: req.branchId,
  });
  return ApiResponse.success(res, {
    data: carts,
    message: 'Held carts retrieved',
    messageBn: 'হোল্ড কার্ট তালিকা লোড হয়েছে',
  });
});

// Get single held cart
exports.getHeldCart = asyncHandler(async (req, res) => {
  const cart = await heldCartService.getHeldCartById(req.shop._id, req.params.id, req);
  return ApiResponse.success(res, {
    data: cart,
    message: 'Held cart retrieved',
    messageBn: 'হোল্ড কার্ট লোড হয়েছে',
  });
});

// Resume held cart
exports.resumeCart = asyncHandler(async (req, res) => {
  const cart = await heldCartService.resumeCart(req.shop._id, req.params.id, req);
  return ApiResponse.success(res, {
    data: cart,
    message: 'Cart resumed',
    messageBn: 'কার্ট পুনরায় লোড হয়েছে',
  });
});

// Discard held cart
exports.discardCart = asyncHandler(async (req, res) => {
  await heldCartService.discardCart(req.shop._id, req.params.id, req);
  return ApiResponse.success(res, {
    message: 'Cart discarded',
    messageBn: 'কার্ট বাতিল করা হয়েছে',
  });
});

// Expire old carts
exports.expireOldCarts = asyncHandler(async (req, res) => {
  const result = await heldCartService.expireOldCarts(req.shop._id);
  return ApiResponse.success(res, {
    data: result,
    message: 'Old carts expired',
    messageBn: 'পুরানো কার্ট মেয়াদোত্তীর্ণ করা হয়েছে',
  });
});
