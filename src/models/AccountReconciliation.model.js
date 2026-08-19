const mongoose = require('mongoose');

/**
 * "The statement says ৳6,04,200. The app says ৳6,00,000. Where is the ৳4,200?"
 *
 * ── What this generalises ───────────────────────────────────────────────────
 *
 * `CashRegister` already does exactly this for physical cash: it computes what
 * should be in the drawer, the shopkeeper counts what IS, and the difference is
 * recorded and explained. That mechanism was never available for anything else,
 * so a bank account could drift from its statement for a year with nothing in
 * the app that would notice.
 *
 * This is the same act for any account. The shop reads a figure off a bank
 * statement or a bKash app, the system supplies its own, and the gap is written
 * down with a reason.
 *
 * ── Why it is NOT `CashRegister` with a wider `type` ────────────────────────
 *
 * A cash register is a DAY: it opens, accumulates, and closes, and there is
 * exactly one per branch per date — that uniqueness is an index. A bank
 * reconciliation is a MOMENT: a shop might check twice in March and not again
 * until June, and forcing it into a per-day slot would either refuse the second
 * check or invent registers for days nobody looked. The two also close
 * differently — a till is counted at closing time and a statement arrives
 * whenever the bank sends it.
 *
 * `CashRegister` therefore stays exactly as it is, including for cash accounts.
 * A shop reconciling its drawer uses the till it already knows.
 *
 * ── The difference is stored ────────────────────────────────────────────────
 *
 * Unlike the account balance itself, which is stored because it is a rollup, and
 * unlike the transfer charge, which is derived because it is arithmetic on one
 * row — this is stored because `systemBalance` is a SNAPSHOT. Recomputing the
 * difference later would compare March's statement against today's balance and
 * report a discrepancy that was reconciled months ago.
 */
const accountReconciliationSchema = new mongoose.Schema({
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
  /** As of when the statement figure was true. */
  date: {
    type: Date,
    default: Date.now,
    required: true,
  },
  /** What the app believed at the moment of checking. A snapshot — see above. */
  systemBalance: {
    type: Number,
    required: true,
  },
  /** What the bank, the bKash app or the counted drawer actually said. */
  statementBalance: {
    type: Number,
    required: [true, 'স্টেটমেন্টের ব্যালান্স দিন'],
  },
  /**
   * `statementBalance - systemBalance`. Positive means the real world holds MORE
   * than the app knows about — usually money in that was never recorded.
   * Negative means the app thinks there is money that is not there.
   */
  difference: {
    type: Number,
    default: 0,
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
}, { timestamps: true });

accountReconciliationSchema.index({ shop: 1, account: 1, date: -1 });
accountReconciliationSchema.index({ shop: 1, branch: 1, date: -1 });

accountReconciliationSchema.pre('save', function (next) {
  this.difference = (this.statementBalance || 0) - (this.systemBalance || 0);
  next();
});

/**
 * Recording a reconciliation deliberately does NOT move the balance.
 *
 * It is a note that the two disagree, not a licence to overwrite one with the
 * other. A gap means either a transaction was never entered — in which case the
 * fix is to enter it, and the balance corrects itself — or the statement figure
 * was misread. Silently writing the statement figure into `balance` would
 * destroy the only evidence of which.
 *
 * An owner who has investigated and wants the app to agree writes an
 * `AccountEntry` of type `adjustment`, which is owner-only, carries a required
 * reason, and leaves both the discrepancy and its correction on the record.
 */
const AccountReconciliation = mongoose.model('AccountReconciliation', accountReconciliationSchema);

module.exports = AccountReconciliation;
