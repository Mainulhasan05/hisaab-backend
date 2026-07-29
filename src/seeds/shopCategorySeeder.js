const ShopCategory = require('../models/ShopCategory.model');
const CATEGORY_SEEDS = require('./categorySeeds');

// Default enabled modules for retail businesses
const RETAIL_MODULES = {
  products: true, services: false, appointments: false, treatments: false,
  equipment: false, beforeAfterPhotos: false, sales: true, customers: true,
  expenses: true, cashRegister: true, reports: true, sms: true, staff: true,
  suppliers: true, purchases: true, stockTransfers: true, coupons: true,
  categories: true, auditLogs: true,
};

// Default enabled modules for service businesses
const SERVICE_MODULES = {
  products: true,  // For consumables/stock
  services: true, appointments: true, treatments: true,
  equipment: true, beforeAfterPhotos: true, sales: true, customers: true,
  expenses: true, cashRegister: true, reports: true, sms: true, staff: true,
  suppliers: true, purchases: true, stockTransfers: false, coupons: true,
  categories: true, auditLogs: true,
};

// Default enabled modules for hybrid businesses
const HYBRID_MODULES = {
  products: true, services: true, appointments: true, treatments: false,
  equipment: false, beforeAfterPhotos: false, sales: true, customers: true,
  expenses: true, cashRegister: true, reports: true, sms: true, staff: true,
  suppliers: true, purchases: true, stockTransfers: true, coupons: true,
  categories: true, auditLogs: true,
};

// Default retail terminology
const RETAIL_TERMINOLOGY = {
  product:  { bn: 'পণ্য', en: 'Product' },
  sale:     { bn: 'বিক্রয়', en: 'Sale' },
  customer: { bn: 'কাস্টমার', en: 'Customer' },
  invoice:  { bn: 'ইনভয়েস', en: 'Invoice' },
  purchase: { bn: 'ক্রয়', en: 'Purchase' },
  supplier: { bn: 'সরবরাহকারী', en: 'Supplier' },
};

// Service business terminology
const SERVICE_TERMINOLOGY = {
  product:  { bn: 'সেবা/পণ্য', en: 'Service/Product' },
  sale:     { bn: 'বিলিং', en: 'Billing' },
  customer: { bn: 'ক্লায়েন্ট', en: 'Client' },
  invoice:  { bn: 'বিল', en: 'Bill' },
  purchase: { bn: 'কাঁচামাল ক্রয়', en: 'Material Purchase' },
  supplier: { bn: 'সরবরাহকারী', en: 'Supplier' },
};

const RETAIL_WIDGETS = ['todayRevenue', 'todayProfit', 'totalDue', 'lowStock', 'recentSales', 'topProducts', 'salesChart'];
const SERVICE_WIDGETS = ['todayAppointments', 'todayRevenue', 'upcomingReminders', 'topServices', 'clientCount', 'expenseSummary', 'salesChart'];

const INITIAL_SHOP_CATEGORIES = [
  // ─── Existing Retail Categories ───
  { key: 'cloth', name: 'কাপড়/পোশাক', icon: '👔', sortOrder: 1, businessModel: 'retail', enabledModules: RETAIL_MODULES, terminology: RETAIL_TERMINOLOGY, dashboardWidgets: RETAIL_WIDGETS, defaultVariantTypes: ['size', 'color'] },
  { key: 'grocery', name: 'মুদি/মনোহারি', icon: '🛒', sortOrder: 2, businessModel: 'retail', enabledModules: RETAIL_MODULES, terminology: RETAIL_TERMINOLOGY, dashboardWidgets: RETAIL_WIDGETS, defaultVariantTypes: ['weight', 'pack-size'] },
  { key: 'electronics', name: 'ইলেকট্রনিক্স', icon: '📱', sortOrder: 3, businessModel: 'retail', enabledModules: RETAIL_MODULES, terminology: RETAIL_TERMINOLOGY, dashboardWidgets: RETAIL_WIDGETS, defaultVariantTypes: ['color', 'storage', 'warranty'] },
  { key: 'pharmacy', name: 'ফার্মেসি', icon: '💊', sortOrder: 4, businessModel: 'retail', enabledModules: RETAIL_MODULES, terminology: RETAIL_TERMINOLOGY, dashboardWidgets: RETAIL_WIDGETS, defaultVariantTypes: ['strength', 'pack-size'] },
  { key: 'cosmetics', name: 'কসমেটিক্স', icon: '💄', sortOrder: 5, businessModel: 'retail', enabledModules: RETAIL_MODULES, terminology: RETAIL_TERMINOLOGY, dashboardWidgets: RETAIL_WIDGETS, defaultVariantTypes: ['shade', 'pack-size', 'weight'] },
  { key: 'hardware', name: 'হার্ডওয়্যার', icon: '🔧', sortOrder: 6, businessModel: 'retail', enabledModules: RETAIL_MODULES, terminology: RETAIL_TERMINOLOGY, dashboardWidgets: RETAIL_WIDGETS, defaultVariantTypes: ['size', 'weight'] },
  { key: 'bookshop', name: 'বইয়ের দোকান', icon: '📚', sortOrder: 7, businessModel: 'retail', enabledModules: RETAIL_MODULES, terminology: RETAIL_TERMINOLOGY, dashboardWidgets: RETAIL_WIDGETS, defaultVariantTypes: [] },

  // ─── New Service-Based Categories ───
  { key: 'beauty_salon', name: 'বিউটি পার্লার / সেলুন', icon: '💇', sortOrder: 8, businessModel: 'service', enabledModules: SERVICE_MODULES, terminology: SERVICE_TERMINOLOGY, dashboardWidgets: SERVICE_WIDGETS, defaultVariantTypes: ['duration'] },
  { key: 'clinic', name: 'ক্লিনিক / মেডিকেল', icon: '🏥', sortOrder: 9, businessModel: 'service', enabledModules: SERVICE_MODULES, terminology: SERVICE_TERMINOLOGY, dashboardWidgets: SERVICE_WIDGETS, defaultVariantTypes: [] },
  { key: 'spa_wellness', name: 'স্পা ও ওয়েলনেস', icon: '🧖', sortOrder: 10, businessModel: 'service', enabledModules: SERVICE_MODULES, terminology: SERVICE_TERMINOLOGY, dashboardWidgets: SERVICE_WIDGETS, defaultVariantTypes: ['duration'] },
  { key: 'gym_fitness', name: 'জিম / ফিটনেস', icon: '🏋️', sortOrder: 11, businessModel: 'hybrid', enabledModules: HYBRID_MODULES, terminology: SERVICE_TERMINOLOGY, dashboardWidgets: SERVICE_WIDGETS, defaultVariantTypes: [] },

  // ─── Catch-all ───
  { key: 'other', name: 'অন্যান্য', icon: '🏪', sortOrder: 99, businessModel: 'retail', enabledModules: RETAIL_MODULES, terminology: RETAIL_TERMINOLOGY, dashboardWidgets: RETAIL_WIDGETS, defaultVariantTypes: ['size', 'color', 'weight'] }
];

/**
 * Seed initial ShopCategories if DB is empty or missing keys.
 * Also updates existing categories with new fields if they are missing.
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
          businessModel: cat.businessModel,
          enabledModules: cat.enabledModules,
          terminology: cat.terminology,
          dashboardWidgets: cat.dashboardWidgets,
          defaultVariantTypes: cat.defaultVariantTypes,
          isActive: true,
          defaultCategories: formattedDefaultCategories
        });
        console.log(`Seeded shop category: ${cat.key}`);
      } else {
        // Backfill new fields on existing categories if missing
        let needsSave = false;
        if (!existing.businessModel) {
          existing.businessModel = cat.businessModel;
          needsSave = true;
        }
        if (!existing.enabledModules || !existing.enabledModules.sales) {
          existing.enabledModules = cat.enabledModules;
          needsSave = true;
        }
        if (!existing.terminology || !existing.terminology.product) {
          existing.terminology = cat.terminology;
          needsSave = true;
        }
        if (!existing.dashboardWidgets || existing.dashboardWidgets.length === 0) {
          existing.dashboardWidgets = cat.dashboardWidgets;
          needsSave = true;
        }
        if (needsSave) {
          await existing.save();
          console.log(`Updated shop category with new fields: ${cat.key}`);
        }
      }
    }
  } catch (error) {
    console.error('Error seeding shop categories:', error.message);
  }
}

module.exports = { seedShopCategories };
