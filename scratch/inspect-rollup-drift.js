/** READ-ONLY: characterise each drifted variant product. */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;

  const products = await db.collection('products')
    .find({ variants: { $exists: true, $ne: [] }, isDeleted: { $ne: true } }).toArray();
  const shops = await db.collection('shops').find({}).project({ name: 1 }).toArray();
  const shopName = Object.fromEntries(shops.map(s => [String(s._id), s.name]));

  for (const p of products) {
    const sum = Math.round(p.variants.reduce((s, v) => s + (Number(v.stock) || 0), 0) * 1000) / 1000;
    const stored = Number(p.stock) || 0;
    if (Math.abs(sum - stored) <= 0.0005) continue;

    const txns = await db.collection('stocktransactions')
      .find({ product: p._id }).sort({ createdAt: 1 }).toArray();
    const variantTxns = txns.filter(t => t.variantId);
    const plainTxns = txns.filter(t => !t.variantId);

    console.log(`\n${'='.repeat(76)}`);
    console.log(`${p.name}  [${shopName[String(p.shop)] || p.shop}]`);
    console.log(`  stored stock=${stored}   Σvariants=${sum}   delta=${(sum - stored).toFixed(3)}`);
    console.log(`  hasVariants=${p.hasVariants}  created=${p.createdAt && p.createdAt.toISOString().slice(0,10)}  updated=${p.updatedAt && p.updatedAt.toISOString().slice(0,10)}`);
    console.log(`  variants: ${p.variants.map(v => `${v.sku || v._id}=${v.stock}${v.isActive === false ? '(inactive)' : ''}`).join(', ')}`);
    console.log(`  txns: ${txns.length} total — ${variantTxns.length} variant-scoped, ${plainTxns.length} product-level`);
    for (const t of txns.slice(-8)) {
      console.log(`     ${t.createdAt.toISOString().slice(0,10)} ${String(t.type).padEnd(11)} qty=${String(t.quantity).padStart(6)} ${String(t.previousStock).padStart(6)}→${String(t.newStock).padStart(6)} ${t.variantId ? 'var=' + String(t.variantId).slice(-6) : 'PRODUCT-LEVEL'}`);
    }
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
