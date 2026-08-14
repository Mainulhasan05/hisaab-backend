const mongoose = require('mongoose');
const { PAYMENT_METHODS, PAYMENT_TYPES } = require('../config/constants');
const { immutableGuard } = require('../utils/immutableGuard.util');
const { getBangladeshDayRange, toBangladeshDateStr } = require('../utils/bdTime.util');

const paymentSchema = new mongoose.Schema({
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
  /**
   * Was this row written by `createSale` as the checkout leg?
   *
   * ── Why a flag and not an inference ────────────────────────────────────────
   *
   * Checkout money is recorded TWICE by design: once inside `Sale.payments[]`
   * (which is what makes split payments legible) and once as a `Payment` row
   * (which is what makes the invoice's payment history complete). Both are
   * wanted. What was missing was any way to tell the two apart afterwards —
   * `type` is `sale_payment` either way and `sale` is set either way.
   *
   * `cashRegister._calculateCashFlows` reads both: it sums the cash legs of
   * every sale, AND sums every cash `Payment{type:'sale_payment'}`. So every
   * cash checkout was counted twice and the till's expected closing ran over by
   * the day's takings — the drawer appeared short by exactly the money in it.
   * The comment there asserted the two streams were disjoint; they never were.
   *
   * With the flag they are: `true` means "already counted in `Sale.payments[]`",
   * `false` means money that arrived later (`recordPayment`, `collectDuePayment`)
   * and is counted only here.
   *
   * Rows written before this field existed read `false` and would be
   * double-counted, so `scripts/backfill-payment-at-checkout.js` stamps them.
   * Only OPEN registers recalculate, so in practice that is same-day rows —
   * closed registers are settled records and are deliberately left alone.
   */
  atCheckout: {
    type: Boolean,
    default: false
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

// Indexes - Optimized for scalability
paymentSchema.index({ shop: 1, branch: 1, createdAt: -1 }); // Main listing with branch
paymentSchema.index({ shop: 1, customer: 1, createdAt: -1 }); // Customer payment history
paymentSchema.index({ shop: 1, sale: 1 }); // Sale payments lookup
paymentSchema.index({ shop: 1, purchase: 1 }, { sparse: true }); // Purchase payments
paymentSchema.index({ type: 1, createdAt: -1 }); // Admin subscription-payment queries (no shop predicate)

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
  // The Bangladesh calendar day containing `date`. Server-local `setHours`
  // made "daily collection" a UTC day, six hours out of step with every other
  // daily figure in the app.
  const { startOfDay, endOfDay } = getBangladeshDayRange(toBangladeshDateStr(date));

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

// Apply immutable ledger guard
paymentSchema.plugin(immutableGuard, { modelName: 'Payment' });

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;
