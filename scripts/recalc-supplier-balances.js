/**
 * Rebuild and verify per-branch supplier balances.
 *
 *   node scripts/recalc-supplier-balances.js                    # dry-run, every multi-branch shop
 *   node scripts/recalc-supplier-balances.js --shop <id>        # dry-run, one shop
 *   node scripts/recalc-supplier-balances.js --shop <id> --apply
 *   node scripts/recalc-supplier-balances.js --verify-only      # check the invariant, write nothing
 *
 * TWO JOBS
 * --------
 * 1. BACKFILL. `SupplierBalance` did not exist until now, so every multi-branch
 *    shop has purchase history and no rows. **Run this once with --apply after
 *    deploying**, or every branch will show ৳0 owed to suppliers it does owe.
 * 2. VERIFY the invariant, on demand, against live data:
 *
 *        Σ SupplierBalance.totalDue  ===  Supplier.totalDue      (per supplier)
 *
 * The rebuild derives every figure from source documents — Purchase, Payment
 * and SupplierDueAdjustment — never from the rollup it is checking, so it is a
 * genuine second opinion rather than a copy.
 *
 * WHAT COUNTS
 * -----------
 *   totalAmount   = Σ purchase.totalAmount        (non-cancelled)
 *   totalPaid     = Σ purchase.paid  +  Σ payments of type 'purchase_payment'
 *   openingDue    = Σ supplierdueadjustments.amount
 *   totalDue      = max(0, totalAmount + openingDue − totalPaid)
 *   purchaseCount = number of non-cancelled purchases
 *
 * `purchase.paid` already includes anything settled at the counter. Later
 * settlements are separate `Payment` rows — which is exactly the pair the cash
 * register also has to add together, and the reason supplier payments were
 * invisible to it before.
 *
 * `openingDue` is the payable a shop carried in from its paper খাতা. It has no
 * purchase behind it, so it lives in its own immutable collection — see
 * models/SupplierDueAdjustment.model.js. Omitting the term here would make this
 * script report every shop that onboarded old supplier debt as drifted, and
 * with --apply it would WRITE that drift into the book.
 *
 * SAFETY
 * ------
 * Dry-run by default: prints what would change and exits 0/1 on the invariant.
 * Single-branch shops are skipped entirely — they have no rows by design.
 * Writes are per-(supplier, branch) and idempotent, so an interrupted run
 * resumes by being re-run.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const VERIFY_ONLY = process.argv.includes('--verify-only');
const shopArgIdx = process.argv.indexOf('--shop');
const SHOP_ARG = shopArgIdx !== -1 ? process.argv[shopArgIdx + 1] : null;

// The same rounding the live write paths use. A repair script that rounds
// differently from the code it repairs manufactures its own drift — and with
// --apply it writes that drift into the book. `Number.EPSILON` is an ABSOLUTE
// 2.2e-16, so the form this replaces stopped nudging above ~2 and rounded
// ~0.8% of paisa-boundary values the other way. See utils/quantity.util.js.
const { quantizeMoney: round } = require('../src/utils/quantity.util');

/** Rebuild one shop's (supplier, branch) figures from source documents. */
async function rebuildShop(db, shopId) {
  const purchases = await db.collection('purchases').aggregate([
    { $match: { shop: shopId, supplier: { $ne: null }, status: { $ne: 'cancelled' } } },
    {
      $group: {
        _id: { supplier: '$supplier', branch: '$branch' },
        totalAmount: { $sum: '$totalAmount' },
        totalPaid: { $sum: '$paid' },
        purchaseCount: { $sum: 1 },
        lastPurchase: { $max: '$date' },
      },
    },
  ]).toArray();

  // Settlements made after the purchase. They carry no supplier of their own,
  // so they are joined back through the purchase they were made against —
  // which is also where their branch comes from.
  const settlements = await db.collection('payments').aggregate([
    { $match: { shop: shopId, type: 'purchase_payment', purchase: { $ne: null } } },
    {
      $lookup: {
        from: 'purchases',
        localField: 'purchase',
        foreignField: '_id',
        as: 'purchaseDoc',
      },
    },
    { $unwind: '$purchaseDoc' },
    { $match: { 'purchaseDoc.status': { $ne: 'cancelled' } } },
    {
      $group: {
        _id: { supplier: '$purchaseDoc.supplier', branch: '$purchaseDoc.branch' },
        paid: { $sum: '$amount' },
      },
    },
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
    const key = `${supplier}|${branch}`;
    if (!rows.has(key)) {
      rows.set(key, {
        shop: shopId, supplier, branch,
        totalAmount: 0, totalPaid: 0, totalDue: 0, openingDue: 0, purchaseCount: 0, lastPurchase: null,
      });
    }
    return rows.get(key);
  };

  for (const p of purchases) {
    if (!p._id.branch) continue; // pre-multi-branch history; nothing to split
    const row = slot(p._id.supplier, p._id.branch);
    row.totalAmount += p.totalAmount || 0;
    row.totalPaid += p.totalPaid || 0;
    row.purchaseCount += p.purchaseCount || 0;
    row.lastPurchase = p.lastPurchase || null;
  }

  for (const s of settlements) {
    if (!s._id.branch || !s._id.supplier) continue;
    slot(s._id.supplier, s._id.branch).totalPaid += s.paid || 0;
  }

  for (const o of openings) {
    // Same skip as purchases: a null branch is a single-branch shop's row and
    // has no per-branch half to rebuild.
    if (!o._id.branch || !o._id.supplier) continue;
    slot(o._id.supplier, o._id.branch).openingDue += o.opening || 0;
  }

  for (const row of rows.values()) {
    row.totalAmount = round(row.totalAmount);
    row.totalPaid = round(row.totalPaid);
    row.openingDue = round(row.openingDue);
    row.totalDue = round(Math.max(0, row.totalAmount + row.openingDue - row.totalPaid));
  }

  return [...rows.values()];
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
  });

  const db = mongoose.connection.db;
  const mode = VERIFY_ONLY ? 'VERIFY-ONLY' : (APPLY ? 'APPLY' : 'DRY-RUN');
  console.log(`Connected to ${mongoose.connection.host}/${db.databaseName} (${mode})\n`);

  const shopFilter = { multiBranchEnabled: true };
  if (SHOP_ARG) shopFilter._id = new mongoose.Types.ObjectId(SHOP_ARG);

  const shops = await db.collection('shops').find(shopFilter).project({ name: 1 }).toArray();

  if (shops.length === 0) {
    console.log('No multi-branch shops matched. Single-branch shops have no balance rows by design — nothing to do.');
    await mongoose.connection.close();
    return;
  }

  let mismatches = 0;
  let written = 0;

  for (const shop of shops) {
    console.log(`\n=== ${shop.name} (${shop._id})`);

    const rebuilt = await rebuildShop(db, shop._id);
    const existing = await db.collection('supplierbalances').find({ shop: shop._id }).toArray();
    const existingByKey = new Map(existing.map((r) => [`${r.supplier}|${r.branch}`, r]));

    console.log(`  rebuilt ${rebuilt.length} (supplier, branch) rows; ${existing.length} currently stored`);

    // --- the invariants, per supplier ---
    const dueBySupplier = new Map();
    const openingBySupplier = new Map();
    for (const row of rebuilt) {
      const k = String(row.supplier);
      dueBySupplier.set(k, round((dueBySupplier.get(k) || 0) + row.totalDue));
      openingBySupplier.set(k, round((openingBySupplier.get(k) || 0) + row.openingDue));
    }

    const suppliers = await db.collection('suppliers')
      .find({ shop: shop._id }).project({ name: 1, totalDue: 1, openingDue: 1 }).toArray();

    for (const supplier of suppliers) {
      const branchSum = dueBySupplier.get(String(supplier._id)) || 0;
      const shopWide = round(supplier.totalDue || 0);
      if (Math.abs(branchSum - shopWide) > 0.01) {
        mismatches++;
        if (mismatches <= 20) {
          console.log(
            `  MISMATCH ${supplier.name}: branches sum to ৳${branchSum}, Supplier.totalDue is ৳${shopWide}`
          );
        }
      }

      // Checked on its own rather than folded into the due comparison above.
      // The two can offset — an opening due lost from one branch and a payment
      // miscounted on another net out in `totalDue` — and an invariant that
      // only holds in aggregate hides exactly the write path that broke.
      const openingSum = openingBySupplier.get(String(supplier._id)) || 0;
      const openingShopWide = round(supplier.openingDue || 0);
      if (Math.abs(openingSum - openingShopWide) > 0.01) {
        mismatches++;
        if (mismatches <= 20) {
          console.log(
            `  MISMATCH ${supplier.name}: branch openingDue sums to ৳${openingSum}, Supplier.openingDue is ৳${openingShopWide}`
          );
        }
      }
    }

    if (VERIFY_ONLY) continue;

    // --- write ---
    const ops = [];
    for (const row of rebuilt) {
      const current = existingByKey.get(`${row.supplier}|${row.branch}`);
      const differs = !current ||
        Math.abs((current.totalAmount || 0) - row.totalAmount) > 0.01 ||
        Math.abs((current.totalPaid || 0) - row.totalPaid) > 0.01 ||
        Math.abs((current.totalDue || 0) - row.totalDue) > 0.01 ||
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
      if (!rebuilt.some((r) => `${r.supplier}|${r.branch}` === key)) {
        if ((row.totalAmount || 0) === 0 && (row.totalPaid || 0) === 0 &&
            (row.totalDue || 0) === 0 && (row.openingDue || 0) === 0) continue;
        ops.push({
          updateOne: {
            filter: { _id: row._id },
            update: {
              $set: {
                totalAmount: 0, totalPaid: 0, totalDue: 0, openingDue: 0,
                purchaseCount: 0, updatedAt: new Date(),
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
  console.log(`mismatches: ${mismatches}${APPLY ? `  |  rows written: ${written}` : ''}`);
  if (!APPLY && !VERIFY_ONLY) console.log('Dry run — re-run with --apply to write.');

  await mongoose.connection.close();
  // Non-zero on drift so CI or a cron can alert on it.
  process.exit(mismatches > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
