/**
 * READ-ONLY diagnostic: reconcile "Total Due" across dashboard vs customer list
 * for one shop. Writes nothing.
 *
 *   node scratch/diag-due.js 01792449180
 */
require('dotenv').config();
const mongoose = require('mongoose');

const PHONE = process.argv[2] || '01792449180';
const r = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const fmt = (n) => r(n).toLocaleString('en-US');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, autoIndex: false });
  const db = mongoose.connection.db;
  console.log(`Connected: ${mongoose.connection.host}/${db.databaseName}\n`);

  const shop = await db.collection('shops').findOne({ phone: PHONE });
  if (!shop) {
    const u = await db.collection('users').findOne({ phone: PHONE });
    console.log('No shop with that phone. user =', u && u._id, u && u.shop);
    if (!u) return;
  }
  const shopDoc = shop || (await db.collection('shops').findOne({ _id: (await db.collection('users').findOne({ phone: PHONE })).shop }));
  const shopId = shopDoc._id;
  console.log(`Shop: ${shopDoc.name} (${shopId})`);
  console.log(`  multiBranchEnabled=${shopDoc.multiBranchEnabled}  customerScope=${shopDoc.customerScope}\n`);

  const branches = await db.collection('branches').find({ shop: shopId }).toArray();
  console.log('Branches:');
  branches.forEach((b) => console.log(`  ${b.name} (${b._id}) isActive=${b.isActive} isDefault=${b.isDefault}`));
  console.log();

  // ---------- A. Dashboard all-branches figure: Customer.totalDue, isActive:true
  const [allBranchAgg] = await db.collection('customers').aggregate([
    { $match: { shop: shopId, isActive: true } },
    { $group: { _id: null, totalDue: { $sum: '$totalDue' }, n: { $sum: 1 } } },
  ]).toArray();

  const [allCustAgg] = await db.collection('customers').aggregate([
    { $match: { shop: shopId } },
    { $group: { _id: null, totalDue: { $sum: '$totalDue' }, n: { $sum: 1 } } },
  ]).toArray();

  const [inactiveAgg] = await db.collection('customers').aggregate([
    { $match: { shop: shopId, isActive: { $ne: true } } },
    { $group: { _id: null, totalDue: { $sum: '$totalDue' }, n: { $sum: 1 } } },
  ]).toArray();

  console.log('=== A. Dashboard "All branches" source (Customer.totalDue) ===');
  console.log(`  isActive:true    -> ৳${fmt(allBranchAgg?.totalDue || 0)}  (${allBranchAgg?.n || 0} customers)`);
  console.log(`  ALL customers    -> ৳${fmt(allCustAgg?.totalDue || 0)}  (${allCustAgg?.n || 0} customers)`);
  console.log(`  inactive only    -> ৳${fmt(inactiveAgg?.totalDue || 0)}  (${inactiveAgg?.n || 0} customers)\n`);

  // ---------- B. Dashboard per-branch figure: CustomerBalance.totalDue (NO isActive filter)
  console.log('=== B. Dashboard per-branch source (CustomerBalance.totalDue, no isActive filter) ===');
  const perBranch = await db.collection('customerbalances').aggregate([
    { $match: { shop: shopId } },
    { $group: { _id: '$branch', totalDue: { $sum: '$totalDue' }, rows: { $sum: 1 }, positiveRows: { $sum: { $cond: [{ $gt: ['$totalDue', 0] }, 1, 0] } }, negative: { $sum: { $cond: [{ $lt: ['$totalDue', 0] }, '$totalDue', 0] } } } },
  ]).toArray();
  let branchSum = 0;
  for (const p of perBranch) {
    const b = branches.find((x) => String(x._id) === String(p._id));
    branchSum += p.totalDue;
    console.log(`  ${b ? b.name : '(unknown branch ' + p._id + ')'} -> ৳${fmt(p.totalDue)}  rows=${p.rows} withDue=${p.positiveRows} negativeSum=${fmt(p.negative)}`);
  }
  console.log(`  SUM of branches  -> ৳${fmt(branchSum)}`);
  console.log(`  vs All-branches  -> ৳${fmt(allBranchAgg?.totalDue || 0)}   GAP = ৳${fmt(branchSum - (allBranchAgg?.totalDue || 0))}\n`);

  // ---------- C. Same, but only counting balances of ACTIVE customers
  console.log('=== C. Per-branch CustomerBalance restricted to isActive customers ===');
  const perBranchActive = await db.collection('customerbalances').aggregate([
    { $match: { shop: shopId } },
    { $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: 'c' } },
    { $unwind: '$c' },
    { $match: { 'c.isActive': true } },
    { $group: { _id: '$branch', totalDue: { $sum: '$totalDue' }, rows: { $sum: 1 } } },
  ]).toArray();
  let activeBranchSum = 0;
  for (const p of perBranchActive) {
    const b = branches.find((x) => String(x._id) === String(p._id));
    activeBranchSum += p.totalDue;
    console.log(`  ${b ? b.name : p._id} -> ৳${fmt(p.totalDue)}  rows=${p.rows}`);
  }
  console.log(`  SUM (active only) -> ৳${fmt(activeBranchSum)}\n`);

  // ---------- D. Invariant check: Σ CustomerBalance.totalDue === Customer.totalDue
  console.log('=== D. Invariant: Σ branch dues per customer vs Customer.totalDue ===');
  const drift = await db.collection('customers').aggregate([
    { $match: { shop: shopId } },
    { $lookup: { from: 'customerbalances', let: { cid: '$_id' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$customer', '$$cid'] }, { $eq: ['$shop', shopId] }] } } }, { $group: { _id: null, s: { $sum: '$totalDue' } } }], as: 'bal' } },
    { $addFields: { branchSum: { $ifNull: [{ $arrayElemAt: ['$bal.s', 0] }, 0] } } },
    { $addFields: { diff: { $subtract: ['$branchSum', { $ifNull: ['$totalDue', 0] }] } } },
    { $match: { $expr: { $gt: [{ $abs: '$diff' }, 0.01] } } },
    { $project: { name: 1, phone: 1, isActive: 1, totalDue: 1, branchSum: 1, diff: 1 } },
    { $sort: { diff: -1 } },
  ]).toArray();
  console.log(`  mismatching customers: ${drift.length}`);
  const driftTotal = drift.reduce((s, d) => s + d.diff, 0);
  console.log(`  net drift (branchSum - Customer.totalDue): ৳${fmt(driftTotal)}`);
  drift.slice(0, 15).forEach((d) => console.log(`    ${d.name || d.phone} active=${d.isActive} Customer=৳${fmt(d.totalDue || 0)} branches=৳${fmt(d.branchSum)} diff=৳${fmt(d.diff)}`));
  console.log();

  // ---------- E. What the customer LIST page would show (page 1, limit 20, hasDue)
  console.log('=== E. /dashboard/customers?filter=due  — what the list returns ===');
  for (const b of branches) {
    const rows = await db.collection('customerbalances').aggregate([
      { $match: { shop: shopId, branch: b._id, totalDue: { $gt: 0 } } },
      { $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: 'customer' } },
      { $unwind: '$customer' },
      { $match: { 'customer.isActive': true } },
      { $facet: {
        page1: [{ $sort: { createdAt: -1 } }, { $limit: 20 }, { $project: { totalDue: 1 } }],
        all: [{ $group: { _id: null, total: { $sum: '$totalDue' }, n: { $sum: 1 } } }],
      } },
    ]).toArray();
    const f = rows[0];
    const page1Sum = (f.page1 || []).reduce((s, x) => s + (x.totalDue || 0), 0);
    const all = f.all[0] || { total: 0, n: 0 };
    console.log(`  ${b.name}:`);
    console.log(`     true total of ALL due customers : ৳${fmt(all.total)} across ${all.n} customers`);
    console.log(`     sum of PAGE 1 only (limit 20)   : ৳${fmt(page1Sum)}   <-- what the card shows`);
  }
  console.log();

  // Shop-wide list mode (page 1 of Customer.find sorted createdAt desc)
  const swPage1 = await db.collection('customers')
    .find({ shop: shopId, isActive: true, totalDue: { $gt: 0 } })
    .sort({ createdAt: -1 }).limit(20).project({ totalDue: 1 }).toArray();
  const swAll = await db.collection('customers').aggregate([
    { $match: { shop: shopId, isActive: true, totalDue: { $gt: 0 } } },
    { $group: { _id: null, total: { $sum: '$totalDue' }, n: { $sum: 1 } } },
  ]).toArray();
  console.log(`  ALL-branches list mode: true total ৳${fmt(swAll[0]?.total || 0)} across ${swAll[0]?.n || 0}; page-1 sum ৳${fmt(swPage1.reduce((s, x) => s + x.totalDue, 0))}`);
  console.log();

  // ---------- F. Due aging source (Sale.due)
  console.log('=== F. Due-aging tab source (Sale.due) ===');
  const aging = await db.collection('sales').aggregate([
    { $match: { shop: shopId, status: { $ne: 'cancelled' }, due: { $gt: 0 } } },
    { $group: { _id: '$branch', totalDue: { $sum: '$due' }, n: { $sum: 1 } } },
  ]).toArray();
  let agingSum = 0;
  aging.forEach((a) => {
    const b = branches.find((x) => String(x._id) === String(a._id));
    agingSum += a.totalDue;
    console.log(`  ${b ? b.name : a._id} -> ৳${fmt(a.totalDue)} from ${a.n} sales`);
  });
  console.log(`  SUM -> ৳${fmt(agingSum)}   (excludes openingDue; ignores due collections)`);

  // openingDue totals
  const [op] = await db.collection('customers').aggregate([
    { $match: { shop: shopId } },
    { $group: { _id: null, opening: { $sum: '$openingDue' }, purchases: { $sum: '$totalPurchases' }, paid: { $sum: '$totalPaid' } } },
  ]).toArray();
  console.log(`\n  Customer rollup totals: openingDue=৳${fmt(op?.opening || 0)} totalPurchases=৳${fmt(op?.purchases || 0)} totalPaid=৳${fmt(op?.paid || 0)}`);

  // ---------- G. Clamping loss: customers whose derived due went negative
  const clamp = await db.collection('customerbalances').aggregate([
    { $match: { shop: shopId } },
    { $addFields: { derived: { $subtract: [{ $add: [{ $ifNull: ['$totalPurchases', 0] }, { $ifNull: ['$openingDue', 0] }] }, { $ifNull: ['$totalPaid', 0] }] } } },
    { $match: { derived: { $lt: -0.01 } } },
    { $group: { _id: null, n: { $sum: 1 }, overpaid: { $sum: '$derived' } } },
  ]).toArray();
  console.log(`\n=== G. Over-paid (clamped) branch rows: ${clamp[0]?.n || 0}, hidden credit ৳${fmt(clamp[0]?.overpaid || 0)} ===`);

  await mongoose.connection.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
