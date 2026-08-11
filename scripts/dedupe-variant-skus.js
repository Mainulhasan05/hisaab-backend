/**
 * Give every variant of a product its own SKU.
 *
 *   node scripts/dedupe-variant-skus.js                  # dry-run, all shops
 *   node scripts/dedupe-variant-skus.js --shop <id>      # dry-run, one shop
 *   node scripts/dedupe-variant-skus.js --shop <id> --apply
 *   node scripts/dedupe-variant-skus.js --apply          # all shops, writes
 *
 * WHY
 * ---
 * The form built a variant's SKU by truncating each attribute value to two
 * characters. Two characters cannot tell `10mg` from `100mg`, or `50mg` from
 * `500mg`, or `XXL` from `XXXL`: each pair produced ONE token, so a product
 * ended up holding two variants under a single SKU.
 *
 * That is not cosmetic. `Product.getVariantBySKU` returns the first match, and
 * a variant SKU is what the label sheet encodes when the variant has no barcode
 * of its own (`products/barcode/page.js` falls back to `variant.sku`). So the
 * 100mg box carried a label that scanned as the 10mg variant, and selling it
 * took the 10mg price off the 10mg stock. The shop's count of both drifts, and
 * nothing anywhere reports an error.
 *
 * `lib/data/variants.js` no longer truncates, so newly built variants are
 * distinct. This script is for the rows written before that landed.
 *
 * WHAT IT DOES AND DOES NOT TOUCH
 * -------------------------------
 * ONLY variants whose SKU is shared with another variant of the SAME product.
 * A SKU that is already unique is left exactly as it is, deliberately: it may be
 * printed on labels that are on boxes on a shelf right now, and re-deriving it
 * to match today's generator would invalidate them to no purpose. Within a
 * colliding group the FIRST variant also keeps its SKU, so the migration
 * invalidates as few labels as it possibly can — only the duplicates, which
 * were scanning as the wrong variant anyway.
 *
 * Historical sale, return and transfer rows are NOT rewritten. They store
 * `variantSku` as a snapshot of what was sold, and they join back to the variant
 * by `variantId` (an ObjectId), not by SKU — so the record of what left the shop
 * that day stays true, and nothing is orphaned. Verified against
 * sale.service.js, salesReturn.service.js and stockTransfer.service.js.
 *
 * WHERE THE NEW SKU COMES FROM
 * ----------------------------
 * The variant's own attributes, romanised — `100mg` gives `CODE-100MG`. When a
 * variant has no attributes stored (see EMPTY ATTRIBUTES below) there is nothing
 * to derive from, and it falls back to suffixing the existing SKU with `-2`,
 * `-3`, … Both paths are deterministic: a dry-run prints what an `--apply`
 * writes, which is the only thing making the preview worth reading.
 *
 * This aims at uniqueness, not at reproducing the frontend generator byte for
 * byte — the unit-word table lives in the frontend and is not duplicated here.
 * Editing a product in the UI afterwards regenerates its SKUs from that
 * generator in the normal way.
 *
 * EMPTY ATTRIBUTES
 * ----------------
 * Many variants have none stored. The builder sends attributes as FLAT keys
 * (`{ weight: '৫০০ গ্রাম' }`) while `variantSchema` declares them nested under
 * `attributes`, and only `size / color / weight / material / style / custom` at
 * that — so Mongoose's strict mode drops the rest on write. That is a separate
 * bug and this script does not fix it; it reports the count, because it is why
 * some rows can only get a `-2` suffix.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { romaniseExistingCode, sanitizeProductCode } = require('../src/utils/productCode.util');

const APPLY = process.argv.includes('--apply');
const shopArgIdx = process.argv.indexOf('--shop');
const SHOP_ARG = shopArgIdx !== -1 ? process.argv[shopArgIdx + 1] : null;

/** Stable order, so the same variant always yields the same token. */
const ATTRIBUTE_KEYS = ['size', 'color', 'weight', 'material', 'style', 'custom'];

/**
 * A SKU token built from what the variant actually knows about itself.
 * Returns '' when the variant has no usable attributes.
 */
const tokenFromAttributes = (variant) => {
  const attrs = variant?.attributes || {};
  const parts = [];

  for (const key of ATTRIBUTE_KEYS) {
    const raw = attrs[key];
    if (raw === undefined || raw === null) continue;
    // `custom` is Mixed and may hold an object; only scalars are usable.
    if (typeof raw === 'object') continue;
    const token = romaniseExistingCode(String(raw)).replace(/[^A-Z0-9]/g, '');
    if (token) parts.push(token);
  }

  return parts.join('-');
};

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
  });

  const db = mongoose.connection.db;
  console.log(`Connected to ${mongoose.connection.host}/${db.databaseName} (${APPLY ? 'APPLY' : 'DRY-RUN'})\n`);

  const filter = { 'variants.1': { $exists: true } }; // at least two variants
  if (SHOP_ARG) filter.shop = new mongoose.Types.ObjectId(SHOP_ARG);

  const products = await db
    .collection('products')
    .find(filter)
    .project({ shop: 1, code: 1, name: 1, variants: 1 })
    .toArray();

  console.log(`Scanned ${products.length} product(s) with more than one variant.\n`);

  const updates = [];
  let renamed = 0;
  let productsAffected = 0;
  let noAttributes = 0;

  /* Shop-wide SKU census, for the cross-product report at the end. A scan looks
     up `variants.sku` across the whole shop (product.service.getProductByCode),
     so a SKU shared by two PRODUCTS mis-resolves too — but fixing that is a
     different decision, and this script does not make it. */
  const shopWide = new Map();

  for (const product of products) {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const base = sanitizeProductCode(product.code || '') || 'PRD';

    // Group by SKU, preserving document order so "the first one keeps it" is
    // a stable, reviewable rule.
    const groups = new Map();
    variants.forEach((variant, index) => {
      const sku = String(variant?.sku || '').trim();
      if (!sku) return;
      if (!groups.has(sku)) groups.set(sku, []);
      groups.get(sku).push({ variant, index });

      const shopKey = `${product.shop}|${sku}`;
      if (!shopWide.has(shopKey)) shopWide.set(shopKey, new Set());
      shopWide.get(shopKey).add(String(product._id));
    });

    const taken = new Set(groups.keys());
    const set = {};
    let headerPrinted = false;

    for (const [sku, members] of groups) {
      if (members.length < 2) continue;

      if (!headerPrinted) {
        console.log(`  ${product.name || '(unnamed)'}  [${product.code || 'no code'}]`);
        headerPrinted = true;
      }

      // members[0] keeps `sku` — see WHAT IT DOES AND DOES NOT TOUCH.
      for (let i = 1; i < members.length; i += 1) {
        const { variant, index } = members[i];
        const token = tokenFromAttributes(variant);
        if (!token) noAttributes += 1;

        let candidate = token ? `${base}-${token}` : `${sku}-${i + 1}`;
        let n = 1;
        while (taken.has(candidate)) {
          n += 1;
          candidate = token ? `${base}-${token}-${n}` : `${sku}-${i + n}`;
        }
        taken.add(candidate);

        set[`variants.${index}.sku`] = candidate;
        renamed += 1;
        console.log(
          `      ${sku.padEnd(20)} -> ${candidate.padEnd(20)}` +
          `${token ? '' : '  (no attributes stored; suffixed)'}`
        );
      }
    }

    if (Object.keys(set).length > 0) {
      productsAffected += 1;
      updates.push({ updateOne: { filter: { _id: product._id }, update: { $set: set } } });
    }
  }

  const crossProduct = [...shopWide.values()].filter((ids) => ids.size > 1).length;

  console.log('\n' + '─'.repeat(60));
  console.log(`Products with duplicate variant SKUs: ${productsAffected}`);
  console.log(`  variant SKUs to rename: ${renamed}`);
  if (noAttributes) {
    console.log(`  ${noAttributes} had no attributes stored and got a numeric suffix`);
  }
  if (crossProduct) {
    console.log(
      `\n  NOTE: ${crossProduct} SKU(s) are shared by DIFFERENT products in the same shop.` +
      '\n  A barcode scan searches variants.sku shop-wide, so those resolve to whichever' +
      '\n  product is found first. Not touched by this script — raise it before deciding.'
    );
  }

  if (updates.length === 0) {
    console.log('\nEvery variant already has its own SKU. Nothing to do.');
    await mongoose.connection.close();
    return;
  }

  if (!APPLY) {
    console.log('\nDRY-RUN — nothing written. Re-run with --apply.');
    await mongoose.connection.close();
    return;
  }

  const res = await db.collection('products').bulkWrite(updates, { ordered: false });
  console.log(`\nWritten: ${res.modifiedCount} product document(s).`);
  console.log('Reprint labels for the renamed variants — their old ones scan as a sibling.');

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
