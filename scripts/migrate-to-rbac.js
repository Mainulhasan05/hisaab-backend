/**
 * Migration: Flat permissions → RBAC Role system
 *
 * This script:
 * 1. Creates default Roles (ম্যানেজার, ক্যাশিয়ার) per shop
 * 2. Migrates users: owner → isOwner:true, manager/staff → role ref
 * 3. Cleans up old fields
 *
 * Run: node scripts/migrate-to-rbac.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const Role = require('../src/models/Role.model');
const { ROLE_PRESETS } = require('../src/config/permissions');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const db = mongoose.connection.db;
  const usersCol = db.collection('users');
  const rolesCol = db.collection('roles');

  // ── Step 1: Get all shops that have users ──
  const shopIds = await usersCol.distinct('shop');
  console.log(`Found ${shopIds.length} shops`);

  // ── Step 2: Create default roles per shop ──
  for (const shopId of shopIds) {
    for (const [key, preset] of Object.entries(ROLE_PRESETS)) {
      const existing = await rolesCol.findOne({ shop: shopId, name: preset.name });
      if (!existing) {
        await rolesCol.insertOne({
          shop: shopId,
          name: preset.name,
          permissions: preset.permissions,
          isDefault: true,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        console.log(`  Created role "${preset.name}" for shop ${shopId}`);
      }
    }
  }

  // ── Step 3: Migrate owner users ──
  const ownerResult = await usersCol.updateMany(
    { role: 'owner' },
    {
      $set: { isOwner: true },
      $unset: { permissions: 1 },
    }
  );
  console.log(`Migrated ${ownerResult.modifiedCount} owners → isOwner: true`);

  // Set role to null for owners (it was a string 'owner', now should be null ObjectId ref)
  await usersCol.updateMany(
    { isOwner: true },
    { $set: { role: null } }
  );

  // ── Step 4: Migrate manager users ──
  for (const shopId of shopIds) {
    const managerRole = await rolesCol.findOne({ shop: shopId, name: ROLE_PRESETS.manager.name });
    if (managerRole) {
      const res = await usersCol.updateMany(
        { shop: shopId, role: 'manager' },
        {
          $set: { isOwner: false, role: managerRole._id },
          $unset: { permissions: 1 },
        }
      );
      if (res.modifiedCount > 0) console.log(`  Migrated ${res.modifiedCount} managers in shop ${shopId}`);
    }
  }

  // ── Step 5: Migrate staff users ──
  for (const shopId of shopIds) {
    const cashierRole = await rolesCol.findOne({ shop: shopId, name: ROLE_PRESETS.cashier.name });
    if (cashierRole) {
      const res = await usersCol.updateMany(
        { shop: shopId, role: 'staff' },
        {
          $set: { isOwner: false, role: cashierRole._id },
          $unset: { permissions: 1 },
        }
      );
      if (res.modifiedCount > 0) console.log(`  Migrated ${res.modifiedCount} staff in shop ${shopId}`);
    }
  }

  // ── Step 6: Ensure all users have isOwner field ──
  await usersCol.updateMany(
    { isOwner: { $exists: false } },
    { $set: { isOwner: false } }
  );

  console.log('\n✅ Migration complete!');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
