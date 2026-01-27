const mongoose = require('mongoose');
const { PAYMENT_METHODS, PAYMENT_TYPES } = require('../config/constants');

const paymentSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  sale: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale'
  },
  purchase: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Purchase'
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  },
  amount: {
    type: Number,
    required: [true, 'পরিমাণ দিন'],
    min: [0.01, 'পরিমাণ ০ এর বেশি হতে হবে']
  },
  method: {
    type: String,
    enum: {
      values: Object.values(PAYMENT_METHODS),
      message: 'অবৈধ পেমেন্ট পদ্ধতি'
    },
    default: PAYMENT_METHODS.CASH
  },
  type: {
    type: String,
    enum: {
      values: Object.values(PAYMENT_TYPES),
      message: 'অবৈধ পেমেন্ট ধরন'
    },
    default: PAYMENT_TYPES.SALE_PAYMENT
  },
  transactionId: {
    type: String,
    trim: true
  },
  reference: {
    type: String,
    trim: true
  },
  notes: {
    type: String,
    maxlength: [500, 'নোট ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  receivedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
paymentSchema.index({ shop: 1, createdAt: -1 });
paymentSchema.index({ shop: 1, customer: 1 });
paymentSchema.index({ shop: 1, sale: 1 });
paymentSchema.index({ shop: 1, purchase: 1 });
paymentSchema.index({ shop: 1, method: 1 });
paymentSchema.index({ shop: 1, type: 1 });
paymentSchema.index({ shop: 1, receivedBy: 1 });

// Virtual: Is refund
paymentSchema.virtual('isRefund').get(function() {
  return this.type === PAYMENT_TYPES.REFUND;
});

// Static: Get payments summary
paymentSchema.statics.getPaymentsSummary = async function(shopId, startDate, endDate) {
  const match = {
    shop: new mongoose.Types.ObjectId(shopId),
    createdAt: { $gte: startDate, $lte: endDate }
  };

  const summary = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$method',
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    }
  ]);

  // Also get by type
  const byType = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$type',
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    }
  ]);

  return {
    byMethod: summary,
    byType: byType,
    grandTotal: summary.reduce((sum, s) => sum + s.total, 0)
  };
};

// Static: Get customer payments
paymentSchema.statics.getCustomerPayments = function(shopId, customerId, options = {}) {
  const { page = 1, limit = 20 } = options;

  return this.find({
    shop: shopId,
    customer: customerId
  })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('sale', 'invoiceNo total')
    .populate('receivedBy', 'name');
};

// Static: Get daily collection
paymentSchema.statics.getDailyCollection = async function(shopId, date) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const collection = await this.aggregate([
    {
      $match: {
        shop: new mongoose.Types.ObjectId(shopId),
        createdAt: { $gte: startOfDay, $lte: endOfDay }
      }
    },
    {
      $group: {
        _id: '$method',
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    }
  ]);

  const total = collection.reduce((sum, c) => sum + c.total, 0);

  return {
    date: startOfDay,
    byMethod: collection,
    total
  };
};

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;
