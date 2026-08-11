const brandService = require('../services/brand.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

// Get all brands for the shop
exports.getBrands = asyncHandler(async (req, res) => {
  const brands = await brandService.getBrands(req.shop._id, {
    // Only the management page asks for deactivated rows; the product picker
    // must never offer one.
    includeInactive: req.query.includeInactive === 'true',
  });
  return ApiResponse.success(res, {
    data: brands,
    message: 'Brands retrieved successfully',
    messageBn: 'ব্র্যান্ড তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Get single brand
exports.getBrand = asyncHandler(async (req, res) => {
  const brand = await brandService.getBrandById(req.shop._id, req.params.id);
  return ApiResponse.success(res, {
    data: brand,
    message: 'Brand retrieved successfully',
    messageBn: 'ব্র্যান্ড সফলভাবে লোড হয়েছে',
  });
});

// Create brand
exports.createBrand = asyncHandler(async (req, res) => {
  const brand = await brandService.createBrand(req.shop._id, req.body);
  return ApiResponse.success(res, {
    data: brand,
    message: 'Brand created successfully',
    messageBn: 'ব্র্যান্ড সফলভাবে যোগ করা হয়েছে',
    statusCode: 201,
  });
});

// Update brand
exports.updateBrand = asyncHandler(async (req, res) => {
  const brand = await brandService.updateBrand(req.shop._id, req.params.id, req.body);
  return ApiResponse.success(res, {
    data: brand,
    message: 'Brand updated successfully',
    messageBn: 'ব্র্যান্ড সফলভাবে আপডেট করা হয়েছে',
  });
});

// Delete brand (soft)
exports.deleteBrand = asyncHandler(async (req, res) => {
  await brandService.deleteBrand(req.shop._id, req.params.id);
  return ApiResponse.success(res, {
    message: 'Brand deleted successfully',
    messageBn: 'ব্র্যান্ড সফলভাবে মুছে ফেলা হয়েছে',
  });
});
