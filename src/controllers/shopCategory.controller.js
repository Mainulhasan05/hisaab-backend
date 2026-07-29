const ShopCategory = require('../models/ShopCategory.model');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');



/**
 * Public: Get active shop categories for user signup/onboarding
 */
exports.getPublicShopCategories = asyncHandler(async (req, res) => {
  const categories = await ShopCategory.find({ isActive: true })
    .sort({ sortOrder: 1, createdAt: 1 })
    .select('key name icon description defaultVariantTypes sortOrder');

  return ApiResponse.success(res, {
    data: categories,
    message: 'Shop categories retrieved successfully'
  });
});

/**
 * Admin: Get all shop categories (including inactive)
 */
exports.getAllShopCategories = asyncHandler(async (req, res) => {
  const categories = await ShopCategory.find()
    .sort({ sortOrder: 1, createdAt: 1 });

  return ApiResponse.success(res, {
    data: categories,
    message: 'All shop categories retrieved successfully'
  });
});

/**
 * Admin: Get single shop category by ID
 */
exports.getShopCategoryById = asyncHandler(async (req, res) => {
  const category = await ShopCategory.findById(req.params.id);

  if (!category) {
    return ApiResponse.notFound(res, 'Shop category not found');
  }

  return ApiResponse.success(res, {
    data: category,
    message: 'Shop category details retrieved'
  });
});

/**
 * Admin: Create new shop category
 */
exports.createShopCategory = asyncHandler(async (req, res) => {
  const { key, name, icon, description, sortOrder, defaultVariantTypes, defaultCategories, isActive, businessModel, enabledModules, terminology, dashboardWidgets } = req.body;

  if (!name) {
    return ApiResponse.badRequest(res, 'ক্যাটাগরির নাম বাধ্যতামূলক');
  }

  // Generate key if not provided
  let categoryKey = key
    ? key.toLowerCase().trim().replace(/[^\w-]/g, '')
    : name.toLowerCase().trim().replace(/[^\w-]/g, '');

  if (!categoryKey) {
    categoryKey = `cat-${Date.now()}`;
  }

  const existing = await ShopCategory.findOne({ key: categoryKey });
  if (existing) {
    return ApiResponse.conflict(res, 'এই কি (key) দিয়ে ক্যাটাগরি ইতোমধ্যে আছে');
  }

  const newCategory = await ShopCategory.create({
    key: categoryKey,
    name,
    icon: icon || '🏪',
    description: description || '',
    sortOrder: sortOrder || 0,
    businessModel: businessModel || 'retail',
    enabledModules: enabledModules || {},
    terminology: terminology || {},
    dashboardWidgets: Array.isArray(dashboardWidgets) ? dashboardWidgets : [],
    defaultVariantTypes: Array.isArray(defaultVariantTypes) ? defaultVariantTypes : ['size', 'color'],
    defaultCategories: Array.isArray(defaultCategories) ? defaultCategories : [],
    isActive: isActive !== undefined ? isActive : true
  });

  return ApiResponse.created(res, {
    data: newCategory,
    message: 'Shop category created successfully'
  });
});

/**
 * Admin: Update shop category
 */
exports.updateShopCategory = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { key, name, icon, description, sortOrder, defaultVariantTypes, defaultCategories, isActive, businessModel, enabledModules, terminology, dashboardWidgets } = req.body;

  const category = await ShopCategory.findById(id);
  if (!category) {
    return ApiResponse.notFound(res, 'Shop category not found');
  }

  if (key && key.toLowerCase() !== category.key) {
    const existing = await ShopCategory.findOne({ key: key.toLowerCase(), _id: { $ne: id } });
    if (existing) {
      return ApiResponse.conflict(res, 'এই কি (key) দিয়ে অন্য ক্যাটাগরি আছে');
    }
    category.key = key.toLowerCase().trim();
  }

  if (name !== undefined) category.name = name;
  if (icon !== undefined) category.icon = icon;
  if (description !== undefined) category.description = description;
  if (sortOrder !== undefined) category.sortOrder = sortOrder;
  if (defaultVariantTypes !== undefined) category.defaultVariantTypes = defaultVariantTypes;
  if (defaultCategories !== undefined) category.defaultCategories = defaultCategories;
  if (isActive !== undefined) category.isActive = isActive;
  // New business-type config fields
  if (businessModel !== undefined) category.businessModel = businessModel;
  if (enabledModules !== undefined) category.enabledModules = enabledModules;
  if (terminology !== undefined) category.terminology = terminology;
  if (dashboardWidgets !== undefined) category.dashboardWidgets = dashboardWidgets;

  await category.save();

  return ApiResponse.success(res, {
    data: category,
    message: 'Shop category updated successfully'
  });
});

/**
 * Admin: Delete shop category
 */
exports.deleteShopCategory = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const category = await ShopCategory.findByIdAndDelete(id);
  if (!category) {
    return ApiResponse.notFound(res, 'Shop category not found');
  }

  return ApiResponse.success(res, {
    message: 'Shop category deleted successfully'
  });
});
