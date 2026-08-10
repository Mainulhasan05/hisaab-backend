const mongoose = require('mongoose');
// For `deriveDue` only — the shared due formula. Not a cycle: Customer does not
// know this collection exists.
const Customer = require('./Customer.model');

/**
 * Per-branch customer ledger (Phase 7).
 *
 * `Customer` stays exactly what it always was: one document per human, unique
 * on {shop, phone}, carrying the **shop-wide** rollup. This collection carries
 * the same rollup split per branch, so a shop can choose whether its branches
 * share one customer book or keep separate ones (`Shop.customerScope`).
 *
 * Three rules this model exists to enforce:
 *
 * 1. **A row is written only for multi-branch shops.** `branch` is required and
 *    never null. For a single-branch shop the absence of any row *is* the
 *    single-branch state — cheaper, and impossible to half-read by mistake.
 *    (This is the one deliberate departure from the "single-branch shops are
 *    `branch: null` everywhere" rule in MULTI_BRANCH_HANDOFF §3.2.)
 *
 * 2. **Rows are written whatever `customerScope` says.** Only the read path
 *    branches on the flag. That is what makes the toggle a same-request switch
 *    with no migration and no way to lose data by flipping it back.
 *
 * 3. **The invariant:** for any customer,
 *        Σ CustomerBalance.totalDue  ===  Customer.totalDue
 *    Every mutation here mirrors the corresponding `Customer` mutation with the
 *    same arithmetic, in the same transaction. `scripts/recalc-customer-balances.js`
 *    checks the invariant against live data; a mismatch means a write path was
 *    changed on one side only.
 */
const customerBalanceSchema = new mongoose.Schema({
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
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true // never null — see rule 1
  },
  totalPurchases: {
    type: Number,
    default: 0
  },
  totalPaid: {
    type: Number,
    default: 0
  },
  totalDue: {
    type: Number,
    default: 0
  },
  // This branch's share of the pre-software debt. Mirrors `Customer.openingDue`
  // the same way every other figure here mirrors its shop-wide twin, so the Σ
  // invariant in rule 3 covers it too. See DueAdjustment.model.js.
  openingDue: {
    type: Number,
    default: 0
  },
  purchaseCount: {
    type: Number,
    default: 0
  },
  lastPurchase: {
    type: Date
  },
  /**
   * What THIS branch calls this customer.
   *
   * ── Why only the name is per-branch ─────────────────────────────────────
   *
   * A shop reported the real failure: Chittagong corrected a customer's name
   * and number, and Dhaka — who had been tracking the same person as "Sadek"
   * — could never find them again. One `Customer` document per human is still
   * right (splitting it would split the money), so what had to stop was one
   * branch silently rewriting another branch's label.
   *
   * The name is a LABEL. Two branches disagreeing about it costs nothing.
   * The phone is an IDENTITY, and it deliberately stays shared:
   *
   *   - `{shop, phone}` is a unique index. A per-branch phone would move that
   *     guarantee from the database into an application check that races.
   *   - SMS would go to whichever number the sending branch happened to hold,
   *     so a corrected number would never reach the other branches — the
   *     original bug, made permanent and silent instead of visible once.
   *   - `Sale` snapshots the phone, and the due-aging report groups on it.
   *
   * Null means "use the shop-wide name", which is the state every existing row
   * is in and stays in until a branch deliberately renames. So this is inert
   * for every shop that does not use it, and `Customer.name` remains the one
   * canonical answer to "who is this".
   */
  localName: {
    type: String,
    trim: true,
    maxlength: [100, 'নাম ১০০ অক্ষরের বেশি হতে পারবে না'],
    default: null
  }
}, {
  timestamps: true
});

// The upsert key.
customerBalanceSchema.index({ shop: 1, customer: 1, branch: 1 }, { unique: true });
// Due list and leaderboard: filter by branch, sort by amount, paginate — served
// entirely by this index. The array-on-Customer alternative could not do this.
customerBalanceSchema.index({ shop: 1, branch: 1, totalDue: -1 });
// "Which customers is this branch allowed to see" + the customer-list join.
customerBalanceSchema.index({ shop: 1, branch: 1, customer: 1 });

/**
 * Atomic `$inc` upsert. Mirrors whichever `Customer` mutation it sits beside.
 *
 * No-ops when `branch` or `customer` is missing, which is what keeps every call
 * site free of `if (multiBranch)` noise: a single-branch shop passes
 * `branch: null` and nothing is written, a walk-in with no customer record
 * passes `customer: null` and nothing is written.
 *
 * @param {Object} delta
 * @param {ObjectId} delta.shop
 * @param {ObjectId|null} delta.customer
 * @param {ObjectId|null} delta.branch
 * @param {number} [delta.purchases]  added to totalPurchases
 * @param {number} [delta.paid]       added to totalPaid
 * @param {number} [delta.due]        added to totalDue
 * @param {number} [delta.opening]    added to openingDue (caller also passes `due`)
 * @param {number} [delta.count]      added to purchaseCount
 * @param {Date}   [delta.lastPurchase]
 * @param {Object|null} session
 */
customerBalanceSchema.statics.applyDelta = async function (delta, session = null) {
  const { shop, customer, branch, purchases = 0, paid = 0, due = 0, opening = 0, count = 0, lastPurchase } = delta;

  if (!shop || !customer || !branch) return null;

  const inc = {};
  if (purchases) inc.totalPurchases = purchases;
  if (paid) inc.totalPaid = paid;
  if (due) inc.totalDue = due;
  if (opening) inc.openingDue = opening;
  if (count) inc.purchaseCount = count;

  const update = {};
  if (Object.keys(inc).length > 0) update.$inc = inc;
  if (lastPurchase) update.$set = { lastPurchase };

  // Nothing to change, but the row must still exist — creating a customer at a
  // branch is a zero delta, and it is what makes them visible there.
  if (Object.keys(update).length === 0) update.$setOnInsert = { totalDue: 0 };

  return this.updateOne(
    { shop, customer, branch },
    update,
    { upsert: true, ...(session ? { session } : {}) }
  );
};

/**
 * Re-derive `totalDue` from purchases plus opening debt minus payments,
 * clamped at zero.
 *
 * Used only where `Customer` does the same clamped recompute rather than a
 * plain `$inc` — the sales-return paths. Mirroring the clamp is what keeps the
 * Σ invariant true; recomputing here while `Customer` clamps (or vice versa)
 * would silently drift the two apart on any over-refunded customer.
 *
 * Deliberately delegates to `Customer.deriveDue` rather than repeating the
 * arithmetic: the `openingDue` term must appear on both sides or neither, and
 * one shared function is the only way to guarantee that.
 */
customerBalanceSchema.statics.recomputeDue = async function ({ shop, customer, branch }, session = null) {
  if (!shop || !customer || !branch) return null;

  const sessionOpt = session ? { session } : {};
  const row = await this.findOne({ shop, customer, branch }, null, sessionOpt);
  if (!row) return null;

  row.totalDue = Customer.deriveDue(row);
  await row.save(sessionOpt);
  return row;
};

/**
 * Spread a due collection across the branches that actually hold the debt.
 *
 * A due collection is the one payment not tied to an invoice, so there is no
 * `sale.branch` to attribute it to. Crediting it wholesale to the collecting
 * branch is wrong in shared mode: a shop where Dhaka is owed ৳3,000 and
 * Noyagola collects it would leave Noyagola at −৳3,000 and Dhaka still at
 * +৳3,000. The sum stays right, so nothing looks broken — until the shop flips
 * to branch scope and a branch shows a negative balance out of nowhere. That
 * would quietly cost the toggle its "flip any time, no migration" property.
 *
 * Allocation order: the collecting branch first (settle your own book), then
 * oldest debt first. In branch scope the caller has already checked the amount
 * against the collecting branch's own due, so everything lands on that one row
 * and this reduces to the simple case — one code path, both modes.
 *
 * Any remainder (a customer carrying shop-wide due with no branch rows — real
 * only for history predating Phase 7) lands on the collecting branch, so
 * `Σ branch dues === Customer.totalDue` survives regardless.
 *
 * @returns {Array<{branch: ObjectId, amount: number}>} what was applied where
 */
customerBalanceSchema.statics.settleDue = async function ({ shop, customer, preferBranch, amount }, session = null) {
  if (!shop || !customer || !preferBranch || !amount) return [];

  const sessionOpt = session ? { session } : {};
  const rows = await this.find(
    { shop, customer, totalDue: { $gt: 0 } },
    null,
    sessionOpt
  ).sort({ lastPurchase: 1, createdAt: 1 });

  // Nothing tracked per branch yet — a single-branch shop, or a customer whose
  // whole history predates Phase 7. Either way there is no row to reduce.
  if (rows.length === 0) return [];

  rows.sort((a, b) => {
    const aPref = String(a.branch) === String(preferBranch);
    const bPref = String(b.branch) === String(preferBranch);
    return aPref === bPref ? 0 : (aPref ? -1 : 1);
  });

  const applied = [];
  let remaining = amount;

  for (const row of rows) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, row.totalDue);
    row.totalPaid += take;
    row.totalDue -= take;
    await row.save(sessionOpt);
    applied.push({ branch: row.branch, amount: take });
    remaining -= take;
  }

  if (remaining > 0) {
    await this.applyDelta(
      { shop, customer, branch: preferBranch, paid: remaining, due: -remaining },
      session
    );
    applied.push({ branch: preferBranch, amount: remaining });
  }

  return applied;
};

/** One customer's balance at one branch, or a zero row if they have none there. */
customerBalanceSchema.statics.getBalance = async function ({ shop, customer, branch }) {
  if (!shop || !customer || !branch) return null;

  const row = await this.findOne({ shop, customer, branch }).lean();
  return row || {
    shop, customer, branch,
    totalPurchases: 0, totalPaid: 0, totalDue: 0, purchaseCount: 0, lastPurchase: null,
  };
};

/** Branch totals for the dashboard: how much is owed here, by how many people. */
customerBalanceSchema.statics.getBranchDueSummary = async function (shopId, branchId) {
  const result = await this.aggregate([
    {
      $match: {
        shop: new mongoose.Types.ObjectId(shopId),
        branch: new mongoose.Types.ObjectId(branchId),
        totalDue: { $gt: 0 },
      },
    },
    { $group: { _id: null, totalDue: { $sum: '$totalDue' }, customerCount: { $sum: 1 } } },
  ]);

  return result[0] || { totalDue: 0, customerCount: 0 };
};

const CustomerBalance = mongoose.model('CustomerBalance', customerBalanceSchema);

module.exports = CustomerBalance;
