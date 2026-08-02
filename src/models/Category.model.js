const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
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
  slug: {
    type: String,
    lowercase: true,
    trim: true
  },
  description: {
    type: String,
    maxlength: [500, 'বিবরণ ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  icon: {
    type: String
  },
  image: {
    type: String
  },
  parent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    default: null // null = top-level category
  },
  order: {
    type: Number,
    default: 0
  },
  productCount: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
categorySchema.index({ shop: 1, parent: 1 });
categorySchema.index({ shop: 1, name: 1 }, { unique: true, sparse: true });
categorySchema.index({ parent: 1, isActive: 1 }); // Subcategory populate (queries by parent without shop)
categorySchema.index({ shop: 1, order: 1 });

// Generate slug before saving
categorySchema.pre('save', function(next) {
  if (this.isModified('name') || !this.slug) {
    this.slug = this.name
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  }
  next();
});

// Virtual: Is subcategory
categorySchema.virtual('isSubcategory').get(function() {
  return !!this.parent;
});

// Virtual: Full name (with parent)
categorySchema.virtual('fullName').get(function() {
  // This will be populated with parent name when needed
  return this.name;
});

// Virtual: Subcategories
categorySchema.virtual('subcategories', {
  ref: 'Category',
  localField: '_id',
  foreignField: 'parent'
});

// Static: Get categories with subcategories
categorySchema.statics.getCategoriesWithSubcategories = async function(shopId) {
  return this.find({
    $or: [
      { shop: shopId },
      { shop: null } // Include system defaults
    ],
    parent: null,
    isActive: true
  })
    .sort({ order: 1, name: 1 })
    .populate({
      path: 'subcategories',
      match: { isActive: true },
      options: { sort: { order: 1, name: 1 } }
    });
};

// Static: Get all categories (flat)
categorySchema.statics.getAllCategories = function(shopId) {
  return this.find({
    $or: [
      { shop: shopId },
      { shop: null }
    ],
    isActive: true
  }).sort({ parent: 1, order: 1, name: 1 });
};

// Static: Get subcategories
categorySchema.statics.getSubcategories = function(parentId) {
  return this.find({
    parent: parentId,
    isActive: true
  }).sort({ order: 1, name: 1 });
};

// Method: Update product count
categorySchema.methods.updateProductCount = async function(increment = 1) {
  this.productCount = Math.max(0, this.productCount + increment);
  await this.save();

  // Also update parent category count
  if (this.parent) {
    await this.model('Category').findByIdAndUpdate(this.parent, {
      $inc: { productCount: increment }
    });
  }
};

const Category = mongoose.model('Category', categorySchema);

module.exports = Category;
