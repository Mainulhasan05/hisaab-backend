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
/**
 * `owner` on both sides is the counterpart of `transfers`, for the movement
 * that has no other side inside the app.
 *
 * `AccountEntry` (FUND_ACCOUNT_PLAN §3.6) records the owner taking ৳30,000 out
 * of the drawer for household expenses, putting their own money in to cover a
 * delivery, or a loan moving either way. It debits `PaymentAccount.balance`
 * correctly — and until this bucket existed the register knew nothing about it,
 * so the drawer read ৳30,000 short at close, every evening, with nothing on
 * screen to explain it.
 *
 * That is the exact failure `AccountEntry` was written to prevent ("the cash box
 * is ৳30,000 short of what the app expects, every day, forever" — its own
 * docblock). Phase 3 taught this register about transfers and Phase 4 shipped
 * the entries without coming back for it.
 *
 * Zero for every shop that has never recorded an entry, which is every shop
 * without `features.fundAccounts` — so the register renders exactly as it
 * always has for them (I-1).
 *
 * ── Why not folded into `other` ──────────────────────────────────────────────
 *
 * `other` is a MANUAL box the shopkeeper types into, with a free-text note. If
 * owner movements landed there, the recalculation on every page load would
 * overwrite whatever they had typed — and a shopkeeper who recorded a draw both
 * ways would be counted twice. Derived figures and typed figures do not share a
 * field anywhere else in this model, and must not start here.
 */
const cashInSchema = new mongoose.Schema({
  sales: { type: Number, default: 0 },
  dueCollections: { type: Number, default: 0 },
  transfers: { type: Number, default: 0 },
  owner: { type: Number, default: 0 },
  other: { type: Number, default: 0 },
  otherNote: { type: String, trim: true, maxlength: 500 },
}, { _id: false });

const cashOutSchema = new mongoose.Schema({
  expenses: { type: Number, default: 0 },
  purchases: { type: Number, default: 0 },
  refunds: { type: Number, default: 0 },
  transfers: { type: Number, default: 0 },
  owner: { type: Number, default: 0 },
  other: { type: Number, default: 0 },
  otherNote: { type: String, trim: true, maxlength: 500 },
}, { _id: false });

/**
 * The two sums, stated once.
 *
 * They were written out three times — twice in virtuals, once in the pre-save
 * hook — and adding `owner` above would have meant editing all three. A bucket
 * added to the schema and missed in the hook is a bucket that shows on screen
 * and never reaches `expectedClosing`: the drawer would read wrong in exactly
 * the way this change exists to fix, and no test that checks the rendered rows
 * would catch it.
 */
const CASH_IN_KEYS = ['sales', 'dueCollections', 'transfers', 'owner', 'other'];
const CASH_OUT_KEYS = ['expenses', 'purchases', 'refunds', 'transfers', 'owner', 'other'];

const sumKeys = (bucket, keys) =>
  keys.reduce((total, key) => total + (bucket?.[key] || 0), 0);

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
  return sumKeys(this.cashIn, CASH_IN_KEYS);
});

cashRegisterSchema.virtual('totalCashOut').get(function () {
  return sumKeys(this.cashOut, CASH_OUT_KEYS);
});

// Pre-save: auto-calculate expectedClosing and difference
cashRegisterSchema.pre('save', function (next) {
  const totalIn = sumKeys(this.cashIn, CASH_IN_KEYS);
  const totalOut = sumKeys(this.cashOut, CASH_OUT_KEYS);

  this.expectedClosing = this.openingBalance + totalIn - totalOut;

  if (this.actualClosing != null) {
    this.difference = this.actualClosing - this.expectedClosing;
  }

  next();
});

const CashRegister = mongoose.model('CashRegister', cashRegisterSchema);

module.exports = CashRegister;
// Exported so the service's flow mapper and its tests name the same buckets.
module.exports.CASH_IN_KEYS = CASH_IN_KEYS;
module.exports.CASH_OUT_KEYS = CASH_OUT_KEYS;
