const ShopCategory = require('../models/ShopCategory.model');
const CATEGORY_SEEDS = require('./categorySeeds');

// `other` keeps sortOrder 8 (already live in production databases); the public
// endpoint pins it to the end of the list regardless of its numeric order.
const INITIAL_SHOP_CATEGORIES = [
  { key: 'cloth', name: 'কাপড়/পোশাক', icon: '👔', sortOrder: 1, defaultVariantTypes: ['size', 'color'], description: 'শাড়ি, থ্রি পিস, শার্ট, প্যান্ট, শোরুম' },
  { key: 'grocery', name: 'মুদি/মনোহারি', icon: '🛒', sortOrder: 2, defaultVariantTypes: ['weight', 'pack-size'], description: 'চাল, ডাল, তেল, মসলা' },
  { key: 'electronics', name: 'ইলেকট্রনিক্স', icon: '📱', sortOrder: 3, defaultVariantTypes: ['color', 'storage', 'warranty'], description: 'টিভি, ফ্রিজ, এসি, হোম অ্যাপ্লায়েন্স' },
  { key: 'pharmacy', name: 'ফার্মেসি', icon: '💊', sortOrder: 4, defaultVariantTypes: ['strength', 'pack-size'], description: 'ওষুধ ও স্বাস্থ্য সামগ্রী' },
  { key: 'cosmetics', name: 'কসমেটিক্স', icon: '💄', sortOrder: 5, defaultVariantTypes: ['shade', 'pack-size', 'weight'], description: 'মেকআপ, স্কিন কেয়ার, পারফিউম' },
  { key: 'hardware', name: 'হার্ডওয়্যার', icon: '🔧', sortOrder: 6, defaultVariantTypes: ['size', 'weight'], description: 'পেইন্ট, পাইপ, ফিটিংস, টুলস' },
  { key: 'bookshop', name: 'বইয়ের দোকান', icon: '📚', sortOrder: 7, defaultVariantTypes: [], description: 'পাঠ্যবই, গল্পের বই, স্টেশনারি' },
  { key: 'other', name: 'অন্যান্য', icon: '🏪', sortOrder: 8, defaultVariantTypes: ['size', 'color', 'weight'], description: 'অন্যান্য ধরনের ব্যবসা' },
  { key: 'computer', name: 'কম্পিউটার পণ্য', icon: '💻', sortOrder: 9, defaultVariantTypes: ['storage', 'color', 'warranty'], description: 'ডেস্কটপ, ল্যাপটপ, পার্টস, এক্সেসরিজ' },
  { key: 'dealership', name: 'ডিলারশিপ', icon: '🤝', sortOrder: 10, defaultVariantTypes: ['size', 'color', 'warranty'], description: 'ব্র্যান্ড পরিবেশক ও পাইকারি বিক্রয়' },
  { key: 'ecommerce', name: 'ই-কমার্স', icon: '🛍️', sortOrder: 11, defaultVariantTypes: ['size', 'color', 'weight'], description: 'অনলাইন শপ ও কুরিয়ার ডেলিভারি' },
  { key: 'furniture', name: 'ফার্নিচার', icon: '🛋️', sortOrder: 12, defaultVariantTypes: ['size', 'color'], description: 'খাট, সোফা, আলমারি, অফিস ফার্নিচার' },
  { key: 'manufacturing', name: 'ম্যানুফ্যাকচারিং', icon: '🏭', sortOrder: 13, defaultVariantTypes: ['size', 'weight', 'pack-size'], description: 'উৎপাদন, কাঁচামাল ও পণ্য বিক্রয়' },
  { key: 'medical-surgical', name: 'মেডিকেল ও সার্জিক্যাল', icon: '🩺', sortOrder: 14, defaultVariantTypes: ['size', 'pack-size', 'strength'], description: 'সার্জিক্যাল যন্ত্রপাতি ও মেডিকেল সামগ্রী' },
  { key: 'mobile', name: 'মোবাইল ও এক্সেসরিজ', icon: '📲', sortOrder: 15, defaultVariantTypes: ['color', 'storage', 'warranty'], description: 'মোবাইল, কভার, চার্জার, সার্ভিসিং' },
  { key: 'general-trading', name: 'পণ্য বিক্রয় ও হিসাব', icon: '📦', sortOrder: 16, defaultVariantTypes: ['size', 'color', 'weight', 'pack-size'], description: 'সাধারণ পণ্য বিক্রয়, ইনভেন্টরি ও হিসাব' },
  { key: 'shoe', name: 'জুতা', icon: '👟', sortOrder: 17, defaultVariantTypes: ['size', 'color'], description: 'পুরুষ, নারী ও শিশুদের জুতা' },
  { key: 'supershop', name: 'সুপার শপ', icon: '🏬', sortOrder: 18, defaultVariantTypes: ['weight', 'pack-size', 'size'], description: 'ডিপার্টমেন্টাল ও সুপার স্টোর' },
  { key: 'stationery', name: 'স্টেশনারি', icon: '✏️', sortOrder: 19, defaultVariantTypes: ['size', 'color', 'pack-size'], description: 'কলম, খাতা, অফিস ও স্কুল সামগ্রী' }
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
          description: cat.description || '',
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

module.exports = { seedShopCategories, INITIAL_SHOP_CATEGORIES };
