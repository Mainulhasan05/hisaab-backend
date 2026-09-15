/**
 * Link old sale-time stock rows to the invoice that took the goods.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Until 2026-09-15 `createSale` wrote its `StockTransaction` rows with no
 * `reference`, so the product stock history showed "বিক্রি −৩" with nothing to
 * open. New sales now carry `reference: { type: 'sale', id }`. This fills in the
 * rows written before that.
 *
 * The rows hold no pointer to the sale, so the match is inferred: same shop,
 * same seller (`createdBy`), a sale that contains the product (directly or as a
 * combo component), created within 2 minutes AFTER the ledger row (the ledger
 * is written first, inside the same checkout) — or at exactly the same instant,
 * which is what a backdated sale stamps on both.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Only rows with `type: 'sale'` and no `reference.id`. A row with more than one
 * candidate sale in the window is AMBIGUOUS and left alone — a wrong link is
 * worse than no link. It touches no stock figure, no quantity, no money.
 * Idempotent.
 *
 * Usage:
 *   node scripts/backfill-stock-sale-reference.js                 # report only
 *   node scripts/backfill-stock-sale-reference.js --shop <id>     # one shop
 *   node scripts/backfill-stock-sale-reference.js --apply         # write
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const shopArg = (() => {
  const i = process.argv.indexOf('--shop');
  return i > -1 ? process.argv[i + 1] : null;
})();

const AFTER_MS = 2 * 60 * 1000;
const BEFORE_MS = 1000;

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Aborting.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const db = mongoose.connection.db;
  const txns = db.collection('stocktransactions');
  const sales = db.collection('sales');

  const shopFilter = shopArg ? { _id: new mongoose.Types.ObjectId(shopArg) } : {};
  const shops = await db.collection('shops').find(shopFilter, { projection: { name: 1 } }).toArray();

  const totals = { rows: 0, linked: 0, ambiguous: 0, unmatched: 0 };

  for (const shop of shops) {
    const rows = await txns.find(
      { shop: shop._id, type: 'sale', 'reference.id': { $exists: false } },
      { projection: { product: 1, createdBy: 1, createdAt: 1, branch: 1, quantity: 1 } }
    ).toArray();
    if (!rows.length) continue;

    const minAt = new Date(Math.min(...rows.map((r) => r.createdAt.getTime())) - BEFORE_MS);
    const maxAt = new Date(Math.max(...rows.map((r) => r.createdAt.getTime())) + AFTER_MS);

    const candidates = await sales.find(
      { shop: shop._id, createdAt: { $gte: minAt, $lte: maxAt } },
      {
        projection: {
          invoiceNo: 1, createdBy: 1, createdAt: 1, branch: 1,
          'items.product': 1, 'items.quantity': 1,
          'items.comboComponents.product': 1, 'items.comboComponents.totalQuantity': 1,
        },
      }
    ).sort({ createdAt: 1 }).toArray();

    // Seller → their sales, time-ordered, each with product → the quantities it
    // moved of it. The quantity is the tie-breaker: backdated sales all land on
    // the same instant of their day, so one seller's two sales of the same rice
    // cannot be told apart by time — but 5 kg and 12 kg can.
    const qtyKey = (q) => Math.abs(Number(q) || 0).toFixed(3);
    const bySeller = new Map();
    for (const s of candidates) {
      const products = new Map();
      const add = (p, q) => {
        if (!p) return;
        const k = String(p);
        if (!products.has(k)) products.set(k, new Set());
        products.get(k).add(qtyKey(q));
      };
      for (const it of s.items || []) {
        add(it.product, it.quantity);
        for (const c of it.comboComponents || []) add(c.product, c.totalQuantity);
      }
      const key = String(s.createdBy);
      if (!bySeller.has(key)) bySeller.set(key, []);
      bySeller.get(key).push({ ...s, products });
    }

    const ops = [];
    let ambiguous = 0;
    let unmatched = 0;
    for (const row of rows) {
      const t = row.createdAt.getTime();
      let fits = (bySeller.get(String(row.createdBy)) || []).filter((s) => {
        const d = s.createdAt.getTime() - t;
        return d >= -BEFORE_MS && d <= AFTER_MS
          && s.products.has(String(row.product))
          && String(s.branch || '') === String(row.branch || '');
      });
      if (fits.length > 1) {
        fits = fits.filter((s) => s.products.get(String(row.product)).has(qtyKey(row.quantity)));
      }
      if (fits.length === 1) {
        ops.push({
          updateOne: {
            filter: { _id: row._id, shop: shop._id, 'reference.id': { $exists: false } },
            update: { $set: { reference: { type: 'sale', id: fits[0]._id, invoiceNo: fits[0].invoiceNo } } },
          },
        });
      } else if (fits.length > 1) {
        ambiguous += 1;
      } else {
        unmatched += 1;
      }
    }

    console.log(`${shop.name} (${shop._id})`);
    console.log(`  ${rows.length} unlinked · ${ops.length} linkable · ${ambiguous} ambiguous · ${unmatched} no sale found`);

    if (APPLY && ops.length) {
      for (let i = 0; i < ops.length; i += 1000) {
        const res = await txns.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
        console.log(`  linked ${res.modifiedCount}`);
      }
    }

    totals.rows += rows.length;
    totals.linked += ops.length;
    totals.ambiguous += ambiguous;
    totals.unmatched += unmatched;
  }

  console.log(`\n${totals.rows} unlinked rows · ${totals.linked} linkable · ${totals.ambiguous} ambiguous · ${totals.unmatched} unmatched`);
  if (!APPLY) console.log('DRY RUN — nothing written. Re-run with --apply.');
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.connection.close(); } catch { /* already closed */ }
  process.exit(1);
});
