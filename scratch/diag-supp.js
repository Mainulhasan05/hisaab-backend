/** READ-ONLY: shape of the supplier Σ drift. */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const sups = await db.collection('suppliers')
    .find({ name: { $in: ['Dhaka Wholesale Apparel', 'Islampur Textile Hub'] } }).toArray();

  for (const s of sups) {
    console.log(`\n=== ${s.name} (${s._id}) shop=${s.shop}`);
    console.log('  supplier doc:', JSON.stringify({
      totalAmount: s.totalAmount, totalDue: s.totalDue, openingDue: s.openingDue,
      totalPurchases: s.totalPurchases, createdAt: s.createdAt,
    }));
    const rows = await db.collection('supplierbalances').find({ supplier: s._id }).toArray();
    console.log('  branch rows:', JSON.stringify(rows.map(r => ({
      branch: String(r.branch), totalAmount: r.totalAmount, totalPaid: r.totalPaid,
      totalDue: r.totalDue, openingDue: r.openingDue, purchaseCount: r.purchaseCount,
      createdAt: r.createdAt,
    })), null, 2));
    const purch = await db.collection('purchases').find({ supplier: s._id })
      .project({ invoiceNo: 1, branch: 1, total: 1, due: 1, createdAt: 1, status: 1 }).toArray();
    console.log('  purchases:', JSON.stringify(purch.map(p => ({
      inv: p.invoiceNo, branch: String(p.branch), total: p.total, due: p.due, status: p.status, at: p.createdAt,
    })), null, 2));
    const adj = await db.collection('supplierdueadjustments').find({ supplier: s._id }).toArray();
    console.log('  adjustments:', JSON.stringify(adj.map(a => ({
      branch: String(a.branch), kind: a.kind, amount: a.amount, at: a.createdAt,
    })), null, 2));
  }

  const branches = await db.collection('branches').find({}).project({ name: 1 }).toArray();
  console.log('\nbranches:', JSON.stringify(branches.map(b => ({ id: String(b._id), name: b.name }))));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
