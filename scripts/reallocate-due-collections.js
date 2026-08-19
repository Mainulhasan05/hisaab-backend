/**
 * ─────────────────────────────────────────────────────────────────────────────
 * REPAIR: spread historical khata collections onto the invoices that hold them
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── What went wrong ──────────────────────────────────────────────────────────
 *
 * `dueSettlement.settleCustomerDue` — বাকি আদায় on the customer page, and the
 * surplus settled at a later checkout — reduced `Customer.totalDue` and the
 * `CustomerBalance` rows and wrote a `Payment{type:'due_collection'}` row, but
 * never touched the invoices. So:
 *
 *     Customer page:  ৳0 owed          ✓
 *     Invoice:        due ৳4,200, status 'partial'   ✗  (frozen since checkout)
 *
 * Ten aggregations across `report.service`, `staffReport.service` and
 * `sale.service` sum `$due` as "মোট বাকি". Every one of them kept counting money
 * the shop had already collected and banked.
 *
 * ── What this script does ────────────────────────────────────────────────────
 *
 * Nothing of its own. It calls the very same
 * `dueSettlement.reallocateCustomerInvoices` the live code now runs on every
 * collection, cancellation, return and payment. That is deliberate: a repair
 * script with its own arithmetic is a second implementation, and a second
 * implementation is how the book drifted in the first place. If this script and
 * production ever disagree, one of them is a bug — so there is only one.
 *
 * Because that function is a full recompute rather than a delta, running this
 * twice is the same as running it once, and running it on an already-correct
 * customer writes nothing.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   node scripts/reallocate-due-collections.js                 # dry run (default)
 *   node scripts/reallocate-due-collections.js --shop <id>     # one shop only
 *   node scripts/reallocate-due-collections.js --apply         # write
 *
 * DRY RUN IS THE DEFAULT AND `--apply` IS THE ONLY WAY PAST IT. The dry run
 * prints every invoice that would move, with its before/after due, and the
 * per-shop totals — read that before you write anything.
 *
 * Take a backup first: `node scripts/backup-db.js` (there is no mongodump on
 * the dev machine — see the note in that file).
 */

require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const shopArgIndex = args.indexOf('--shop');
const ONLY_SHOP = shopArgIndex !== -1 ? args[shopArgIndex + 1] : null;

const taka = (n) => `৳${(Math.round((n || 0) * 100) / 100).toLocaleString('en-IN')}`;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  // Required after the connection so the models register against it.
  const Sale = require('../src/models/Sale.model');
  const dueSettlement = require('../src/services/dueSettlement.service');

  console.log(`\n${APPLY ? '*** APPLYING ***' : '--- DRY RUN (no writes) ---'}\n`);

  /**
   * Only customers who have ever had a khata collection can be affected: the
   * allocation pool is `Σ Payment{type:'due_collection'}`, and for everyone else
   * it is empty and the recompute is a no-op. Narrowing here keeps the run
   * proportional to the damage rather than to the size of the database.
   */
  const match = { type: 'due_collection', customer: { $ne: null } };
  if (ONLY_SHOP) match.shop = new mongoose.Types.ObjectId(ONLY_SHOP);

  const affected = await db.collection('payments').aggregate([
    { $match: match },
    { $group: { _id: { shop: '$shop', customer: '$customer' }, pool: { $sum: '$amount' }, n: { $sum: 1 } } },
    { $sort: { pool: -1 } },
  ]).toArray();

  console.log(`Customers with khata collections: ${affected.length}\n`);

  const shopTotals = new Map();
  let movedInvoices = 0;
  let movedTaka = 0;

  for (const row of affected) {
    const { shop, customer } = row._id;

    const cust = await db.collection('customers').findOne({ _id: customer });
    const shopDoc = await db.collection('shops').findOne({ _id: shop });
    const label = `${cust?.name || '(deleted)'} ${cust?.phone ? `(${cust.phone})` : ''}`;

    /**
     * Snapshot BEFORE, so the dry run can report what would change without
     * writing. The recompute itself reports what it changed, but on a dry run
     * it is rolled back and we still want the figures.
     */
    const before = await Sale.find(
      { shop, customer, status: { $ne: 'cancelled' } },
      'invoiceNo due status ledgerSettled'
    ).lean();
    const beforeById = new Map(before.map((s) => [String(s._id), s]));

    /**
     * Run the real thing inside a transaction we control, and ABORT it unless
     * `--apply` was passed. This is what makes the dry run trustworthy: it is
     * not a simulation of the repair, it IS the repair, discarded.
     */
    const session = await mongoose.startSession();
    let changed = [];
    try {
      await session.withTransaction(async () => {
        changed = await dueSettlement.reallocateCustomerInvoices(
          { shopId: shop, customerId: customer },
          session
        );
        if (!APPLY) {
          // Unwind. `withTransaction` retries on transient errors, so a plain
          // `abortTransaction()` here would be re-driven; throwing is the
          // documented way to end it for good.
          throw new DryRunRollback();
        }
      });
    } catch (err) {
      if (!(err instanceof DryRunRollback)) throw err;
    } finally {
      await session.endSession();
    }

    if (changed.length === 0) continue;

    console.log(`${label} @ ${shopDoc?.name || shop}`);
    console.log(`  pool: ${taka(row.pool)} across ${row.n} collection(s) | ledger due now ${taka(cust?.totalDue)}`);
    for (const c of changed) {
      const b = beforeById.get(String(c.sale));
      console.log(
        `    ${c.invoiceNo}: due ${taka(c.dueBefore)} → ${taka(c.dueAfter)}` +
        `  (${b?.status || '?'} → ${c.cleared ? 'completed' : 'partial'})`
      );
      movedInvoices++;
      movedTaka += Math.abs(c.applied);
    }
    console.log('');

    const key = String(shop);
    const t = shopTotals.get(key) || { name: shopDoc?.name, customers: 0, taka: 0 };
    t.customers++;
    t.taka += changed.reduce((s, c) => s + Math.abs(c.applied), 0);
    shopTotals.set(key, t);
  }

  console.log('─'.repeat(70));
  console.log(`Invoices ${APPLY ? 'corrected' : 'that would be corrected'}: ${movedInvoices}`);
  console.log(`Khata money ${APPLY ? 'allocated' : 'to allocate'}: ${taka(movedTaka)}\n`);
  for (const [, t] of shopTotals) {
    console.log(`  ${t.name}: ${t.customers} customer(s), ${taka(t.taka)}`);
  }

  if (!APPLY && movedInvoices > 0) {
    console.log('\nNothing was written. Re-run with --apply to commit (back up first).');
  }

  await mongoose.disconnect();
}

/** Sentinel: ends the dry-run transaction without `withTransaction` retrying it. */
class DryRunRollback extends Error {}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
