const mongoose = require('mongoose');
const { immutableGuard } = require('../utils/immutableGuard.util');
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
  },
  // ── Combo lines ────────────────────────────────────────────────────────────
  //
  // A combo returns WHOLE: returning quantity R restores R × quantityPerCombo
  // of every component. This array is the return's own frozen copy of what
  // that meant — scaled from the sale item's snapshot at return time, so the
  // return document stands on its own the way the sale does.
  itemType: {
    type: String,
    enum: ['standard', 'combo'],
    default: 'standard'
  },
  comboComponents: {
    type: [{
      product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
      productName: { type: String, required: true },
      productCode: { type: String },
      variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
      variantSku: { type: String },
      variantAttributes: { type: mongoose.Schema.Types.Mixed },
      unit: { type: String },
      quantityPerCombo: { type: Number, required: true, min: 0.001 },
      // Across this RETURN (quantityPerCombo × returned combo quantity).
      totalQuantity: { type: Number, required: true, min: 0.001 },
      unitCost: { type: Number, default: 0, min: 0 },
    }],
    default: undefined
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
  /**
   * The MERCHANDISE refunded — line refunds net of the invoice discount, and
   * deliberately NOT including the VAT below.
   *
   * It is the figure `Sale.returnedAmount` accumulates, and `salesReturn
   * .service` compares that running total against the invoice's own
   * merchandise base to decide "is this sale fully returned?". Folding VAT in
   * here would make a fully-returned invoice look OVER-returned by the tax and
   * the comparison would never be like for like again — the exact bug that
   * comparison was rewritten to fix when it was measured against `total`.
   */
  totalAmount: {
    type: Number,
    required: true,
    min: [0, 'মোট ০ এর কম হতে পারবে না']
  },
  /**
   * The VAT coming back with the goods.
   *
   * Zero for every shop that does not charge VAT, and for every return raised
   * before the tax feature was finished — so nothing may read a zero here as
   * "not yet computed".
   *
   * ── Why it is refunded at all ────────────────────────────────────────────
   *
   * The comment that used to sit on the fully-returned check said a return
   * refunds neither delivery nor tax, "the courier was still paid, the tax was
   * still collected". The first half is right and stays. The second was
   * written when `Sale.tax` was always zero, so it was never once tested
   * against a real figure — and it is wrong twice over:
   *
   *   · the customer paid VAT on goods they no longer have, so keeping it is
   *     an overcharge;
   *   · the shop is holding VAT on a sale that did not happen, which it would
   *     otherwise have to remit.
   *
   * Delivery is genuinely different: the courier really did drive, and that
   * money really is spent.
   *
   * ── Why it is a separate field and not added to `totalAmount` ────────────
   *
   * See that field's note. `totalAmount` has one job — feeding the
   * fully-returned comparison — and it can only keep doing it if it stays a
   * merchandise figure. Every place that moves MONEY (the refund payment, the
   * account debit, the customer's ledger) uses the sum of the two, because the
   * customer was charged the sum of the two.
   */
  taxRefund: {
    type: Number,
    default: 0,
    min: [0, 'ভ্যাট ফেরত ০ এর কম হতে পারবে না']
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
  /**
   * Which PaymentAccount the refund was actually paid out of.
   *
   * Covers both moments this document can part with money: a same-day cash
   * refund (`paymentMethod`) and the later settlement of a store credit
   * (`settlementMethod`). One field for both because an account can only be
   * debited once per return — whichever of the two happened, this is where the
   * money came from.
   *
   * Null for an `adjustment` refund, which moves no cash at all, and for every
   * shop without `features.fundAccounts`.
   */
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PaymentAccount',
    default: null
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
/**
 * What the customer is actually owed: the goods plus the VAT charged on them.
 *
 * A derived virtual rather than a stored field, because it is exactly the sum
 * of two figures that are already stored — and a third stored copy is a third
 * thing to keep in step. `createReturn` computes the same sum before this
 * document exists; every reader afterwards uses this.
 *
 * Every MONEY path moves this figure. `totalAmount` on its own is the
 * merchandise, and exists to feed the fully-returned comparison — see its note.
 */
salesReturnSchema.virtual('refundTotal').get(function() {
  return (this.totalAmount || 0) + (this.taxRefund || 0);
});

salesReturnSchema.virtual('itemCount').get(function() {
  return this.items.reduce((sum, item) => sum + item.quantity, 0);
});

/**
 * Generate a return number, `RET<YYYYMMDD><seq>`.
 *
 * Backed by an atomic per-(shop, day) counter — see ReturnCounter.model.js for
 * the race, the timezone bug and the 9,999-per-day overflow this replaces, and
 * for how it seeds itself so a shop switching over mid-day continues its
 * sequence rather than restarting at 0001.
 *
 * The day is the BANGLADESH calendar day, matching the sale's invoice number.
 * It used to come off the server clock, which on a UTC host put every return
 * made before 6am Dhaka on the previous date.
 *
 * `padStart(4)` is a minimum width, not a cap: past 9,999 the number simply
 * grows to five digits and stays unique, where the old `slice(-4)` parse wrapped
 * back to 0001 and collided.
 */
salesReturnSchema.statics.generateReturnNo = async function(shopId) {
  // Required here rather than at module top to keep model load order free of
  // cycles — the same reason Purchase.generateInvoiceNo does it.
  const ReturnCounter = require('./ReturnCounter.model');
  const { getBangladeshTodayStr, getBangladeshDayRange } = require('../utils/bdTime.util');

  const dateStr = getBangladeshTodayStr();
  const prefix = `RET${dateStr.replace(/-/g, '')}`;

  // Only consulted the first time this shop returns anything on a given day.
  const { startOfDay, endOfDay } = getBangladeshDayRange(dateStr);
  const countExisting = () => this.countDocuments({
    shop: shopId,
    createdAt: { $gte: startOfDay, $lte: endOfDay },
  });

  const seq = await ReturnCounter.nextSeq(shopId, dateStr, countExisting);

  return `${prefix}${String(seq).padStart(4, '0')}`;
};

// Static: Get returns summary for date range
//
// `branchId` is not optional decoration — it is what keeps these totals over
// the same rows `getReturns` lists. Without it the cards summed every branch
// while the table below them showed one, so a branch with no returns of its own
// still displayed another branch's count and pending-refund amount.
//
// Cast, not passed through: `req.branchId` arrives as a STRING off the Redis
// auth payload, and `$match` compares raw BSON types rather than casting the
// way `find()` does. An uncast string here matches zero documents and silently
// falls back to the zeros below — the same failure `salesSummaryBranchCast`
// pins for sales.
// An absent bound means unbounded, exactly as it does for the list — see the
// note in the service. `Purchase.getSummary` reads the same way.
salesReturnSchema.statics.getReturnsSummary = async function(shopId, startDate, endDate, branchId = null) {
  const match = {
    shop: new mongoose.Types.ObjectId(shopId),
  };
  if (branchId) match.branch = new mongoose.Types.ObjectId(branchId);

  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = startDate;
    if (endDate) match.createdAt.$lte = endDate;
  }

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

/**
 * A return is a ledger row, not a draft.
 *
 * `createReturn` decrements `Sale.returnedProfit`, `Sale.returnedAdjustment`,
 * the customer's due and the product's stock — all in one transaction, none of
 * it re-derivable from this document alone. Deleting the row leaves every one of
 * those decrements standing with nothing left to explain them: the invoice
 * quietly reads a lower profit, the customer quietly owes less, and no screen
 * anywhere says a return ever happened.
 *
 * Its three peers on the same money paths — `Sale`, `Payment`, `Expense` — have
 * carried this guard from the start. This one was the odd one out.
 */
salesReturnSchema.plugin(immutableGuard, { modelName: 'SalesReturn' });

const SalesReturn = mongoose.model('SalesReturn', salesReturnSchema);

module.exports = SalesReturn;
