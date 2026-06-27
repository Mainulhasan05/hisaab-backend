const Category = require('../models/Category.model');
const CATEGORY_SEEDS = require('./categorySeeds');

/**
 * Seed categories for a newly created shop based on shop type.
 * Called during shop onboarding (registration).
 *
 * @param {ObjectId} shopId - The shop's MongoDB _id
 * @param {string} shopType - One of: cloth, grocery, electronics, pharmacy, hardware, cosmetics, other
 * @returns {Promise<{ categories: number, subcategories: number }>} Count of created items
 */
async function seedCategories(shopId, shopType) {
  const seeds = CATEGORY_SEEDS[shopType];
  if (!seeds || seeds.length === 0) {
    return { categories: 0, subcategories: 0 };
  }

  let categoryCount = 0;
  let subcategoryCount = 0;

  for (const seed of seeds) {
    // Create parent category
    const parent = await Category.create({
      shop: shopId,
      name: seed.nameBn || seed.name,
      icon: seed.icon || null,
      parent: null,
      order: seed.order || 0,
    });
    categoryCount++;

    // Create subcategories
    if (seed.subcategories && seed.subcategories.length > 0) {
      const subcategoryDocs = seed.subcategories.map((sub) => ({
        shop: shopId,
        name: sub.nameBn || sub.name,
        icon: sub.icon || null,
        parent: parent._id,
        order: sub.order || 0,
      }));

      await Category.insertMany(subcategoryDocs);
      subcategoryCount += subcategoryDocs.length;
    }
  }

  return { categories: categoryCount, subcategories: subcategoryCount };
}

module.exports = { seedCategories };
