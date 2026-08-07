/**
 * Phase 1 index migration — StockTransfer.transferNo scope fix (FEATURE_AUDIT.md M-9).
 *
 *   node scripts/migrate-stockTransfer-index.js           # dry-run (default)
 *   node scripts/migrate-stockTransfer-index.js --apply   # execute
 *
 * WHY THIS EXISTS AS A SEPARATE SCRIPT
 * ------------------------------------
 * `transferNo` was declared `unique: true` on the field, producing a GLOBAL
 * unique index `transferNo_1`. Numbers are generated per shop (`TRF-000001`,
 * `TRF-000002`, … counted within one shop), so two different shops collide on
 * their first transfer. The schema now declares `{shop, transferNo}` unique
 * instead — but a schema edit does not change the database:
 *
 *   - production runs with `autoIndex: false` (src/config/database.js), and
 *   - `scripts/sync-indexes.js` only registers models exported from
 *     `src/models/index.js`, which does not include StockTransfer.
 *
 * So the stale global index has to be dropped explicitly. Run this as part of
 * the Phase 1 deploy. It is idempotent — safe to re-run.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

const OLD_INDEX = 'transferNo_1';
const NEW_KEY = { shop: 1, transferNo: 1 };
const NEW_NAME = 'shop_1_transferNo_1';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
  });
  console.log(`Connected to ${mongoose.connection.host} (${APPLY ? 'APPLY' : 'DRY-RUN'})\n`);

  const db = mongoose.connection.db;
  const exists = (await db.listCollections({ name: 'stocktransfers' }).toArray()).length > 0;

  if (!exists) {
    console.log('Collection `stocktransfers` does not exist yet — nothing to migrate.');
    console.log('The correct index will be built from the schema on first write.');
    await mongoose.connection.close();
    return;
  }

  const col = db.collection('stocktransfers');
  const [indexes, docCount] = await Promise.all([col.indexes(), col.countDocuments()]);
  const names = indexes.map((i) => i.name);

  console.log(`Documents: ${docCount}`);
  console.log('Current indexes:');
  indexes.forEach((i) => console.log(`  ${i.name} ${JSON.stringify(i.key)}${i.unique ? ' UNIQUE' : ''}`));
  console.log('');

  // Safety: a per-shop unique index cannot be built if duplicates already exist.
  if (docCount > 0) {
    const dupes = await col.aggregate([
      { $group: { _id: { shop: '$shop', transferNo: '$transferNo' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: 10 },
    ]).toArray();

    if (dupes.length) {
      console.error('ABORT: duplicate (shop, transferNo) pairs exist — the unique index would fail:');
      dupes.forEach((d) => console.error(`  shop=${d._id.shop} transferNo=${d._id.transferNo} ×${d.n}`));
      console.error('\nResolve these before running with --apply.');
      await mongoose.connection.close();
      process.exit(1);
    }
    console.log('Duplicate check: none found.\n');
  }

  const plan = [];
  if (!names.includes(NEW_NAME)) plan.push(`create ${NEW_NAME} ${JSON.stringify(NEW_KEY)} UNIQUE`);
  if (names.includes(OLD_INDEX)) plan.push(`drop   ${OLD_INDEX} (global unique — the bug)`);

  if (!plan.length) {
    console.log('Already migrated — nothing to do.');
    await mongoose.connection.close();
    return;
  }

  console.log('Planned changes:');
  plan.forEach((p) => console.log(`  ${p}`));
  console.log('');

  if (!APPLY) {
    console.log('Dry-run only. Re-run with --apply to execute.');
    await mongoose.connection.close();
    return;
  }

  // Create the replacement BEFORE dropping the old one, so uniqueness is never
  // unenforced in between.
  if (!names.includes(NEW_NAME)) {
    await col.createIndex(NEW_KEY, { unique: true, name: NEW_NAME });
    console.log(`  ✓ created ${NEW_NAME}`);
  }
  if (names.includes(OLD_INDEX)) {
    await col.dropIndex(OLD_INDEX);
    console.log(`  ✓ dropped ${OLD_INDEX}`);
  }

  const after = await col.indexes();
  console.log('\nIndexes now:');
  after.forEach((i) => console.log(`  ${i.name} ${JSON.stringify(i.key)}${i.unique ? ' UNIQUE' : ''}`));
  console.log('\nDone.');

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error('\nMigration failed:', err.message);
  try { await mongoose.connection.close(); } catch {}
  process.exit(1);
});
