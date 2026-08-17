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
  const { category, created } = await categoryService.createCategory(req.shop._id, req.body, req);
  return ApiResponse.success(res, {
    data: category,
    message: created ? 'Category created successfully' : 'Category already exists',
    messageBn: created
      ? 'ক্যাটাগরি সফলভাবে যোগ করা হয়েছে'
      : 'এই নামে ক্যাটাগরি আগে থেকেই ছিল',
    statusCode: created ? 201 : 200,
  });
});

/**
 * Create a category from a name alone, for the picker on the product form.
 *
 * Separate from `createCategory` because the semantics differ and one route
 * cannot honestly do both: this one takes an existing category by that name
 * WHEREVER it sits in the tree, while the management page's create means "put
 * one exactly here" and must refuse a name already used elsewhere.
 *
 * A shopkeeper who types "শার্ট" into the category box while it exists as a
 * subcategory has not made a mistake — they were looking at the parent list and
 * could not see it. Handing them the row they meant is right; a 409 would be
 * baffling, and it would come at the worst possible moment, mid-way through
 * their first product.
 */
exports.quickCreateCategory = asyncHandler(async (req, res) => {
  const { category, created } = await categoryService.findOrCreateByName(
    req.shop._id,
    req.body?.name,
    { parent: req.body?.parent || null }
  );

  return ApiResponse.success(res, {
    data: category,
    message: created ? 'Category created successfully' : 'Category already exists',
    messageBn: created
      ? 'ক্যাটাগরি সফলভাবে যোগ করা হয়েছে'
      : 'এই নামে ক্যাটাগরি আগে থেকেই ছিল, সেটিই বাছাই করা হয়েছে',
    statusCode: created ? 201 : 200,
  });
});

// The shop-type suggestion list, each row flagged with whether it already exists
exports.getSuggestions = asyncHandler(async (req, res) => {
  const suggestions = await categoryService.getSuggestions(req.shop);
  return ApiResponse.success(res, {
    data: suggestions,
    message: 'Suggestions retrieved successfully',
    messageBn: 'প্রস্তাবিত ক্যাটাগরি লোড হয়েছে',
  });
});

// Create the suggestions the shopkeeper ticked
exports.applyTemplate = asyncHandler(async (req, res) => {
  const result = await categoryService.applyTemplate(req.shop, {
    names: req.body?.names,
    includeSubcategories: req.body?.includeSubcategories === true,
  });
  return ApiResponse.success(res, {
    data: result,
    message: 'Categories added successfully',
    messageBn: `${result.categories}টি ক্যাটাগরি যোগ হয়েছে`,
    statusCode: 201,
  });
});

// Category tree with live product counts, for the tidy-up screen
exports.getUsage = asyncHandler(async (req, res) => {
  const usage = await categoryService.getUsage(req.shop._id);
  return ApiResponse.success(res, {
    data: usage,
    message: 'Category usage retrieved successfully',
    messageBn: 'ক্যাটাগরির ব্যবহার লোড হয়েছে',
  });
});

// Soft-delete several categories in one confirmed action
exports.bulkDelete = asyncHandler(async (req, res) => {
  const result = await categoryService.bulkDelete(req.shop._id, req.body?.ids);
  return ApiResponse.success(res, {
    data: result,
    message: 'Categories deleted successfully',
    messageBn: `${result.deleted}টি ক্যাটাগরি মুছে ফেলা হয়েছে`,
  });
});

// Update category
exports.updateCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.updateCategory(req.shop._id, req.params.id, req.body, req);
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
