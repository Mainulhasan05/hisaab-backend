/**
 * One-time migration: re-activate shops incorrectly set to isActive=false
 * due to a bug in updateShopStatus where setting status='trial'|'expired'
 * was incorrectly setting isActive=false.
 *
 * Run from hisaab-backend/:
 *   node scripts/fix-inactive-shops.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const Shop = require('../src/models/Shop.model');

  // Shops that are trial/active/expired but were incorrectly deactivated
  const broken = await Shop.find({
    isActive: false,
    'subscription.status': { $in: ['trial', 'active', 'expired'] },
  }).lean();

  console.log(`Found ${broken.length} incorrectly deactivated shop(s):`);
  broken.forEach((s) =>
    console.log(`  - ${s.name} (status: ${s.subscription?.status})`)
  );

  if (broken.length === 0) {
    console.log('Nothing to fix.');
    process.exit(0);
  }

  const result = await Shop.updateMany(
    { isActive: false, 'subscription.status': { $in: ['trial', 'active', 'expired'] } },
    { $set: { isActive: true } }
  );

  console.log(`Fixed ${result.modifiedCount} shop(s). They can now log in again.`);
  process.exit(0);
}

run().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
