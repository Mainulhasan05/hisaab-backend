/**
 * One-shot: clear the sale-receipt language that was never actually chosen.
 *
 * ── What this is fixing ──────────────────────────────────────────────────────
 *
 * `settings.smsSettings.language` decides whether the receipt a CUSTOMER gets
 * is Bangla or English. It used to default to `bn`. On 2026-09-10 the default
 * became `en`, because Bangla is not free: one Bangla character flips the whole
 * message to UCS-2 and cuts the segment budget from 160 characters to 70. For a
 * shop whose own name is Bangla the message was UCS-2 regardless and the labels
 * cost nothing — but for a shop named in ASCII the old default silently doubled
 * the cost of every receipt it ever sent, and nobody had asked it.
 *
 * Changing the schema default fixes new shops and the 26 shops that had no
 * stored value. It does NOT fix the 10 shops carrying a stored `bn`, because a
 * stored value beats a default. That is what this script is for.
 *
 * ── Why a stored `bn` is safe to clear, this once ────────────────────────────
 *
 * Because on the day of the change not one of those ten had chosen it. The
 * evidence is in the data: every shop created from 2026-08-04 — the day the
 * field was added to the schema — has `bn` persisted, every shop created before
 * it has no value at all, and not a single shop anywhere has `en`. That is the
 * signature of a default being written at document creation, not of ten
 * separate decisions.
 *
 * ── Why it will NOT be safe to run again ─────────────────────────────────────
 *
 * The moment a shopkeeper picks Bangla, their choice is stored as exactly the
 * same `bn` this script clears — the data cannot tell a decision from an
 * inherited default. Re-running it later would silently overrule real choices.
 *
 * Run it once, on the deploy that ships the new default. If you find yourself
 * reaching for it a second time, the answer is almost certainly no.
 *
 * ── Why it UNSETS rather than writing 'en' ───────────────────────────────────
 *
 * Writing `en` would leave the same problem for whoever changes the default
 * next: ten shops that look like they chose English and did not. Removing the
 * field says the true thing — "this shop has no preference" — so the platform
 * default applies now and continues to apply if it ever moves again. From here
 * on, a stored value means somebody chose it.
 *
 * A shop with its OWN receipt wording is skipped and reported. Its template
 * bypasses `language` entirely (see `buildInvoiceSms`), so nothing this script
 * could do would change what its customers receive — and touching a shop whose
 * receipt has been deliberately configured is exactly what should not happen
 * quietly.
 *
 *   node scripts/sms-receipt-language-en.js            # dry run, changes nothing
 *   node scripts/sms-receipt-language-en.js --apply    # writes
 */

require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');

  await mongoose.connect(uri);
  const shops = mongoose.connection.db.collection('shops');

  const stored = await shops
    .find({ 'settings.smsSettings.language': { $exists: true } })
    .project({ name: 1, 'settings.smsSettings.language': 1, 'settings.smsSettings.invoiceTemplate': 1 })
    .toArray();

  const rows = stored.map((shop) => {
    const sms = shop.settings.smsSettings;
    return {
      _id: shop._id,
      name: shop.name,
      language: sms.language,
      hasTemplate: Boolean(String(sms.invoiceTemplate || '').trim()),
    };
  });

  // A shop that has already said `en` is where this script wants it. Leave it
  // alone rather than unsetting it — the outcome is identical today, and an
  // explicit `en` is a preference worth keeping if the default ever moves.
  const clear = rows.filter((r) => r.language === 'bn' && !r.hasTemplate);
  const skippedTemplate = rows.filter((r) => r.language === 'bn' && r.hasTemplate);
  const alreadyEn = rows.filter((r) => r.language === 'en');

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — sale receipt language\n`);
  console.log(`shops with a stored language : ${rows.length}`);
  console.log(`  -> clearing to the default : ${clear.length}`);
  console.log(`  -> skipped, own wording    : ${skippedTemplate.length}`);
  console.log(`  -> already 'en', untouched : ${alreadyEn.length}\n`);

  for (const r of clear) console.log(`  clear   ${String(r.name).slice(0, 40)}`);
  for (const r of skippedTemplate) console.log(`  skip    ${String(r.name).slice(0, 40)}  (custom receipt template)`);
  for (const r of alreadyEn) console.log(`  keep    ${String(r.name).slice(0, 40)}  (explicitly en)`);

  if (!APPLY) {
    console.log('\nNothing written. Re-run with --apply.\n');
  } else if (clear.length === 0) {
    console.log('\nNothing to do.\n');
  } else {
    const result = await shops.updateMany(
      { _id: { $in: clear.map((r) => r._id) } },
      { $unset: { 'settings.smsSettings.language': '' } }
    );
    console.log(`\nCleared on ${result.modifiedCount} shop(s). They now follow the platform default.\n`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
