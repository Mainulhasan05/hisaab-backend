const mongoose = require('mongoose');

const variantSchema = new mongoose.Schema({
  sku: {
    type: String,
    required: true,
    trim: true
  },
  attributes: {
    size: String,
    color: String,
    weight: String,
    material: String,
    style: String,
    custom: mongoose.Schema.Types.Mixed
  },
  buyingPrice: {
    type: Number,
    required: [true, 'ক্রয় মূল্য দিন'],
    min: [0, 'ক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  sellingPrice: {
    type: Number,
    required: [true, 'বিক্রয় মূল্য দিন'],
    min: [0, 'বিক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  stock: {
    type: Number,
    default: 0,
    min: [0, 'স্টক ০ এর কম হতে পারবে না']
  },
  barcode: {
    type: String,
    trim: true
  },
  image: {
    type: String
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { _id: true });

const productSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  code: {
    type: String,
    required: [true, 'পণ্যের কোড দিন'],
    trim: true,
    uppercase: true
  },
  barcode: {
    type: String,
    trim: true
  },
  name: {
    type: String,
    required: [true, 'পণ্যের নাম দিন'],
    trim: true,
    maxlength: [200, 'পণ্যের নাম ২০০ অক্ষরের বেশি হতে পারবে না']
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category'
  },
  subcategory: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category'
  },
  description: {
    type: String,
    maxlength: [2000, 'বিবরণ ২০০০ অক্ষরের বেশি হতে পারবে না']
  },
  brand: {
    type: String,
    trim: true
  },
  unit: {
    type: String,
    default: 'piece',
    enum: ['piece', 'kg', 'gram', 'liter', 'ml', 'meter', 'inch', 'feet', 'dozen', 'pack', 'box', 'set', 'sack']
  },
  hasVariants: {
    type: Boolean,
    default: false
  },
  // For non-variant products
  buyingPrice: {
    type: Number,
    min: [0, 'ক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  sellingPrice: {
    type: Number,
    min: [0, 'বিক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  stock: {
    type: Number,
    default: 0,
    min: [0, 'স্টক ০ এর কম হতে পারবে না']
  },
  minStock: {
    type: Number,
    default: 5,
    min: [0, 'নূন্যতম স্টক ০ এর কম হতে পারবে না']
  },
  // For variant products
  variants: [variantSchema],
  images: [{
    type: String
  }],
  tags: [{
    type: String,
    trim: true
  }],
  // Sales tracking
  totalSold: {
    type: Number,
    default: 0
  },
  lastSold: {
    type: Date
  },
  isActive: {
    type: Boolean,
    default: true
  },
  // Online Selling
  isAvailableOnline: {
    type: Boolean,
    default: true
  },
  onlinePrice: {
    type: Number,
    min: [0, 'অনলাইন বিক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  onlineDescription: {
    type: String,
    maxlength: [2000, 'অনলাইন বিবরণ ২০০০ অক্ষরের বেশি হতে পারবে না']
  },
  isFeaturedOnline: {
    type: Boolean,
    default: false
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes - Optimized for scalability
// Essential indexes only - removed redundant and rarely-used indexes
productSchema.index({ shop: 1, code: 1 }, { unique: true }); // Product code lookup
productSchema.index({ shop: 1, barcode: 1 }, { sparse: true }); // Barcode scan
productSchema.index({ shop: 1, category: 1, isActive: 1 }); // Category listing with active filter
productSchema.index({ shop: 1, 'variants.sku': 1 }, { sparse: true }); // Variant SKU lookup
productSchema.index({ shop: 1, 'variants.barcode': 1 }, { sparse: true }); // Variant barcode scan
productSchema.index({ shop: 1, createdAt: -1 }); // Listing by date
productSchema.index({ shop: 1, isAvailableOnline: 1, isActive: 1 }); // Online product listing
// Note: Text search removed for scalability - use regex or external search (Elasticsearch) for large datasets

// Virtual: Is low stock
productSchema.virtual('isLowStock').get(function() {
  if (this.hasVariants) {
    return this.variants.some(v => v.isActive && v.stock <= this.minStock);
  }
  return this.stock <= this.minStock;
});

// Virtual: Total stock (for variant products)
productSchema.virtual('totalStock').get(function() {
  if (this.hasVariants) {
    return this.variants
      .filter(v => v.isActive)
      .reduce((sum, v) => sum + v.stock, 0);
  }
  return this.stock;
});

// Virtual: Profit margin
productSchema.virtual('profitMargin').get(function() {
  if (!this.hasVariants && this.sellingPrice && this.buyingPrice) {
    return ((this.sellingPrice - this.buyingPrice) / this.sellingPrice * 100).toFixed(2);
  }
  return null;
});

// Static: Find by code
productSchema.statics.findByCode = function(shopId, code) {
  return this.findOne({ shop: shopId, code: code.toUpperCase(), isActive: true });
};

// Static: Find by barcode
productSchema.statics.findByBarcode = function(shopId, barcode) {
  return this.findOne({
    shop: shopId,
    isActive: true,
    $or: [
      { barcode },
      { 'variants.barcode': barcode }
    ]
  });
};

// Static: Get low stock products
productSchema.statics.getLowStockProducts = function(shopId, threshold = 5) {
  return this.find({
    shop: shopId,
    isActive: true,
    $or: [
      { hasVariants: false, stock: { $lte: threshold } },
      { hasVariants: true, 'variants.stock': { $lte: threshold } }
    ]
  }).sort({ stock: 1 });
};

// Static: Search products
productSchema.statics.searchProducts = function(shopId, query, options = {}) {
  const { page = 1, limit = 20, category, sortBy = 'name', sortOrder = 1 } = options;

  const filter = {
    shop: shopId,
    isActive: true,
    $or: [
      { name: { $regex: query, $options: 'i' } },
      { code: { $regex: query, $options: 'i' } },
      { barcode: { $regex: query, $options: 'i' } }
    ]
  };

  if (category) {
    filter.$or.push({ category }, { subcategory: category });
  }

  return this.find(filter)
    .sort({ [sortBy]: sortOrder })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('category', 'name')
    .populate('subcategory', 'name');
};

// Method: Update stock
productSchema.methods.updateStock = async function(quantity, variantId = null) {
  if (this.hasVariants && variantId) {
    const variant = this.variants.id(variantId);
    if (variant) {
      variant.stock = Math.max(0, variant.stock + quantity);
    }
  } else {
    this.stock = Math.max(0, this.stock + quantity);
  }
  await this.save();
};

// Method: Record sale
productSchema.methods.recordSale = async function(quantity, variantId = null) {
  await this.updateStock(-quantity, variantId);
  this.totalSold += quantity;
  this.lastSold = new Date();
  await this.save();
};

// Method: Get variant by ID
productSchema.methods.getVariant = function(variantId) {
  if (!this.hasVariants) return null;
  return this.variants.id(variantId);
};

// Method: Get variant by SKU
productSchema.methods.getVariantBySKU = function(sku) {
  if (!this.hasVariants) return null;
  return this.variants.find(v => v.sku === sku);
};

const Product = mongoose.model('Product', productSchema);

module.exports = Product;
