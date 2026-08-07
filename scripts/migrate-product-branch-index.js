/**
 * Phase 3 index migration — per-branch product catalogues.
 *
 *   node scripts/migrate-product-branch-index.js           # dry-run (default)
 *   node scripts/migrate-product-branch-index.js --apply   # execute
 *
 * WHAT AND WHY
 * ------------
 * Product codes are now unique per BRANCH, not per shop: two branches
 * legitimately stock the same item under the same code as two separate
 * documents. The schema declares {shop, branch, code} unique, but production
 * runs with autoIndex: false, so the old {shop, code} unique index has to be
 * swapped explicitly.
 *
 * For single-branch shops `branch` is always null, so the new index means
 * exactly what the old one meant — no behaviour change for them.
 *
 * The replacement is created BEFORE the old one is dropped, so code uniqueness
 * is never unenforced in between. Idempotent — safe to re-run.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

const OLD_UNIQUE = 'shop_1_code_1';                  // was unique
const NEW_UNIQUE = { shop: 1, branch: 1, code: 1 };
const NEW_UNIQUE_NAME = 'shop_1_branch_1_code_1';
const NEW_PLAIN = { shop: 1, code: 1 };              // non-unique, for transfer matching
const NEW_PLAIN_NAME = 'shop_1_code_1_plain';
const NEW_LIST = { shop: 1, branch: 1, createdAt: -1 };
const NEW_LIST_NAME = 'shop_1_branch_1_createdAt_-1';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
  });
  console.log(`Connected to ${mongoose.connection.host} (${APPLY ? 'APPLY' : 'DRY-RUN'})\n`);

  const col = mongoose.connection.db.collection('products');
  const [indexes, docCount, unbranched] = await Promise.all([
    col.indexes(),
    col.countDocuments(),
    col.countDocuments({ $or: [{ branch: null }, { branch: { $exists: false } }] }),
  ]);
  const byName = new Map(indexes.map((i) => [i.name, i]));

  console.log(`Products: ${docCount} total, ${unbranched} with no branch (single-branch shops)`);
  console.log('Current indexes:');
  indexes.forEach((i) => console.log(`  ${i.name} ${JSON.stringify(i.key)}${i.unique ? ' UNIQUE' : ''}`));
  console.log('');

  // Safety: the new unique index cannot build if duplicates already exist.
  const dupes = await col.aggregate([
    { $group: { _id: { shop: '$shop', branch: '$branch', code: '$code' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 10 },
  ]).toArray();

  if (dupes.length) {
    console.error('ABORT: duplicate (shop, branch, code) triples exist — the unique index would fail:');
    dupes.forEach((d) => console.error(`  shop=${d._id.shop} branch=${d._id.branch} code=${d._id.code} ×${d.n}`));
    await mongoose.connection.close();
    process.exit(1);
  }
  console.log('Duplicate check: none found.\n');

  const plan = [];
  if (!byName.has(NEW_UNIQUE_NAME)) plan.push(['create', NEW_UNIQUE_NAME, NEW_UNIQUE, true]);
  if (!byName.has(NEW_LIST_NAME)) plan.push(['create', NEW_LIST_NAME, NEW_LIST, false]);
  if (byName.get(OLD_UNIQUE)?.unique) plan.push(['drop', OLD_UNIQUE, byName.get(OLD_UNIQUE).key, false]);
  if (!byName.has(NEW_PLAIN_NAME) && !(byName.has(OLD_UNIQUE) && !byName.get(OLD_UNIQUE).unique)) {
    plan.push(['create', NEW_PLAIN_NAME, NEW_PLAIN, false]);
  }

  if (!plan.length) {
    console.log('Already migrated — nothing to do.');
    await mongoose.connection.close();
    return;
  }

  console.log('Planned changes:');
  plan.forEach(([op, name, key, uniq]) =>
    console.log(`  ${op.padEnd(6)} ${name} ${JSON.stringify(key)}${uniq ? ' UNIQUE' : ''}`));
  console.log('');

  if (!APPLY) {
    console.log('Dry-run only. Re-run with --apply to execute.');
    await mongoose.connection.close();
    return;
  }

  // Creates first, drop last — uniqueness is never unenforced.
  for (const [op, name, key, uniq] of plan.filter(([o]) => o === 'create')) {
    await col.createIndex(key, { unique: uniq, name });
    console.log(`  ✓ created ${name}`);
  }
  for (const [op, name] of plan.filter(([o]) => o === 'drop')) {
    await col.dropIndex(name);
    console.log(`  ✓ dropped ${name} (shop-wide unique)`);
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
