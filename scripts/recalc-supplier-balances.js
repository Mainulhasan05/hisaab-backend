/**
 * Rebuild and verify supplier balances — shop-wide AND per-branch.
 *
 *   node scripts/recalc-supplier-balances.js                    # dry-run, every shop
 *   node scripts/recalc-supplier-balances.js --shop <id>        # dry-run, one shop
 *   node scripts/recalc-supplier-balances.js --shop <id> --apply
 *   node scripts/recalc-supplier-balances.js --verify-only      # check, write nothing
 *   node scripts/recalc-supplier-balances.js --shop <id> --apply --repair-suppliers
 *
 * TWO JOBS
 * --------
 * 1. BACKFILL `SupplierBalance` for multi-branch shops, whose per-branch rows
 *    did not exist until that collection was added.
 * 2. VERIFY, on demand, against live data:
 *
 *        Σ SupplierBalance.totalDue  ===  Supplier.totalDue      (per supplier)
 *        Supplier.totalDue           ===  rebuilt from source    (per supplier)
 *
 * The rebuild derives every figure from source documents — Purchase, Payment
 * and SupplierDueAdjustment — never from the rollup it is checking, so it is a
 * genuine second opinion rather than a copy.
 *
 * WHAT COUNTS
 * -----------
 *   totalAmount   = Σ purchase.totalAmount        (non-cancelled)
 *   totalPaid     = Σ purchase.paid               (non-cancelled)
 *                 + Σ live supplier payments carrying NO purchase
 *   openingDue    = Σ supplierdueadjustments.amount
 *   net           = totalAmount + openingDue − totalPaid
 *   totalDue      = max(0, net)
 *   purchaseCount = number of non-cancelled purchases
 *
 * ── `purchase.paid` is the WHOLE of what has been paid on a bill ────────────
 *
 * Not just what was handed over at the counter. `recordPayment` folds every
 * later settlement into it — `purchase.paid += applied`, on the primary bill
 * and on each older bill an over-payment reaches — which is the mechanism by
 * which `pre('save')` re-derives a smaller `due`.
 *
 * **So the `Payment` rows behind those settlements must NOT be added again.**
 * This script did exactly that until 2026-08-31: it summed `purchase.paid` AND
 * every `purchase_payment` row, counting each later settlement twice. On a
 * ৳10,000 bill paid ৳3,000 afterwards it computed `totalPaid` ৳6,000 and a
 * payable of ৳4,000 where ৳7,000 is owed — and `--apply` would have WRITTEN
 * that ৳3,000 understatement into the branch book. It was masked in the common
 * case only because a fully-settled bill clamps to zero either way.
 *
 * `detailedReport.getSupplierStatements` has known this since the allocation
 * work landed — see its `laterPaymentsLookup`, which subtracts exactly these
 * rows back out of `paid`. This script simply never got the same memo.
 *
 * The one thing `purchase.paid` cannot capture is supplier money that never
 * lands on a bill: settling a paper-খাতা `openingDue`, or an advance paid
 * ahead of goods. Those rows carry `purchase: null` and name their supplier
 * directly, and they are the second term above. **Zero such rows exist today**
 * — no door writes one (SUPPLIER_DUE_ADVANCE_PLAN.md S-2/S-4/S-5) — which is
 * precisely why the term ships now, before the doors, rather than after: a
 * reconciler that learns about a money path only once the path exists has
 * nothing to reconcile that path's first day against.
 *
 * ── Cancelled payments ──────────────────────────────────────────────────────
 *
 * Every payment read applies `LIVE_PAYMENT` (`status != 'cancelled'`). Today
 * the only thing that voids a supplier payment is cancelling its purchase, and
 * such rows were already excluded transitively by the join this script used to
 * do — so the filter is inert now and load-bearing the moment a payment-void
 * endpoint exists, which the advance work requires.
 *
 * ── `openingDue` ────────────────────────────────────────────────────────────
 *
 * The payable a shop carried in from its paper খাতা. It has no purchase behind
 * it, so it lives in its own immutable collection — see
 * models/SupplierDueAdjustment.model.js. Omitting the term here would make this
 * script report every shop that onboarded old supplier debt as drifted, and
 * with --apply it would WRITE that drift into the book.
 *
 * ── An IMPLIED ADVANCE is reported, never repaired ──────────────────────────
 *
 * `net < 0` means the source documents say the shop has paid a supplier more
 * than it ever owed them. There is nowhere to put that today: `totalDue`
 * clamps at zero and the money simply stops being represented. The script says
 * so loudly instead of quietly clamping, because until supplier advances ship
 * this is the signature of a real defect — the over-payment leak closed on
 * 2026-08-31, a mis-keyed opening-due correction, or a payment recorded twice.
 *
 * It does NOT count as a mismatch and does NOT fail the run: it is a finding
 * about the DATA, not a disagreement between two books, and failing on it would
 * leave every run red until the advance work lands. `mismatches` keeps its
 * original meaning — the rollup disagrees with the documents beneath it.
 *
 * SAFETY
 * ------
 * Dry-run by default: prints what would change and exits 0/1 on the invariant.
 * `--apply` writes ONLY `SupplierBalance` rows, and only for multi-branch
 * shops. **A shop-wide `Supplier.totalDue` disagreement is reported and not
 * repaired** unless `--repair-suppliers` is also passed — a rollup that drifted
 * through a live write path must be traced, not silently restated, because
 * restating it destroys the evidence. See that flag for the one case where
 * repairing is right.
 * Writes are per-(supplier, branch) and idempotent, so an interrupted run
 * resumes by being re-run.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const VERIFY_ONLY = process.argv.includes('--verify-only');
/**
 * Restate a drifted shop-wide `Supplier.totalDue` to the document-derived
 * figure. Off by default, requires `--apply`, and deliberately hard to reach.
 *
 * A mismatch normally means a live write path moved one book and not the other,
 * and rewriting the rollup would hide that bug rather than fix it — which is
 * what this script's exit code exists to prevent. Mirrors `--repair-customers`.
 *
 * The flag is for the other case: a rollup that was never maintained by our
 * code at all — seeded or imported history, where the figures were written
 * straight into `Supplier` alongside purchases that were inserted without ever
 * going through `createPurchase`. There the documents are the only figures
 * derived from anything, so restating the rollup is a repair rather than a
 * paper-over.
 *
 * **Establish which case you are in before using it.** The evidence that
 * settled it for হিসাব ফ্যাশন গ্যালারী on 2026-08-31: four suppliers created
 * within two seconds of the shop, 13 of 15 purchases carrying no
 * `purchase_create` audit log, every bill paid exactly 60%, and both gaps
 * unchanged to the taka since the day the data appeared.
 *
 * Repairs `totalDue` and `openingDue` — the two figures this script verifies —
 * together with the components they are DERIVED from (`totalAmount`,
 * `totalPaid`) and the paired `advanceBalance`. Restating the derived half
 * alone would put the rollup right for exactly as long as it took the next
 * purchase to re-derive it from the same bad input.
 */
const REPAIR_SUPPLIERS = process.argv.includes('--repair-suppliers');
const shopArgIdx = process.argv.indexOf('--shop');
const SHOP_ARG = shopArgIdx !== -1 ? process.argv[shopArgIdx + 1] : null;

// The same rounding the live write paths use. A repair script that rounds
// differently from the code it repairs manufactures its own drift — and with
// --apply it writes that drift into the book. `Number.EPSILON` is an ABSOLUTE
// 2.2e-16, so the form this replaces stopped nudging above ~2 and rounded
// ~0.8% of paisa-boundary values the other way. See utils/quantity.util.js.
const { quantizeMoney: round } = require('../src/utils/quantity.util');
const { LIVE_PAYMENT } = require('../src/utils/paymentDate.util');
const { PAYMENT_TYPES } = require('../src/config/constants');

/**
 * Payment types that move a SUPPLIER's book without landing on a bill.
 *
 * Read from the constants rather than written as literals so a renamed type is
 * a crash here rather than a silently unread collection of rows.
 *
 * **A new supplier-side money type must be added to this list.** Adding one to
 * `PAYMENT_TYPES` and not to this line makes every row of it invisible to the
 * only second opinion the supplier books have.
 *
 * ── THE CONTRACT A NEW PAYMENT DOOR MUST KEEP ──────────────────────────────
 *
 * A `Payment` row is counted here **only for money that did not land on a
 * bill**, and the discriminator is the row's own `purchase` field. So a
 * standalone supplier payment that settles open bills must NOT be written as
 * one bill-less row for its full amount: `purchase.paid` will already have
 * risen by the settled portion, and this term would add it a second time —
 * reviving the exact double count fixed on 2026-08-31, one release after it
 * was removed.
 *
 * Write it the way the straddle rule already requires: the portion that landed
 * on bills as a row carrying `purchase` (its split on `allocations[]`, as
 * `recordPayment` does), and only the remainder — the paper-খাতা settlement or
 * the advance — as a bill-less row. Two rows, each self-describing, each
 * summed by exactly one term above.
 */
const BILL_LESS_SUPPLIER_TYPES = [
  PAYMENT_TYPES.PURCHASE_PAYMENT,
  PAYMENT_TYPES.SUPPLIER_ADVANCE,
];

const keyOf = (supplier, branch) => `${supplier}|${branch}`;

/**
 * Rebuild one shop's supplier figures from source documents.
 *
 * Returns EVERY (supplier, branch) slot, including the `branch: null` slots a
 * single-branch shop's history lives in. The caller splits them: the real
 * branches are what `SupplierBalance` stores, and the sum of all of them —
 * null branch included — is what `Supplier` stores.
 */
async function rebuildShop(db, shopId) {
  const purchases = await db.collection('purchases').aggregate([
    { $match: { shop: shopId, supplier: { $ne: null }, status: { $ne: 'cancelled' } } },
    {
      $group: {
        _id: { supplier: '$supplier', branch: '$branch' },
        totalAmount: { $sum: '$totalAmount' },
        // The whole of what has been paid on these bills, counter and later
        // settlements alike — see the header. There is deliberately no second
        // aggregate over `purchase_payment` rows to add to this.
        totalPaid: { $sum: '$paid' },
        purchaseCount: { $sum: 1 },
        lastPurchase: { $max: '$date' },
      },
    },
  ]).toArray();

  // Supplier money with no bill under it: a paper-খাতা settlement, or an
  // advance. These name their supplier and branch directly, because there is no
  // purchase to read either from. No rows match today.
  const billLess = await db.collection('payments').aggregate([
    {
      $match: {
        shop: shopId,
        type: { $in: BILL_LESS_SUPPLIER_TYPES },
        purchase: null,
        supplier: { $ne: null },
        ...LIVE_PAYMENT,
      },
    },
    { $group: { _id: { supplier: '$supplier', branch: '$branch' }, paid: { $sum: '$amount' } } },
  ]).toArray();

  // Pre-software payables. These carry their own branch and have no purchase
  // behind them, so they are summed straight from the ledger rows rather than
  // joined through anything.
  const openings = await db.collection('supplierdueadjustments').aggregate([
    { $match: { shop: shopId } },
    { $group: { _id: { supplier: '$supplier', branch: '$branch' }, opening: { $sum: '$amount' } } },
  ]).toArray();

  const rows = new Map();
  const slot = (supplier, branch) => {
    const key = keyOf(supplier, branch);
    if (!rows.has(key)) {
      rows.set(key, {
        shop: shopId, supplier, branch: branch || null,
        totalAmount: 0, totalPaid: 0, totalDue: 0, openingDue: 0,
        net: 0, impliedAdvance: 0, purchaseCount: 0, lastPurchase: null,
      });
    }
    return rows.get(key);
  };

  for (const p of purchases) {
    if (!p._id.supplier) continue;
    const row = slot(p._id.supplier, p._id.branch);
    row.totalAmount += p.totalAmount || 0;
    row.totalPaid += p.totalPaid || 0;
    row.purchaseCount += p.purchaseCount || 0;
    row.lastPurchase = p.lastPurchase || null;
  }

  for (const s of billLess) {
    if (!s._id.supplier) continue;
    slot(s._id.supplier, s._id.branch).totalPaid += s.paid || 0;
  }

  for (const o of openings) {
    if (!o._id.supplier) continue;
    slot(o._id.supplier, o._id.branch).openingDue += o.opening || 0;
  }

  for (const row of rows.values()) finalise(row);

  return [...rows.values()];
}

/**
 * Round the components, then derive the money from them — in that order.
 *
 * `net` is kept beside `totalDue` rather than thrown away by the clamp,
 * because a negative net is the one thing this script exists to surface that
 * the stored figure structurally cannot hold.
 */
function finalise(row) {
  row.totalAmount = round(row.totalAmount);
  row.totalPaid = round(row.totalPaid);
  row.openingDue = round(row.openingDue);
  row.net = round(row.totalAmount + row.openingDue - row.totalPaid);
  row.totalDue = round(Math.max(0, row.net));
  row.impliedAdvance = round(Math.max(0, -row.net));
  return row;
}

/**
 * The shop-wide figure, derived from shop-wide components.
 *
 * NOT `Σ branch totalDue`. Each branch row clamps its own net at zero, so
 * summing the clamped halves overstates the payable for a supplier who is
 * over-paid at one branch and owed at another. `Supplier.totalDue` is a single
 * clamp on a single net, and it has to be rebuilt the same way or this check
 * reports drift that is really just the clamp applied twice.
 *
 * That divergence is itself worth naming, which is why the caller compares the
 * branch sum separately rather than only against this.
 */
function rollUpBySupplier(rows) {
  const bySupplier = new Map();
  for (const row of rows) {
    const key = String(row.supplier);
    if (!bySupplier.has(key)) {
      bySupplier.set(key, {
        supplier: row.supplier,
        totalAmount: 0, totalPaid: 0, totalDue: 0, openingDue: 0,
        net: 0, impliedAdvance: 0, purchaseCount: 0,
        branchDueSum: 0,
      });
    }
    const agg = bySupplier.get(key);
    agg.totalAmount += row.totalAmount;
    agg.totalPaid += row.totalPaid;
    agg.openingDue += row.openingDue;
    agg.purchaseCount += row.purchaseCount;
    agg.branchDueSum += row.totalDue;
  }
  for (const agg of bySupplier.values()) {
    finalise(agg);
    agg.branchDueSum = round(agg.branchDueSum);
  }
  return bySupplier;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
  });

  const db = mongoose.connection.db;
  const mode = VERIFY_ONLY ? 'VERIFY-ONLY' : (APPLY ? 'APPLY' : 'DRY-RUN');
  console.log(`Connected to ${mongoose.connection.host}/${db.databaseName} (${mode})\n`);

  // EVERY shop, not only the multi-branch ones. The shop-wide rollup is the
  // book a single-branch shop actually reads, and it had no second opinion at
  // all while this script looked only at `SupplierBalance` — which those shops
  // deliberately have no rows in.
  const shopFilter = {};
  if (SHOP_ARG) shopFilter._id = new mongoose.Types.ObjectId(SHOP_ARG);

  const shops = await db.collection('shops')
    .find(shopFilter).project({ name: 1, multiBranchEnabled: 1 }).toArray();

  if (shops.length === 0) {
    console.log('No shops matched.');
    await mongoose.connection.close();
    return;
  }

  let mismatches = 0;
  let impliedAdvances = 0;
  let written = 0;
  let repaired = 0;

  for (const shop of shops) {
    const multiBranch = shop.multiBranchEnabled === true;
    console.log(`\n=== ${shop.name} (${shop._id})${multiBranch ? ' [multi-branch]' : ''}`);

    const rebuilt = await rebuildShop(db, shop._id);
    if (rebuilt.length === 0) {
      console.log('  no supplier history');
      continue;
    }

    const bySupplier = rollUpBySupplier(rebuilt);
    // Only real branches are stored. A `branch: null` slot is a single-branch
    // shop's history, or a multi-branch shop's pre-migration history — neither
    // has a per-branch half to rebuild.
    const branchRows = rebuilt.filter((r) => r.branch);

    const suppliers = await db.collection('suppliers')
      .find({ shop: shop._id }).project({ name: 1, totalDue: 1, openingDue: 1 }).toArray();

    const report = (msg) => {
      mismatches++;
      if (mismatches <= 40) console.log(`  ${msg}`);
    };

    // [{ _id, name, totalDue?, openingDue? }] — only the fields that disagreed.
    const supplierRepairs = [];

    for (const supplier of suppliers) {
      const agg = bySupplier.get(String(supplier._id));
      const rebuiltDue = agg ? agg.totalDue : 0;
      const rebuiltOpening = agg ? agg.openingDue : 0;

      // --- 1. the rollup against the DOCUMENTS (every shop) ---
      const storedDue = round(supplier.totalDue || 0);
      if (Math.abs(rebuiltDue - storedDue) > 0.01) {
        report(
          `MISMATCH ${supplier.name}: documents say ৳${rebuiltDue}, Supplier.totalDue is ৳${storedDue}`
          + (agg ? `  (billed ৳${agg.totalAmount} + opening ৳${agg.openingDue} − paid ৳${agg.totalPaid})` : '')
        );
        supplierRepairs.push({
          _id: supplier._id,
          name: supplier.name,
          totalDue: rebuiltDue,
          // The components behind it, restated in the same write. Repairing the
          // derived half while leaving `totalPaid` wrong would put the rollup
          // right for exactly as long as it took the next purchase to re-derive
          // it from the same bad input.
          totalPaid: agg ? agg.totalPaid : 0,
          totalAmount: agg ? agg.totalAmount : 0,
          advanceBalance: agg ? agg.impliedAdvance : 0,
        });
      }

      // Checked on its own rather than folded into the due comparison above.
      // The two can offset — an opening due lost from one branch and a payment
      // miscounted on another net out in `totalDue` — and an invariant that
      // only holds in aggregate hides exactly the write path that broke.
      const storedOpening = round(supplier.openingDue || 0);
      if (Math.abs(rebuiltOpening - storedOpening) > 0.01) {
        report(
          `MISMATCH ${supplier.name}: documents say opening ৳${rebuiltOpening}, `
          + `Supplier.openingDue is ৳${storedOpening}`
        );
        const existingRepair = supplierRepairs.find((r) => String(r._id) === String(supplier._id));
        if (existingRepair) existingRepair.openingDue = rebuiltOpening;
        else supplierRepairs.push({ _id: supplier._id, name: supplier.name, openingDue: rebuiltOpening });
      }

      // --- 2. the branch halves against the shop-wide figure (multi-branch) ---
      if (multiBranch && agg && Math.abs(agg.branchDueSum - agg.totalDue) > 0.01) {
        report(
          `MISMATCH ${supplier.name}: branch dues sum to ৳${agg.branchDueSum}, `
          + `shop-wide net gives ৳${agg.totalDue} — one branch is over-paid while another is owed`
        );
      }

      // --- 3. money the model cannot hold ---
      if (agg && agg.impliedAdvance > 0.01) {
        impliedAdvances++;
        if (impliedAdvances <= 40) {
          console.log(
            `  IMPLIED ADVANCE ${supplier.name}: paid ৳${agg.totalPaid} against `
            + `৳${round(agg.totalAmount + agg.openingDue)} ever owed — ৳${agg.impliedAdvance} `
            + 'has nowhere to sit and is being clamped away'
          );
        }
      }
    }

    // ── the shop-wide repair, behind its own flag ─────────────────────────
    //
    // Runs before the branch-row work and independently of it, because the
    // rollup is the book a single-branch shop reads and those shops never
    // reach the code below.
    if (supplierRepairs.length > 0) {
      if (APPLY && REPAIR_SUPPLIERS) {
        const ops = supplierRepairs.map((r) => ({
          updateOne: {
            filter: { _id: r._id },
            update: {
              $set: {
                ...(r.totalDue !== undefined ? { totalDue: r.totalDue } : {}),
                ...(r.totalPaid !== undefined ? { totalPaid: r.totalPaid } : {}),
                ...(r.totalAmount !== undefined ? { totalAmount: r.totalAmount } : {}),
                ...(r.advanceBalance !== undefined ? { advanceBalance: r.advanceBalance } : {}),
                ...(r.openingDue !== undefined ? { openingDue: r.openingDue } : {}),
                updatedAt: new Date(),
              },
            },
          },
        }));
        const res = await db.collection('suppliers').bulkWrite(ops, { ordered: false });
        repaired += res.modifiedCount || 0;
        for (const r of supplierRepairs) {
          console.log(
            `  REPAIRED ${r.name}:`
            + `${r.totalDue !== undefined ? ` totalDue -> ৳${r.totalDue}` : ''}`
            + `${r.openingDue !== undefined ? ` openingDue -> ৳${r.openingDue}` : ''}`
          );
        }
      } else if (REPAIR_SUPPLIERS) {
        for (const r of supplierRepairs) {
          console.log(
            `  would repair ${r.name}:`
            + `${r.totalDue !== undefined ? ` totalDue -> ৳${r.totalDue}` : ''}`
            + `${r.openingDue !== undefined ? ` openingDue -> ৳${r.openingDue}` : ''}`
          );
        }
      }
    }

    if (!multiBranch) {
      console.log(`  ${suppliers.length} supplier(s) checked shop-wide; no branch rows by design`);
      continue;
    }

    const existing = await db.collection('supplierbalances').find({ shop: shop._id }).toArray();
    const existingByKey = new Map(existing.map((r) => [keyOf(r.supplier, r.branch), r]));

    console.log(`  rebuilt ${branchRows.length} (supplier, branch) rows; ${existing.length} currently stored`);

    if (VERIFY_ONLY) {
      for (const row of branchRows) {
        const current = existingByKey.get(keyOf(row.supplier, row.branch));
        if (!current || Math.abs((current.totalDue || 0) - row.totalDue) > 0.01) {
          report(
            `MISMATCH branch row ${row.supplier}@${row.branch}: `
            + `documents say ৳${row.totalDue}, stored ৳${current ? round(current.totalDue || 0) : 'none'}`
          );
        }
      }
      continue;
    }

    // --- write ---
    const ops = [];
    for (const row of branchRows) {
      const current = existingByKey.get(keyOf(row.supplier, row.branch));
      const differs = !current ||
        Math.abs((current.totalAmount || 0) - row.totalAmount) > 0.01 ||
        Math.abs((current.totalPaid || 0) - row.totalPaid) > 0.01 ||
        Math.abs((current.totalDue || 0) - row.totalDue) > 0.01 ||
        Math.abs((current.advanceBalance || 0) - row.impliedAdvance) > 0.01 ||
        Math.abs((current.openingDue || 0) - row.openingDue) > 0.01 ||
        (current.purchaseCount || 0) !== row.purchaseCount;

      if (differs) {
        ops.push({
          updateOne: {
            filter: { shop: row.shop, supplier: row.supplier, branch: row.branch },
            update: {
              $set: {
                totalAmount: row.totalAmount,
                totalPaid: row.totalPaid,
                totalDue: row.totalDue,
                advanceBalance: row.impliedAdvance,
                openingDue: row.openingDue,
                purchaseCount: row.purchaseCount,
                lastPurchase: row.lastPurchase,
                updatedAt: new Date(),
              },
              $setOnInsert: { createdAt: new Date() },
            },
            upsert: true,
          },
        });
      }
    }

    // Rows the rebuild says should not exist — every purchase behind them was
    // cancelled. Zeroed rather than deleted, so the supplier stays visible at
    // that branch with no money attached.
    for (const [key, row] of existingByKey) {
      if (!branchRows.some((r) => keyOf(r.supplier, r.branch) === key)) {
        if ((row.totalAmount || 0) === 0 && (row.totalPaid || 0) === 0 &&
            (row.totalDue || 0) === 0 && (row.advanceBalance || 0) === 0 &&
            (row.openingDue || 0) === 0) continue;
        ops.push({
          updateOne: {
            filter: { _id: row._id },
            update: {
              $set: {
                totalAmount: 0, totalPaid: 0, totalDue: 0, advanceBalance: 0,
                openingDue: 0, purchaseCount: 0, updatedAt: new Date(),
              },
            },
          },
        });
      }
    }

    console.log(`  ${ops.length} row(s) would change`);

    if (APPLY && ops.length > 0) {
      const res = await db.collection('supplierbalances').bulkWrite(ops, { ordered: false });
      written += (res.upsertedCount || 0) + (res.modifiedCount || 0);
      console.log(`  applied: ${res.upsertedCount || 0} inserted, ${res.modifiedCount || 0} updated`);
    }
  }

  console.log(`\n${'-'.repeat(60)}`);
  console.log(
    `mismatches: ${mismatches}  |  implied advances: ${impliedAdvances}`
    + `${APPLY ? `  |  rows written: ${written}` : ''}`
    + `${APPLY && REPAIR_SUPPLIERS ? `  |  rollups repaired: ${repaired}` : ''}`
  );
  if (impliedAdvances > 0) {
    console.log(
      'An IMPLIED ADVANCE is money the books cannot represent — investigate it,\n'
      + 'do not repair it. See SUPPLIER_DUE_ADVANCE_PLAN.md S-1/S-4.'
    );
  }
  if (mismatches > 0 && REPAIR_SUPPLIERS && !APPLY) {
    console.log('Add --apply to write the repairs listed above.');
  } else if (mismatches > 0 && !REPAIR_SUPPLIERS) {
    console.log(
      'A shop-wide Supplier.totalDue mismatch is not repaired unless you pass '
      + '--repair-suppliers, and you should not until you know which write path was wrong.'
    );
  }
  if (!APPLY && !VERIFY_ONLY) console.log('Dry run — re-run with --apply to write.');

  await mongoose.connection.close();
  // Non-zero on drift so CI or a cron can alert on it. Implied advances are
  // deliberately excluded — see the header. A repair run that actually wrote is
  // not a failure: the mismatch it counted is the thing it just corrected.
  process.exit(mismatches > 0 && !(APPLY && REPAIR_SUPPLIERS) ? 1 : 0);
}

// Guarded so the pure arithmetic below can be required by a test without the
// script connecting to a database. `node scripts/recalc-supplier-balances.js`
// is unaffected — it IS the main module.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { finalise, rollUpBySupplier, BILL_LESS_SUPPLIER_TYPES };
