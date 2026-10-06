/**
 * ─────────────────────────────────────────────────────────────────────────────
 * BACKFILL: `Sale.advanceUsed` on invoices a deposit paid before the field existed
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `advanceUsed` is what lets an invoice print "অগ্রিম থেকে কাটা ৳95" instead of
 * a পরিশোধিত/বাকি pair that does not add up. `createSale` snapshots it from
 * 2026-10-06; older invoices have only `ledgerSettled`, which the slip then
 * labels "বাকি আদায় থেকে সমন্বয়" — right money, wrong word, when it was a deposit.
 *
 * ── The one rule, and why it is exact ────────────────────────────────────────
 *
 * The reallocator's pool is `advance` + `due_collection` rows. For a customer
 * whose live pool holds ONLY `advance` rows, every taka of `ledgerSettled` on
 * every one of their invoices came from a deposit — there is nothing else it
 * could be. So `advanceUsed = ledgerSettled` for those, and nothing is guessed.
 *
 * A customer with BOTH kinds cannot be split honestly after the fact (the pool
 * does not record which taka landed where), so they are listed and SKIPPED.
 * Their invoices keep the collection label, which is what they printed before.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   node scripts/backfill-sale-advance-used.js                 # dry run (default)
 *   node scripts/backfill-sale-advance-used.js --shop <id>     # one shop only
 *   node scripts/backfill-sale-advance-used.js --apply         # write
 *
 * Idempotent: an invoice that already carries `advanceUsed` is never touched.
 * Run AFTER `reallocate-due-collections.js --apply`, so `ledgerSettled` is
 * already right when it is copied.
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

  console.log(`\n${APPLY ? '*** APPLYING ***' : '--- DRY RUN (no writes) ---'}\n`);

  const match = {
    type: { $in: ['advance', 'due_collection'] },
    customer: { $ne: null },
    // Same exclusion the pool applies — a voided row is not money held.
    status: { $ne: 'cancelled' },
  };
  if (ONLY_SHOP) match.shop = new mongoose.Types.ObjectId(ONLY_SHOP);

  const pools = await db.collection('payments').aggregate([
    { $match: match },
    {
      $group: {
        _id: { shop: '$shop', customer: '$customer' },
        types: { $addToSet: '$type' },
      },
    },
  ]).toArray();

  let fixed = 0;
  let fixedTaka = 0;
  const skipped = [];

  for (const { _id: { shop, customer }, types } of pools) {
    if (!types.includes('advance')) continue;

    const sales = await db.collection('sales').find(
      {
        shop,
        customer,
        status: { $ne: 'cancelled' },
        ledgerSettled: { $gt: 0 },
        advanceUsed: { $exists: false },
      },
      { projection: { invoiceNo: 1, ledgerSettled: 1 } }
    ).toArray();
    if (sales.length === 0) continue;

    const cust = await db.collection('customers').findOne({ _id: customer }, { projection: { name: 1, phone: 1 } });
    const label = `${cust?.name || '(deleted)'}${cust?.phone ? ` (${cust.phone})` : ''} @ shop ${shop}`;

    if (types.includes('due_collection')) {
      skipped.push(`${label} — ${sales.length} invoice(s), mixed pool`);
      continue;
    }

    console.log(label);
    for (const s of sales) {
      console.log(`    ${s.invoiceNo}: advanceUsed ← ${taka(s.ledgerSettled)}`);
      if (APPLY) {
        await db.collection('sales').updateOne(
          { _id: s._id, shop, advanceUsed: { $exists: false } },
          { $set: { advanceUsed: s.ledgerSettled } }
        );
      }
      fixed++;
      fixedTaka += s.ledgerSettled;
    }
  }

  console.log('─'.repeat(70));
  console.log(`Invoices ${APPLY ? 'backfilled' : 'that would be backfilled'}: ${fixed} (${taka(fixedTaka)})`);
  if (skipped.length) {
    console.log(`\nSkipped — deposit AND collections in one pool, cannot be split honestly:`);
    for (const line of skipped) console.log(`  ${line}`);
  }
  if (!APPLY && fixed > 0) console.log('\nNothing was written. Re-run with --apply to commit.');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
