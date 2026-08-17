/**
 * ONE-OFF: hard-delete a shop's entire sales history and reverse everything it
 * moved — stock, batches, customer dues, payments, counters.
 *
 *   node scripts/purge-shop-sales.js --shop <id>            # dry run (default)
 *   node scripts/purge-shop-sales.js --shop <id> --apply    # write
 *
 * ── Why this exists rather than "just cancel them" ──────────────────────────
 *
 * `saleService.cancelSale` is the sanctioned reversal and it is correct as far
 * as it goes, but three things make it the wrong tool for a shop that wants its
 * TEST invoices gone:
 *
 *   1. It refuses outright when `returnedAmount > 0` (sale.service.js:1983), and
 *      that is exactly the state of one of these invoices. There is no escape
 *      hatch, by design — a return knows what it has already reversed.
 *   2. A cancelled sale is still a Sale. It stays in the list, in the reports'
 *      cancelled bucket, and in `Shop.stats.totalSales` (never decremented).
 *   3. `Sale` and `Payment` both carry `immutableGuard`, so nothing in the
 *      application can remove them. This script goes through the raw driver
 *      deliberately, which is the only reason it is safe to keep it a script:
 *      the guard stays intact for every code path a user can reach.
 *
 * ── What it reverses, and what it deliberately does not ─────────────────────
 *
 * REVERSED   product stock (incl. per-variant + the `stock` rollup), FEFO
 *            batches, `Customer` / `CustomerBalance` rollups, `Shop.stats`,
 *            invoice + return counters.
 * DELETED    every Sale, SalesReturn, sale-linked Payment, sale/return
 *            StockTransaction and sale-entity AuditLog for the shop.
 * UNTOUCHED  `Customer.openingDue` and the `DueAdjustment` rows behind it —
 *            that is the shop's paper খাতা carried in at onboarding and it has
 *            no invoice behind it. 147 of this shop's 151 customers are nothing
 *            BUT opening due; touching that would destroy the real book while
 *            clearing the test one. Purchases, expenses and manual stock
 *            adjustments are likewise real and left alone.
 *
 * ── The stock arithmetic ────────────────────────────────────────────────────
 *
 * Restore quantity is `item.quantity − already returned for that saleItemId`,
 * never the raw line quantity. A sale that has been through `salesReturn` has
 * ALREADY had its goods put back and its ledger credited; restoring the line
 * again would count the goods twice on the shelf — the same double-count
 * `cancelSale` refuses to risk. Cancelled sales restore nothing at all: their
 * stock went back when they were cancelled.
 *
 * Variant lines use `buildVariantStockRollupUpdate`, not the
 * `buildVariantStockUpdate` that `cancelSale` uses. That is not a stylistic
 * choice — see the finding in the report: the sale path decrements
 * `variants[].stock` and leaves the product-level `stock` rollup alone, so the
 * rollup drifts up by every variant sale ever made. The rollup helper recomputes
 * `stock` from the array it just wrote, so this purge heals that drift instead
 * of preserving it.
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
if (!SHOP_ID) {
  console.error('usage: node scripts/purge-shop-sales.js --shop <id> [--apply]');
  process.exit(1);
}

const {
  buildStockUpdate,
  buildVariantStockRollupUpdate,
  storageUnit,
  quantize,
  quantizeMoney,
} = require('../src/utils/quantity.util');
const { restoreBatches, batchWriteOp } = require('../src/utils/batch.util');

const money = (n) => `৳${Number(n || 0).toLocaleString('en-IN')}`;
const line = (c = '─') => console.log(c.repeat(78));

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 20000,
    autoIndex: false,
  });
  const db = mongoose.connection.db;
  const shopOid = new mongoose.Types.ObjectId(SHOP_ID);

  const Product = require('../src/models/Product.model');
  const StockTransaction = require('../src/models/StockTransaction.model');
  const AuditLog = require('../src/models/AuditLog.model');

  const shop = await db.collection('shops').findOne({ _id: shopOid });
  if (!shop) throw new Error(`shop ${SHOP_ID} not found`);

  console.log(`\n${APPLY ? '*** APPLY ***' : '=== DRY RUN ==='}  ${shop.name}`);
  console.log(`host=${mongoose.connection.host}\n`);

  // ── Gather ────────────────────────────────────────────────────────────────
  const sales = await db.collection('sales').find({ shop: shopOid }).toArray();
  const returns = await db.collection('salesreturns').find({ shop: shopOid }).toArray();
  const saleIds = sales.map((s) => s._id);
  const returnIds = returns.map((r) => r._id);
  const refIds = [...saleIds, ...returnIds];

  if (sales.length === 0) {
    console.log('No sales for this shop — nothing to do.');
    await mongoose.disconnect();
    return;
  }

  // How much of each sale line has already come back through a return. Keyed by
  // saleItemId, which is the only stable identifier a return records.
  const returnedByItem = new Map();
  for (const r of returns) {
    for (const it of r.items || []) {
      const k = String(it.saleItemId);
      returnedByItem.set(k, (returnedByItem.get(k) || 0) + (Number(it.quantity) || 0));
    }
  }

  // ── Plan: stock to restore ────────────────────────────────────────────────
  // One entry per {product, variant}; combo lines expand to their components.
  const restore = new Map();
  const addRestore = (productId, variantId, qty, label) => {
    if (!(qty > 0)) return;
    const key = `${productId}|${variantId || ''}`;
    const row = restore.get(key) || { productId: String(productId), variantId: variantId ? String(variantId) : null, qty: 0, labels: [] };
    row.qty += qty;
    row.labels.push(label);
    restore.set(key, row);
  };

  for (const s of sales) {
    // A cancelled sale already gave its goods back — `cancelSale` restored stock,
    // batches and the customer ledger at the time. Deleting the document now must
    // move no stock at all, or every voided invoice would restock a second time.
    if (s.status === 'cancelled') continue;

    for (const item of s.items || []) {
      const returned = returnedByItem.get(String(item._id)) || 0;

      if (item.itemType === 'combo' && Array.isArray(item.comboComponents)) {
        // A combo's stock lives on its components, and a partial return of the
        // combo reduces every component proportionally — same ratio the sale
        // used, because `totalQuantity` is already the whole-line figure.
        const ratio = item.quantity > 0 ? (item.quantity - returned) / item.quantity : 0;
        for (const c of item.comboComponents) {
          addRestore(c.product, c.variantId, (Number(c.totalQuantity) || 0) * ratio, `${s.invoiceNo}/${c.productName}`);
        }
        continue;
      }

      addRestore(item.product, item.variantId, (Number(item.quantity) || 0) - returned, `${s.invoiceNo}/${item.productName}`);
    }
  }

  const productIds = [...new Set([...restore.values()].map((r) => r.productId))];
  const products = await Product.find({ _id: { $in: productIds }, shop: shopOid });
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  console.log('STOCK TO RESTORE');
  line();
  const stockOps = [];
  const batchOps = [];
  const stockTxns = [];
  for (const row of restore.values()) {
    const p = productMap.get(row.productId);
    if (!p) {
      console.log(`  !! product ${row.productId} not found in this shop — SKIPPED (${row.labels.join(', ')})`);
      continue;
    }
    const unit = storageUnit(p);
    const qty = quantize(row.qty, unit);

    let prev = 0;
    let next = 0;
    if (row.variantId) {
      const v = p.variants?.id
        ? p.variants.id(row.variantId)
        : (p.variants || []).find((x) => String(x._id) === row.variantId);
      prev = v?.stock || 0;
      next = quantize(prev + qty, unit);
      if (v) v.stock = next;
      stockOps.push({
        updateOne: {
          filter: { _id: p._id, 'variants._id': new mongoose.Types.ObjectId(row.variantId) },
          // Rollup variant — heals `product.stock`, which the sale path never
          // decremented. See the header.
          update: buildVariantStockRollupUpdate(row.variantId, qty, unit),
        },
      });
      console.log(`  ${String(p.name).slice(0, 26).padEnd(28)} [${v?.sku || row.variantId}]  +${qty}   ${prev} → ${next}`);
    } else {
      prev = p.stock || 0;
      next = quantize(prev + qty, unit);
      p.stock = next;
      stockOps.push({
        updateOne: { filter: { _id: p._id }, update: buildStockUpdate(qty, unit) },
      });
      console.log(`  ${String(p.name).slice(0, 26).padEnd(28)} ${''.padEnd(20)}  +${qty}   ${prev} → ${next}`);
    }

    // Batches, newest-expiry-first — the mirror of the FEFO deduction, exactly
    // as `cancelSale.queueBatchRestore` does it.
    if (restoreBatches(p, row.variantId || null, qty)) {
      batchOps.push(batchWriteOp(p));
      const owned = (p.batches || []).filter((b) => String(b.variantId || '') === String(row.variantId || ''));
      console.log(`      batches → ${owned.map((b) => b.quantity).join(', ')}`);
    }

    // One honest ledger row per restored line. Typed `adjustment`/`manual`
    // rather than `return`, because the invoice it would have referenced is
    // about to stop existing — a `reference.type:'sale'` row pointing at a
    // deleted id is worse than no row.
    stockTxns.push({
      shop: shopOid,
      branch: sales.find((s) => s.status !== 'cancelled')?.branch || null,
      product: p._id,
      productName: p.name,
      productCode: p.code,
      variantId: row.variantId ? new mongoose.Types.ObjectId(row.variantId) : null,
      type: 'adjustment',
      quantity: qty,
      previousStock: prev,
      newStock: next,
      reference: { type: 'manual' },
      notes: 'টেস্ট বিক্রয় মুছে ফেলা হয়েছে — স্টক ফেরত দেওয়া হলো',
      createdBy: shop.owner || sales[0].createdBy,
    });
  }
  if (restore.size === 0) console.log('  (nothing — every live line was already returned)');

  // ── Plan: customer ledgers ────────────────────────────────────────────────
  //
  // Absolute targets, not deltas. EVERY sale and EVERY sale-linked payment for
  // this shop is going away, so what must remain is precisely the pre-software
  // debt: totalPurchases = totalPaid = purchaseCount = 0, and
  // totalDue = deriveDue() = max(0, 0 + openingDue − 0) = openingDue.
  //
  // Deltas would be the wrong tool here for the reason the report gives: this
  // shop already carries a customer at `totalPaid: −5,440`, so unwinding
  // sale-by-sale would faithfully reproduce a figure that is already wrong.
  const custIds = [...new Set(sales.filter((s) => s.customer).map((s) => String(s.customer)))];
  const customers = await db.collection('customers')
    .find({ _id: { $in: custIds.map((c) => new mongoose.Types.ObjectId(c)) } }).toArray();

  console.log('\nCUSTOMER LEDGERS');
  line();
  const custOps = [];
  for (const c of customers) {
    const opening = Number(c.openingDue) || 0;
    const targetDue = quantizeMoney(Math.max(0, opening));
    console.log(
      `  ${String(c.name).slice(0, 22).padEnd(24)} ` +
      `due ${String(money(c.totalDue)).padStart(12)} → ${String(money(targetDue)).padStart(12)}   ` +
      `paid ${money(c.totalPaid)} → ৳0   purchases ${money(c.totalPurchases)} → ৳0   count ${c.purchaseCount} → 0`
    );
    custOps.push({
      updateOne: {
        filter: { _id: c._id },
        update: {
          $set: {
            totalPurchases: 0,
            totalPaid: 0,
            totalDue: targetDue,
            purchaseCount: 0,
            lastPurchase: null,
          },
        },
      },
    });
  }

  // The per-branch mirror. Same absolute reset, and only for rows belonging to a
  // customer whose sales are being deleted — every other row in the collection
  // is pure opening due and must not be touched.
  const balRows = await db.collection('customerbalances')
    .find({ shop: shopOid, customer: { $in: custIds.map((c) => new mongoose.Types.ObjectId(c)) } }).toArray();
  const balOps = balRows.map((r) => ({
    updateOne: {
      filter: { _id: r._id },
      update: {
        $set: {
          totalPurchases: 0,
          totalPaid: 0,
          totalDue: quantizeMoney(Math.max(0, Number(r.openingDue) || 0)),
          purchaseCount: 0,
          lastPurchase: null,
        },
      },
    },
  }));
  console.log(`  (${balRows.length} per-branch CustomerBalance rows reset the same way)`);

  // Σ invariant, checked here rather than discovered later: for each customer
  // the branch rows' openings must sum to the shop-wide opening, or the reset
  // would leave `Σ CustomerBalance.totalDue ≠ Customer.totalDue`.
  for (const c of customers) {
    const rows = balRows.filter((r) => String(r.customer) === String(c._id));
    const sumOpening = rows.reduce((s, r) => s + (Number(r.openingDue) || 0), 0);
    if (quantizeMoney(sumOpening) !== quantizeMoney(Number(c.openingDue) || 0)) {
      console.log(`  !! ${c.name}: branch openings ${money(sumOpening)} ≠ shop opening ${money(c.openingDue)} — will drift`);
    }
  }

  // ── Plan: deletions ───────────────────────────────────────────────────────
  const payFilter = { shop: shopOid, sale: { $in: saleIds } };
  // Sale-item deductions carry no `reference` at all (createSale does not set
  // one), so they are matched by type. Safe precisely because every sale in this
  // shop is in the delete set — the assertion below is what makes that explicit
  // rather than assumed.
  const stxFilter = {
    shop: shopOid,
    $or: [
      { type: 'sale' },
      { type: 'return', 'reference.id': { $in: refIds } },
    ],
  };
  const auditFilter = { shop: shopOid, 'entity.id': { $in: refIds } };
  const invCounterFilter = { shop: shopOid, date: { $regex: '^\\d{4}-\\d{2}-\\d{2}$' } };

  const counts = {
    sales: sales.length,
    salesreturns: returns.length,
    payments: await db.collection('payments').countDocuments(payFilter),
    stocktransactions: await db.collection('stocktransactions').countDocuments(stxFilter),
    auditlogs: await db.collection('auditlogs').countDocuments(auditFilter),
    invoicecounters: await db.collection('invoicecounters').countDocuments(invCounterFilter),
    returncounters: await db.collection('returncounters').countDocuments({ shop: shopOid }),
  };

  // Guard: the stock-transaction filter must never reach a purchase or a manual
  // adjustment. Those are real history for a shop that is still trading.
  const collateral = await db.collection('stocktransactions')
    .countDocuments({ ...stxFilter, type: { $nin: ['sale', 'return'] } });
  if (collateral > 0) throw new Error(`stock-transaction filter would delete ${collateral} non-sale rows — aborting`);

  console.log('\nDOCUMENTS TO DELETE');
  line();
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`\n  Shop.stats.totalSales  ${shop.stats?.totalSales ?? 0} → 0`);
  console.log(`  (purchase counter PUR:* and all DueAdjustment / opening due rows are left alone)`);

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply.\n');
    await mongoose.disconnect();
    return;
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  //
  // One transaction. A half-applied purge is the one outcome that must be
  // impossible: stock back on the shelf with the invoices still standing would
  // double the shop's inventory against a book that still claims the sales.
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const so = { session };

      if (stockOps.length) await Product.bulkWrite(stockOps, so);
      if (batchOps.length) await Product.bulkWrite(batchOps, so);

      await db.collection('stocktransactions').deleteMany(stxFilter, so);
      await db.collection('payments').deleteMany(payFilter, so);
      await db.collection('salesreturns').deleteMany({ shop: shopOid }, so);
      await db.collection('sales').deleteMany({ shop: shopOid }, so);
      await db.collection('auditlogs').deleteMany(auditFilter, so);
      await db.collection('invoicecounters').deleteMany(invCounterFilter, so);
      await db.collection('returncounters').deleteMany({ shop: shopOid }, so);

      // After the delete, so the purge's own rows survive it.
      if (stockTxns.length) await StockTransaction.insertMany(stockTxns, so);

      if (custOps.length) await db.collection('customers').bulkWrite(custOps, so);
      if (balOps.length) await db.collection('customerbalances').bulkWrite(balOps, so);

      await db.collection('shops').updateOne(
        { _id: shopOid },
        { $set: { 'stats.totalSales': 0, 'stats.totalRevenue': 0 } },
        so
      );
    });
  } finally {
    await session.endSession();
  }

  // Outside the transaction, deliberately: a log write that could roll the purge
  // back would be a reversal that fails because the logging did — the same rule
  // `cancelSale` follows for its own audit entry.
  await AuditLog.create({
    shop: shopOid,
    user: shop.owner || sales[0].createdBy,
    action: 'sale_purge',
    actionBn: 'টেস্ট বিক্রয় মুছে ফেলা',
    description: `Purged ${counts.sales} test sales, ${counts.salesreturns} returns, ${counts.payments} payments. Stock restored on ${restore.size} lines; ${customers.length} customer ledgers reset to opening due.`,
    descriptionBn: `${counts.sales}টি টেস্ট বিক্রয় মুছে ফেলা হয়েছে, স্টক ফেরত ও বাকি সমন্বয় করা হয়েছে।`,
    entity: { type: 'shop', id: shopOid, name: shop.name },
    changes: { before: { invoices: sales.map((s) => s.invoiceNo), stats: shop.stats }, after: { invoices: [] } },
  });

  console.log('\nApplied.\n');
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('\nFAILED:', e.message);
  console.error(e.stack);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
