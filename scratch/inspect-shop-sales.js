/**
 * READ-ONLY inventory of everything a shop's sales touch.
 * Usage: node scratch/inspect-shop-sales.js <shopId>
 */
require('dotenv').config();
const mongoose = require('mongoose');

const SHOP_ID = process.argv[2];
if (!SHOP_ID) { console.error('usage: node scratch/inspect-shop-sales.js <shopId>'); process.exit(1); }

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    autoIndex: false,
    readPreference: 'primaryPreferred',
  });
  const db = mongoose.connection.db;
  const oid = new mongoose.Types.ObjectId(SHOP_ID);
  console.log(`Connected to ${mongoose.connection.host}\n`);

  const shop = await db.collection('shops').findOne({ _id: oid });
  if (!shop) { console.log('SHOP NOT FOUND'); await mongoose.disconnect(); return; }
  console.log('SHOP:', JSON.stringify({
    name: shop.name, phone: shop.phone, isActive: shop.isActive,
    multiBranch: shop.features?.multiBranch ?? shop.multiBranchEnabled,
    customerScope: shop.customerScope,
    createdAt: shop.createdAt, stats: shop.stats,
  }, null, 2));

  const counts = {};
  const cols = ['sales', 'salesreturns', 'payments', 'stocktransactions', 'customers',
    'customerbalances', 'products', 'purchases', 'expenses', 'cashregisters',
    'orders', 'branches', 'auditlogs', 'smslogs', 'coupons', 'heldcarts',
    'invoicecounters', 'returncounters', 'dueadjustments', 'stocktransfers'];
  for (const c of cols) {
    counts[c] = await db.collection(c).countDocuments({ shop: oid }).catch(() => 'n/a');
  }
  console.log('\nCOLLECTION COUNTS (shop-scoped):');
  console.table(counts);

  const sales = await db.collection('sales').find({ shop: oid }).sort({ createdAt: 1 }).toArray();
  console.log(`\nSALES: ${sales.length}`);
  const byStatus = {};
  for (const s of sales) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  console.log('by status:', byStatus);

  console.log('\nINVOICES:');
  for (const s of sales) {
    console.log(
      `  ${String(s.invoiceNo).padEnd(24)} ${String(s.status).padEnd(10)} ` +
      `total=${String(s.total).padStart(9)} paid=${String(s.paid).padStart(9)} due=${String(s.due).padStart(9)} ` +
      `ret=${s.returnedAmount || 0} items=${s.items.length} cust=${s.customerName || '-'}(${s.customer || 'walk-in'}) ` +
      `branch=${s.branch || 'null'} online=${!!s.isOnline} rev=${s.revision || 0}${s.revisedTo ? ' →' + s.revisedTo : ''} ` +
      `at=${s.createdAt && s.createdAt.toISOString().slice(0, 16)}`
    );
    for (const it of s.items) {
      console.log(`      - ${String(it.productName).slice(0, 30).padEnd(32)} qty=${it.quantity} ${it.unit || ''} ` +
        `type=${it.itemType || 'standard'} variant=${it.variantId || '-'} prod=${it.product} total=${it.total}`);
      if (Array.isArray(it.comboComponents)) {
        for (const c of it.comboComponents) {
          console.log(`          combo> ${c.productName} totalQty=${c.totalQuantity} prod=${c.product} variant=${c.variantId || '-'}`);
        }
      }
    }
  }

  const saleIds = sales.map(s => s._id);
  const payments = await db.collection('payments').find({ shop: oid }).toArray();
  console.log(`\nPAYMENTS: ${payments.length}`);
  for (const p of payments) {
    console.log(`  ${p.type} amt=${p.amount} method=${p.method} atCheckout=${p.atCheckout} sale=${p.sale || '-'} cust=${p.customer || '-'} at=${p.createdAt && p.createdAt.toISOString().slice(0, 16)}`);
  }

  const stx = await db.collection('stocktransactions').find({ shop: oid }).toArray();
  console.log(`\nSTOCK TRANSACTIONS: ${stx.length}`);
  const stxByType = {};
  for (const t of stx) stxByType[t.type] = (stxByType[t.type] || 0) + 1;
  console.log('by type:', stxByType);
  for (const t of stx.filter(t => t.reference?.type === 'sale')) {
    console.log(`  ${t.type} ${t.productName} qty=${t.quantity} prev=${t.previousStock} new=${t.newStock} inv=${t.reference?.invoiceNo}`);
  }

  const returns = await db.collection('salesreturns').find({ shop: oid }).toArray();
  console.log(`\nSALES RETURNS: ${returns.length}`);
  for (const r of returns) console.log(`  ${r.returnNo} sale=${r.sale} total=${r.totalAmount} method=${r.refundMethod} status=${r.status}`);

  const customers = await db.collection('customers').find({ shop: oid }).toArray();
  console.log(`\nCUSTOMERS: ${customers.length}`);
  for (const c of customers) {
    console.log(`  ${String(c.name).padEnd(20)} ${c.phone} purchases=${c.totalPurchases} paid=${c.totalPaid} due=${c.totalDue} opening=${c.openingDue || 0} count=${c.purchaseCount} _id=${c._id}`);
  }

  const cbs = await db.collection('customerbalances').find({ shop: oid }).toArray();
  console.log(`\nCUSTOMER BALANCES (per-branch): ${cbs.length}`);
  for (const c of cbs) console.log(`  cust=${c.customer} branch=${c.branch} purchases=${c.totalPurchases} paid=${c.totalPaid} due=${c.totalDue} count=${c.purchaseCount}`);

  const das = await db.collection('dueadjustments').find({ shop: oid }).toArray();
  console.log(`\nDUE ADJUSTMENTS: ${das.length}`);
  for (const d of das) console.log(`  cust=${d.customer} type=${d.type} amount=${d.amount} note=${d.note || ''}`);

  // products involved in sales
  const prodIds = [...new Set(sales.flatMap(s => s.items.flatMap(i => [String(i.product), ...(i.comboComponents || []).map(c => String(c.product))])))];
  const prods = await db.collection('products').find({ _id: { $in: prodIds.map(p => new mongoose.Types.ObjectId(p)) } }).toArray();
  console.log(`\nPRODUCTS INVOLVED: ${prods.length} of ${prodIds.length} referenced`);
  for (const p of prods) {
    console.log(`  ${String(p.name).slice(0, 30).padEnd(32)} stock=${p.stock} unit=${p.unit} variants=${(p.variants || []).length} batches=${(p.batches || []).length} shop=${String(p.shop) === SHOP_ID ? 'ok' : 'OTHER!'}`);
    for (const v of (p.variants || [])) console.log(`      variant ${v.sku || v._id} stock=${v.stock}`);
    for (const b of (p.batches || [])) console.log(`      batch qty=${b.quantity} exp=${b.expiryDate && b.expiryDate.toISOString?.().slice(0, 10)} variant=${b.variantId || '-'}`);
  }
  const missing = prodIds.filter(id => !prods.find(p => String(p._id) === id));
  if (missing.length) console.log('  MISSING PRODUCT DOCS:', missing);

  const orders = await db.collection('orders').find({ shop: oid }).toArray();
  console.log(`\nORDERS: ${orders.length}`);
  for (const o of orders) console.log(`  ${o.orderNo} status=${o.status} sale=${o.sale || '-'} total=${o.total}`);

  const registers = await db.collection('cashregisters').find({ shop: oid }).toArray();
  console.log(`\nCASH REGISTERS: ${registers.length}`);
  for (const r of registers) console.log(`  date=${r.date && r.date.toISOString().slice(0, 10)} status=${r.status} opening=${r.openingBalance} closing=${r.closingBalance} branch=${r.branch || 'null'}`);

  const counters = await db.collection('invoicecounters').find({ shop: oid }).toArray();
  console.log(`\nINVOICE COUNTERS: ${counters.length}`);
  for (const c of counters) console.log(`  ${JSON.stringify(c)}`);

  const coupons = await db.collection('coupons').find({ shop: oid }).toArray();
  console.log(`\nCOUPONS: ${coupons.length}`);
  for (const c of coupons) console.log(`  ${c.code} usageCount=${c.usageCount} redemptions=${(c.redemptions || []).length}`);

  const held = await db.collection('heldcarts').find({ shop: oid }).toArray();
  console.log(`\nHELD CARTS: ${held.length}`, held.map(h => ({ status: h.status, sale: h.sale })));

  const smslogs = await db.collection('smslogs').find({ shop: oid }).toArray();
  console.log(`\nSMS LOGS: ${smslogs.length}`, smslogs.map(s => ({ type: s.type, sale: s.sale, status: s.status })));

  const branches = await db.collection('branches').find({ shop: oid }).toArray();
  console.log(`\nBRANCHES: ${branches.length}`);
  for (const b of branches) console.log(`  ${b.name} code=${b.code} _id=${b._id} isMain=${b.isMain}`);

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
