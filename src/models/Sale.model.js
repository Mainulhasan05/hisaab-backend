const mongoose = require('mongoose');
const { PAYMENT_METHODS, SALE_STATUS } = require('../config/constants');
const { immutableGuard } = require('../utils/immutableGuard.util');

const saleItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
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
  quantity: {
    type: Number,
    required: [true, 'পরিমাণ দিন'],
    min: [1, 'পরিমাণ কমপক্ষে ১ হতে হবে']
  },
  unitPrice: {
    type: Number,
    required: [true, 'একক মূল্য দিন'],
    min: [0, 'মূল্য ০ এর কম হতে পারবে না']
  },
  buyingPrice: {
    type: Number,
    min: [0, 'ক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  discount: {
    type: Number,
    default: 0,
    min: [0, 'ছাড় ০ এর কম হতে পারবে না']
  },
  total: {
    type: Number,
    required: true
  }
}, { _id: true });

const saleSchema = new mongoose.Schema({
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
  invoiceNo: {
    type: String,
    required: [true, 'ইনভয়েস নম্বর দিন']
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  },
  customerName: {
    type: String,
    default: 'Walk-in Customer'
  },
  customerPhone: {
    type: String
  },
  items: {
    type: [saleItemSchema],
    required: [true, 'পণ্য যোগ করুন'],
    validate: [arr => arr.length > 0, 'অন্তত একটি পণ্য যোগ করুন']
  },
  subtotal: {
    type: Number,
    required: true,
    min: [0, 'সাবটোটাল ০ এর কম হতে পারবে না']
  },
  discount: {
    type: Number,
    default: 0,
    min: [0, 'ছাড় ০ এর কম হতে পারবে না']
  },
  discountType: {
    type: String,
    enum: ['fixed', 'percentage'],
    default: 'fixed'
  },
  tax: {
    type: Number,
    default: 0,
    min: [0, 'ট্যাক্স ০ এর কম হতে পারবে না']
  },
  total: {
    type: Number,
    required: true,
    min: [0, 'মোট ০ এর কম হতে পারবে না']
  },
  paid: {
    type: Number,
    default: 0,
    min: [0, 'পরিশোধিত ০ এর কম হতে পারবে না']
  },
  due: {
    type: Number,
    default: 0,
    min: [0, 'বাকি ০ এর কম হতে পারবে না']
  },
  profit: {
    type: Number,
    default: 0
  },
  paymentMethod: {
    type: String,
    enum: Object.values(PAYMENT_METHODS),
    default: PAYMENT_METHODS.CASH
  },
  // Split payment support: array of payment method + amount pairs
  payments: [{
    method: {
      type: String,
      enum: Object.values(PAYMENT_METHODS),
      required: true
    },
    amount: {
      type: Number,
      required: true,
      min: [0, 'পেমেন্ট ০ এর কম হতে পারবে না']
    },
    reference: {
      type: String // MFS transaction ID, card auth code, etc.
    }
  }],
  status: {
    type: String,
    enum: Object.values(SALE_STATUS),
    default: SALE_STATUS.COMPLETED
  },
  notes: {
    type: String,
    maxlength: [500, 'নোট ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  cancelledAt: {
    type: Date
  },
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  cancelReason: {
    type: String
  },
  // Return tracking
  returnedAmount: {
    type: Number,
    default: 0,
    min: [0, 'ফেরত ০ এর কম হতে পারবে না']
  },
  // Online sale tracking & logistics
  isOnline: {
    type: Boolean,
    default: false
  },
  channel: {
    type: String,
    enum: ['pos', 'facebook', 'instagram', 'whatsapp', 'website', 'other'],
    default: 'pos'
  },
  deliveryCharge: {
    type: Number,
    default: 0,
    min: [0, 'ডেলিভারি চার্জ ০ এর কম হতে পারবে না']
  },
  advancePaid: {
    type: Number,
    default: 0,
    min: [0, 'এডভান্স পরিশোধ ০ এর কম হতে পারবে না']
  },
  courierName: {
    type: String
  },
  shippingAddress: {
    type: String
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
saleSchema.index({ shop: 1, invoiceNo: 1 }, { unique: true }); // Invoice lookup
saleSchema.index({ shop: 1, customer: 1, createdAt: -1 }); // Customer purchase history
saleSchema.index({ shop: 1, branch: 1, createdAt: -1 }); // Main listing with branch filter
saleSchema.index({ shop: 1, branch: 1, status: 1, createdAt: -1 }); // Due/pending sales with branch
saleSchema.index({ shop: 1, isOnline: 1, createdAt: -1 }); // Online sales filter index
saleSchema.index({ shop: 1, createdAt: -1 }); // Single-branch listing, recent sales, invoice-number day count
saleSchema.index({ shop: 1, due: 1 }); // Dues listing/sort
saleSchema.index({ shop: 1, total: -1 }); // Sort by amount (whitelisted sort field)
saleSchema.index({ shop: 1, createdBy: 1, createdAt: -1 }); // Staff attribution filter + staff sales report

// Calculate totals before saving
saleSchema.pre('save', function(next) {
  // Calculate subtotal from items
  this.subtotal = this.items.reduce((sum, item) => sum + item.total, 0);

  // Calculate total
  let discountAmount = this.discount;
  if (this.discountType === 'percentage') {
    discountAmount = (this.subtotal * this.discount) / 100;
  }

  const delivery = this.deliveryCharge || 0;
  this.total = Math.min(Math.max(0, this.subtotal - discountAmount + this.tax + delivery), 1e11);
  if (!Number.isFinite(this.paid) || this.paid > this.total) {
    this.paid = Math.min(Math.max(0, this.paid || 0), this.total);
  }
  this.due = Math.max(0, this.total - this.paid);

  // Calculate profit
  this.profit = this.items.reduce((sum, item) => {
    const itemProfit = (item.unitPrice - (item.buyingPrice || 0)) * item.quantity - item.discount;
    return sum + itemProfit;
  }, 0) - discountAmount;

  // Set payment status unless the sale has been explicitly cancelled.
  if (this.status !== SALE_STATUS.CANCELLED) {
    if (this.due === 0) {
      this.status = SALE_STATUS.COMPLETED;
    } else if (this.paid > 0) {
      this.status = SALE_STATUS.PARTIAL;
    } else {
      this.status = SALE_STATUS.UNPAID;
    }
  }

  next();
});

// Virtual: Item count
saleSchema.virtual('itemCount').get(function() {
  return this.items.reduce((sum, item) => sum + item.quantity, 0);
});

// Virtual: Is paid
saleSchema.virtual('isPaid').get(function() {
  return this.due === 0;
});

// Virtual: Is cancelled
saleSchema.virtual('isCancelled').get(function() {
  return this.status === SALE_STATUS.CANCELLED;
});

// Virtual: Has returns
saleSchema.virtual('hasReturns').get(function() {
  return (this.returnedAmount || 0) > 0;
});

// Virtual: Net total (after returns)
saleSchema.virtual('netTotal').get(function() {
  return this.total - (this.returnedAmount || 0);
});

// Static: Generate invoice number
saleSchema.statics.generateInvoiceNo = async function(shopId, prefix = 'INV') {
  const today = new Date();
  const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

  const lastSale = await this.findOne({
    shop: shopId,
    invoiceNo: { $regex: `^${prefix}${dateStr}` }
  }).sort({ invoiceNo: -1 });

  let sequence = 1;
  if (lastSale) {
    const lastSequence = parseInt(lastSale.invoiceNo.slice(-4));
    sequence = lastSequence + 1;
  }

  return `${prefix}${dateStr}${String(sequence).padStart(4, '0')}`;
};

// Static: Get sales summary
saleSchema.statics.getSalesSummary = async function(shopId, startDate, endDate) {
  const match = {
    shop: new mongoose.Types.ObjectId(shopId),
    status: { $ne: SALE_STATUS.CANCELLED },
    createdAt: { $gte: startDate, $lte: endDate }
  };

  const summary = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        totalPaid: { $sum: '$paid' },
        totalDue: { $sum: '$due' },
        totalProfit: { $sum: '$profit' },
        count: { $sum: 1 }
      }
    }
  ]);

  return summary[0] || {
    totalSales: 0,
    totalPaid: 0,
    totalDue: 0,
    totalProfit: 0,
    count: 0
  };
};

// Method: Add payment
saleSchema.methods.addPayment = async function(amount) {
  this.paid += amount;
  this.due = Math.max(0, this.total - this.paid);

  if (this.due === 0) {
    this.status = SALE_STATUS.COMPLETED;
  } else if (this.paid > 0) {
    this.status = SALE_STATUS.PARTIAL;
  }

  await this.save();
};

// Method: Cancel sale
saleSchema.methods.cancelSale = async function(userId, reason) {
  this.status = SALE_STATUS.CANCELLED;
  this.cancelledAt = new Date();
  this.cancelledBy = userId;
  this.cancelReason = reason;
  await this.save();
};

// Apply immutable ledger guard — prevents hard deletion of sale records
saleSchema.plugin(immutableGuard, { modelName: 'Sale' });

const Sale = mongoose.model('Sale', saleSchema);

module.exports = Sale;
