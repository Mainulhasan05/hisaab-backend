const mongoose = require('mongoose');

/**
 * Money that is not trade.
 *
 * ── The gap this fills ──────────────────────────────────────────────────────
 *
 * A shop owner takes ৳30,000 out for household expenses. Before this there were
 * two places to put it and both were wrong:
 *
 *   · as an EXPENSE — the month's profit drops by ৳30,000 the business never
 *     spent, and every margin figure the owner reads is understated;
 *   · nowhere — the cash box is ৳30,000 short of what the app expects, every
 *     day, forever.
 *
 * The same is true in reverse when they put their own money IN to cover a bulk
 * purchase, and again for a loan taken or repaid. All of it moves the balance
 * and **none of it touches profit**. That distinction is the entire reason this
 * is a separate collection rather than an `ExpenseCategory` called "মালিকের
 * খরচ" — a category would put the money in the P&L, which is the bug.
 *
 * ── Direction is derived from `type`, except for `adjustment` ───────────────
 *
 * A withdrawal is always out; a deposit is always in. Storing both and letting
 * them disagree buys nothing, so `directionFor` below is the single statement of
 * the rule and the service applies it. `adjustment` is the one type that can go
 * either way, because a correction can be in either direction — and it is the
 * only one that has to say so explicitly.
 *
 * ── Not an audit hole ──────────────────────────────────────────────────────
 *
 * `adjustment` is deliberately owner-only at the service layer. It is the one
 * entry that can move a balance without a real-world event behind it, so it is
 * the one a staff member must never be able to write — otherwise it becomes the
 * way a till discrepancy gets quietly papered over.
 */
const accountEntrySchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন'],
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null,
  },
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PaymentAccount',
    required: [true, 'অ্যাকাউন্ট নির্বাচন করুন'],
  },
  type: {
    type: String,
    enum: {
      values: ['owner_deposit', 'owner_withdrawal', 'loan_in', 'loan_out', 'adjustment'],
      message: 'অবৈধ ধরন',
    },
    required: [true, 'ধরন নির্বাচন করুন'],
  },
  direction: {
    type: String,
    enum: ['in', 'out'],
    required: true,
  },
  amount: {
    type: Number,
    required: [true, 'পরিমাণ দিন'],
    min: [0.01, 'পরিমাণ ০ এর বেশি হতে হবে'],
  },
  /**
   * When the money moved, not when it was typed — the same rule
   * `Payment.paidAt`, `Expense.date` and `AccountTransfer.date` follow. An
   * owner who drew cash on Thursday and records it on Sunday needs Thursday's
   * drawer to know about it.
   */
  date: {
    type: Date,
    default: Date.now,
    required: true,
  },
  /**
   * Required for `adjustment` (enforced in the service), optional otherwise.
   *
   * An adjustment with no reason is a number nobody can account for six months
   * later, which is exactly what this collection exists to prevent. The same
   * argument `SalesReturn.reason` makes about optional free-text boxes.
   */
  notes: {
    type: String,
    trim: true,
    maxlength: [500, 'নোট ৫০০ অক্ষরের বেশি হতে পারবে না'],
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

accountEntrySchema.index({ shop: 1, branch: 1, date: -1 });
accountEntrySchema.index({ shop: 1, account: 1, date: -1 });

/** One statement of "which way does this type move money". */
accountEntrySchema.statics.directionFor = function (type) {
  switch (type) {
    case 'owner_deposit':
    case 'loan_in':
      return 'in';
    case 'owner_withdrawal':
    case 'loan_out':
      return 'out';
    default:
      // `adjustment` — the caller must say, because a correction can go either
      // way and guessing would silently double the error it was meant to fix.
      return null;
  }
};

/** The signed delta this entry applies to its account. */
accountEntrySchema.virtual('signedAmount').get(function () {
  return this.direction === 'out' ? -(this.amount || 0) : (this.amount || 0);
});

const AccountEntry = mongoose.model('AccountEntry', accountEntrySchema);

module.exports = AccountEntry;
