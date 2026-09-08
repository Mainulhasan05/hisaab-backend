/**
 * Clear the storefront SEO values that were SEEDED rather than written.
 *
 *   node scripts/clear-seeded-storefront-seo.js            # dry-run
 *   node scripts/clear-seeded-storefront-seo.js --apply
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY STORED DEFAULTS HAVE TO GO BEFORE THE SEO SCREEN IS USEFUL
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Until now `createStorefront` seeded `seo` with `{ title: <shop name>,
 * description: "<shop name> — অনলাইনে অর্ডার করুন।", ogImage: <logo> }`. Nothing
 * read those values that would not have derived the same text anyway, so they
 * were harmless — right up until there was a screen showing them.
 *
 * The SEO editor labels each field "স্বয়ংক্রিয়" when the shop has not written
 * it, precisely so a placeholder does not read as finished work. A seeded value
 * is indistinguishable from an authored one, so every existing shop would open
 * that screen, see a generic description presented as their own writing, and
 * close it. The one field that would have earned them search traffic is the one
 * that looks already done.
 *
 * The same text still renders — `resolveSeo` derives it live from the current
 * shop, which also fixes the stale-copy bug where renaming a shop left the old
 * name in the meta tag forever.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONLY EXACT MATCHES ARE CLEARED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A field is cleared only when it is character-for-character what the seeder
 * would have written for THAT shop, today. A shop that typed one word of their
 * own keeps everything. There is no fuzzy match and no "looks generic enough"
 * rule, because the cost of being wrong in that direction is deleting a
 * shopkeeper's own writing with no undo — and the cost of being too strict is
 * that one shop keeps a default they can edit at any time.
 *
 * ── BOTH `draft` AND `published`, AND `history` IS LEFT ALONE ───────────────
 *
 * `published` is what customers' search results are built from, so leaving it
 * seeded would keep the stale value live. `history` is an audit of what WAS
 * published and rewriting it would be a lie about the past — a rollback to v3
 * restores what v3 actually said, and that is the point of keeping it.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const isApply = process.argv.includes('--apply');

/** Exactly what `_seedSeo` used to write for this shop. */
function seededValues(shop) {
  return {
    title: shop?.name || '',
    description: `${shop?.name || ''} — অনলাইনে অর্ডার করুন।`,
    ogImage: shop?.logo || null,
  };
}

/**
 * The fields of one `seo` block that are still the seeder's own output.
 * Returns the `$unset` paths, or an empty array when the shop has written.
 */
function seededFields(seo, expected, prefix) {
  if (!seo || typeof seo !== 'object') return [];
  const out = [];
  for (const key of ['title', 'description', 'ogImage']) {
    const stored = seo[key];
    if (stored === undefined || stored === null || stored === '') continue;
    if (stored === expected[key]) out.push(`${prefix}.${key}`);
  }
  return out;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const storefronts = await db
    .collection('storefronts')
    .find({}, { projection: { shop: 1, 'draft.seo': 1, 'published.seo': 1 } })
    .toArray();

  const shops = await db
    .collection('shops')
    .find(
      { _id: { $in: storefronts.map((s) => s.shop) } },
      { projection: { name: 1, logo: 1, slug: 1 } }
    )
    .toArray();

  const byId = new Map(shops.map((s) => [String(s._id), s]));

  const plan = [];
  for (const sf of storefronts) {
    const shop = byId.get(String(sf.shop));
    if (!shop) continue;

    const expected = seededValues(shop);
    const paths = [
      ...seededFields(sf.draft?.seo, expected, 'draft.seo'),
      ...seededFields(sf.published?.seo, expected, 'published.seo'),
    ];
    if (paths.length) plan.push({ id: sf._id, shop, paths });
  }

  console.log(`Storefronts: ${storefronts.length}`);
  console.log(`With seeded SEO still stored: ${plan.length}\n`);

  for (const row of plan) {
    console.log(`  ${row.shop.name} (/s/${row.shop.slug})`);
    console.log(`    clearing: ${row.paths.join(', ')}`);
  }

  if (!plan.length) {
    console.log('Nothing to do.');
    await mongoose.connection.close();
    return;
  }

  if (!isApply) {
    console.log('\nDry run. Re-run with --apply to clear these.');
    console.log('The same text still renders — resolveSeo derives it live from the shop.');
    await mongoose.connection.close();
    return;
  }

  let changed = 0;
  for (const row of plan) {
    const unset = {};
    for (const path of row.paths) unset[path] = '';
    const res = await db
      .collection('storefronts')
      .updateOne({ _id: row.id }, { $unset: unset, $set: { updatedAt: new Date() } });
    changed += res.modifiedCount;
  }

  console.log(`\nCleared on ${changed} storefront(s).`);
  console.log('Each shop now sees these fields as "স্বয়ংক্রিয়" and can write their own.');

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
