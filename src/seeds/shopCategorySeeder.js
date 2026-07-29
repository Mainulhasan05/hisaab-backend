const ShopCategory = require('../models/ShopCategory.model');
const CATEGORY_SEEDS = require('./categorySeeds');

const INITIAL_SHOP_CATEGORIES = [
  { key: 'cloth', name: 'কাপড়/পোশাক', icon: '👔', sortOrder: 1, defaultVariantTypes: ['size', 'color'] },
  { key: 'grocery', name: 'মুদি/মনোহারি', icon: '🛒', sortOrder: 2, defaultVariantTypes: ['weight', 'pack-size'] },
  { key: 'electronics', name: 'ইলেকট্রনিক্স', icon: '📱', sortOrder: 3, defaultVariantTypes: ['color', 'storage', 'warranty'] },
  { key: 'pharmacy', name: 'ফার্মেসি', icon: '💊', sortOrder: 4, defaultVariantTypes: ['strength', 'pack-size'] },
  { key: 'cosmetics', name: 'কসমেটিক্স', icon: '💄', sortOrder: 5, defaultVariantTypes: ['shade', 'pack-size', 'weight'] },
  { key: 'hardware', name: 'হার্ডওয়্যার', icon: '🔧', sortOrder: 6, defaultVariantTypes: ['size', 'weight'] },
  { key: 'bookshop', name: 'বইয়ের দোকান', icon: '📚', sortOrder: 7, defaultVariantTypes: [] },
  { key: 'other', name: 'অন্যান্য', icon: '🏪', sortOrder: 8, defaultVariantTypes: ['size', 'color', 'weight'] }
];

/**
 * Seed initial ShopCategories if DB is empty or missing keys
 */
async function seedShopCategories() {
  try {
    for (const cat of INITIAL_SHOP_CATEGORIES) {
      const existing = await ShopCategory.findOne({ key: cat.key });
      if (!existing) {
        const rawDefaultCategories = CATEGORY_SEEDS[cat.key] || [];
        const formattedDefaultCategories = rawDefaultCategories.map((c) => ({
          name: c.name,
          icon: c.icon || null,
          order: c.order || 0,
          subcategories: (c.subcategories || []).map((sub) => ({
            name: sub.name,
            order: sub.order || 0
          }))
        }));

        await ShopCategory.create({
          key: cat.key,
          name: cat.name,
          icon: cat.icon,
          sortOrder: cat.sortOrder,
          defaultVariantTypes: cat.defaultVariantTypes,
          isActive: true,
          defaultCategories: formattedDefaultCategories
        });
        console.log(`Seeded shop category: ${cat.key}`);
      }
    }
  } catch (error) {
    console.error('Error seeding shop categories:', error.message);
  }
}

module.exports = { seedShopCategories };
