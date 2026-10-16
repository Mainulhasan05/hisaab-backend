/**
 * PlatformExpense — money HisaabBD spends. The operator's own expense book.
 *
 * Not `Expense`, which is a SHOP's expense and is shop- and branch-scoped by
 * every invariant in CLAUDE.md. This collection has no `shop` at all: a server
 * bill belongs to the platform, and putting it in a shop's collection would
 * surface it in that shop's P&L. Same reasoning that split PlatformPayment from
 * Payment.
 *
 * ── Coverage: why a one-off bill can be spread ───────────────────────────────
 *
 * A ৳12,000 annual server renewal paid in January is ONE cash outflow and
 * TWELVE months of cost. Booking it all in January makes January a loss and
 * February–December look better than they are. `coverageMonths` says how many
 * months the bill pays for; the finance service spreads the cost across them
 * on the earned (accrual) view and keeps it on `paidAt` on the cash view. That
 * is the mirror of a shop paying six months up front — see
 * platformFinance.service.
 *
 * `coverageMonths: 1` (the default) is an ordinary expense: one month, the
 * month it was paid.
 *
 * ── Never deleted ────────────────────────────────────────────────────────────
 *
 * Voided with a reason, like every other ledger here. A wrong AMOUNT is a void
 * and re-entry; everything else may be corrected in place and the correction is
 * stamped in `amendments`. Hard deletion is refused by immutableGuard and by the
 * admin panel's deny-by-default DELETE policy.
 */

const mongoose = require('mongoose');
const { immutableGuard } = require('../utils/immutableGuard.util');
const { PLATFORM_EXPENSE_CATEGORIES, PLATFORM_PAYMENT_METHODS } = require('../config/constants');

const actorSchema = new mongoose.Schema({
  kind: { type: String, enum: ['admin', 'system'], default: 'admin' },
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String },
}, { _id: false });

const platformExpenseSchema = new mongoose.Schema({
  category: {
    type: String,
    enum: Object.values(PLATFORM_EXPENSE_CATEGORIES),
    required: [true, 'Choose a category'],
  },
  // What it was — "Hostinger VPS renewal", "Facebook ads, Eid campaign".
  title: {
    type: String,
    trim: true,
    required: [true, 'Describe the expense'],
    maxlength: 200,
  },
  vendor: { type: String, trim: true, maxlength: 120 },
  amount: {
    type: Number,
    required: [true, 'Enter an amount'],
    // Strictly positive. A refund from a vendor is income-side, and a ৳0 row is
    // a note, not an expense.
    min: [0.01, 'Amount must be more than zero'],
  },
  currency: { type: String, default: 'BDT' },
  method: {
    type: String,
    enum: Object.values(PLATFORM_PAYMENT_METHODS),
    default: PLATFORM_PAYMENT_METHODS.CASH,
  },
  // When the money left, not when it was keyed in. Dates the cash view.
  paidAt: { type: Date, required: true },
  // The first day the bill pays for. Defaults to `paidAt` — a renewal paid a
  // week before the old term ends can set it to the day the new term starts.
  coverageStart: { type: Date },
  coverageMonths: {
    type: Number,
    default: 1,
    min: [1, 'Coverage must be at least one month'],
    max: [60, 'Coverage cannot exceed 60 months'],
    validate: { validator: Number.isInteger, message: 'Coverage must be whole months' },
  },
  reference: { type: String, trim: true, maxlength: 120 },
  notes: { type: String, maxlength: 1000 },

  recordedBy: actorSchema,

  // Set once; a voided row counts in no figure but stays in the list.
  voidedAt: { type: Date, default: null },
  voidedBy: actorSchema,
  voidReason: { type: String, maxlength: 500 },

  amendments: [{
    at: { type: Date, default: Date.now },
    by: actorSchema,
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
    reason: { type: String, maxlength: 500 },
  }],
}, {
  timestamps: true,
});

// The expense list, newest first, live rows only — the only hot read.
platformExpenseSchema.index({ voidedAt: 1, paidAt: -1 });
// "What did hosting cost us this year."
platformExpenseSchema.index({ category: 1, paidAt: -1 });

platformExpenseSchema.plugin(immutableGuard, { modelName: 'PlatformExpense' });

const PlatformExpense = mongoose.model('PlatformExpense', platformExpenseSchema);

module.exports = PlatformExpense;
