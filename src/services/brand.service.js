const Brand = require('../models/Brand.model');
const Product = require('../models/Product.model');
const { AppError } = require('../middleware/error.middleware');

/**
 * Brand list management.
 *
 * Deliberately thin, and deliberately NOT cached. `category.service` caches its
 * tree for 15 minutes because the sale screen reads it on every load; the brand
 * list is read by two forms and the page that edits it, where a stale list is
 * exactly the wrong trade — a shopkeeper who adds "Square" and does not see it
 * on the next product will add it again.
 */
class BrandService {
  /**
   * Every active brand for a shop, in display order.
   *
   * Used both by the management page and by the product form's picker, so it is
   * one query with no pagination: a shop's brand list is tens of rows, and
   * paginating a `<select>` helps nobody.
   */
  async getBrands(shopId, { includeInactive = false } = {}) {
    const filter = { shop: shopId };
    if (!includeInactive) filter.isActive = true;

    return Brand.find(filter)
      .sort({ order: 1, name: 1 })
      .collation({ locale: 'en', strength: 2 })
      .lean();
  }

  async getBrandById(shopId, brandId) {
    const brand = await Brand.findOne({ _id: brandId, shop: shopId });
    if (!brand) {
      throw new AppError('Brand not found', 'ব্র্যান্ড পাওয়া যায়নি', 404);
    }
    return brand;
  }

  /**
   * Create a brand.
   *
   * The duplicate check is done here AND by a unique index. The index is the
   * one that actually holds under two concurrent requests; this exists to turn
   * its E11000 into a sentence a shopkeeper can read.
   */
  async createBrand(shopId, data) {
    const name = String(data.name || '').trim();

    const existing = await Brand.findOne({ shop: shopId, name, isActive: true })
      .collation({ locale: 'en', strength: 2 });
    if (existing) {
      throw new AppError(
        'A brand with this name already exists',
        `"${name}" নামে একটি ব্র্যান্ড আগে থেকেই আছে`,
        400
      );
    }

    try {
      return await Brand.create({
        shop: shopId,
        name,
        description: data.description || '',
        order: data.order || 0,
      });
    } catch (err) {
      if (err?.code === 11000) {
        throw new AppError(
          'A brand with this name already exists',
          `"${name}" নামে একটি ব্র্যান্ড আগে থেকেই আছে`,
          400
        );
      }
      throw err;
    }
  }

  async updateBrand(shopId, brandId, data) {
    const brand = await this.getBrandById(shopId, brandId);

    if (data.name !== undefined) {
      const name = String(data.name).trim();
      const clash = await Brand.findOne({
        shop: shopId,
        name,
        isActive: true,
        _id: { $ne: brand._id },
      }).collation({ locale: 'en', strength: 2 });

      if (clash) {
        throw new AppError(
          'A brand with this name already exists',
          `"${name}" নামে একটি ব্র্যান্ড আগে থেকেই আছে`,
          400
        );
      }
      brand.name = name;
    }

    for (const field of ['description', 'order', 'isActive']) {
      if (data[field] !== undefined) brand[field] = data[field];
    }

    try {
      await brand.save();
    } catch (err) {
      if (err?.code === 11000) {
        throw new AppError(
          'A brand with this name already exists',
          'এই নামে একটি ব্র্যান্ড আগে থেকেই আছে',
          400
        );
      }
      throw err;
    }

    return brand;
  }

  /**
   * Soft-delete a brand, refusing while products still point at it.
   *
   * Same rule as `category.service.deleteCategory`, and for the same reason: a
   * product whose brand row is gone renders a blank on every screen that reads
   * it, and there is nothing in the UI to tell the shopkeeper why. Refusing is
   * the honest answer, and the count tells them what to fix.
   *
   * Counts ACTIVE products only — a deleted product must not keep a brand
   * hostage forever.
   */
  async deleteBrand(shopId, brandId) {
    const brand = await this.getBrandById(shopId, brandId);

    const productCount = await Product.countDocuments({
      shop: shopId,
      brand: brandId,
      isActive: true,
      isDeleted: { $ne: true },
    });

    if (productCount > 0) {
      throw new AppError(
        'Cannot delete a brand that still has products',
        `এই ব্র্যান্ডে ${productCount}টি পণ্য আছে, মুছে ফেলা যাবে না`,
        400
      );
    }

    brand.isActive = false;
    await brand.save();
  }
}

module.exports = new BrandService();
