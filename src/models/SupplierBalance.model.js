const mongoose = require('mongoose');

/**
 * Per-branch supplier ledger.
 *
 * `Supplier` stays what it always was: one document per vendor, unique on
 * {shop, name}, carrying the **shop-wide** rollup. This collection carries the
 * same figures split by the branch the goods were actually bought for.
 *
 * ── Why suppliers need this but did not have it ─────────────────────────────
 *
 * `Purchase` has always been branch-scoped; `Supplier.totalDue` never was. The
 * arithmetic still came out right — every branch's purchase added to the same
 * book and every payment subtracted from it, so the shop-wide total was never
 * wrong — but it could not answer the question a multi-branch shop actually
 * asks: *this* branch bought the goods, what does *this* branch owe?
 *
 * Worse, the purchase reports ARE branch-filtered. So selecting Dhaka showed
 * Dhaka's purchases beside a supplier due covering every branch, and the two
 * numbers on one screen did not reconcile.
 *
 * ── Deliberately simpler than CustomerBalance ───────────────────────────────
 *
 * Two differences, both because supplier money behaves differently:
 *
 * 1. **No scope flag.** Customers have `Shop.customerScope` because a shop may
 *    want its branches to keep separate customer books. Suppliers are shared by
 *    definition — every branch buys from the same vendors, and the shop
 *    confirmed it wants them listed everywhere. So the LIST is always
 *    shop-wide; only the FIGURES follow the active branch.
 *
 * 2. **No `settleDue` allocation.** A customer due collection is not tied to an
 *    invoice, so `CustomerBalance.settleDue` has to spread it across branches.
 *    A supplier payment is always made against a specific purchase, and that
 *    purchase carries its branch — so payments attribute exactly, with no
 *    allocation policy to get wrong.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 *
 *     Σ SupplierBalance.totalDue  ===  Supplier.totalDue
 *
 * Every mutation here sits beside the corresponding `Supplier` mutation, with
 * the same arithmetic, in the same transaction.
 * `scripts/recalc-supplier-balances.js` rebuilds both from Purchase and Payment
 * and reports any drift; a mismatch means a write path was changed on one side
 * only.
 *
 * Rows are written only for multi-branch shops — `branch` is required and never
 * null, so for a single-branch shop the absence of any row IS the single-branch
 * state. Same rule as CustomerBalance; see its header for why.
 */
const supplierBalanceSchema = new mongoose.Schema({
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
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true // never null — see the header
  },
  // Money bought from this supplier at this branch. Named to match
  // `Supplier.totalAmount`, NOT `Customer.totalPurchases` — on a supplier,
  // `totalPurchases` is a COUNT. Keeping the parent's vocabulary is what stops
  // a reader assuming the customer meaning and summing the wrong column.
  totalAmount: {
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
  // This branch's share of the pre-software debt. `totalDue` includes it, and
  // Σ across branches is `Supplier.openingDue` — the same invariant the money
  // columns keep. See Supplier.model.js for the formula.
  openingDue: {
    type: Number,
    default: 0
  },
  // Number of purchases, mirroring `Supplier.totalPurchases`.
  purchaseCount: {
    type: Number,
    default: 0
  },
  lastPurchase: {
    type: Date
  }
}, {
  timestamps: true
});

// The upsert key.
supplierBalanceSchema.index({ shop: 1, supplier: 1, branch: 1 }, { unique: true });
// "What does this branch owe, most first" — payables list, served from index.
supplierBalanceSchema.index({ shop: 1, branch: 1, totalDue: -1 });

/**
 * Atomic `$inc` upsert. Mirrors whichever `Supplier` mutation it sits beside.
 *
 * No-ops when `branch` or `supplier` is missing, which keeps every call site
 * free of `if (multiBranch)` noise: a single-branch shop passes `branch: null`
 * and nothing is written, a purchase with no supplier passes `supplier: null`
 * and nothing is written.
 *
 * @param {Object} delta
 * @param {ObjectId} delta.shop
 * @param {ObjectId|null} delta.supplier
 * @param {ObjectId|null} delta.branch
 * @param {number} [delta.amount]  added to totalAmount
 * @param {number} [delta.paid]    added to totalPaid
 * @param {number} [delta.due]     added to totalDue
 * @param {number} [delta.opening] added to openingDue (pass `due` alongside —
 *                                 opening debt is due, and moving one without
 *                                 the other is how the two rollups drift)
 * @param {number} [delta.count]   added to purchaseCount
 * @param {Date}   [delta.lastPurchase]
 * @param {Object|null} session
 */
supplierBalanceSchema.statics.applyDelta = async function (delta, session = null) {
  const { shop, supplier, branch, amount = 0, paid = 0, due = 0, opening = 0, count = 0, lastPurchase } = delta;

  if (!shop || !supplier || !branch) return null;

  const inc = {};
  if (amount) inc.totalAmount = amount;
  if (paid) inc.totalPaid = paid;
  if (due) inc.totalDue = due;
  if (opening) inc.openingDue = opening;
  if (count) inc.purchaseCount = count;

  const update = {};
  if (Object.keys(inc).length > 0) update.$inc = inc;
  if (lastPurchase) update.$set = { lastPurchase };

  // Nothing to change, but the row must still exist — a supplier reachable from
  // a branch with no purchases yet is a zero row, not a missing one.
  if (Object.keys(update).length === 0) update.$setOnInsert = { totalDue: 0 };

  return this.updateOne(
    { shop, supplier, branch },
    update,
    { upsert: true, ...(session ? { session } : {}) }
  );
};

/**
 * Re-derive `totalDue` from amount plus opening minus paid, clamped at zero.
 *
 * Used only where `Supplier` does the same clamped recompute rather than a
 * plain `$inc` — the purchase-cancel path. Mirroring the clamp is what keeps
 * the Σ invariant true on an over-paid supplier.
 *
 * The `openingDue` term is load-bearing and easy to drop, exactly as it is on
 * `CustomerBalance.recomputeBalances`: `Supplier.totalDue` is only ever `$inc`-ed
 * (cancel subtracts the purchase's own due and nothing else), so leaving it out
 * here would silently wipe a shop's carried-over payable from the branch book
 * the first time any purchase from that supplier was cancelled — while the
 * shop-wide rollup kept it. That is the drift `recalc-supplier-balances.js`
 * would then report forever with nothing to explain it.
 */
supplierBalanceSchema.statics.recomputeDue = async function ({ shop, supplier, branch }, session = null) {
  if (!shop || !supplier || !branch) return null;

  const sessionOpt = session ? { session } : {};
  const row = await this.findOne({ shop, supplier, branch }, null, sessionOpt);
  if (!row) return null;

  row.totalDue = Math.max(0, (row.totalAmount || 0) + (row.openingDue || 0) - (row.totalPaid || 0));
  await row.save(sessionOpt);
  return row;
};

/** One supplier's figures at one branch, or a zero row if they have none there. */
supplierBalanceSchema.statics.getBalance = async function ({ shop, supplier, branch }) {
  if (!shop || !supplier || !branch) return null;

  const row = await this.findOne({ shop, supplier, branch }).lean();
  return row || {
    shop, supplier, branch,
    totalAmount: 0, totalPaid: 0, totalDue: 0, openingDue: 0, purchaseCount: 0, lastPurchase: null,
  };
};

/**
 * Overlay a page of suppliers with one branch's figures, in a single query.
 *
 * The supplier LIST stays shop-wide in every mode — every branch buys from the
 * same vendors. Only the money follows the active branch. A supplier this
 * branch has never bought from reads as zeros rather than disappearing, which
 * is the difference between "we owe them nothing here" and "they do not exist".
 *
 * @param {Array} suppliers plain objects (`.lean()`)
 * @returns {Array} same order, money replaced by this branch's
 */
supplierBalanceSchema.statics.overlayBranchFigures = async function (suppliers, shopId, branchId) {
  if (!branchId || !Array.isArray(suppliers) || suppliers.length === 0) return suppliers;

  const rows = await this.find({
    shop: shopId,
    branch: branchId,
    supplier: { $in: suppliers.map((s) => s._id) },
  }).lean();

  const bySupplier = new Map(rows.map((r) => [String(r.supplier), r]));

  return suppliers.map((supplier) => {
    const row = bySupplier.get(String(supplier._id));
    return {
      ...supplier,
      totalAmount: row?.totalAmount || 0,
      totalPaid: row?.totalPaid || 0,
      totalDue: row?.totalDue || 0,
      // Overlaid like every other money column. Left out, the edit form would
      // show the shop-wide opening beside this branch's due and an owner
      // correcting it would restate the wrong book — the bug
      // `customer.service.setOpeningDue` carries a whole comment about.
      openingDue: row?.openingDue || 0,
      totalPurchases: row?.purchaseCount || 0,
      lastPurchase: row?.lastPurchase || null,
      // Kept so a screen can say "৳X এই শাখায়, সব শাখা মিলে ৳Y" instead of
      // silently showing a smaller number than the shop owner expects.
      shopWideDue: supplier.totalDue || 0,
      branchScoped: true,
    };
  });
};

/** Branch totals for the dashboard: how much this branch owes, to how many. */
supplierBalanceSchema.statics.getBranchDueSummary = async function (shopId, branchId) {
  const result = await this.aggregate([
    {
      $match: {
        shop: new mongoose.Types.ObjectId(shopId),
        branch: new mongoose.Types.ObjectId(branchId),
        totalDue: { $gt: 0 },
      },
    },
    { $group: { _id: null, totalDue: { $sum: '$totalDue' }, supplierCount: { $sum: 1 } } },
  ]);

  return result[0] || { totalDue: 0, supplierCount: 0 };
};

const SupplierBalance = mongoose.model('SupplierBalance', supplierBalanceSchema);

module.exports = SupplierBalance;
