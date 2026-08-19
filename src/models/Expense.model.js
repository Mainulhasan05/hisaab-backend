const mongoose = require('mongoose');
const { PAYMENT_METHODS } = require('../config/constants');
const { immutableGuard } = require('../utils/immutableGuard.util');

const expenseSchema = new mongoose.Schema({
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
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ExpenseCategory',
    required: [true, 'খরচের ক্যাটাগরি দিন']
  },
  categoryName: {
    type: String,
    required: [true, 'ক্যাটাগরির নাম দিন']
  },
  amount: {
    type: Number,
    required: [true, 'টাকার পরিমাণ দিন'],
    min: [0.01, 'টাকার পরিমাণ ০ এর বেশি হতে হবে']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'বিবরণ ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  date: {
    type: Date,
    default: Date.now,
    required: [true, 'তারিখ দিন']
  },
  paymentMethod: {
    type: String,
    enum: Object.values(PAYMENT_METHODS),
    default: PAYMENT_METHODS.CASH
  },
  /**
   * Which PaymentAccount the money left. `paymentMethod` above says how; this
   * says from where. Null for a shop without `features.fundAccounts`, and for
   * every expense written before this field existed.
   *
   * A VOIDED expense returns the money to this account — `voidExpense` applies
   * the opposite delta. That is why the void path is not merely a flag flip
   * once accounts are on.
   */
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PaymentAccount',
    default: null
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // ── Void ───────────────────────────────────────────────────────────────────
  //
  // An expense is a ledger row: `immutableGuard` below refuses to delete it, so
  // a mistyped ৳50,000 has to be retractable some other way or the shopkeeper is
  // stuck with a wrong profit figure forever. Voiding retracts the AMOUNT while
  // keeping the ROW — which is the difference between "this never counted" and
  // "this never happened". The first is true and auditable; the second is a
  // month-end total that changed with nothing to explain why.
  isVoided: {
    type: Boolean,
    default: false
  },
  voidedAt: Date,
  voidedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  voidReason: {
    type: String,
    trim: true,
    maxlength: [200, 'কারণ ২০০ অক্ষরের বেশি হতে পারবে না']
  }
}, {
  timestamps: true
});

/**
 * Voided expenses are invisible by DEFAULT, everywhere, automatically.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SCHEMA HOOK AND NOT A FILTER ON EACH QUERY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Twelve places read or sum expenses: the list and its count, `getTotal` and
 * `getSummaryByCategory` below, the cash register's cash-expense total, seven
 * aggregations in report.service (dashboard, profit & loss, daily summary,
 * date-wise, monthly), and the platform counter in admin.service.
 *
 * Adding `isVoided: { $ne: true }` to twelve call sites means the thirteenth —
 * whoever writes the next report — silently sums voided rows back in. The
 * failure is a profit figure that is wrong by exactly the amount someone
 * retracted, on one screen and not the others, with nothing on screen to hint
 * at it. Nobody reconciles two dashboards against each other; they just trust
 * the number.
 *
 * So the filter lives here, applied to every find and every aggregate, and
 * being wrong requires opting OUT explicitly rather than remembering to opt in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OPTING OUT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Expense.find(q).setOptions({ includeVoided: true })
 *   Expense.aggregate(p).option({ includeVoided: true })
 *
 * Exactly two callers should: the expense list when the shopkeeper ticks "বাতিল
 * করা দেখুন", and `voidExpense` itself, which has to load a row it is about to
 * void and would otherwise be unable to find one twice.
 *
 * `$ne: true` rather than `false` — every expense written before this field
 * existed has no `isVoided` at all, and `{ isVoided: false }` would exclude
 * every one of them from every total.
 */
const NOT_VOIDED = { isVoided: { $ne: true } };

expenseSchema.pre(/^(find|count|distinct)/, function (next) {
  if (!this.getOptions?.().includeVoided) this.where(NOT_VOIDED);
  next();
});

expenseSchema.pre('aggregate', function (next) {
  if (!this.options?.includeVoided) this.pipeline().unshift({ $match: NOT_VOIDED });
  next();
});

// Indexes - Optimized for scalability
expenseSchema.index({ shop: 1, branch: 1, date: -1 }); // Date-based listing with branch
expenseSchema.index({ shop: 1, branch: 1, category: 1, date: -1 }); // Category-wise expenses with branch
expenseSchema.index({ shop: 1, date: -1 }); // All-branch date-range reports (P&L, daily summary)

// Static: Get summary by category for a date range
expenseSchema.statics.getSummaryByCategory = async function(shopId, startDate, endDate, branchId = null) {
  const match = {
    shop: new mongoose.Types.ObjectId(shopId),
    date: { $gte: startDate, $lte: endDate }
  };
  if (branchId) match.branch = new mongoose.Types.ObjectId(branchId);

  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$category',
        categoryName: { $first: '$categoryName' },
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    },
    { $sort: { total: -1 } }
  ]);
};

// Static: Get total expenses for a date range
expenseSchema.statics.getTotal = async function(shopId, startDate, endDate, branchId = null) {
  const match = {
    shop: new mongoose.Types.ObjectId(shopId),
    date: { $gte: startDate, $lte: endDate }
  };
  if (branchId) match.branch = new mongoose.Types.ObjectId(branchId);

  const result = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    }
  ]);

  return result[0] || { total: 0, count: 0 };
};

// Apply immutable ledger guard
expenseSchema.plugin(immutableGuard, { modelName: 'Expense' });

const Expense = mongoose.model('Expense', expenseSchema);

module.exports = Expense;
