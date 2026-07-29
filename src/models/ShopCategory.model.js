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
