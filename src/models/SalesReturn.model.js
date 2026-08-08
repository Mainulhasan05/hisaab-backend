const mongoose = require('mongoose');
const { PAYMENT_METHODS } = require('../config/constants');

const returnItemSchema = new mongoose.Schema({
  saleItemId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
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
  // 0-exclusive rather than `min: 1` — fractional units (kg / litre / yard).
  // The flag-and-unit-aware refusal lives in `parseQuantity`; schema bounds are
  // the floor, not the policy. See AGENT_WORKFLOW.md I-6.
  quantity: {
    type: Number,
    required: [true, 'ফেরতের পরিমাণ দিন'],
    min: [0.001, 'পরিমাণ ০ এর বেশি হতে হবে']
  },
  unitPrice: {
    type: Number,
    required: true
  },
  buyingPrice: {
    type: Number,
    default: 0
  },
  discount: {
    type: Number,
    default: 0
  },
  total: {
    type: Number,
    required: true
  },
  profitLoss: {
    type: Number,
    default: 0
  },
  reason: {
    type: String,
    trim: true
  }
}, { _id: true });

const salesReturnSchema = new mongoose.Schema({
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
  returnNo: {
    type: String,
    required: [true, 'রিটার্ন নম্বর দিন']
  },
  sale: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale',
    required: [true, 'বিক্রয় নির্বাচন করুন']
  },
  invoiceNo: {
    type: String,
    required: true
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
    type: [returnItemSchema],
    required: [true, 'ফেরতের পণ্য যোগ করুন'],
    validate: [arr => arr.length > 0, 'অন্তত একটি পণ্য ফেরত দিতে হবে']
  },
  totalAmount: {
    type: Number,
    required: true,
    min: [0, 'মোট ০ এর কম হতে পারবে না']
  },
  profitReduction: {
    type: Number,
    default: 0
  },
  refundMethod: {
    type: String,
    enum: ['cash', 'adjustment', 'store_credit'],
    required: [true, 'ফেরতের পদ্ধতি নির্বাচন করুন']
  },
  /**
   * Has the shop actually parted with the money yet?
   *
   * ───────────────────────────────────────────────────────────────────────────
   * WHY THIS FIELD EXISTS
   * ───────────────────────────────────────────────────────────────────────────
   *
   * `refundMethod` says HOW the customer gets their money back. It did not say
   * WHETHER they have. For `cash` and `adjustment` that was fine — both move
   * money at the moment the return is recorded, and both leave a trail (a
   * `Payment` row, a customer-ledger delta).
   *
   * `store_credit` — the option the till labels "পরে দিবেন" — moved nothing.
   * The goods came back into stock, the sale's `returnedAmount` went up, and
   * the fact that the shop now OWED the customer money was recorded precisely
   * nowhere. There was no balance, no list, no reminder: a shopkeeper who took
   * a product back on Tuesday and meant to pay on Friday had nothing in the app
   * to tell them on Friday.
   *
   * So a store-credit return is born `pending` and stays there until someone
   * settles it, at which point the same `Payment` a cash refund would have
   * created is written. Cash and adjustment returns are `settled` on arrival,
   * which is why that is the default — every return that already exists is one
   * of those two and is correctly labelled without a migration.
   */
  refundStatus: {
    type: String,
    enum: ['settled', 'pending'],
    default: 'settled'
  },
  settledAt: {
    type: Date
  },
  settledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  // How the money was finally handed over — cash, bkash, etc. Separate from
  // `paymentMethod` above, which belongs to a same-day cash refund.
  settlementMethod: {
    type: String,
    enum: Object.values(PAYMENT_METHODS)
  },
  paymentMethod: {
    type: String,
    enum: Object.values(PAYMENT_METHODS)
  },
  // Required. A return moves stock back in and money back out, and six months
  // later "why" is the only thing that separates a damaged delivery from a
  // sizing problem from a staff member quietly reversing their own sales. It
  // was optional, and an optional free-text box on a modal is a box nobody
  // fills in.
  //
  // Not `required: true` on its own: an existing return written before this
  // rule has no reason, and a hard requirement would make every one of them
  // unsaveable on any future write. Enforced at the service layer, where new
  // returns go through and old ones do not. Same pattern as `Product.unit`'s
  // enum accepting the full registry.
  reason: {
    type: String,
    trim: true,
    maxlength: [500, 'কারণ ৫০০ অক্ষরের বেশি হতে পারবে না']
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

// Indexes
salesReturnSchema.index({ shop: 1, returnNo: 1 }, { unique: true });
salesReturnSchema.index({ shop: 1, sale: 1 });
salesReturnSchema.index({ shop: 1, customer: 1 });
salesReturnSchema.index({ shop: 1, branch: 1, createdAt: -1 }); // Main listing with branch
// "Which refunds do I still owe?" — the one query the pending status exists to
// answer, and the one a shopkeeper opens the returns page to ask. Sparse would
// not help here: `refundStatus` has a default, so every document carries it.
salesReturnSchema.index({ shop: 1, branch: 1, refundStatus: 1, createdAt: -1 });

// Virtual: Item count
salesReturnSchema.virtual('itemCount').get(function() {
  return this.items.reduce((sum, item) => sum + item.quantity, 0);
});

// Static: Generate return number RET-YYYYMMDD-0001
salesReturnSchema.statics.generateReturnNo = async function(shopId) {
  const today = new Date();
  const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const prefix = `RET${dateStr}`;

  const lastReturn = await this.findOne({
    shop: shopId,
    returnNo: { $regex: `^${prefix}` }
  }).sort({ returnNo: -1 });

  let sequence = 1;
  if (lastReturn) {
    const lastSeq = parseInt(lastReturn.returnNo.slice(-4));
    sequence = lastSeq + 1;
  }

  return `${prefix}${String(sequence).padStart(4, '0')}`;
};

// Static: Get returns summary for date range
salesReturnSchema.statics.getReturnsSummary = async function(shopId, startDate, endDate) {
  const match = {
    shop: new mongoose.Types.ObjectId(shopId),
    createdAt: { $gte: startDate, $lte: endDate }
  };

  const summary = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalReturns: { $sum: '$totalAmount' },
        totalProfitLoss: { $sum: '$profitReduction' },
        count: { $sum: 1 },
        // Money the shop took goods back for and has not handed over yet. The
        // whole point of `refundStatus` — without a running total there is
        // nothing to notice on a screen nobody scrolls.
        pendingRefundAmount: {
          $sum: { $cond: [{ $eq: ['$refundStatus', 'pending'] }, '$totalAmount', 0] }
        },
        pendingRefundCount: {
          $sum: { $cond: [{ $eq: ['$refundStatus', 'pending'] }, 1, 0] }
        }
      }
    }
  ]);

  return summary[0] || {
    totalReturns: 0,
    totalProfitLoss: 0,
    count: 0,
    pendingRefundAmount: 0,
    pendingRefundCount: 0,
  };
};

const SalesReturn = mongoose.model('SalesReturn', salesReturnSchema);

module.exports = SalesReturn;
