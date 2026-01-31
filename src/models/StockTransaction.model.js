const mongoose = require('mongoose');
const { STOCK_TRANSACTION_TYPES } = require('../config/constants');

const stockTransactionSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
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
stockTransactionSchema.index({ shop: 1, product: 1, createdAt: -1 }); // Product stock history
stockTransactionSchema.index({ shop: 1, createdAt: -1 }); // Main listing

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
    isActive: true
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
