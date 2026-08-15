/**
 * Phase 7 — rebuild and verify per-branch customer balances.
 *
 *   node scripts/recalc-customer-balances.js                    # dry-run, every multi-branch shop
 *   node scripts/recalc-customer-balances.js --shop <id>        # dry-run, one shop
 *   node scripts/recalc-customer-balances.js --shop <id> --apply
 *   node scripts/recalc-customer-balances.js --verify-only      # check the invariant, write nothing
 *   node scripts/recalc-customer-balances.js --shop <id> --apply --repair-customers
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
 * SalesReturn, DueAdjustment — never from the rollup it is checking, so it is a
 * genuine second opinion rather than a copy.
 *
 * `DueAdjustment` is the pre-software debt a shop carried in from its paper
 * খাতা. It has no invoice behind it, so it enters the formula as its own term:
 *
 *     totalDue = max(0, totalPurchases + openingDue − totalPaid)
 *
 * If this script is ever seen to zero out an opening balance, the cause is a
 * `dueadjustments` read that was dropped from `rebuildShop` — not bad data.
 *
 * --repair-customers
 * ------------------
 * Off by default, and deliberately so. A mismatch normally means a write path
 * updates one book and not the other, and rewriting `Customer` from the branch
 * rows would hide that bug rather than fix it — which is what the exit code
 * below exists to prevent.
 *
 * The flag is for the other case: a rollup that was never maintained at all
 * (imported or seeded history, where `Customer.totalPurchases` sits at 0 beside
 * hundreds of real sales). There the branch rows are the only figures derived
 * from source documents, so summing them back into `Customer` is a repair, not
 * a paper-over. Use it only once you have read the mismatches and know which
 * case you are in.
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
const REPAIR_CUSTOMERS = process.argv.includes('--repair-customers');
const shopArgIdx = process.argv.indexOf('--shop');
const SHOP_ARG = shopArgIdx !== -1 ? process.argv[shopArgIdx + 1] : null;

/**
 * The SAME rounding the live write paths use — `Customer.deriveDue`,
 * `CustomerBalance.settleDue` and `customer.service.round2` all resolve here.
 *
 * This script's whole value is being a second opinion computed from source
 * documents. A second opinion that rounds differently from the code it is
 * checking manufactures its own disagreements: this file used to carry its own
 * `Math.round((n + Number.EPSILON) * 100) / 100`, and `Number.EPSILON` is an
 * ABSOLUTE 2.2e-16, so above ~2 it stops nudging and rounds ~0.8% of
 * paisa-boundary values the other way (2.135 -> 2.13 against 2.14).
 *
 * With `--apply` that was worse than a false report: it WROTE the divergent
 * figure into the book it had just been asked to repair.
 */
const { quantizeMoney: round } = require('../src/utils/quantity.util');

/**
 * Rebuild one shop's (customer, branch) figures from source documents.
 *
 * Mirrors the write paths exactly:
 *   totalPurchases  = Σ sale.total       − Σ refunds attributed to purchases
 *   totalPaid       = Σ sale.paid        + Σ payments  − Σ cash refunds
 *   totalDue        = max(0, purchases − paid)         ← the same clamp
 *   purchaseCount   = number of non-cancelled sales
 *
 * A customer who has never transacted anywhere gets a zero row at the default
 * branch. Deriving rows from sales alone would leave them with no row at any
 * branch, and in branch scope a customer with no row is invisible — so a
 * customer added by hand before the ledger existed would silently disappear
 * from every branch's list. `enableMultiBranch` already puts every customer on
 * the default branch for the same reason; this keeps the backfill agreeing
 * with it.
 */
async function rebuildShop(db, shop, defaultBranchId) {
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

  // Debt no invoice of ours produced — the paper-খাতা balance carried in at
  // onboarding, plus later owner corrections. Summed from the rows themselves,
  // never from `Customer.openingDue`, so this stays a genuine second opinion on
  // the rollup rather than a copy of it.
  const openings = await db.collection('dueadjustments').aggregate([
    { $match: { shop: shopId, customer: { $ne: null } } },
    { $group: { _id: { customer: '$customer', branch: '$branch' }, opening: { $sum: '$amount' } } },
  ]).toArray();

  const rows = new Map();
  const keyOf = (customer, branch) => `${customer}|${branch}`;
  const slot = (customer, branch) => {
    const key = keyOf(customer, branch);
    if (!rows.has(key)) {
      rows.set(key, {
        shop: shopId, customer, branch,
        totalPurchases: 0, totalPaid: 0, totalDue: 0, openingDue: 0, purchaseCount: 0, lastPurchase: null,
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
  for (const o of openings) {
    if (!o._id.branch) continue;
    slot(o._id.customer, o._id.branch).openingDue += o.opening || 0;
  }

  for (const row of rows.values()) {
    row.totalPurchases = round(row.totalPurchases);
    row.totalPaid = round(row.totalPaid);
    row.openingDue = round(row.openingDue);
    // Same formula as Customer.deriveDue — kept literal here because this
    // script is the independent check and must not import the code it verifies.
    row.totalDue = round(Math.max(0, row.totalPurchases + row.openingDue - row.totalPaid));
  }

  // Customers with no transaction anywhere — see the note above. Skipped when
  // the shop somehow has no default branch, since there is no honest home for
  // them and an arbitrary one would put a customer in a branch that never
  // served them.
  if (defaultBranchId) {
    const seen = new Set([...rows.values()].map((r) => String(r.customer)));
    const all = await db.collection('customers')
      .find({ shop: shopId }).project({ _id: 1 }).toArray();

    for (const c of all) {
      if (seen.has(String(c._id))) continue;
      slot(c._id, defaultBranchId);
    }
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
  let repaired = 0;

  for (const shop of shops) {
    console.log(`\n=== ${shop.name} (${shop._id}) — customerScope: ${shop.customerScope || 'unset'}`);

    // Same resolution order as enableMultiBranch: the flagged default, else the
    // oldest branch. It is only used as the home for transaction-less customers.
    const defaultBranch =
      (await db.collection('branches').findOne({ shop: shop._id, isDefault: true })) ||
      (await db.collection('branches').find({ shop: shop._id }).sort({ createdAt: 1 }).limit(1).next());

    if (!defaultBranch) {
      console.log('  no branch found — customers with no transactions will be left without a row');
    }

    const rebuilt = await rebuildShop(db, shop, defaultBranch?._id || null);
    const existing = await db.collection('customerbalances')
      .find({ shop: shop._id }).toArray();
    const existingByKey = new Map(existing.map((r) => [`${r.customer}|${r.branch}`, r]));

    console.log(`  rebuilt ${rebuilt.length} (customer, branch) rows; ${existing.length} currently stored`);

    // --- the invariant, per customer ---
    // Summed across every field, not just totalDue, because --repair-customers
    // writes the whole rollup back and a partial sum would leave `Customer`
    // internally inconsistent (a due that its own purchases minus paid cannot
    // produce).
    const rebuiltByCustomer = new Map();
    for (const row of rebuilt) {
      const k = String(row.customer);
      const acc = rebuiltByCustomer.get(k) ||
        { totalPurchases: 0, totalPaid: 0, totalDue: 0, openingDue: 0, purchaseCount: 0, lastPurchase: null };
      acc.totalPurchases = round(acc.totalPurchases + row.totalPurchases);
      acc.totalPaid = round(acc.totalPaid + row.totalPaid);
      acc.totalDue = round(acc.totalDue + row.totalDue);
      acc.openingDue = round(acc.openingDue + row.openingDue);
      acc.purchaseCount += row.purchaseCount;
      if (row.lastPurchase && (!acc.lastPurchase || row.lastPurchase > acc.lastPurchase)) {
        acc.lastPurchase = row.lastPurchase;
      }
      rebuiltByCustomer.set(k, acc);
    }

    const customers = await db.collection('customers')
      .find({ shop: shop._id })
      .project({ totalPurchases: 1, totalPaid: 1, totalDue: 1, purchaseCount: 1, name: 1, phone: 1 })
      .toArray();

    const customerRepairs = [];

    for (const customer of customers) {
      const rebuiltRollup = rebuiltByCustomer.get(String(customer._id)) ||
        { totalPurchases: 0, totalPaid: 0, totalDue: 0, openingDue: 0, purchaseCount: 0, lastPurchase: null };
      const branchSum = rebuiltRollup.totalDue;
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

      if (!REPAIR_CUSTOMERS) continue;

      const differs =
        Math.abs(round(customer.totalPurchases || 0) - rebuiltRollup.totalPurchases) > 0.01 ||
        Math.abs(round(customer.totalPaid || 0) - rebuiltRollup.totalPaid) > 0.01 ||
        Math.abs(round(customer.openingDue || 0) - rebuiltRollup.openingDue) > 0.01 ||
        Math.abs(shopWide - branchSum) > 0.01 ||
        (customer.purchaseCount || 0) !== rebuiltRollup.purchaseCount;

      if (differs) {
        customerRepairs.push({
          updateOne: {
            filter: { _id: customer._id },
            update: {
              $set: {
                totalPurchases: rebuiltRollup.totalPurchases,
                totalPaid: rebuiltRollup.totalPaid,
                totalDue: rebuiltRollup.totalDue,
                openingDue: rebuiltRollup.openingDue,
                purchaseCount: rebuiltRollup.purchaseCount,
                lastPurchase: rebuiltRollup.lastPurchase,
                updatedAt: new Date(),
              },
            },
          },
        });
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
        Math.abs((current.openingDue || 0) - row.openingDue) > 0.01 ||
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

    // Rows that exist but the rebuild says should not — a customer whose only
    // sales were later cancelled. Zero them rather than delete: a zero row is
    // how a branch keeps a customer visible without any money attached.
    for (const [key, row] of existingByKey) {
      if (!rebuilt.some((r) => `${r.customer}|${r.branch}` === key)) {
        if ((row.totalPurchases || 0) === 0 && (row.totalPaid || 0) === 0 &&
            (row.totalDue || 0) === 0 && (row.openingDue || 0) === 0) continue;
        ops.push({
          updateOne: {
            filter: { _id: row._id },
            update: { $set: { totalPurchases: 0, totalPaid: 0, totalDue: 0, openingDue: 0, purchaseCount: 0, updatedAt: new Date() } },
          },
        });
      }
    }

    console.log(`  ${ops.length} row(s) would change`);
    if (REPAIR_CUSTOMERS) {
      console.log(`  ${customerRepairs.length} Customer rollup(s) would be rewritten from the branch rows`);
    }

    if (APPLY && ops.length > 0) {
      const res = await db.collection('customerbalances').bulkWrite(ops, { ordered: false });
      written += (res.upsertedCount || 0) + (res.modifiedCount || 0);
      console.log(`  applied: ${res.upsertedCount || 0} inserted, ${res.modifiedCount || 0} updated`);
    }

    // After this the branch rows and the shop-wide rollup agree by construction,
    // so the mismatches counted above are the ones that were just repaired.
    if (APPLY && REPAIR_CUSTOMERS && customerRepairs.length > 0) {
      const res = await db.collection('customers').bulkWrite(customerRepairs, { ordered: false });
      repaired += res.modifiedCount || 0;
      console.log(`  repaired: ${res.modifiedCount || 0} Customer rollup(s)`);
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Shops processed: ${shops.length}`);
  console.log(`Invariant mismatches: ${mismatches}${mismatches > 20 ? ' (first 20 shown)' : ''}`);
  if (APPLY) console.log(`Rows written: ${written}`);
  else if (!VERIFY_ONLY) console.log('DRY-RUN — nothing written. Re-run with --apply.');
  if (APPLY && REPAIR_CUSTOMERS) console.log(`Customer rollups repaired: ${repaired}`);

  await mongoose.connection.close();

  // A mismatch means a write path updates one book and not the other. That is a
  // code bug, not a data blip, so fail loudly rather than quietly rewriting.
  //
  // Not an error once --repair-customers has actually run: there the mismatch
  // was the input, and the rollups have just been rewritten from it. Re-run
  // without the flag to confirm the count is back to zero.
  if (mismatches > 0 && !(APPLY && REPAIR_CUSTOMERS)) {
    console.error('\nInvariant broken. Fix the write path before applying — do not paper over it here.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
