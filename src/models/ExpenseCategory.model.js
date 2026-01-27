const mongoose = require('mongoose');

const expenseCategorySchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    default: null // null = system default category
  },
  name: {
    type: String,
    required: [true, 'ক্যাটাগরির নাম দিন'],
    trim: true,
    maxlength: [100, 'ক্যাটাগরির নাম ১০০ অক্ষরের বেশি হতে পারবে না']
  },
  icon: {
    type: String,
    default: null
  },
  order: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Indexes
expenseCategorySchema.index({ shop: 1, name: 1 }, { unique: true, sparse: true });
expenseCategorySchema.index({ shop: 1, order: 1 });

// Static: Get categories for a shop (includes system defaults)
expenseCategorySchema.statics.getCategories = function(shopId) {
  return this.find({
    $or: [
      { shop: shopId },
      { shop: null }
    ],
    isActive: true
  }).sort({ order: 1, name: 1 });
};

// Static: Seed default categories
expenseCategorySchema.statics.seedDefaults = async function() {
  const defaults = [
    { name: 'দোকান ভাড়া', icon: 'home', order: 1 },
    { name: 'বিদ্যুৎ বিল', icon: 'zap', order: 2 },
    { name: 'কর্মচারী বেতন', icon: 'users', order: 3 },
    { name: 'পরিবহন', icon: 'truck', order: 4 },
    { name: 'প্যাকেজিং', icon: 'package', order: 5 },
    { name: 'খাবার', icon: 'coffee', order: 6 },
    { name: 'মেরামত', icon: 'tool', order: 7 },
    { name: 'ফোন/ইন্টারনেট', icon: 'wifi', order: 8 },
    { name: 'ট্যাক্স/ফি', icon: 'file-text', order: 9 },
    { name: 'অন্যান্য', icon: 'more-horizontal', order: 10 },
  ];

  for (const cat of defaults) {
    await this.findOneAndUpdate(
      { shop: null, name: cat.name },
      { $setOnInsert: cat },
      { upsert: true, new: true }
    );
  }
};

const ExpenseCategory = mongoose.model('ExpenseCategory', expenseCategorySchema);

module.exports = ExpenseCategory;
