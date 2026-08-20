const mongoose = require('mongoose');
const { immutableGuard } = require('../utils/immutableGuard.util');
const AccountTransferCounter = require('./AccountTransferCounter.model');

/**
 * Money changing places — the entry this app has never had.
 *
 * ── The thing it fixes ─────────────────────────────────────────────────────
 *
 * Banking the day's takings and cashing out bKash are the two most common
 * things a shop does with its money, and neither was recordable. The shopkeeper
 * had two options and both were wrong:
 *
 *   · record it as an EXPENSE — the money is gone from the drawer, and the P&L
 *     now says the shop spent ৳60,000 it did not spend;
 *   · record nothing — the cash register reports a ৳60,000 shortfall every
 *     evening, which reads as theft.
 *
 * A transfer is neither income nor expense. Nothing was earned and nothing was
 * spent; the same money is simply somewhere else. The only thing that touches
 * profit is the CHARGE, and that is real.
 *
 * ── Two amounts, not `amount` + `charge` ───────────────────────────────────
 *
 * The shopkeeper knows what left and what arrived. They do not know — and must
 * not be asked to work out — which side the fee came off, which differs between
 * a bKash cash-out (deducted from the sender) and some bank transfers (deducted
 * from the recipient). One shape covers every case:
 *
 *   ৳60,000 cash banked           out 60,000   in 60,000   charge 0
 *   bKash cash-out ৳50,000        out 50,925   in 50,000   charge 925
 *   Bank → bKash, receiver pays   out 20,000   in 19,950   charge 50
 *
 * `charge` is therefore a VIRTUAL, derived, never stored — the same rule D-1
 * applies to the grand total. Two copies of one number is how they disagree.
 *
 * ── Immutable ──────────────────────────────────────────────────────────────
 *
 * There is no edit and no delete. A transfer has already moved two balances;
 * "correcting" one would have to unwind both, and a reversing transfer is the
 * honest way to do that — it leaves both the mistake and the correction on the
 * record, which is what a ledger is for.
 */
const accountTransferSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন'],
  },
  /**
   * Where the transfer was initiated.
   *
   * NOT the account's branch — a shared bank account has none. This is the
   * branch whose till the cash leg belongs to, and it is what
   * `cashRegister.service` matches on so banking the takings reaches the right
   * drawer. `null` for a single-branch shop, as everywhere else (I-1).
   */
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null,
  },
  transferNo: {
    type: String,
    required: true,
  },
  fromAccount: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PaymentAccount',
    required: [true, 'কোন অ্যাকাউন্ট থেকে, নির্বাচন করুন'],
  },
  toAccount: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PaymentAccount',
    required: [true, 'কোন অ্যাকাউন্টে, নির্বাচন করুন'],
  },
  /** What LEFT the from-account. */
  amountOut: {
    type: Number,
    required: [true, 'কত টাকা পাঠালেন দিন'],
    min: [0.01, 'পরিমাণ ০ এর বেশি হতে হবে'],
  },
  /** What ARRIVED in the to-account. Never more than `amountOut`. */
  amountIn: {
    type: Number,
    required: [true, 'কত টাকা পৌঁছাল দিন'],
    min: [0.01, 'পরিমাণ ০ এর বেশি হতে হবে'],
  },
  /**
   * When the money moved, not when it was typed.
   *
   * Same reason `Payment.paidAt` and `Expense.date` exist: a Thursday bank
   * deposit entered on Saturday belongs to Thursday's books, and the cash
   * register for Thursday is the one that has to know about it.
   */
  date: {
    type: Date,
    default: Date.now,
    required: true,
  },
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

// Listing, newest first, per branch. §9.2.
accountTransferSchema.index({ shop: 1, branch: 1, date: -1 });
// The cash register and `recalc-account-balances` both ask "what moved through
// this account in this window", one direction at a time.
accountTransferSchema.index({ shop: 1, fromAccount: 1, date: -1 });
accountTransferSchema.index({ shop: 1, toAccount: 1, date: -1 });
// Per SHOP, not global — a plain `unique: true` on `transferNo` made two
// different shops collide on their first transfer, which is the bug
// `StockTransfer`'s own index comment records.
accountTransferSchema.index({ shop: 1, transferNo: 1 }, { unique: true });

/**
 * The MFS or bank fee, derived.
 *
 * Never stored. `amountOut - amountIn` is the only definition that cannot drift
 * from the two figures it is computed from.
 */
accountTransferSchema.virtual('charge').get(function () {
  return Math.max(0, (this.amountOut || 0) - (this.amountIn || 0));
});

accountTransferSchema.pre('validate', async function (next) {
  if (this.isNew && !this.transferNo) {
    try {
      const seq = await AccountTransferCounter.nextSeq(this.shop, () =>
        mongoose.model('AccountTransfer').countDocuments({ shop: this.shop })
      );
      this.transferNo = `TFR-${String(seq).padStart(6, '0')}`;
    } catch (err) {
      return next(err);
    }
  }
  next();
});

/**
 * Same guard as `AccountEntry` above, and one degree worse: a transfer moved
 * TWO balances, and the cash register reads it from both ends to decide what
 * the drawer should hold. Deleting one leaves both accounts wrong and the till
 * expecting money that was banked.
 */
accountTransferSchema.plugin(immutableGuard, { modelName: 'AccountTransfer' });

const AccountTransfer = mongoose.model('AccountTransfer', accountTransferSchema);

module.exports = AccountTransfer;
