const mongoose = require('mongoose');

const subcategorySeedSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  order: {
    type: Number,
    default: 0
  }
}, { _id: false });

const defaultCategorySeedSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  icon: {
    type: String,
    default: null
  },
  order: {
    type: Number,
    default: 0
  },
  subcategories: [subcategorySeedSchema]
}, { _id: false });

// Terminology override schema — allows each business type to rename UI labels
const terminologyEntrySchema = new mongoose.Schema({
  bn: { type: String, trim: true },
  en: { type: String, trim: true }
}, { _id: false });

// Module toggle schema — controls which modules are visible for this business type
const enabledModulesSchema = new mongoose.Schema({
  products:        { type: Boolean, default: true },
  services:        { type: Boolean, default: false },
  appointments:    { type: Boolean, default: false },
  treatments:      { type: Boolean, default: false },
  equipment:       { type: Boolean, default: false },
  beforeAfterPhotos: { type: Boolean, default: false },
  sales:           { type: Boolean, default: true },
  customers:       { type: Boolean, default: true },
  expenses:        { type: Boolean, default: true },
  cashRegister:    { type: Boolean, default: true },
  reports:         { type: Boolean, default: true },
  sms:             { type: Boolean, default: true },
  staff:           { type: Boolean, default: true },
  suppliers:       { type: Boolean, default: true },
  purchases:       { type: Boolean, default: true },
  stockTransfers:  { type: Boolean, default: true },
  coupons:         { type: Boolean, default: true },
  categories:      { type: Boolean, default: true },
  auditLogs:       { type: Boolean, default: true },
}, { _id: false });

const shopCategorySchema = new mongoose.Schema({
  key: {
    type: String,
    required: [true, 'ক্যাটাগরি কি (key) দিন'],
    unique: true,
    lowercase: true,
    trim: true
  },
  name: {
    type: String,
    required: [true, 'ক্যাটাগরির নাম দিন'],
    trim: true
  },
  icon: {
    type: String,
    default: '🏪'
  },
  description: {
    type: String,
    trim: true
  },
  // NEW: Business model type — drives fundamental UX differences
  businessModel: {
    type: String,
    enum: ['retail', 'service', 'hybrid'],
    default: 'retail'
  },
  // NEW: Module visibility configuration — admin toggles per category
  enabledModules: {
    type: enabledModulesSchema,
    default: () => ({})
  },
  // NEW: Terminology overrides — customize UI labels per business type
  terminology: {
    product:  { type: terminologyEntrySchema, default: () => ({ bn: 'পণ্য', en: 'Product' }) },
    sale:     { type: terminologyEntrySchema, default: () => ({ bn: 'বিক্রয়', en: 'Sale' }) },
    customer: { type: terminologyEntrySchema, default: () => ({ bn: 'কাস্টমার', en: 'Customer' }) },
    invoice:  { type: terminologyEntrySchema, default: () => ({ bn: 'ইনভয়েস', en: 'Invoice' }) },
    purchase: { type: terminologyEntrySchema, default: () => ({ bn: 'ক্রয়', en: 'Purchase' }) },
    supplier: { type: terminologyEntrySchema, default: () => ({ bn: 'সরবরাহকারী', en: 'Supplier' }) },
  },
  // NEW: Dashboard widget configuration — which cards/charts to show
  dashboardWidgets: {
    type: [String],
    default: ['todayRevenue', 'todayProfit', 'totalDue', 'lowStock', 'recentSales', 'topProducts', 'salesChart']
  },
  isActive: {
    type: Boolean,
    default: true
  },
  sortOrder: {
    type: Number,
    default: 0
  },
  defaultVariantTypes: {
    type: [String],
    default: ['size', 'color']
  },
  defaultCategories: [defaultCategorySeedSchema]
}, {
  timestamps: true
});

shopCategorySchema.index({ isActive: 1, sortOrder: 1 });


const ShopCategory = mongoose.model('ShopCategory', shopCategorySchema);

module.exports = ShopCategory;
