/**
 * Phase 7 — rebuild and verify per-branch customer balances.
 *
 *   node scripts/recalc-customer-balances.js                    # dry-run, every multi-branch shop
 *   node scripts/recalc-customer-balances.js --shop <id>        # dry-run, one shop
 *   node scripts/recalc-customer-balances.js --shop <id> --apply
 *   node scripts/recalc-customer-balances.js --verify-only      # check the invariant, write nothing
 *
 * THREE JOBS, ONE SCRIPT
 * ----------------------
 * 1. BACKFILL for shops that were already multi-branch when Phase 7 shipped —
 *    they have sales history but no CustomerBalance rows.
 * 2. REPAIR drift. `Customer.totalDue` and the branch rows are maintained by
 *    the same code in the same transactions, so they should never disagree; if
 *    they do, a write path was changed on one side only.
 * 3. VERIFY the invariant, on demand, against live data:
 *
 *        Σ CustomerBalance.totalDue  ===  Customer.totalDue      (per customer)
 *
 * The rebuild derives every figure from source documents — Sale, Payment,
 * SalesReturn — never from the rollup it is checking, so it is a genuine second
 * opinion rather than a copy.
 *
 * SAFETY
 * ------
 * Dry-run by default: prints what would change and exits 0/1 on the invariant.
 * Single-branch shops are skipped entirely — they have no rows by design.
 * Writes are per-customer and idempotent, so an interrupted run resumes by
 * being re-run.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const VERIFY_ONLY = process.argv.includes('--verify-only');
const shopArgIdx = process.argv.indexOf('--shop');
const SHOP_ARG = shopArgIdx !== -1 ? process.argv[shopArgIdx + 1] : null;

const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Rebuild one shop's (customer, branch) figures from source documents.
 *
 * Mirrors the write paths exactly:
 *   totalPurchases  = Σ sale.total       − Σ refunds attributed to purchases
 *   totalPaid       = Σ sale.paid        + Σ payments  − Σ cash refunds
 *   totalDue        = max(0, purchases − paid)         ← the same clamp
 *   purchaseCount   = number of non-cancelled sales
 */
async function rebuildShop(db, shop) {
  const shopId = shop._id;

  const sales = await db.collection('sales').aggregate([
    { $match: { shop: shopId, customer: { $ne: null }, status: { $ne: 'cancelled' } } },
    {
      $group: {
        _id: { customer: '$customer', branch: '$branch' },
        totalPurchases: { $sum: '$total' },
        totalPaid: { $sum: '$paid' },
        purchaseCount: { $sum: 1 },
        lastPurchase: { $max: '$createdAt' },
      },
    },
  ]).toArray();

  // Due collections are not tied to a sale, so they carry only the branch that
  // took the cash. Invoice payments are already inside sale.paid above.
  const collections = await db.collection('payments').aggregate([
    { $match: { shop: shopId, customer: { $ne: null }, type: 'due_collection' } },
    { $group: { _id: { customer: '$customer', branch: '$branch' }, paid: { $sum: '$amount' } } },
  ]).toArray();

  const refunds = await db.collection('payments').aggregate([
    { $match: { shop: shopId, customer: { $ne: null }, type: 'refund' } },
    { $group: { _id: { customer: '$customer', branch: '$branch' }, refunded: { $sum: '$amount' } } },
  ]).toArray();

  const rows = new Map();
  const keyOf = (customer, branch) => `${customer}|${branch}`;
  const slot = (customer, branch) => {
    const key = keyOf(customer, branch);
    if (!rows.has(key)) {
      rows.set(key, {
        shop: shopId, customer, branch,
        totalPurchases: 0, totalPaid: 0, totalDue: 0, purchaseCount: 0, lastPurchase: null,
      });
    }
    return rows.get(key);
  };

  for (const s of sales) {
    if (!s._id.branch) continue; // pre-enable history; the backfill tags it first
    const row = slot(s._id.customer, s._id.branch);
    row.totalPurchases += s.totalPurchases || 0;
    row.totalPaid += s.totalPaid || 0;
    row.purchaseCount += s.purchaseCount || 0;
    row.lastPurchase = s.lastPurchase || null;
  }
  for (const c of collections) {
    if (!c._id.branch) continue;
    slot(c._id.customer, c._id.branch).totalPaid += c.paid || 0;
  }
  for (const r of refunds) {
    if (!r._id.branch) continue;
    const row = slot(r._id.customer, r._id.branch);
    row.totalPurchases -= r.refunded || 0;
    row.totalPaid -= r.refunded || 0;
  }

  for (const row of rows.values()) {
    row.totalPurchases = round(row.totalPurchases);
    row.totalPaid = round(row.totalPaid);
    row.totalDue = round(Math.max(0, row.totalPurchases - row.totalPaid));
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

  const shops = await db.collection('shops').find(shopFilter).project({ name: 1, customerScope: 1 }).toArray();

  if (shops.length === 0) {
    console.log('No multi-branch shops matched. Single-branch shops have no balance rows by design — nothing to do.');
    await mongoose.connection.close();
    return;
  }

  let mismatches = 0;
  let written = 0;

  for (const shop of shops) {
    console.log(`\n=== ${shop.name} (${shop._id}) — customerScope: ${shop.customerScope || 'unset'}`);

    const rebuilt = await rebuildShop(db, shop);
    const existing = await db.collection('customerbalances')
      .find({ shop: shop._id }).toArray();
    const existingByKey = new Map(existing.map((r) => [`${r.customer}|${r.branch}`, r]));

    console.log(`  rebuilt ${rebuilt.length} (customer, branch) rows; ${existing.length} currently stored`);

    // --- the invariant, per customer ---
    const rebuiltByCustomer = new Map();
    for (const row of rebuilt) {
      const k = String(row.customer);
      rebuiltByCustomer.set(k, round((rebuiltByCustomer.get(k) || 0) + row.totalDue));
    }

    const customers = await db.collection('customers')
      .find({ shop: shop._id }).project({ totalDue: 1, name: 1, phone: 1 }).toArray();

    for (const customer of customers) {
      const branchSum = rebuiltByCustomer.get(String(customer._id)) || 0;
      const shopWide = round(customer.totalDue || 0);
      if (Math.abs(branchSum - shopWide) > 0.01) {
        mismatches++;
        if (mismatches <= 20) {
          console.log(
            `  MISMATCH ${customer.name || customer.phone}: ` +
            `branches sum to ৳${branchSum}, Customer.totalDue is ৳${shopWide}`
          );
        }
      }
    }

    if (VERIFY_ONLY) continue;

    // --- write ---
    const ops = [];
    for (const row of rebuilt) {
      const key = `${row.customer}|${row.branch}`;
      const current = existingByKey.get(key);
      const differs = !current ||
        Math.abs((current.totalPurchases || 0) - row.totalPurchases) > 0.01 ||
        Math.abs((current.totalPaid || 0) - row.totalPaid) > 0.01 ||
        Math.abs((current.totalDue || 0) - row.totalDue) > 0.01 ||
        (current.purchaseCount || 0) !== row.purchaseCount;

      if (differs) {
        ops.push({
          updateOne: {
            filter: { shop: row.shop, customer: row.customer, branch: row.branch },
            update: {
              $set: {
                totalPurchases: row.totalPurchases,
                totalPaid: row.totalPaid,
                totalDue: row.totalDue,
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

    // Rows that exist but the rebuild says should not — a customer whose only
    // sales were later cancelled. Zero them rather than delete: a zero row is
    // how a branch keeps a customer visible without any money attached.
    for (const [key, row] of existingByKey) {
      if (!rebuilt.some((r) => `${r.customer}|${r.branch}` === key)) {
        if ((row.totalPurchases || 0) === 0 && (row.totalPaid || 0) === 0 && (row.totalDue || 0) === 0) continue;
        ops.push({
          updateOne: {
            filter: { _id: row._id },
            update: { $set: { totalPurchases: 0, totalPaid: 0, totalDue: 0, purchaseCount: 0, updatedAt: new Date() } },
          },
        });
      }
    }

    console.log(`  ${ops.length} row(s) would change`);

    if (APPLY && ops.length > 0) {
      const res = await db.collection('customerbalances').bulkWrite(ops, { ordered: false });
      written += (res.upsertedCount || 0) + (res.modifiedCount || 0);
      console.log(`  applied: ${res.upsertedCount || 0} inserted, ${res.modifiedCount || 0} updated`);
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Shops processed: ${shops.length}`);
  console.log(`Invariant mismatches: ${mismatches}${mismatches > 20 ? ' (first 20 shown)' : ''}`);
  if (APPLY) console.log(`Rows written: ${written}`);
  else if (!VERIFY_ONLY) console.log('DRY-RUN — nothing written. Re-run with --apply.');

  await mongoose.connection.close();

  // A mismatch means a write path updates one book and not the other. That is a
  // code bug, not a data blip, so fail loudly rather than quietly rewriting.
  if (mismatches > 0) {
    console.error('\nInvariant broken. Fix the write path before applying — do not paper over it here.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
