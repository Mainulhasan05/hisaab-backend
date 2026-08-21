const mongoose = require('mongoose');
const { immutableGuard } = require('../utils/immutableGuard.util');

/**
 * Due that exists without an invoice behind it.
 *
 * The case this model exists for: a shop that has been trading for years on a
 * paper খাতা signs up, and two hundred of its customers already owe money. That
 * debt is real, it must appear in every due figure the software shows, and
 * every future invoice must stack on top of it — but no sale of ours produced
 * it, so there is no `Sale` to hang it on.
 *
 * ── Why this is not a `Sale` with `type: 'opening_balance'` ──────────────────
 *
 * That was the obvious alternative and it is a trap. `Sale` is read by roughly
 * fifty aggregations — every report, the cash register's expected-closing
 * calculation, per-branch revenue, and the platform-wide admin dashboard that
 * spans tenants. A fake invoice would inflate every one of them, and each would
 * need `type: { $ne: 'opening_balance' }` bolted on. Miss one and a shop's
 * onboarding data silently becomes revenue — with no error, in the numbers an
 * owner trusts most.
 *
 * Here the blast radius is closed and enumerable instead: nothing sums this
 * collection except the code that deliberately asks for it. What DOES have to
 * stay in step is the due formula, which gains one term:
 *
 *     totalDue = max(0, totalPurchases + openingDue − totalPaid)
 *
 * Every place that recomputes due rather than `$inc`-ing it must use that form.
 * They are: `CustomerBalance.recomputeBalances`, the three sales-return paths, and
 * `scripts/recalc-customer-balances.js`. `grep "totalPurchases + "` finds them.
 *
 * ── Signed amounts ───────────────────────────────────────────────────────────
 *
 * `amount` is a delta, not a balance: +500 raises what the customer owes, −500
 * lowers it. Corrections are new rows, never edits — which is what makes the
 * খতিয়ান readable ("৳৫,০০০ পুরনো বাকি, পরে ৳২,০০০ কমানো হয়েছে") and what stops a
 * staff member from quietly reshaping history. The rollup is the sum:
 *
 *     Customer.openingDue        === Σ amount for that customer
 *     CustomerBalance.openingDue === Σ amount for that (customer, branch)
 *
 * Owner-only at the route layer, and deliberately so: writing a row here
 * conjures a receivable out of nothing, which is the one customer-desk action
 * that cannot be undone by a counter-sale.
 */
const dueAdjustmentSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  // Null for single-branch shops, exactly like Sale and Payment. Which branch's
  // book the old debt belongs to — in separate-books mode a customer cannot pay
  // it at any other branch, so this is not cosmetic.
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  // 'opening'    — set while creating the customer (onboarding / CSV import)
  // 'adjustment' — a later correction by the owner
  // Only the label differs; both move `openingDue` by `amount`.
  kind: {
    type: String,
    enum: ['opening', 'adjustment'],
    default: 'opening'
  },
  // Signed. Positive raises the due, negative lowers it. Never zero — a no-op
  // row would clutter the খতিয়ান with an entry that changed nothing.
  amount: {
    type: Number,
    required: [true, 'পরিমাণ দিন'],
    validate: {
      validator: (v) => Number.isFinite(v) && v !== 0,
      message: 'পরিমাণ ০ হতে পারবে না'
    }
  },
  // What the customer's opening due became after this row. Snapshotted rather
  // than recomputed, so the খতিয়ান and any printed statement keep showing what
  // was true at the time even after later rows are added.
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

// The খতিয়ান read: one customer, newest first.
dueAdjustmentSchema.index({ shop: 1, customer: 1, createdAt: -1 });
// Due-aging and any branch rollup: bucket by age within a branch.
dueAdjustmentSchema.index({ shop: 1, branch: 1, createdAt: -1 });

/**
 * Sum of every adjustment for a customer — the figure `Customer.openingDue`
 * caches. Used by the reconciliation script as an independent second opinion,
 * so it deliberately reads the rows rather than the rollup.
 */
dueAdjustmentSchema.statics.sumForCustomer = async function (shopId, customerId, branchId = undefined) {
  const match = { shop: shopId, customer: customerId };
  if (branchId !== undefined) match.branch = branchId;

  const [row] = await this.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  return row?.total || 0;
};

// Corrections are new rows, never deletions.
dueAdjustmentSchema.plugin(immutableGuard, { modelName: 'DueAdjustment' });

const DueAdjustment = mongoose.model('DueAdjustment', dueAdjustmentSchema);

module.exports = DueAdjustment;
