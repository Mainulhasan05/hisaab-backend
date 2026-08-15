/**
 * Migration: give the stored SMS price list an actual volume discount.
 *
 * WHY
 * ---
 * `PlatformSetting.smsTiers` was seeded with six packs, five of which worked
 * out to exactly ৳0.40 per SMS:
 *
 *     100 → ৳50   (৳0.50)
 *     250 → ৳100  (৳0.40)  [Popular]
 *     500 → ৳200  (৳0.40)
 *    1000 → ৳400  (৳0.40)  [Best value]
 *    2500 → ৳1000 (৳0.40)
 *    5000 → ৳2000 (৳0.40)
 *
 * That is a quantity picker, not a price list. A shop has no reason to buy
 * anything past the smallest pack that covers the month, and the "Best value"
 * badge on the 1000 rung is not true — it is the same rate as the two rungs
 * below it and the two above.
 *
 * It also never reached anyone: the admin panel priced its own hard-coded packs
 * at `quantity × 0.40` and read this document not at all, so the 100-pack
 * displayed ৳40 against the ৳50 stored here, and the 2500 and 5000 packs were
 * unreachable. The panel now reads the setting, which is what makes the stored
 * ladder worth fixing.
 *
 * WHAT IT TOUCHES
 * ---------------
 * `PlatformSetting.smsTiers`, and nothing else. Specifically NOT:
 *
 *   · `defaultSmsUnitPrice` — still ৳0.40, and the new ladder is anchored on it
 *     at the 1000 rung so "the standard rate" keeps meaning something.
 *   · `Shop.billing.smsUnitPrice` — every negotiated rate is left alone. A
 *     bargained rate is a conversation that happened; a migration must not
 *     overwrite it.
 *   · Past `SMSQuota.allocations` and `PlatformPayment` rows — those record what
 *     a purchase actually cost at the time, which does not change retroactively.
 *
 * THE LADDER IS A SUGGESTION
 * --------------------------
 * The rates below descend from ৳0.55 to ৳0.33, anchored at ৳0.40 for 1000.
 * Whether those are the right numbers is a pricing decision, not an engineering
 * one — it depends on what MimSMS charges you, which this repo does not know.
 * Run the dry run, and if the shape is right but the numbers are not, set them
 * on the admin panel's Platform settings page instead of here.
 *
 * Idempotent: a second run reports nothing left to do.
 *
 * Run:  node scripts/migrate-sms-tier-ladder.js           # dry run
 *       node scripts/migrate-sms-tier-ladder.js --apply
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

/** Matches the schema default in `PlatformSetting.model.js`. Keep them in step. */
const LADDER = [
  { quantity: 100, price: 55, label: '১০০ এসএমএস' },
  { quantity: 250, price: 120, label: '২৫০ এসএমএস', badge: 'Popular' },
  { quantity: 500, price: 220, label: '৫০০ এসএমএস' },
  { quantity: 1000, price: 400, label: '১০০০ এসএমএস' },
  { quantity: 2500, price: 900, label: '২৫০০ এসএমএস' },
  { quantity: 5000, price: 1650, label: '৫০০০ এসএমএস', badge: 'Best value' },
];

const rate = (t) => (t.quantity > 0 ? t.price / t.quantity : 0);

const printLadder = (label, tiers) => {
  console.log(`\n${label}`);
  if (!tiers?.length) {
    console.log('   (none)');
    return;
  }
  tiers.forEach((t) => {
    console.log(
      `   ${String(t.quantity).padStart(5)} SMS  →  ৳${String(t.price).padStart(5)}` +
      `   =  ৳${rate(t).toFixed(3)}/SMS${t.badge ? `   [${t.badge}]` : ''}`
    );
  });

  // The property that makes it a ladder. Printed rather than asserted, because
  // an operator's own numbers are theirs to choose.
  const rates = tiers.map(rate);
  const descends = rates.every((r, i) => i === 0 || r < rates[i - 1]);
  console.log(`   ${descends ? '✓' : '✗'} gets cheaper per SMS as the pack grows`);
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const settings = mongoose.connection.db.collection('platformsettings');

  const current = await settings.findOne({ key: 'platform' });

  if (!current) {
    console.log(
      'No settings document exists yet. Nothing to migrate — the schema default\n' +
      'already carries the new ladder, and it will be written on first read.'
    );
    await mongoose.disconnect();
    return;
  }

  printLadder('CURRENT', current.smsTiers);
  printLadder('PROPOSED', LADDER);

  const unchanged =
    JSON.stringify((current.smsTiers || []).map((t) => [t.quantity, t.price])) ===
    JSON.stringify(LADDER.map((t) => [t.quantity, t.price]));

  if (unchanged) {
    console.log('\nAlready on this ladder. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    console.log(
      '\nDRY RUN — nothing written. Re-run with --apply to store the proposed ladder,\n' +
      'or set your own numbers on the admin panel’s Platform settings page.'
    );
    await mongoose.disconnect();
    return;
  }

  await settings.updateOne(
    { key: 'platform' },
    { $set: { smsTiers: LADDER, updatedAt: new Date() } }
  );

  console.log('\n✓ Ladder updated. Negotiated per-shop rates were not touched.');
  console.log(
    '  Next: set the gateway cost (what one SMS costs you at MimSMS) on the\n' +
    '  Platform settings page — it is what turns on the margin figure and the\n' +
    '  below-cost warning in the allocation sheet.'
  );

  await mongoose.disconnect();
})().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
