/**
 * Backfill: new role presets + purchases.view_cost split
 *
 * Three things happen here, in this order:
 *
 * 1. PRESERVE — `purchases.view_cost` is a brand-new action, so it defaults to
 *    false on every existing role. Any role that can already see purchases
 *    could already see their amounts, so grant it view_cost to keep behaviour
 *    identical. Skipping this would silently blank the purchase ledger for
 *    every Manager in production.
 *
 * 2. SEED — insert the presets each shop is missing (বিক্রয়কর্মী, স্টক ম্যানেজার).
 *    Soft-deleted roles keep their document, so the shop+name unique index
 *    makes those inserts fail and the role stays deleted. That's intended.
 *
 * 3. CLOSE — revoke purchases + suppliers from the default ক্যাশিয়ার role. The
 *    purchase ledger is raw buying-price data, so granting it there handed a
 *    cashier every cost figure despite products.view_cost being off.
 *
 * Run:  node scripts/backfill-role-presets.js --dry-run   (preview, no writes)
 *       node scripts/backfill-role-presets.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const { ROLE_PRESETS } = require('../src/config/permissions');

const DRY_RUN = process.argv.includes('--dry-run');
const CASHIER_NAME = ROLE_PRESETS.cashier.name;
const NEW_PRESET_KEYS = ['salesperson', 'inventory_manager'];

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to MongoDB${DRY_RUN ? '  [DRY RUN — no writes]' : ''}\n`);

  const rolesCol = mongoose.connection.db.collection('roles');

  // ── Step 1: preserve existing purchase-cost visibility ──
  const needsViewCost = await rolesCol
    .find({ 'permissions.purchases.view': true, 'permissions.purchases.view_cost': { $ne: true } })
    .project({ _id: 1, name: 1, shop: 1 })
    .toArray();

  console.log(`Step 1 — grant purchases.view_cost to ${needsViewCost.length} role(s) that already see purchases`);
  for (const r of needsViewCost) console.log(`   • ${r.name} (shop ${r.shop})`);
  if (!DRY_RUN && needsViewCost.length > 0) {
    await rolesCol.updateMany(
      { _id: { $in: needsViewCost.map((r) => r._id) } },
      { $set: { 'permissions.purchases.view_cost': true, updatedAt: new Date() } }
    );
  }

  // ── Step 2: seed the new presets into every existing shop ──
  const shopIds = await rolesCol.distinct('shop');
  console.log(`\nStep 2 — seed new presets across ${shopIds.length} shop(s)`);

  let seeded = 0;
  let skipped = 0;
  for (const shopId of shopIds) {
    for (const key of NEW_PRESET_KEYS) {
      const preset = ROLE_PRESETS[key];
      const existing = await rolesCol.findOne({ shop: shopId, name: preset.name });
      if (existing) {
        skipped++;
        continue;
      }
      if (!DRY_RUN) {
        await rolesCol.insertOne({
          shop: shopId,
          name: preset.name,
          permissions: preset.permissions,
          isDefault: true,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      seeded++;
    }
  }
  console.log(`   seeded ${seeded}, already present ${skipped}`);

  // ── Step 3: close the cashier purchase-cost leak ──
  const leakyCashiers = await rolesCol
    .find({
      name: CASHIER_NAME,
      isDefault: true,
      $or: [{ 'permissions.purchases.view': true }, { 'permissions.suppliers.view': true }],
    })
    .project({ _id: 1, shop: 1 })
    .toArray();

  console.log(`\nStep 3 — revoke purchases + suppliers from ${leakyCashiers.length} default "${CASHIER_NAME}" role(s)`);
  if (!DRY_RUN && leakyCashiers.length > 0) {
    await rolesCol.updateMany(
      { _id: { $in: leakyCashiers.map((r) => r._id) } },
      {
        $set: {
          'permissions.purchases.view': false,
          'permissions.purchases.create': false,
          'permissions.purchases.update': false,
          'permissions.purchases.delete': false,
          'permissions.purchases.view_cost': false,
          'permissions.suppliers.view': false,
          'permissions.suppliers.create': false,
          'permissions.suppliers.update': false,
          'permissions.suppliers.delete': false,
          updatedAt: new Date(),
        },
      }
    );
  }

  // ── Step 4: flush the auth cache for affected staff ──
  // The auth middleware caches user+permissions under `auth:user:{id}` for
  // 300s, so without this a cashier keeps their purchase access for 5 minutes.
  const touchedRoleIds = [...needsViewCost.map((r) => r._id), ...leakyCashiers.map((r) => r._id)];
  if (!DRY_RUN && touchedRoleIds.length > 0) {
    const cacheService = require('../src/services/cache.service');
    const users = await mongoose.connection.db
      .collection('users')
      .find({ role: { $in: touchedRoleIds } })
      .project({ _id: 1 })
      .toArray();
    await Promise.all(
      users.map((u) => cacheService.delete(`auth:user:${u._id}`).catch(() => {}))
    );
    console.log(`\nStep 4 — flushed auth cache for ${users.length} staff account(s)`);
  }

  console.log(`\n${DRY_RUN ? 'Dry run complete — nothing written.' : '✅ Backfill complete.'}`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
