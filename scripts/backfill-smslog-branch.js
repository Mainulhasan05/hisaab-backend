/**
 * Tag the branch on automatic receipt SMS logs written with `branch: null`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Until 2026-09-15 every background receipt — sale receipt, due-collection
 * receipt, invoice-payment receipt — called `sms.service.sendSingle` without a
 * `req`, so its log was written `branch: null`. The message was sent and the
 * quota was charged correctly, but a multi-branch shop reads its SMS history
 * as `{ shop, branch }`, so those rows were invisible from every branch.
 *
 * This fills in the branch from the record each receipt reported on:
 *
 *   sale receipt     → Sale.branch     (via `sale`, else `invoiceNumber`)
 *   payment receipt  → Payment.branch  (same shop + customer, the payment row
 *                                       written in the 5 minutes before the SMS)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Only multi-branch shops, only rows whose branch is null, only rows a source
 * record can be found for. It never overwrites a branch. It touches no quota,
 * no cost and no money — `branch` is a read-scope tag, nothing sums it.
 * Anything unresolved is reported and left alone. Idempotent.
 *
 * Usage:
 *   node scripts/backfill-smslog-branch.js            # report only
 *   node scripts/backfill-smslog-branch.js --apply    # write
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const PAYMENT_WINDOW_MS = 5 * 60 * 1000;

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const db = mongoose.connection.db;
  const shops = await db.collection('shops')
    .find({ multiBranchEnabled: true }, { projection: { name: 1 } })
    .toArray();

  let totalResolved = 0;
  let totalUnresolved = 0;

  for (const shop of shops) {
    const rows = await db.collection('smslogs').find(
      { shop: shop._id, branch: null },
      { projection: { sale: 1, invoiceNumber: 1, message: 1, createdAt: 1, 'recipients.customer': 1 } }
    ).toArray();
    if (rows.length === 0) continue;

    const updates = [];
    const unresolved = [];

    for (const row of rows) {
      let branch = null;
      let via = null;

      if (row.sale || row.invoiceNumber) {
        const sale = await db.collection('sales').findOne(
          row.sale ? { _id: row.sale, shop: shop._id } : { shop: shop._id, invoiceNo: row.invoiceNumber },
          { projection: { branch: 1 } }
        );
        branch = sale?.branch || null;
        via = 'sale';
      } else if (/payment received/.test(row.message || '') && row.recipients?.[0]?.customer) {
        const payment = await db.collection('payments').findOne(
          {
            shop: shop._id,
            customer: row.recipients[0].customer,
            createdAt: { $gte: new Date(row.createdAt.getTime() - PAYMENT_WINDOW_MS), $lte: row.createdAt },
          },
          { sort: { createdAt: -1 }, projection: { branch: 1 } }
        );
        branch = payment?.branch || null;
        via = 'payment';
      }

      if (branch) {
        updates.push({
          updateOne: {
            filter: { _id: row._id, shop: shop._id, branch: null },
            update: { $set: { branch, audience: via === 'sale' ? 'sale_receipt' : 'payment_receipt' } },
          },
        });
      } else {
        unresolved.push(row);
      }
    }

    console.log(`${shop.name} (${shop._id})`);
    console.log(`  ${rows.length} untagged · ${updates.length} resolvable · ${unresolved.length} left alone`);
    for (const row of unresolved.slice(0, 5)) {
      console.log(`    unresolved ${row._id} ${row.createdAt.toISOString()} ${(row.message || '').slice(0, 50).replace(/\n/g, ' ')}`);
    }

    if (APPLY && updates.length) {
      const result = await db.collection('smslogs').bulkWrite(updates, { ordered: false });
      console.log(`  tagged ${result.modifiedCount}`);
    }

    totalResolved += updates.length;
    totalUnresolved += unresolved.length;
  }

  console.log(`\n${totalResolved} resolvable, ${totalUnresolved} unresolved.`);
  if (!APPLY) console.log('DRY RUN — nothing written. Re-run with --apply.');

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.connection.close(); } catch { /* already closed */ }
  process.exit(1);
});
