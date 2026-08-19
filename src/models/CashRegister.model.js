const mongoose = require('mongoose');

/**
 * `transfers` on both sides is what makes banking the day's takings stop
 * reading as a theft-sized shortfall.
 *
 * Before fund accounts there was no entry for moving money out of the drawer
 * and into a bank, so a shopkeeper who banked ৳60,000 of ৳80,000 saw the
 * register insist ৳80,000 should be in a box holding ৳20,000 — every evening,
 * with nothing on screen to explain it. See FUND_ACCOUNT_PLAN.md UC-1.
 *
 * Zero for every shop that has never recorded a transfer, which is every shop
 * without `features.fundAccounts` — so the register renders exactly as it
 * always has for them (I-1).
 */
const cashInSchema = new mongoose.Schema({
  sales: { type: Number, default: 0 },
  dueCollections: { type: Number, default: 0 },
  transfers: { type: Number, default: 0 },
  other: { type: Number, default: 0 },
  otherNote: { type: String, trim: true, maxlength: 500 },
}, { _id: false });

const cashOutSchema = new mongoose.Schema({
  expenses: { type: Number, default: 0 },
  purchases: { type: Number, default: 0 },
  refunds: { type: Number, default: 0 },
  transfers: { type: Number, default: 0 },
  other: { type: Number, default: 0 },
  otherNote: { type: String, trim: true, maxlength: 500 },
}, { _id: false });

const cashRegisterSchema = new mongoose.Schema({
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
  date: {
    type: Date,
    required: [true, 'তারিখ দিন']
  },
  openingBalance: {
    type: Number,
    default: 0,
    min: [0, 'শুরুর ব্যালান্স ০ এর কম হতে পারবে না']
  },
  cashIn: {
    type: cashInSchema,
    default: () => ({})
  },
  cashOut: {
    type: cashOutSchema,
    default: () => ({})
  },
  expectedClosing: {
    type: Number,
    default: 0
  },
  actualClosing: {
    type: Number
  },
  difference: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['open', 'closed'],
    default: 'open'
  },
  closedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  closedAt: {
    type: Date
  },
  notes: {
    type: String,
    trim: true,
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
cashRegisterSchema.index({ shop: 1, branch: 1, date: -1 }, { unique: true });
cashRegisterSchema.index({ shop: 1, branch: 1, status: 1 });

// Virtuals
cashRegisterSchema.virtual('totalCashIn').get(function () {
  return (this.cashIn?.sales || 0) +
    (this.cashIn?.dueCollections || 0) +
    (this.cashIn?.transfers || 0) +
    (this.cashIn?.other || 0);
});

cashRegisterSchema.virtual('totalCashOut').get(function () {
  return (this.cashOut?.expenses || 0) +
    (this.cashOut?.purchases || 0) +
    (this.cashOut?.refunds || 0) +
    (this.cashOut?.transfers || 0) +
    (this.cashOut?.other || 0);
});

// Pre-save: auto-calculate expectedClosing and difference
cashRegisterSchema.pre('save', function (next) {
  const totalIn = (this.cashIn?.sales || 0) +
    (this.cashIn?.dueCollections || 0) +
    (this.cashIn?.transfers || 0) +
    (this.cashIn?.other || 0);
  const totalOut = (this.cashOut?.expenses || 0) +
    (this.cashOut?.purchases || 0) +
    (this.cashOut?.refunds || 0) +
    (this.cashOut?.transfers || 0) +
    (this.cashOut?.other || 0);

  this.expectedClosing = this.openingBalance + totalIn - totalOut;

  if (this.actualClosing != null) {
    this.difference = this.actualClosing - this.expectedClosing;
  }

  next();
});

const CashRegister = mongoose.model('CashRegister', cashRegisterSchema);

module.exports = CashRegister;
