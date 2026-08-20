/**
 * Switch VAT back OFF for every shop that turned it on while it did nothing.
 *
 *   node scripts/reset-stale-tax-settings.js            # dry-run, every shop
 *   node scripts/reset-stale-tax-settings.js --apply
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS HAS TO RUN BEFORE THE VAT CHANGE SHIPS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Shop.settings.taxEnabled` and `taxRate` have been editable from the shop's
 * own Settings page — and from the admin shop editor — for as long as the Shop
 * schema has existed, and **nothing has ever read them**. The POS sent a
 * literal `tax: 0` on every checkout.
 *
 * So some number of shops have switched the toggle on, typed a rate, saved it,
 * seen nothing change, and carried on trading. Their setting says "charge 15%"
 * and their prices have never included it.
 *
 * The moment VAT starts working, every one of those shops adds 15% to its next
 * invoice. Nobody decided that. The shopkeeper would find out when a customer
 * queries the bill, and the shop would have overcharged real people in the
 * meantime.
 *
 * Switching them off is the conservative direction and the reversible one: a
 * shop that genuinely wants VAT flips one toggle and gets it, now with a POS
 * that shows the line and a receipt that prints the rate. A shop that never
 * meant to charge it is protected without having to notice anything.
 *
 * ── The rate is KEPT ────────────────────────────────────────────────────────
 *
 * Only `taxEnabled` is cleared. `taxRate` is left exactly as typed, so a shop
 * re-enabling does not have to remember what it had — and so this script's
 * effect is legible in the data afterwards ("enabled false, rate 15" is a shop
 * that was reset; "enabled false, rate 0" is a shop that never configured it).
 *
 * ── Idempotent ──────────────────────────────────────────────────────────────
 *
 * The filter matches only shops that are currently enabled, so a second run
 * reports zero and writes nothing. Safe to re-run after a partial failure.
 *
 * ── Not a repair ────────────────────────────────────────────────────────────
 *
 * No invoice is touched. Every historical `Sale` carries `tax: 0` and always
 * did — there is nothing to unwind, only a setting to make honest.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  const db = mongoose.connection.db;
  console.log(`Connected to "${mongoose.connection.name}"\n`);

  // Read the collection directly rather than through the model: a schema
  // default must not be able to supply a value the database does not hold.
  // Same reason `recalc-account-balances.js` reads raw.
  const affected = await db.collection('shops')
    .find({ 'settings.taxEnabled': true })
    .project({ name: 1, 'settings.taxEnabled': 1, 'settings.taxRate': 1 })
    .toArray();

  if (affected.length === 0) {
    console.log('No shop has VAT switched on. Nothing to do.');
    await mongoose.connection.close();
    return;
  }

  console.log(`${affected.length} shop(s) have VAT switched on while it did nothing:\n`);
  for (const shop of affected) {
    const rate = shop.settings?.taxRate ?? 0;
    const note = rate > 0
      ? `would have started billing ${rate}% on the next invoice`
      : 'rate is 0, so it would have billed nothing anyway';
    console.log(`  ${String(shop.name || shop._id).padEnd(32)} rate ${String(rate).padStart(5)}%  — ${note}`);
  }

  console.log('\n' + '─'.repeat(70));

  if (!APPLY) {
    console.log('DRY-RUN — nothing written. Re-run with --apply to switch them off.');
    console.log('`taxRate` is kept in every case; only `taxEnabled` is cleared.');
    await mongoose.connection.close();
    return;
  }

  const res = await db.collection('shops').updateMany(
    { 'settings.taxEnabled': true },
    { $set: { 'settings.taxEnabled': false, updatedAt: new Date() } }
  );

  console.log(`Switched off: ${res.modifiedCount} shop(s). Rates left untouched.`);
  console.log('Each can re-enable it deliberately from Settings.');

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
