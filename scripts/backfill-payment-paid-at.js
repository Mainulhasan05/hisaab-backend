/**
 * Stamp `Payment.paidAt` on rows written before the field existed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `paidAt` is when the money changed hands, as opposed to `createdAt`, which is
 * when the row was typed in. Nothing could backdate a payment before the field
 * existed, so for every historical row the two are the same date — and that is
 * exactly what this writes.
 *
 * It is a tidying pass, not a repair. `utils/paymentDate.util.paidAtMatch` reads
 * both shapes on purpose, so every report is already correct with or without
 * this having been run. What running it buys:
 *
 *   • The `$or` in each date-ranged query collapses to a single indexed branch
 *     in practice, instead of unioning two.
 *   • `getCustomerHistory` sorts on `paidAt` directly. Unstamped rows sort as
 *     null — last in a newest-first list, which is where they belong anyway,
 *     but a payment backdated to before them would order ahead of them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Only rows with no `paidAt` are touched, so it is idempotent and can never
 * overwrite a real collection date. It writes through the driver rather than
 * Mongoose documents deliberately: `Payment` carries `immutableGuard`, which
 * refuses `save()` on a ledger row — correctly, since a payment's amount must
 * never be editable. Stamping a field that was absent is not an edit to the
 * ledger, it is completing the record of one.
 *
 * Usage:
 *   node scripts/backfill-payment-paid-at.js            # report only
 *   node scripts/backfill-payment-paid-at.js --apply    # write
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const Payment = require('../src/models/Payment.model');
  const collection = Payment.collection;

  const missing = await collection.countDocuments({ paidAt: null });
  const total = await collection.countDocuments({});

  console.log(`${total} payment rows total.`);
  console.log(`${missing} without paidAt.\n`);

  if (missing === 0) {
    console.log('Nothing to do.');
    await mongoose.connection.close();
    return;
  }

  const sample = await collection
    .find({ paidAt: null }, { projection: { _id: 1, type: 1, amount: 1, createdAt: 1 } })
    .sort({ createdAt: -1 })
    .limit(5)
    .toArray();

  console.log('Sample of what would be stamped (paidAt := createdAt):');
  for (const row of sample) {
    console.log(`  ${row._id}  ${row.type || '-'}  ৳${row.amount}  ${row.createdAt?.toISOString?.() || row.createdAt}`);
  }
  console.log('');

  if (!APPLY) {
    console.log('DRY RUN — nothing written. Re-run with --apply.');
    await mongoose.connection.close();
    return;
  }

  // An update PIPELINE, so `createdAt` is read server-side per document; there
  // is no read-modify-write here and no need to page through the collection.
  const result = await collection.updateMany(
    { paidAt: null },
    [{ $set: { paidAt: '$createdAt' } }]
  );

  console.log(`Stamped ${result.modifiedCount} rows.`);

  const remaining = await collection.countDocuments({ paidAt: null });
  console.log(`${remaining} still without paidAt (expected 0).`);

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.connection.close(); } catch { /* already closed */ }
  process.exit(1);
});
