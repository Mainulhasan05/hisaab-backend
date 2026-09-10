/**
 * Give existing paid shops a billing day, taken from the date they already
 * renew on.
 *
 *   node scripts/backfill-billing-day.js           # report only, writes nothing
 *   node scripts/backfill-billing-day.js --apply
 *   node scripts/backfill-billing-day.js --apply --shop <shopId>
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS OPTIONAL, AND THAT IS THE POINT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A shop left at `billingDay: null` behaves exactly as it did before the field
 * existed: a month-mode extension adds a plain calendar month from its anchor.
 * Nothing degrades, nothing warns, no screen looks broken. So this script can
 * be run now, run per shop later, or never run at all.
 *
 * It exists only to save the wait. Without it a shop's day is stamped on its
 * next paid renewal (`billing.service._applyExtension`), which for a yearly
 * shop is up to twelve months away. With it, the operator's call list is
 * organised by date today.
 *
 * ── What it reads the day FROM ──────────────────────────────────────────────
 *
 * `subscription.expiresAt`, because that is the date the shop and the operator
 * have both been treating as the renewal date. It is not a guess about what
 * they would prefer; it is a record of what has been happening.
 *
 * ── Which shops it SKIPS, and why each one ─────────────────────────────────
 *
 *   already has a day   Never overwritten. A stored day is either an operator's
 *                       decision or the shop's own history, and a backfill is
 *                       not the place to revise either. This is what makes the
 *                       script idempotent.
 *   on trial            A trial ends on a day count. Treating that as a billing
 *                       anniversary anchors the shop to a date that meant
 *                       nothing to it — the same rule the automatic stamp
 *                       follows.
 *   no expiresAt        Perpetual and internal shops. They never renew, so
 *                       there is no cycle to anchor.
 *   blocked             A blocked shop is not billing. Whatever it renews on
 *                       will be decided when it is unblocked, in a conversation.
 *
 * ── Day 29, 30 and 31 ──────────────────────────────────────────────────────
 *
 * Kept as they are. A shop whose expiry falls on the 31st genuinely bills on
 * the 31st, and storing 31 is what makes `alignToBillingDay` hand the day back
 * after a February clamp instead of losing it — the whole reason the field
 * exists. Rounding these down to 28 would bake in the drift this is fixing.
 * They are counted separately in the report so the number is visible.
 *
 * ── Reversible ──────────────────────────────────────────────────────────────
 *
 * Clearing a shop's billing day in the admin pricing sheet puts it back on
 * plain calendar months. There is nothing here that cannot be undone from the
 * panel, one shop at a time.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const shopArgIndex = process.argv.indexOf('--shop');
const ONLY_SHOP = shopArgIndex > -1 ? process.argv[shopArgIndex + 1] : null;

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  const Shop = require('../src/models/Shop.model');
  const { toBangladeshDateStr } = require('../src/utils/bdTime.util');
  const { normalizeBillingDay } = require('../src/services/billing.service');

  const query = {
    'subscription.plan': 'paid',
    'subscription.expiresAt': { $ne: null, $exists: true },
    'access.blockedAt': null,
    isActive: { $ne: false },
    // Absent OR null. A shop written before the field existed has neither.
    $or: [{ 'billing.billingDay': null }, { 'billing.billingDay': { $exists: false } }],
  };
  if (ONLY_SHOP) query._id = ONLY_SHOP;

  const shops = await Shop.find(query)
    .select('name phone subscription.expiresAt billing.billingDay')
    .lean();

  console.log('');
  console.log(`── Billing day backfill ${APPLY ? '(APPLY)' : '(dry run)'} ──────────────────────`);
  console.log(`${shops.length} shop(s) eligible.`);
  console.log('');

  if (shops.length === 0) {
    console.log('Nothing to do. Either every paid shop already has a day, or none qualifies.');
    await mongoose.disconnect();
    return;
  }

  const plan = [];
  for (const shop of shops) {
    const iso = toBangladeshDateStr(shop.subscription.expiresAt);
    const day = normalizeBillingDay(iso ? Number(iso.split('-')[2]) : null);
    // A shop whose expiry does not yield a usable day is left alone and named,
    // rather than given a guessed one.
    if (day === null) {
      console.log(`  SKIP  ${shop.name} — unreadable expiry (${shop.subscription.expiresAt})`);
      continue;
    }
    plan.push({ shop, day, iso });
  }

  const lateMonth = plan.filter((p) => p.day >= 29);

  plan.forEach(({ shop, day, iso }) => {
    console.log(`  day ${String(day).padStart(2)}  ${shop.name}  (expires ${iso})`);
  });

  console.log('');
  console.log(`${plan.length} shop(s) would be stamped.`);
  if (lateMonth.length) {
    console.log(
      `${lateMonth.length} of them land on the 29th–31st. Kept as-is on purpose: that is ` +
      'what makes the day survive a February clamp instead of drifting.'
    );
  }

  if (!APPLY) {
    console.log('');
    console.log('Dry run. Re-run with --apply to write.');
    await mongoose.disconnect();
    return;
  }

  const now = new Date();
  let written = 0;
  for (const { shop, day } of plan) {
    // One shop at a time rather than a bulk write: this is a small, one-off
    // list and a per-shop failure should stop at that shop.
    // eslint-disable-next-line no-await-in-loop
    const res = await Shop.updateOne(
      // Re-assert the null guard at write time. If a renewal stamped this shop
      // between the read above and now, that stamp is the more recent truth and
      // this write must lose.
      {
        _id: shop._id,
        $or: [{ 'billing.billingDay': null }, { 'billing.billingDay': { $exists: false } }],
      },
      { $set: { 'billing.billingDay': day, 'billing.billingDaySetAt': now } }
    );
    if (res.modifiedCount) written += 1;
  }

  console.log('');
  console.log(`✓ ${written} shop(s) stamped.`);
  if (written !== plan.length) {
    console.log(`${plan.length - written} skipped — a day was set between the read and the write.`);
  }
  console.log('');
  console.log('Auth caches are not invalidated here. No access decision reads the billing');
  console.log('day, so nothing can be wrongly allowed or refused. A session already open');
  console.log('may show the old value on its billing card until it next refreshes, which');
  console.log('is a label being briefly out of date and not a shop being mis-billed.');
  console.log('');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
