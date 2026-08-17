/** READ-ONLY: full stock-transaction trail for a shop. */
require('dotenv').config();
const mongoose = require('mongoose');
const SHOP_ID = process.argv[2];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, autoIndex: false });
  const db = mongoose.connection.db;
  const oid = new mongoose.Types.ObjectId(SHOP_ID);

  const stx = await db.collection('stocktransactions').find({ shop: oid }).sort({ createdAt: 1 }).toArray();
  console.log(`STOCK TRANSACTIONS (${stx.length}) chronological:\n`);
  for (const t of stx) {
    console.log(
      `${t.createdAt.toISOString().slice(0, 16)} ${String(t.type).padEnd(11)} ` +
      `${String(t.productName).slice(0, 26).padEnd(28)} qty=${String(t.quantity).padStart(6)} ` +
      `${String(t.previousStock).padStart(7)}→${String(t.newStock).padStart(7)} ` +
      `ref=${t.reference?.type || '-'}/${t.reference?.invoiceNo || t.reference?.id || '-'} ` +
      `var=${t.variantId ? String(t.variantId).slice(-6) : '-'} ${t.notes || ''}`
    );
  }

  const rets = await db.collection('salesreturns').find({ shop: oid }).toArray();
  console.log('\nSALES RETURN DOCS:');
  for (const r of rets) console.log(JSON.stringify(r, null, 2));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
