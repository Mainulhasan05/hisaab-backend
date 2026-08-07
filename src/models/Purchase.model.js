const mongoose = require('mongoose');
const { immutableGuard } = require('../utils/immutableGuard.util');

const purchaseItemSchema = new mongoose.Schema({
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
  variantLabel: {
    type: String
  },
  quantity: {
    type: Number,
    required: [true, 'পরিমাণ দিন'],
    min: [1, 'পরিমাণ কমপক্ষে ১ হতে হবে']
  },
  unitPrice: {
    type: Number,
    required: [true, 'একক দাম দিন'],
    min: [0, 'দাম ০ এর কম হতে পারবে না']
  },
  total: {
    type: Number,
    required: true
  }
}, { _id: true });

const purchaseSchema = new mongoose.Schema({
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
    trim: true
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier'
  },
  supplierName: {
    type: String,
    trim: true,
    default: 'সরাসরি কেনা'
  },
  items: {
    type: [purchaseItemSchema],
    validate: {
      validator: function(v) {
        return v && v.length > 0;
      },
      message: 'কমপক্ষে একটি পণ্য যোগ করুন'
    }
  },
  totalAmount: {
    type: Number,
    required: true,
    min: [0, 'মোট পরিমাণ ০ এর কম হতে পারবে না']
  },
  paid: {
    type: Number,
    default: 0,
    min: [0, 'পরিশোধ ০ এর কম হতে পারবে না']
  },
  due: {
    type: Number,
    default: 0,
    min: [0, 'বাকি ০ এর কম হতে পারবে না']
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'bkash', 'nagad', 'card', 'bank', 'credit'],
    default: 'cash'
  },
  date: {
    type: Date,
    default: Date.now
  },
  notes: {
    type: String,
    maxlength: [500, 'নোট ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  status: {
    type: String,
    enum: ['completed', 'partial', 'unpaid', 'cancelled'],
    default: 'completed'
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
purchaseSchema.index({ shop: 1, branch: 1, date: -1 }); // Date-based listing with branch
purchaseSchema.index({ shop: 1, supplier: 1, date: -1 }); // Supplier purchase history
purchaseSchema.index({ shop: 1, invoiceNo: 1 }, { unique: true, sparse: true }); // Invoice lookup
purchaseSchema.index({ shop: 1, status: 1, date: -1 }); // Status-filtered listing
purchaseSchema.index({ shop: 1, createdAt: -1 }); // Invoice-number day count, unbranched listing

// Pre-save: calculate due and status with numeric boundary checks
purchaseSchema.pre('save', function(next) {
  if (!Number.isFinite(this.totalAmount) || this.totalAmount > 1e11) {
    this.totalAmount = Math.min(Math.max(0, this.totalAmount || 0), 1e11);
  }
  if (!Number.isFinite(this.paid) || this.paid > this.totalAmount) {
    this.paid = Math.min(Math.max(0, this.paid || 0), this.totalAmount);
  }
  this.due = Math.max(0, this.totalAmount - this.paid);
  if (this.due === 0) {
    this.status = 'completed';
  } else if (this.paid > 0) {
    this.status = 'partial';
  } else {
    this.status = 'unpaid';
  }
  next();
});

// Static: Generate invoice number
purchaseSchema.statics.generateInvoiceNo = async function(shopId) {
  const today = new Date();
  const prefix = `PUR${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}`;
  const count = await this.countDocuments({
    shop: shopId,
    createdAt: {
      $gte: new Date(today.getFullYear(), today.getMonth(), 1),
      $lt: new Date(today.getFullYear(), today.getMonth() + 1, 1)
    }
  });
  return `${prefix}${String(count + 1).padStart(4, '0')}`;
};

// Static: Get purchase summary
purchaseSchema.statics.getSummary = async function(shopId, startDate, endDate, branchId = null) {
  const match = {
    shop: new mongoose.Types.ObjectId(shopId),
    status: { $ne: 'cancelled' }
  };
  if (branchId) match.branch = new mongoose.Types.ObjectId(branchId);

  if (startDate && endDate) {
    match.date = { $gte: startDate, $lte: endDate };
  }

  const result = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalAmount: { $sum: '$totalAmount' },
        totalPaid: { $sum: '$paid' },
        totalDue: { $sum: '$due' },
        count: { $sum: 1 },
        totalItems: { $sum: { $size: '$items' } }
      }
    }
  ]);

  return result[0] || {
    totalAmount: 0,
    totalPaid: 0,
    totalDue: 0,
    count: 0,
    totalItems: 0
  };
};

// Apply immutable ledger guard — prevents hard deletion of purchase records
purchaseSchema.plugin(immutableGuard, { modelName: 'Purchase' });

const Purchase = mongoose.model('Purchase', purchaseSchema);

module.exports = Purchase;
