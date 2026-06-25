const mongoose = require('mongoose');

const branchStockSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, 'শাখা নির্বাচন করুন']
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: [true, 'পণ্য নির্বাচন করুন']
  },
  variantId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null // null = base product stock (non-variant)
  },
  stock: {
    type: Number,
    default: 0,
    min: [0, 'স্টক ০ এর কম হতে পারবে না']
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Unique compound index: one stock record per product-variant per branch
branchStockSchema.index(
  { shop: 1, branch: 1, product: 1, variantId: 1 },
  { unique: true }
);

// Efficient lookups by product across branches
branchStockSchema.index({ shop: 1, product: 1 });

// Virtual: Is low stock (uses a default threshold; caller can override)
branchStockSchema.virtual('isLowStock').get(function() {
  return this.stock <= 5;
});

// Static: Get stock for a product across all branches
branchStockSchema.statics.getProductStockByBranch = function(shopId, productId) {
  return this.find({ shop: shopId, product: productId })
    .populate('branch', 'name code');
};

// Static: Get stock for a specific branch
branchStockSchema.statics.getBranchStock = function(shopId, branchId, options = {}) {
  const { page = 1, limit = 50 } = options;
  return this.find({ shop: shopId, branch: branchId })
    .populate('product', 'name code hasVariants variants')
    .skip((page - 1) * limit)
    .limit(limit);
};

// Static: Get or create stock record
branchStockSchema.statics.getOrCreate = async function(shopId, branchId, productId, variantId = null) {
  let record = await this.findOne({
    shop: shopId,
    branch: branchId,
    product: productId,
    variantId: variantId
  });

  if (!record) {
    record = await this.create({
      shop: shopId,
      branch: branchId,
      product: productId,
      variantId: variantId,
      stock: 0
    });
  }

  return record;
};

// Method: Update stock (add or subtract)
branchStockSchema.methods.updateStock = async function(quantity) {
  this.stock = Math.max(0, this.stock + quantity);
  await this.save();
  return this.stock;
};

// Static: Get low stock items for a branch
branchStockSchema.statics.getLowStockItems = function(shopId, branchId, threshold = 5) {
  return this.find({
    shop: shopId,
    branch: branchId,
    stock: { $lte: threshold }
  })
    .populate('product', 'name code minStock')
    .populate('branch', 'name code');
};

// Static: Get total stock for a product across all branches
branchStockSchema.statics.getTotalStock = async function(shopId, productId, variantId = null) {
  const match = {
    shop: new mongoose.Types.ObjectId(shopId),
    product: new mongoose.Types.ObjectId(productId)
  };
  if (variantId) {
    match.variantId = new mongoose.Types.ObjectId(variantId);
  } else {
    match.variantId = null;
  }

  const result = await this.aggregate([
    { $match: match },
    { $group: { _id: null, totalStock: { $sum: '$stock' } } }
  ]);

  return result[0]?.totalStock || 0;
};

const BranchStock = mongoose.model('BranchStock', branchStockSchema);

module.exports = BranchStock;
