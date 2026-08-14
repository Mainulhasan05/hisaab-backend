const mongoose = require('mongoose');
const { STOCK_TRANSACTION_TYPES } = require('../config/constants');

// See the `viaCombo` field below. A named schema rather than an inline object
// so the nested keys can never be misread as SchemaType options.
const viaComboSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  name: { type: String },
  code: { type: String },
  // How many combos this deduction served.
  comboQuantity: { type: Number },
}, { _id: false });

const stockTransactionSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: [true, 'পণ্য নির্বাচন করুন']
  },
  productName: {
    type: String,
    required: true
  },
  productCode: {
    type: String
  },
  variantId: {
    type: mongoose.Schema.Types.ObjectId
  },
  variantSku: {
    type: String
  },
  variantAttributes: {
    type: mongoose.Schema.Types.Mixed
  },
  type: {
    type: String,
    enum: {
      values: Object.values(STOCK_TRANSACTION_TYPES),
      message: 'অবৈধ লেনদেনের ধরন'
    },
    required: [true, 'লেনদেনের ধরন দিন']
  },
  quantity: {
    type: Number,
    required: [true, 'পরিমাণ দিন']
    // Can be negative for stock out
  },
  previousStock: {
    type: Number,
    required: true
  },
  newStock: {
    type: Number,
    required: true
  },
  unitCost: {
    type: Number,
    min: 0
  },
  totalCost: {
    type: Number,
    min: 0
  },
  unitPrice: {
    type: Number,
    min: 0
  },
  totalPrice: {
    type: Number,
    min: 0
  },
  reference: {
    type: {
      type: String,
      enum: ['sale', 'purchase', 'manual', 'return', 'damage']
    },
    id: mongoose.Schema.Types.ObjectId,
    invoiceNo: String
  },
  supplier: {
    type: String,
    trim: true
  },
  // Set when this movement happened because a COMBO was sold, cancelled or
  // returned — the row itself is on the component product, and this says which
  // bundle pulled it. Name and code are snapshots (the combo may be renamed or
  // deleted later; this ledger row must keep reading the same). Absent on every
  // ordinary movement, so pre-combo rows are untouched.
  viaCombo: {
    type: viaComboSchema,
    default: undefined
  },
  notes: {
    type: String,
    maxlength: [500, 'নোট ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes - Optimized for scalability
stockTransactionSchema.index({ shop: 1, branch: 1, product: 1, createdAt: -1 }); // Product stock history with branch
stockTransactionSchema.index({ shop: 1, branch: 1, createdAt: -1 }); // Main listing with branch
stockTransactionSchema.index({ shop: 1, product: 1, createdAt: -1 }); // Product history when branch unscoped

// Virtual: Is stock in
stockTransactionSchema.virtual('isStockIn').get(function() {
  return this.quantity > 0;
});

// Virtual: Is stock out
stockTransactionSchema.virtual('isStockOut').get(function() {
  return this.quantity < 0;
});

// Virtual: Absolute quantity
stockTransactionSchema.virtual('absoluteQuantity').get(function() {
  return Math.abs(this.quantity);
});

// Static: Create stock transaction
stockTransactionSchema.statics.createTransaction = async function(data) {
  const transaction = new this(data);
  return transaction.save();
};

// Static: Get product stock history
stockTransactionSchema.statics.getProductHistory = function(shopId, productId, options = {}) {
  const { page = 1, limit = 20, startDate, endDate } = options;

  const filter = {
    shop: shopId,
    product: productId
  };

  if (startDate && endDate) {
    filter.createdAt = { $gte: startDate, $lte: endDate };
  }

  return this.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('createdBy', 'name');
};

// Static: Get stock movement summary
stockTransactionSchema.statics.getStockMovementSummary = async function(shopId, startDate, endDate) {
  const match = {
    shop: new mongoose.Types.ObjectId(shopId),
    createdAt: { $gte: startDate, $lte: endDate }
  };

  const summary = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$type',
        totalQuantity: { $sum: '$quantity' },
        totalCost: { $sum: '$totalCost' },
        count: { $sum: 1 }
      }
    }
  ]);

  return summary;
};

// Static: Get stock valuation
stockTransactionSchema.statics.getStockValuation = async function(shopId) {
  const Product = mongoose.model('Product');

  const products = await Product.find({
    shop: shopId,
    isActive: true,
    // Combos hold no stock of their own — their value IS their components',
    // which are already counted. Explicit here so a future combo with a stray
    // stock figure can never double-count.
    type: { $ne: 'combo' }
  }).select('name code stock buyingPrice hasVariants variants');

  let totalValue = 0;
  let totalItems = 0;

  products.forEach(product => {
    if (product.hasVariants) {
      product.variants.forEach(variant => {
        if (variant.isActive) {
          totalValue += (variant.buyingPrice || 0) * variant.stock;
          totalItems += variant.stock;
        }
      });
    } else {
      totalValue += (product.buyingPrice || 0) * product.stock;
      totalItems += product.stock;
    }
  });

  return {
    totalProducts: products.length,
    totalItems,
    totalValue
  };
};

const StockTransaction = mongoose.model('StockTransaction', stockTransactionSchema);

module.exports = StockTransaction;
