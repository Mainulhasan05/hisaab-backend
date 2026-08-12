/**
 * Migration: align the stored list price with the advertised one (৳800/month).
 *
 * WHY
 * ---
 * The landing page, the signup screen and the public help centre have always
 * said ৳৮০০/month. The product said ৳১,০০০: `SUBSCRIPTION_PRICE` was 1000, so
 * `PlatformSetting.defaultMonthlyPrice` was seeded at 1000 and every shop that
 * never bargained got `billing.monthlyPrice: 1000`. A shopkeeper read one price
 * before signing up and a different one on their own billing card the next day.
 *
 * The constant is now 800, but a schema default only applies to a document that
 * does not exist yet — the singleton and every existing shop still hold 1000.
 * That is what this script fixes.
 *
 * WHAT IT TOUCHES
 * ---------------
 * 1. `PlatformSetting.defaultMonthlyPrice` — 1000 → 800, always. This is the
 *    list price and nothing negotiated depends on it.
 *
 * 2. Shops holding exactly 1000 — ONLY with `--shops`, and this is why:
 *    a shop that DEFAULTED to 1000 and a shop that NEGOTIATED 1000 are stored
 *    identically. There is no field that distinguishes them, so dropping every
 *    1000 to 800 would silently cut the price for anyone who genuinely agreed
 *    ৳1,000. The dry run prints the list; decide with it in front of you, and
 *    if only some of them should move, change those in the admin panel instead.
 *    Shops on any other figure are never touched — those bargained.
 *
 * The reverse is deliberately not offered. Raising a shop's price is a
 * conversation, not a migration.
 *
 * Idempotent: a second run reports nothing left to do.
 *
 * Run:  node scripts/migrate-list-price-800.js                  # dry run, settings + shop report
 *       node scripts/migrate-list-price-800.js --apply          # settings only
 *       node scripts/migrate-list-price-800.js --apply --shops  # settings + every shop on 1000
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const { SUBSCRIPTION_PRICE } = require('../src/config/constants');

const APPLY = process.argv.includes('--apply');
const WITH_SHOPS = process.argv.includes('--shops');

// The figure being migrated away from. Hard-coded rather than read from the
// constants file, because the constant is now the destination.
const OLD_PRICE = 1000;

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set — refusing to guess a database.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(
    `Connected to ${mongoose.connection.name}` +
      `${APPLY ? '' : '  [DRY RUN — no writes]'}\n`
  );

  console.log(`List price: ৳${OLD_PRICE} → ৳${SUBSCRIPTION_PRICE}/month\n`);

  const settings = mongoose.connection.db.collection('platformsettings');
  const shops = mongoose.connection.db.collection('shops');

  /* ---- 1. the singleton ------------------------------------------------- */

  const setting = await settings.findOne({ key: 'platform' });

  if (!setting) {
    console.log(
      'PlatformSetting: no singleton yet — it will be created at ' +
        `৳${SUBSCRIPTION_PRICE} on first read. Nothing to do.\n`
    );
  } else if (setting.defaultMonthlyPrice === SUBSCRIPTION_PRICE) {
    console.log(`PlatformSetting: already ৳${SUBSCRIPTION_PRICE}. Nothing to do.\n`);
  } else {
    console.log(
      `PlatformSetting: defaultMonthlyPrice ৳${setting.defaultMonthlyPrice} → ৳${SUBSCRIPTION_PRICE}`
    );
    if (APPLY) {
      await settings.updateOne(
        { key: 'platform' },
        { $set: { defaultMonthlyPrice: SUBSCRIPTION_PRICE } }
      );
      console.log('  ✓ updated\n');
    } else {
      console.log('  (dry run)\n');
    }
  }

  /* ---- 2. shops sitting on the old default ------------------------------ */

  const stuck = await shops
    .find({ 'billing.monthlyPrice': OLD_PRICE })
    .project({ name: 1, phone: 1, 'subscription.plan': 1, 'billing.monthlyPrice': 1 })
    .toArray();

  if (stuck.length === 0) {
    console.log(`No shop is on ৳${OLD_PRICE}. Done.`);
  } else {
    console.log(`${stuck.length} shop(s) on ৳${OLD_PRICE}:\n`);
    for (const shop of stuck) {
      console.log(
        `  ${String(shop._id)}  ${(shop.name || '—').padEnd(28)}` +
          `  ${shop.subscription?.plan || '—'}`
      );
    }
    console.log('');

    if (!WITH_SHOPS) {
      console.log(
        'Not touching them. Some may have NEGOTIATED ৳1,000 — the stored value\n' +
          'looks the same either way. Review the list above, then re-run with\n' +
          '--apply --shops to move all of them, or set the ones that should move\n' +
          'individually in the admin panel.'
      );
    } else if (APPLY) {
      const res = await shops.updateMany(
        { 'billing.monthlyPrice': OLD_PRICE },
        { $set: { 'billing.monthlyPrice': SUBSCRIPTION_PRICE } }
      );
      console.log(`  ✓ ${res.modifiedCount} shop(s) moved to ৳${SUBSCRIPTION_PRICE}`);
    } else {
      console.log(`  (dry run — would move all ${stuck.length} to ৳${SUBSCRIPTION_PRICE})`);
    }
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
