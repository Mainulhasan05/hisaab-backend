const categoryService = require('../services/category.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

// Get all categories with subcategories
exports.getCategories = asyncHandler(async (req, res) => {
  const categories = await categoryService.getCategories(req.shop._id);
  return ApiResponse.success(res, {
    data: categories,
    message: 'Categories retrieved successfully',
    messageBn: 'ক্যাটাগরি তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Get single category
exports.getCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.getCategoryById(req.shop._id, req.params.id);
  return ApiResponse.success(res, {
    data: category,
    message: 'Category retrieved successfully',
    messageBn: 'ক্যাটাগরি সফলভাবে লোড হয়েছে',
  });
});

// Create category
exports.createCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.createCategory(req.shop._id, req.body);
  return ApiResponse.success(res, {
    data: category,
    message: 'Category created successfully',
    messageBn: 'ক্যাটাগরি সফলভাবে যোগ করা হয়েছে',
    statusCode: 201,
  });
});

// Update category
exports.updateCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.updateCategory(req.shop._id, req.params.id, req.body);
  return ApiResponse.success(res, {
    data: category,
    message: 'Category updated successfully',
    messageBn: 'ক্যাটাগরি সফলভাবে আপডেট করা হয়েছে',
  });
});

// Delete category
exports.deleteCategory = asyncHandler(async (req, res) => {
  await categoryService.deleteCategory(req.shop._id, req.params.id);
  return ApiResponse.success(res, {
    message: 'Category deleted successfully',
    messageBn: 'ক্যাটাগরি সফলভাবে মুছে ফেলা হয়েছে',
  });
});
