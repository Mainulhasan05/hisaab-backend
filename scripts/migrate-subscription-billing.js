/**
 * Migration: subscription & billing (SUBSCRIPTION_PLAN.md §10.1)
 *
 * Five things, in this order:
 *
 * 1. NORMALISE EXPIRY — every `subscription.expiresAt` is moved to the END of
 *    its Bangladesh day. Existing dates were stored at UTC midnight, which is
 *    06:00 Dhaka, so every shop has been losing most of its final paid day. This
 *    step only ever moves an expiry FORWARD (by up to 18 hours), so it cannot
 *    take access away from anyone.
 *
 * 2. BILLING PROFILE — `billing.monthlyPrice` from the old
 *    `subscription.monthlyPrice` (or 1000), and `billing.smsUnitPrice`
 *    RECOVERED from the shop's most recent SMS allocation where one exists.
 *    That rate was negotiated on the phone and never recorded anywhere else;
 *    the allocation history is the only surviving trace of it.
 *
 * 3. GRACE — 0 for everyone, i.e. expiry behaves exactly as it does today.
 *
 * 4. LEGACY BLOCKS — shops switched off through `isActive: false` or
 *    `status: 'suspended'` get an explicit `access.blockedAt`, so they appear
 *    on the Blocked tab and can be unblocked through the one endpoint that now
 *    exists. Without this they stay blocked (the resolver reads both legacy
 *    switches) but are harder to find, and a shop you cannot find is a shop you
 *    cannot let back in.
 *
 * 5. PLATFORM SETTINGS — create the singleton with the current constants.
 *
 * Nothing here changes what any shop may do today. Idempotent: safe to re-run.
 *
 * Run:  node scripts/migrate-subscription-billing.js --dry-run
 *       node scripts/migrate-subscription-billing.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const {
  endOfBangladeshDay,
  toBangladeshDateStr,
} = require('../src/utils/bdTime.util');

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to MongoDB${DRY_RUN ? '  [DRY RUN — no writes]' : ''}\n`);

  const shops = mongoose.connection.db.collection('shops');
  const smsQuotas = mongoose.connection.db.collection('smsquotas');

  const all = await shops
    .find({})
    .project({ name: 1, isActive: 1, subscription: 1, billing: 1, access: 1 })
    .toArray();

  console.log(`Found ${all.length} shop(s)\n`);

  // Recover each shop's negotiated SMS rate from its latest allocation.
  const quotaRows = await smsQuotas.find({}).project({ shop: 1, allocations: 1 }).toArray();
  const rateByShop = new Map();
  for (const q of quotaRows) {
    const latest = (q.allocations || [])
      .filter((a) => a && a.quantity > 0 && typeof a.price === 'number')
      .sort((a, b) => new Date(b.allocatedAt || 0) - new Date(a.allocatedAt || 0))[0];
    if (latest) {
      rateByShop.set(String(q.shop), Number((latest.price / latest.quantity).toFixed(3)));
    }
  }
  console.log(`Recovered a negotiated SMS rate for ${rateByShop.size} shop(s) from allocation history\n`);

  let expiryFixed = 0;
  let profiled = 0;
  let legacyBlocks = 0;

  for (const shop of all) {
    const set = {};
    const sub = shop.subscription || {};

    // 1 — expiry to end of the Bangladesh day (forward-only by construction)
    if (sub.expiresAt) {
      const normalised = endOfBangladeshDay(sub.expiresAt);
      if (normalised && normalised.getTime() !== new Date(sub.expiresAt).getTime()) {
        set['subscription.expiresAt'] = normalised;
        expiryFixed += 1;
        if (DRY_RUN) {
          console.log(
            `   • ${shop.name}: expiry ${new Date(sub.expiresAt).toISOString()} → ` +
            `${normalised.toISOString()} (${toBangladeshDateStr(normalised)} 23:59 Dhaka)`
          );
        }
      }
    }

    // 2 — billing profile
    if (shop.billing?.monthlyPrice === undefined) {
      set['billing.monthlyPrice'] = sub.monthlyPrice ?? 1000;
      set['billing.cycleMonths'] = 1;
      set['billing.currency'] = 'BDT';
      profiled += 1;
    }
    if (shop.billing?.smsUnitPrice === undefined) {
      set['billing.smsUnitPrice'] = rateByShop.get(String(shop._id)) ?? 0.4;
    }

    // 3 — grace defaults to none, i.e. today's behaviour
    if (sub.graceDays === undefined) set['subscription.graceDays'] = 0;

    // 4 — make legacy suspensions explicit and therefore reversible
    const legacyBlocked = shop.isActive === false || sub.status === 'suspended';
    if (legacyBlocked && !shop.access?.blockedAt) {
      set['access.blockedAt'] = new Date();
      set['access.blockReason'] = 'Migrated from a legacy suspension (isActive/status)';
      legacyBlocks += 1;
    } else if (!legacyBlocked && shop.access?.blockedAt === undefined) {
      set['access.blockedAt'] = null;
    }

    if (Object.keys(set).length && !DRY_RUN) {
      await shops.updateOne({ _id: shop._id }, { $set: set });
    }
  }

  console.log(`Step 1 — expiry normalised to end-of-day Dhaka: ${expiryFixed} shop(s)`);
  console.log(`Step 2 — billing profile written:               ${profiled} shop(s)`);
  console.log(`Step 3 — graceDays defaulted to 0`);
  console.log(`Step 4 — legacy suspensions made explicit:      ${legacyBlocks} shop(s)`);

  // 5 — platform settings singleton
  if (!DRY_RUN) {
    const PlatformSetting = require('../src/models/PlatformSetting.model');
    const settings = await PlatformSetting.current();
    console.log(
      `Step 5 — platform settings ready ` +
      `(trial ${settings.defaultTrialDays}d, ৳${settings.defaultMonthlyPrice}/mo, ` +
      `৳${settings.defaultSmsUnitPrice}/SMS, warn ${settings.warningDays}d, provider ${settings.billingProvider})`
    );
  } else {
    console.log('Step 5 — platform settings would be created');
  }

  console.log(`\n${DRY_RUN ? 'Dry run complete — nothing written.' : 'Migration complete.'}`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
