const Category = require('../models/Category.model');
const Product = require('../models/Product.model');
const { AppError } = require('../middleware/error.middleware');
const cacheService = require('./cache.service');
const mediaService = require('./media.service');
const { KEYS, getTTL } = require('../config/cacheKeys');
const { hasFeature } = require('../utils/features.util');

class CategoryService {
  /**
   * Turn a caller-supplied `imageMediaId` into fields this service may store.
   *
   * The category form's image control is one slot, so this is the single-image
   * cousin of `product.service._applyImageRefs` and follows the same two rules:
   * the media must belong to THIS shop (`resolveOwned` 400s otherwise, which is
   * the tenant boundary), and the URL comes from the ShopMedia document rather
   * than from the client.
   *
   * Returns `null` when there is nothing to apply — either the capability is off
   * or the caller said nothing about the image — and the caller then leaves the
   * stored value alone. That is what keeps an existing photo intact when an
   * admin turns `categoryImages` off and someone renames the category.
   *
   * `{ image: null, imageMediaId: null }` is the deliberate REMOVE, reachable
   * only with the capability on.
   */
  async _resolveImage(shopId, data, req) {
    if (!hasFeature(req, 'categoryImages')) return null;

    const hasMedia = 'imageMediaId' in data;
    const hasUrl = 'image' in data;
    if (!hasMedia && !hasUrl) return null;

    if (!data.imageMediaId) {
      // Either an explicit clear, or an external URL with no media behind it.
      // Both leave `imageMediaId` null, which is what tells reclamation these
      // are not our bytes.
      return { image: hasUrl ? (data.image || null) : null, imageMediaId: null };
    }

    const owned = await mediaService.resolveOwned(shopId, [data.imageMediaId]);
    const media = owned.get(String(data.imageMediaId));
    return {
      // The medium rendition: a category tile is never rendered at full size.
      image: media.mediumUrl || media.url,
      imageMediaId: media._id,
    };
  }

  /**
   * Invalidate category cache for a shop
   */
  async invalidateCache(shopId) {
    await cacheService.delete(KEYS.CATEGORIES(shopId));
  }

  /**
   * Get all categories with subcategories for a shop
   */
  async getCategories(shopId) {
    // Try cache first
    const cacheKey = KEYS.CATEGORIES(shopId);
    const cached = await cacheService.get(cacheKey);
    if (cached) return cached;

    const categories = await Category.getCategoriesWithSubcategories(shopId);

    // Cache the result
    await cacheService.set(cacheKey, categories, getTTL.categories);
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
  async createCategory(shopId, data, req = null) {
    const categoryData = {
      shop: shopId,
      name: data.name,
      icon: data.icon || null,
      parent: data.parent || null,
      order: data.order || 0,
      description: data.description || '',
    };

    const image = await this._resolveImage(shopId, data, req);
    if (image) Object.assign(categoryData, image);

    const category = await Category.create(categoryData);

    // The image stops being `staged` and becomes referenced. After the write,
    // so a failed create cannot leave a reference to a category that is not
    // there. No-op when the category has no photo, which is most of them.
    await mediaService.reconcileRefs(shopId, [], mediaService.mediaIdsOfCategory(category));

    // Invalidate cache
    await this.invalidateCache(shopId);

    return category;
  }

  /**
   * Update a category
   */
  async updateCategory(shopId, categoryId, data, req = null) {
    const category = await Category.findOne({
      _id: categoryId,
      shop: shopId,
    });

    if (!category) {
      throw new AppError('Category not found', 'ক্যাটাগরি পাওয়া যায়নি', 404);
    }

    // Read before anything is assigned — the only moment the old reference is
    // still on the document.
    const previousMediaIds = mediaService.mediaIdsOfCategory(category);

    const allowed = ['name', 'icon', 'order', 'description', 'isActive'];
    allowed.forEach((field) => {
      if (data[field] !== undefined) {
        category[field] = data[field];
      }
    });

    // Not in the allowlist above on purpose: `image` and `imageMediaId` must
    // move together and only through the resolver, or a client could set the URL
    // without the id and store an unaccounted-for photo that looks like ours.
    const image = await this._resolveImage(shopId, data, req);
    if (image) {
      category.image = image.image;
      category.imageMediaId = image.imageMediaId;
    }

    await category.save();

    await mediaService.reconcileRefs(
      shopId,
      previousMediaIds,
      mediaService.mediaIdsOfCategory(category)
    );

    // Invalidate cache
    await this.invalidateCache(shopId);

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

    // Also deactivate subcategories. Their photos have to be released too — a
    // subcategory that disappears with its parent is just as gone, and reading
    // the ids here is the last moment anything knows which images they were.
    const subcategories = await Category.find({ parent: categoryId, shop: shopId })
      .select('imageMediaId')
      .lean();

    await Category.updateMany(
      { parent: categoryId, shop: shopId },
      { isActive: false }
    );

    const previousMediaIds = [
      ...mediaService.mediaIdsOfCategory(category),
      ...subcategories.flatMap((sub) => mediaService.mediaIdsOfCategory(sub)),
    ];

    category.isActive = false;
    await category.save();

    // Release the photos so the orphan clock can start. Nothing else ever does:
    // `getCategories` only returns `isActive: true`, so a deleted category is
    // invisible to every screen and its image would otherwise sit in the shop's
    // quota forever.
    //
    // ⚠️ This is the one place where "delete" and "deactivate" being the SAME
    // flag matters. There is no UI that lists inactive categories, so nothing can
    // resurrect one and find its image reclaimed. If a "restore category" screen
    // is ever added, it must re-attach these references — or, better, give
    // Category a real `isDeleted` field so the two states stop sharing one flag.
    await mediaService.reconcileRefs(shopId, previousMediaIds, []);

    // Invalidate cache
    await this.invalidateCache(shopId);
  }
}

module.exports = new CategoryService();
