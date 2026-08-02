/**
 * Sync MongoDB indexes with schema declarations.
 *
 * autoIndex is disabled in production (src/config/database.js), so run this
 * once per deploy (or whenever model indexes change):
 *
 *   node scripts/sync-indexes.js           # dry-run: show planned changes
 *   node scripts/sync-indexes.js --apply   # apply: create missing, drop stray
 *
 * syncIndexes() drops indexes that are no longer declared in the schema and
 * creates missing ones. Index builds on MongoDB 4.2+ are online (non-blocking).
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const apply = process.argv.includes('--apply');

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
  });
  console.log(`Connected to ${mongoose.connection.host} (${apply ? 'APPLY' : 'DRY-RUN'})`);

  // Register all models
  require('../src/models');

  const modelNames = mongoose.modelNames();
  let changes = 0;

  for (const name of modelNames) {
    const model = mongoose.model(name);
    try {
      const declared = model.schema.indexes().map(([fields, opts]) => ({
        key: fields,
        unique: !!(opts && opts.unique),
      }));
      const existing = await model.collection.indexes().catch(() => []);
      const existingKeys = new Set(existing.map((i) => JSON.stringify(i.key)));
      const declaredKeys = new Set(declared.map((i) => JSON.stringify(i.key)));

      const toCreate = declared.filter((i) => !existingKeys.has(JSON.stringify(i.key)));
      const toDrop = existing.filter(
        (i) => i.name !== '_id_' && !declaredKeys.has(JSON.stringify(i.key))
      );

      if (toCreate.length || toDrop.length) {
        changes += toCreate.length + toDrop.length;
        console.log(`\n${name} (${model.collection.name}):`);
        toCreate.forEach((i) => console.log(`  + create ${JSON.stringify(i.key)}${i.unique ? ' (unique)' : ''}`));
        toDrop.forEach((i) => console.log(`  - drop   ${i.name} ${JSON.stringify(i.key)}`));

        if (apply) {
          const dropped = await model.syncIndexes();
          console.log(`  synced (dropped: ${JSON.stringify(dropped)})`);
        }
      }
    } catch (err) {
      console.error(`  ${name}: ERROR ${err.message}`);
    }
  }

  console.log(changes === 0 ? '\nAll indexes in sync.' : `\n${changes} change(s) ${apply ? 'applied' : 'pending — rerun with --apply'}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
