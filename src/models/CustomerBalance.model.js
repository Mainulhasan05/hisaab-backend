const mongoose = require('mongoose');
// For `deriveDue` only — the shared due formula. Not a cycle: Customer does not
// know this collection exists.
const Customer = require('./Customer.model');
const { quantizeMoney } = require('../utils/quantity.util');

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
 * 3. **The invariant:** for any customer, on the NET position,
 *        Σ (CustomerBalance.totalDue − CustomerBalance.advanceBalance)
 *            ===  Customer.totalDue − Customer.advanceBalance
 *
 *    Before customer advances existed both `advanceBalance` terms were always
 *    zero and this was written, equivalently, as `Σ totalDue === totalDue`.
 *    The net form is the one that survives a customer holding credit at one
 *    branch while owing another — see the field's own note for why that is a
 *    legitimate state rather than drift.
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
  /**
   * This branch's share of the money the shop is holding for the customer.
   *
   * The per-branch twin of `Customer.advanceBalance`, and it extends rule 3 of
   * this file's header by one line:
   *
   *     Σ CustomerBalance.advanceBalance  ===  Customer.advanceBalance
   *
   * Under SEPARATE books an advance belongs to the branch that took it — the
   * customer left ৳5,000 at নয়াগোলা, and Dhaka has no claim on it and must not
   * spend it. Under SHARED books the split is bookkeeping only, exactly as it
   * is for `totalDue`, and the read path is what decides which figure a screen
   * shows. Same reason rows are written in both modes: the `customerScope`
   * toggle stays a same-request switch with nothing to migrate.
   *
   * ── The Σ invariant is on the NET, not on each half ───────────────────────
   *
   * The obvious extension of rule 3 —
   *
   *     Σ CustomerBalance.advanceBalance === Customer.advanceBalance
   *
   * — is FALSE, and believing it will send someone hunting a bug that is not
   * there. A customer can hold ৳700 on deposit at নয়াগোলা while owing ৳1,000 at
   * Dhaka. That is not a fault; under separate books it is the entire point.
   * Shop-wide they are ৳300 in debt, so `Customer.advanceBalance` is 0 while
   * the branch rows sum to 700. Both figures are right.
   *
   * What survives is the invariant on the net position, which is the same rule
   * 3 has always been — `advanceBalance` was simply always zero before:
   *
   *     Σ (totalDue − advanceBalance)  ===  Customer.totalDue − Customer.advanceBalance
   *
   * Per-row, the exclusivity still holds absolutely: no single row ever carries
   * both. It is only the SUM across branches that can show one of each.
   *
   * Derived alongside `totalDue` by `recomputeBalances`, never incremented.
   */
  advanceBalance: {
    type: Number,
    default: 0,
    min: 0
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
// "Which customers does this branch hold money for" — partial for the same
// reason its shop-wide twin on `Customer` is: a tiny subset of a large book.
customerBalanceSchema.index(
  { shop: 1, branch: 1, advanceBalance: -1 },
  { partialFilterExpression: { advanceBalance: { $gt: 0 } } }
);

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
 * Re-derive BOTH halves of this row's balance from purchases plus opening debt
 * minus payments — `totalDue` when that is positive, `advanceBalance` when it
 * is negative, each clamped at zero.
 *
 * Used wherever `Customer` does the same clamped recompute rather than a plain
 * `$inc` — the sales-return paths, the cancellation rollup, and (since the
 * advance work) the tail of `settleDue`. Mirroring the clamp is what keeps the
 * Σ invariant true; recomputing here while `Customer` clamps (or vice versa)
 * would silently drift the two apart on any over-refunded customer.
 *
 * Deliberately delegates to `Customer.applyBalances` rather than repeating the
 * arithmetic: the `openingDue` term must appear on both sides or neither, and
 * one shared function is the only way to guarantee that. It also means the
 * per-branch rows cannot end up with a different notion of "in credit" from the
 * shop-wide document, which is the whole point of rule 3.
 *
 * Renamed from `recomputeDue` when `advanceBalance` arrived. The old name is
 * not kept as an alias on purpose: a call site still saying `recomputeDue`
 * would be one that had not been thought about, and the reference error is a
 * cheaper way to find it than a drifted book six months later.
 */
customerBalanceSchema.statics.recomputeBalances = async function ({ shop, customer, branch }, session = null) {
  if (!shop || !customer || !branch) return null;

  const sessionOpt = session ? { session } : {};
  const row = await this.findOne({ shop, customer, branch }, null, sessionOpt);
  if (!row) return null;

  Customer.applyBalances(row);
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

  // Quantized per step, like `Customer.addPayment` on the shop-wide side. An
  // unrounded `totalDue -= take` leaves the same 1e-13 residue that keeps a
  // settled customer on the branch বাকি list forever — `getBranchDueSummary`
  // and the branch customer list both filter on `totalDue: { $gt: 0 }`.
  for (const row of rows) {
    if (remaining <= 0) break;
    const take = quantizeMoney(Math.min(remaining, row.totalDue));
    if (take <= 0) continue;
    row.totalPaid = quantizeMoney(row.totalPaid + take);
    row.totalDue = quantizeMoney(row.totalDue - take);
    await row.save(sessionOpt);
    applied.push({ branch: row.branch, amount: take });
    remaining = quantizeMoney(remaining - take);
  }

  if (remaining > 0) {
    /**
     * ── Why this credits `paid` and then DERIVES, rather than `$inc`-ing due ──
     *
     * This used to be `applyDelta({ paid: remaining, due: -remaining })` — a
     * raw `$inc` on `totalDue` with no clamp anywhere on the path. It was only
     * ever safe by accident: `settleCustomerDue` refuses an amount larger than
     * the due, so `remaining` could never exceed what the rows held.
     *
     * That is a guarantee held by a caller two files away, and the advance work
     * removes it — an advance IS money arriving with no due to land on, so this
     * branch is now the normal case rather than a historical edge. Left as an
     * `$inc`, the first advance taken would drive this row's `totalDue`
     * NEGATIVE, and negative is the one direction nothing here checks:
     *
     *   · `Σ CustomerBalance.totalDue === Customer.totalDue` breaks, because the
     *     shop-wide side clamps at zero and this side would not;
     *   · every `{ totalDue: { $gt: 0 } }` branch query silently drops the row;
     *   · `getBranchDueSummary` reports a receivable smaller than the truth;
     *   · and nothing anywhere throws.
     *
     * Deriving instead makes the clamp structural: credit the payment to
     * `totalPaid` — which is simply true, the money arrived — and let
     * `recomputeBalances` decide which side of zero the net position lands on.
     * Surplus becomes `advanceBalance` on this branch, which is where an advance
     * belongs: the branch that took the money.
     *
     * Same correction `cancelSale` and the returns paths already made on the
     * shop-wide side, for the same reason. See ADVANCE_PAYMENT_PLAN.md §3.5.
     */
    await this.applyDelta(
      { shop, customer, branch: preferBranch, paid: remaining },
      session
    );
    await this.recomputeBalances({ shop, customer, branch: preferBranch }, session);
    applied.push({ branch: preferBranch, amount: remaining });
  }

  return applied;
};

/**
 * Take `amount` of pre-software debt back off the branch books.
 *
 * The mirror of `settleDue`, for the other way debt leaves a customer: an owner
 * correcting a খাতা figure they typed wrong. It exists because the obvious
 * implementation — `applyDelta` on whichever branch the owner happens to be
 * standing in — is wrong, and wrong *silently*:
 *
 *   Opening due of ৳3,835 is typed at আক্কেলপুর. The owner notices from
 *   নয়াগোলা and corrects it. `applyDelta` puts −৳3,835 on নয়াগোলা and leaves
 *   আক্কেলপুর at +৳3,835. Shop-wide nets to zero, so `Customer.totalDue` is
 *   right and the Σ invariant holds — `recalc-customer-balances.js` reports a
 *   clean book. Meanwhile one branch's dashboard is overstated by ৳3,835 and
 *   the other shows a negative due it can never explain.
 *
 * So a reduction is ALLOCATED, never dumped: each row gives up at most what it
 * actually holds, current branch first (fix your own book), then oldest debt.
 * No row can go negative, and because Σ min(openingᵢ, dueᵢ) ≤ min(Σ openingᵢ,
 * Σ dueᵢ), the total taken can never exceed the shop-wide floor either — the
 * per-branch cap is strictly the tighter of the two.
 *
 * @param {boolean} branchOnly  under separate books, a reduction may only touch
 *   the branch making it. Same rule `collectDuePayment` already enforces for
 *   cash: one branch must not write down another branch's receivable.
 * @returns {number|null} magnitude actually removed, or null when the customer
 *   has no rows at all — a caller-visible difference, see `_applyDueAdjustment`.
 */
customerBalanceSchema.statics.reduceOpening = async function (
  { shop, customer, preferBranch, amount, branchOnly = false },
  session = null
) {
  if (!shop || !customer || !preferBranch || !(amount > 0)) return null;

  const sessionOpt = session ? { session } : {};
  const rows = await this.find(
    { shop, customer, ...(branchOnly ? { branch: preferBranch } : {}) },
    null,
    sessionOpt
  ).sort({ lastPurchase: 1, createdAt: 1 });

  // No row anywhere: history that predates Phase 7, or a book the backfill has
  // not reached. There is nothing to allocate against and inventing a negative
  // row would be worse than the drift, so say so and let the caller fall back.
  if (rows.length === 0) return null;

  rows.sort((a, b) => {
    const aPref = String(a.branch) === String(preferBranch);
    const bPref = String(b.branch) === String(preferBranch);
    return aPref === bPref ? 0 : (aPref ? -1 : 1);
  });

  // `quantizeMoney`, not a local `Math.round((n + Number.EPSILON) * 100) / 100`.
  // `Number.EPSILON` is an ABSOLUTE 2.2e-16, so adding it is a no-op above ~2
  // and the helper rounded ~0.8% of paisa-boundary values down where the rest of
  // the codebase rounds them up (2.135 -> 2.13 against 2.14). These two figures
  // are persisted, so that one-paisa disagreement went into the book.
  // `quantity.util.js` explains why the nudge has to be proportional.
  let remaining = amount;
  let applied = 0;

  for (const row of rows) {
    if (remaining <= 0) break;
    // Capped by the due as well as the opening: a branch whose debt has since
    // been paid down holds no opening debt to give back, however large its
    // `openingDue` field still reads.
    const capacity = Math.min(row.openingDue || 0, row.totalDue || 0);
    if (capacity <= 0) continue;

    const take = quantizeMoney(Math.min(remaining, capacity));
    if (take <= 0) continue;
    row.openingDue = quantizeMoney(row.openingDue - take);
    row.totalDue = quantizeMoney(row.totalDue - take);
    await row.save(sessionOpt);

    remaining = quantizeMoney(remaining - take);
    applied = quantizeMoney(applied + take);
  }

  return applied;
};

/** One customer's balance at one branch, or a zero row if they have none there. */
customerBalanceSchema.statics.getBalance = async function ({ shop, customer, branch }) {
  if (!shop || !customer || !branch) return null;

  const row = await this.findOne({ shop, customer, branch }).lean();
  return row || {
    shop, customer, branch,
    totalPurchases: 0, totalPaid: 0, totalDue: 0, advanceBalance: 0, purchaseCount: 0, lastPurchase: null,
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
