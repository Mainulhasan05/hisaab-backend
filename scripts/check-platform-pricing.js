/**
 * Read what the platform singleton ACTUALLY prices, and optionally seed the
 * package ladder if it has none.
 *
 *   node scripts/check-platform-pricing.js           # report only, writes nothing
 *   node scripts/check-platform-pricing.js --apply   # seed an EMPTY ladder only
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS RUNS BEFORE ANYTHING ELSE SHIPS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A Mongoose schema default applies to a document that does not exist yet. The
 * `PlatformSetting` singleton in production was created long before
 * `subscriptionPackages` was added to the schema, so the 800 / 4000 / 8000
 * ladder written there as a default has never been applied to it. The document
 * may hold an empty list.
 *
 * That is not a cosmetic gap. `platformCheckout.service.quote` falls back to a
 * SINGLE one-month package when the list is empty:
 *
 *     configured = settings.subscriptionPackages?.length
 *       ? settings.subscriptionPackages
 *       : [{ months: 1, price: listMonthly }]
 *
 * So an empty ladder means the owner's billing page offers one month and
 * nothing else — no 6-month, no yearly, no volume discount — while the code,
 * the schema and the admin settings screen all read as though three packages
 * exist. Everything looks correct from the inside.
 *
 * The same trap has now been recorded three times in this codebase (VAT, the
 * SMS tier ladder, and the ৳1000 → ৳800 list price). This script exists so the
 * fourth time is a report instead of a surprise.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT --apply WILL AND WILL NOT DO
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It seeds the ladder ONLY when the stored one is empty or missing. A ladder
 * that already has rungs is reported and left alone, whatever it says, because
 * a stored ladder is somebody's pricing decision and this script has no way to
 * tell a deliberate promotion from a stale default. Change those in the admin
 * settings screen, where the change is attributed and reversible.
 *
 * It never touches `defaultMonthlyPrice` — `migrate-list-price-800.js` owns
 * that field and already handles the 1000 → 800 case. This one only reports it,
 * so the two scripts cannot disagree about who moved it.
 *
 * It never touches a shop. Per-shop prices are negotiated figures and moving
 * them is a conversation, not a migration.
 *
 * Idempotent: a second run finds a populated ladder and writes nothing.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const { SUBSCRIPTION_PRICE } = require('../src/config/constants');

const APPLY = process.argv.includes('--apply');

/**
 * The intended ladder. Kept literal here rather than imported from the schema
 * so that this script reports what SHOULD be true independently of what the
 * schema currently defaults to — a check that reads its expectation from the
 * thing it is checking cannot fail.
 */
const INTENDED = [
  { months: 1, price: 800, label: '১ মাস' },
  { months: 6, price: 4000, label: '৬ মাস', badge: 'জনপ্রিয়' },
  { months: 12, price: 8000, label: '১ বছর', badge: 'সেরা মূল্য' },
];

const taka = (n) => `৳${Number(n).toLocaleString('en-US')}`;

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const PlatformSetting = require('../src/models/PlatformSetting.model');

  // Read raw, without `current()`, so an absent document is reported as absent
  // rather than silently upserted with today's defaults — which would make the
  // problem disappear without anyone learning it had been there.
  const setting = await PlatformSetting.findOne({ key: 'platform' }).lean();

  console.log('');
  console.log('── Platform pricing ──────────────────────────────────────────');

  if (!setting) {
    console.log('No PlatformSetting document exists.');
    console.log('It will be created with the current schema defaults on the first read,');
    console.log('which is the correct outcome. Nothing to do here.');
    await mongoose.disconnect();
    return;
  }

  // ── the monthly list price ──
  const monthly = setting.defaultMonthlyPrice;
  const monthlyOk = Number(monthly) === SUBSCRIPTION_PRICE;
  console.log(
    `defaultMonthlyPrice : ${taka(monthly)}  ${monthlyOk ? '✓' : `✗ expected ${taka(SUBSCRIPTION_PRICE)}`}`
  );
  if (!monthlyOk) {
    console.log('  → run: node scripts/migrate-list-price-800.js --apply');
    console.log('    (that script owns this field; this one only reports it)');
  }

  // ── the package ladder ──
  const stored = Array.isArray(setting.subscriptionPackages) ? setting.subscriptionPackages : [];
  console.log('');
  console.log(`subscriptionPackages: ${stored.length} rung(s)`);

  if (stored.length === 0) {
    console.log('  EMPTY. The owner billing page is offering a single one-month package');
    console.log('  and no volume discount, whatever the admin settings screen shows.');
    console.log('');
    console.log('  Intended ladder:');
    INTENDED.forEach((p) => console.log(`    ${String(p.months).padStart(2)} month(s)  ${taka(p.price)}`));

    if (!APPLY) {
      console.log('');
      console.log('  Dry run. Re-run with --apply to seed it.');
    } else {
      await PlatformSetting.updateOne(
        { key: 'platform' },
        { $set: { subscriptionPackages: INTENDED } }
      );
      console.log('');
      console.log('  ✓ Seeded.');
    }
  } else {
    // A populated ladder is reported and left alone. Comparing it to INTENDED
    // and "fixing" differences would overwrite a deliberate promotion.
    const listMonthly = Number(monthly) || SUBSCRIPTION_PRICE;
    stored
      .slice()
      .sort((a, b) => a.months - b.months)
      .forEach((p) => {
        const perMonth = p.months > 0 ? Math.round(p.price / p.months) : 0;
        const vsList = listMonthly * p.months;
        const saving = vsList - p.price;
        console.log(
          `  ${String(p.months).padStart(2)} month(s)  ${taka(p.price).padEnd(10)}` +
          `  ${taka(perMonth)}/mo` +
          (saving > 0 ? `  (saves ${taka(saving)} vs ${p.months}× list)` : '')
        );
      });
    console.log('');
    console.log('  Populated — left untouched. A stored ladder is a pricing decision;');
    console.log('  change it in the admin settings screen, where it is attributed.');
  }

  // ── everything else the billing screens read ──
  console.log('');
  console.log('── Related figures (report only) ─────────────────────────────');
  console.log(`defaultTrialDays    : ${setting.defaultTrialDays}`);
  console.log(`defaultSmsUnitPrice : ${taka(setting.defaultSmsUnitPrice)}`);
  console.log(`warningDays         : ${setting.warningDays}`);
  console.log(`billingProvider     : ${setting.billingProvider}`);
  console.log('');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
