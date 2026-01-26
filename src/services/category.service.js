const Category = require('../models/Category.model');
const Product = require('../models/Product.model');
const { AppError } = require('../middleware/error.middleware');

class CategoryService {
  /**
   * Get all categories with subcategories for a shop
   */
  async getCategories(shopId) {
    const categories = await Category.getCategoriesWithSubcategories(shopId);
    return categories;
  }

  /**
   * Get single category by ID
   */
  async getCategoryById(shopId, categoryId) {
    const category = await Category.findOne({
      _id: categoryId,
      shop: shopId,
      isActive: true,
    }).populate({
      path: 'subcategories',
      match: { isActive: true },
      options: { sort: { order: 1, name: 1 } },
    });

    if (!category) {
      throw new AppError('Category not found', 'ক্যাটাগরি পাওয়া যায়নি', 404);
    }

    return category;
  }

  /**
   * Create a new category
   */
  async createCategory(shopId, data) {
    const categoryData = {
      shop: shopId,
      name: data.name,
      nameBn: data.nameBn || '',
      icon: data.icon || null,
      parent: data.parent || null,
      order: data.order || 0,
      description: data.description || '',
    };

    const category = await Category.create(categoryData);
    return category;
  }

  /**
   * Update a category
   */
  async updateCategory(shopId, categoryId, data) {
    const category = await Category.findOne({
      _id: categoryId,
      shop: shopId,
    });

    if (!category) {
      throw new AppError('Category not found', 'ক্যাটাগরি পাওয়া যায়নি', 404);
    }

    const allowed = ['name', 'nameBn', 'icon', 'order', 'description', 'isActive'];
    allowed.forEach((field) => {
      if (data[field] !== undefined) {
        category[field] = data[field];
      }
    });

    await category.save();
    return category;
  }

  /**
   * Delete a category (soft delete)
   */
  async deleteCategory(shopId, categoryId) {
    const category = await Category.findOne({
      _id: categoryId,
      shop: shopId,
    });

    if (!category) {
      throw new AppError('Category not found', 'ক্যাটাগরি পাওয়া যায়নি', 404);
    }

    // Check if products exist under this category
    const productCount = await Product.countDocuments({
      shop: shopId,
      $or: [{ category: categoryId }, { subcategory: categoryId }],
      isActive: true,
    });

    if (productCount > 0) {
      throw new AppError(
        'Cannot delete category with products',
        `এই ক্যাটাগরিতে ${productCount}টি পণ্য আছে, মুছে ফেলা যাবে না`,
        400
      );
    }

    // Also deactivate subcategories
    await Category.updateMany(
      { parent: categoryId, shop: shopId },
      { isActive: false }
    );

    category.isActive = false;
    await category.save();
  }
}

module.exports = new CategoryService();
