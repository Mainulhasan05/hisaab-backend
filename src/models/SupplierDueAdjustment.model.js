const mongoose = require('mongoose');
const { immutableGuard } = require('../utils/immutableGuard.util');

/**
 * Payable that exists without a purchase behind it.
 *
 * The supplier-side twin of `DueAdjustment`, and it exists for the same case: a
 * shop that traded on a paper খাতা signs up already owing its vendors money. That
 * debt is real, it must appear in every payable figure, and every future
 * purchase must stack on top of it — but no `Purchase` of ours produced it, so
 * there is nothing to hang it on.
 *
 * ── Why this is not a `Purchase` with a special type ─────────────────────────
 *
 * The same trap `DueAdjustment.model.js` describes for `Sale`, with a different
 * blast radius. `Purchase` feeds the purchase reports, cost-of-goods, stock
 * transactions, the branch purchase summary and the cash register's expected
 * closing. A fake purchase would inflate all of them, and each would need
 * `status: { $ne: 'opening_balance' }` bolted on. Miss one and a shop's
 * onboarding figure silently becomes buying activity — and, worse, stock.
 *
 * ── Why this is not a row in `DueAdjustment` ─────────────────────────────────
 *
 * That was the tempting reuse and it is unsafe, for a reason that is already in
 * the code: `customer.service.getDueAging` aggregates `DueAdjustment` matched on
 * `{shop, branch}` ONLY — no customer predicate — and groups by `$customer`.
 * Supplier rows in that collection would land in the customer receivables aging
 * report as a `_id: null` bucket, turning money the shop OWES into money it is
 * OWED. `scripts/recalc-customer-balances.js` reads the collection the same way.
 * Separate collections keep each side's blast radius enumerable, which is the
 * whole argument `DueAdjustment` itself makes.
 *
 * ── The invariants ──────────────────────────────────────────────────────────
 *
 *     Supplier.openingDue        === Σ amount for that supplier
 *     SupplierBalance.openingDue === Σ amount for that (supplier, branch)
 *
 * `supplier.service._applyOpeningDue` is the single writer and moves all of it
 * in one transaction. `scripts/recalc-supplier-balances.js` rebuilds from this
 * collection and reports drift.
 *
 * ── Signed amounts ──────────────────────────────────────────────────────────
 *
 * `amount` is a delta, not a balance: +500 raises what the shop owes, −500
 * lowers it. Corrections are new rows, never edits — which is what makes the
 * খতিয়ান readable and what stops history being quietly reshaped.
 *
 * Owner-only at the route layer. Writing a row here conjures a payable out of
 * nothing; unlike a purchase, no counter-transaction can undo it.
 */
const supplierDueAdjustmentSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true
  },
  // Null for single-branch shops, exactly like Purchase and Payment. Which
  // branch's book the old debt belongs to — the branch that carried the debt is
  // the branch that pays it off.
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  // 'opening'    — set while creating the supplier (onboarding)
  // 'adjustment' — a later correction by the owner
  // Only the label differs; both move `openingDue` by `amount`.
  kind: {
    type: String,
    enum: ['opening', 'adjustment'],
    default: 'opening'
  },
  // Signed. Positive raises the payable, negative lowers it. Never zero — a
  // no-op row would sit in the খতিয়ান claiming to have changed something.
  amount: {
    type: Number,
    required: [true, 'পরিমাণ দিন'],
    validate: {
      validator: (v) => Number.isFinite(v) && v !== 0,
      message: 'পরিমাণ ০ হতে পারবে না'
    }
  },
  // What the supplier's opening due became after this row. Snapshotted rather
  // than recomputed, so a printed statement keeps showing what was true at the
  // time even after later rows are added.
  balanceAfter: {
    type: Number,
    default: 0
  },
  note: {
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
  timestamps: true
});

// The খতিয়ান read: one supplier, newest first.
supplierDueAdjustmentSchema.index({ shop: 1, supplier: 1, createdAt: -1 });
// Any branch rollup: what old debt did this branch carry in.
supplierDueAdjustmentSchema.index({ shop: 1, branch: 1, createdAt: -1 });

/**
 * Sum of every adjustment for a supplier — the figure `Supplier.openingDue`
 * caches. Used by the reconciliation script as an independent second opinion,
 * so it deliberately reads the rows rather than the rollup.
 */
supplierDueAdjustmentSchema.statics.sumForSupplier = async function (shopId, supplierId, branchId = undefined) {
  const match = { shop: shopId, supplier: supplierId };
  if (branchId !== undefined) match.branch = branchId;

  const [row] = await this.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  return row?.total || 0;
};

// Corrections are new rows, never deletions.
supplierDueAdjustmentSchema.plugin(immutableGuard, { modelName: 'SupplierDueAdjustment' });

const SupplierDueAdjustment = mongoose.model('SupplierDueAdjustment', supplierDueAdjustmentSchema);

module.exports = SupplierDueAdjustment;
