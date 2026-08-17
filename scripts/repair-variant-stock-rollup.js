/**
 * Re-derive `Product.stock` from `variants[]` wherever the two have drifted.
 *
 *   node scripts/repair-variant-stock-rollup.js                  # dry run, every shop
 *   node scripts/repair-variant-stock-rollup.js --shop <id>      # dry run, one shop
 *   node scripts/repair-variant-stock-rollup.js --apply
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 *
 * `stock` on a variant product is DEFINED as the sum across `variants[]` — the
 * inventory-value aggregation, the stock-count stat and the `totalStock`
 * virtual all recompute it that way at read time. The write paths did not
 * maintain it: `buildVariantStockUpdate` wrote `variants.$.stock` and nothing
 * else, so every variant sale left the stored rollup where it was. Only the
 * sales-return path ever wrote it, which made the drift asymmetric — a sale
 * overstated `stock`, and a return of the same line silently corrected it.
 *
 * Net effect: `stock` on a variant product reads high by roughly whatever has
 * been sold and not returned. A shopkeeper looking at the product list is told
 * they have goods that are not on the shelf.
 *
 * The write paths are fixed (`buildVariantStockUpdate` now carries the rollup,
 * `stockWriteOp` in stockTransfer.service does the same, and a `pre('save')` on
 * the model covers the `.save()` paths such as a manual recount). This script is
 * for the drift those fixes inherited.
 *
 * ── Why `variants[]` is the side that wins ──────────────────────────────────
 *
 * Because it is the side every write actually maintained. Both the sale and the
 * purchase paths have always applied their delta to the element under an
 * `$elemMatch` guard; the rollup is the field that was simply never written. So
 * the per-variant numbers are the ones that have tracked reality, and the
 * rollup is a stale copy — recomputing it loses nothing.
 *
 * ── …EXCEPT when `hasVariants` is false ─────────────────────────────────────
 *
 * There is a second population that looks identical to a query and is the exact
 * opposite case: a product CONVERTED BACK to plain. It keeps a stale `variants[]`
 * whose rows were zeroed, `hasVariants: false`, and a product-level `stock` that
 * every subsequent sale, purchase and recount has maintained — its
 * stock-transaction trail is entirely product-level.
 *
 * Repairing those from `variants[]` does not fix drift, it destroys stock:
 * `Brazil P.E Home` would go from 61 units to 0, `France P.E Home` from 50 to 0,
 * and `Old Money Shirt` would be INFLATED from a real 16 to an abandoned 57.
 * Four such products exist in this database today.
 *
 * So the match below requires `hasVariants: true`. The flag is what says which
 * of the two fields the shop has been keeping, and that is the only question
 * that matters here.
 *
 * SAFETY
 * ------
 * Dry run by default. Touches `stock` and nothing else, and only on products
 * that are flagged as variant products AND have a non-empty `variants[]`. A
 * plain product's stock is its own and is never derived. Nothing here reads or
 * writes any other collection.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
};
const APPLY = process.argv.includes('--apply');
const SHOP_ID = arg('shop');

// Stock is quantized to 3 dp everywhere (see quantity.util). Comparing at a
// tighter tolerance than that would report float noise as drift.
const EPS = 0.0005;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 20000,
    autoIndex: false,
  });
  const db = mongoose.connection.db;
  console.log(`${APPLY ? '*** APPLY ***' : '=== DRY RUN ==='}  host=${mongoose.connection.host}\n`);

  const match = {
    hasVariants: true, // see the header — a converted-back product must not be touched
    variants: { $exists: true, $ne: [] },
    isDeleted: { $ne: true },
    ...(SHOP_ID ? { shop: new mongoose.Types.ObjectId(SHOP_ID) } : {}),
  };

  const products = await db.collection('products')
    .find(match, { projection: { name: 1, shop: 1, stock: 1, 'variants.stock': 1, 'variants.sku': 1 } })
    .toArray();

  // Reported, never touched: the population the match above deliberately
  // excludes. Silence here would read as "nothing else drifted", when in fact
  // these are the rows where repairing would be the destructive act.
  const excluded = await db.collection('products').aggregate([
    {
      $match: {
        hasVariants: { $ne: true },
        variants: { $exists: true, $ne: [] },
        isDeleted: { $ne: true },
        ...(SHOP_ID ? { shop: new mongoose.Types.ObjectId(SHOP_ID) } : {}),
      },
    },
    {
      $project: {
        name: 1,
        stock: 1,
        variantSum: { $sum: { $map: { input: '$variants', as: 'v', in: { $ifNull: ['$$v.stock', 0] } } } },
      },
    },
    { $match: { $expr: { $gt: [{ $abs: { $subtract: ['$stock', '$variantSum'] } }, EPS] } } },
  ]).toArray();

  const shops = await db.collection('shops').find({}).project({ name: 1 }).toArray();
  const shopName = Object.fromEntries(shops.map((s) => [String(s._id), s.name]));

  const drifted = [];
  for (const p of products) {
    // Every variant, active or not — matching what the write path now does and
    // what the inventory aggregations already did. A deactivated variant is
    // hidden from the POS; its stock is still in the shop.
    const sum = Math.round(
      (p.variants || []).reduce((s, v) => s + (Number(v.stock) || 0), 0) * 1000
    ) / 1000;
    const stored = Number(p.stock) || 0;
    if (Math.abs(sum - stored) > EPS) drifted.push({ ...p, sum, stored, delta: sum - stored });
  }

  const reportExcluded = () => {
    if (excluded.length === 0) return;
    console.log(`\nNOT TOUCHED — ${excluded.length} product(s) with a stale variants[] and hasVariants: false.`);
    console.log('Their product-level stock is the maintained figure; rolling up would destroy it.');
    for (const e of excluded) {
      console.log(`  ${String(e.name).slice(0, 30).padEnd(32)} stock=${e.stock}  (abandoned variants sum to ${e.variantSum})`);
    }
  };

  if (drifted.length === 0) {
    console.log(`Checked ${products.length} variant products — no drift.`);
    reportExcluded();
    console.log('');
    await mongoose.disconnect();
    return;
  }

  drifted.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  let overstated = 0;
  let understated = 0;
  const byShop = {};
  console.log(`${'SHOP'.padEnd(26)} ${'PRODUCT'.padEnd(30)} ${'STORED'.padStart(9)} ${'ACTUAL'.padStart(9)} ${'DELTA'.padStart(9)}`);
  console.log('─'.repeat(90));
  for (const d of drifted) {
    const sn = shopName[String(d.shop)] || String(d.shop);
    byShop[sn] = (byShop[sn] || 0) + 1;
    if (d.delta < 0) overstated += 1; else understated += 1;
    console.log(
      `${String(sn).slice(0, 24).padEnd(26)} ${String(d.name).slice(0, 28).padEnd(30)} ` +
      `${String(d.stored).padStart(9)} ${String(d.sum).padStart(9)} ${String(d.delta.toFixed(3)).padStart(9)}`
    );
  }

  console.log('─'.repeat(90));
  console.log(`${drifted.length} of ${products.length} variant products have drifted`);
  console.log(`  overstated (stored > actual): ${overstated}   understated: ${understated}`);
  console.log(`  shops affected: ${Object.keys(byShop).length}`);
  reportExcluded();

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply.\n');
    await mongoose.disconnect();
    return;
  }

  // One pipeline update per product, computing the sum SERVER-side from the
  // document as it exists at write time rather than writing the figure this
  // script read. A concurrent sale landing between the read above and this write
  // would otherwise be undone by a "repair" that restored a pre-sale total.
  const ops = drifted.map((d) => ({
    updateOne: {
      filter: { _id: d._id },
      update: [{
        $set: {
          stock: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ['$variants', []] } }, 0] },
              { $round: [{ $sum: { $map: { input: '$variants', as: 'v', in: { $ifNull: ['$$v.stock', 0] } } } }, 3] },
              '$stock',
            ],
          },
        },
      }],
    },
  }));

  const res = await db.collection('products').bulkWrite(ops, { ordered: false });
  console.log(`\nApplied: ${res.modifiedCount} products updated.\n`);

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('\nFAILED:', e.message);
  console.error(e.stack);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
