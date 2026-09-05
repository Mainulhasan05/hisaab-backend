/**
 * Migration: put shops back on a sane ৳/SMS rate.
 *
 *   node scripts/reset-sms-unit-price.js           # dry-run, shows every shop
 *   node scripts/reset-sms-unit-price.js --apply
 *
 * WHY
 * ---
 * `Shop.billing.smsUnitPrice` is the price ONE SMS is sold to that shop at. The
 * platform list rate is ৳0.40, so ৳100 buys 250 messages.
 *
 * Three shops are carrying `2.5`. That is not a negotiated rate, it is a unit
 * error — somebody typed a taka figure into a per-SMS field. It survives because
 * nothing ever displayed the consequence: the admin allocation sheet let an
 * operator type any price, and the shop's own screen never quoted a rate at all.
 *
 * Self-serve top-ups changed that. The owner's billing page now prints
 * "৳১০০ = ৪০টি এসএমএস" — six times the list price, on a screen the shopkeeper
 * reads before deciding whether to buy. That is the bug this fixes.
 *
 * WHAT IT TOUCHES
 * ---------------
 * Only shops whose rate is ABOVE the list price, and only up to the list price.
 *
 *   · A rate BELOW list is a discount somebody agreed. Never touched — raising
 *     a shop's price is a conversation, not a migration. That asymmetry is the
 *     whole safety property here.
 *   · `--max` sets the ceiling above which a rate is treated as an error
 *     (default 1.0, i.e. more than 2.5x list). A shop that genuinely negotiated
 *     ৳0.50 is left alone; one on ৳2.50 is not.
 *
 * Past purchases are NOT rewritten. `SMSQuota.allocations[].price` and
 * `PlatformPayment.smsUnitPrice` record what was actually charged at the time,
 * and history stays truthful even when it records a mistake.
 *
 * Idempotent: a second run reports nothing left to do.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = hit ? Number(hit.split('=')[1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** Anything above this is treated as a unit error rather than a negotiated rate. */
const MAX_SANE = argOf('max', 1.0);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
  });
  require('../src/models');

  const Shop = mongoose.model('Shop');
  const PlatformSetting = mongoose.model('PlatformSetting');

  const settings = await PlatformSetting.current();
  const listRate = Number(settings.defaultSmsUnitPrice) || 0.4;

  console.log(`\nConnected to ${mongoose.connection.name}  [${APPLY ? 'APPLY' : 'DRY RUN — no writes'}]`);
  console.log(`\nList rate: ৳${listRate}/SMS  ·  treating anything above ৳${MAX_SANE} as a unit error\n`);

  const shops = await Shop.find({ 'billing.smsUnitPrice': { $gt: MAX_SANE } })
    .select('name billing.smsUnitPrice')
    .sort({ name: 1 });

  if (!shops.length) {
    console.log('No shop is above the ceiling. Nothing to do.\n');
    await mongoose.disconnect();
    return;
  }

  console.log(`${shops.length} shop(s) above ৳${MAX_SANE}/SMS:\n`);
  for (const shop of shops) {
    const rate = Number(shop.billing.smsUnitPrice);
    const before = rate > 0 ? Math.floor(100 / rate) : 0;
    const after = Math.floor(100 / listRate);
    console.log(
      `  ${String(shop.name).padEnd(30)} ৳${rate}/SMS  →  ৳${listRate}/SMS` +
      `   (৳100 buys ${before} → ${after})`
    );
  }

  // Report the shops that are deliberately left alone, so the operator can see
  // the script made a choice rather than missing them.
  const discounted = await Shop.find({
    'billing.smsUnitPrice': { $lt: listRate, $gt: 0 },
  }).select('name billing.smsUnitPrice').lean();
  if (discounted.length) {
    console.log(`\n  Left alone (below list — these are real discounts):`);
    for (const s of discounted) {
      console.log(`    ${String(s.name).padEnd(28)} ৳${s.billing.smsUnitPrice}/SMS`);
    }
  }

  if (!APPLY) {
    console.log(`\n  (dry run — would move all ${shops.length} to ৳${listRate})\n`);
    await mongoose.disconnect();
    return;
  }

  let moved = 0;
  for (const shop of shops) {
    shop.billing.smsUnitPrice = listRate;
    await shop.save();
    moved += 1;
  }

  console.log(`\n  Updated ${moved} shop(s) to ৳${listRate}/SMS.\n`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
