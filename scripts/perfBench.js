/**
 * Phase 6 — multi-branch performance benchmark.
 *
 *   node scripts/perfBench.js                  # seed → measure → drop
 *   node scripts/perfBench.js --keep           # leave the benchmark DB in place
 *   node scripts/perfBench.js --scale=0.2      # smaller dataset
 *   node scripts/perfBench.js --drop-only      # just clean up
 *
 * SAFETY
 * ------
 * This writes a lot of data, so it NEVER touches the application database. It
 * connects to a separate database on the same cluster (`<db>PerfBench`) and
 * refuses to start if that name resolves to the production one. The benchmark
 * database is dropped at the end unless --keep is passed.
 *
 * The cluster also hosts unrelated projects, so there is a storage budget: the
 * seed aborts and cleans up if the benchmark database grows past MAX_DB_MB.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const KEEP = process.argv.includes('--keep');
const DROP_ONLY = process.argv.includes('--drop-only');
const scaleArg = process.argv.find((a) => a.startsWith('--scale='));
const SCALE = scaleArg ? Number(scaleArg.split('=')[1]) : 1;

const MAX_DB_MB = 250;

// Dataset targets from FEATURE_PLAN.md §9.
const N_PRODUCTS = Math.round(10000 * SCALE); // split across 2 branches
const N_SALES = Math.round(50000 * SCALE);
const N_CUSTOMERS = Math.round(2000 * SCALE);
const N_EXPENSES = Math.round(4000 * SCALE);

const ITERATIONS = 25;

// ── connection ──────────────────────────────────────────────────────────────
function benchUri() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');

  const [base, query = ''] = uri.split('?');
  const withoutTrailing = base.replace(/\/$/, '');
  const lastSlash = withoutTrailing.lastIndexOf('/');
  const host = withoutTrailing.slice(0, lastSlash);
  const dbName = withoutTrailing.slice(lastSlash + 1);

  if (!dbName) throw new Error('Could not determine database name from MONGODB_URI');

  const benchName = `${dbName}PerfBench`;
  if (benchName === dbName) throw new Error('Refusing to run: benchmark name equals production name');

  return { uri: `${host}/${benchName}${query ? '?' + query : ''}`, benchName, prodName: dbName };
}

// ── stats helpers ───────────────────────────────────────────────────────────
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function measure(name, fn, iterations = ITERATIONS) {
  // one warm-up so we measure steady state, not first-call compilation
  try { await fn(); } catch (e) {
    return { name, error: e.message };
  }

  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    try {
      await fn(i);
    } catch (e) {
      return { name, error: e.message };
    }
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  return {
    name,
    p50: pct(times, 50),
    p95: pct(times, 95),
    max: times[times.length - 1],
  };
}

const oid = () => new mongoose.Types.ObjectId();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function dbSizeMB() {
  const s = await mongoose.connection.db.stats();
  return s.storageSize / 1024 / 1024;
}

async function insertBatched(collection, docs, label) {
  const BATCH = 1000;
  for (let i = 0; i < docs.length; i += BATCH) {
    await mongoose.connection.db.collection(collection).insertMany(docs.slice(i, i + BATCH), { ordered: false });
    const size = await dbSizeMB();
    if (size > MAX_DB_MB) {
      throw new Error(`Storage budget exceeded (${size.toFixed(0)}MB > ${MAX_DB_MB}MB) while inserting ${label}`);
    }
  }
  process.stdout.write(`  ${label}: ${docs.length}\n`);
}

// ── seed ────────────────────────────────────────────────────────────────────
/**
 * Register every model, not just the 17 exported from src/models/index.js.
 * Without this, syncIndexes() below silently skips the other 12 collections and
 * the benchmark measures them without their indexes — an artifact, not a real
 * finding. (Production has those indexes: they were built by autoIndex in a
 * non-production boot. The gap is that the deploy tooling can't see them.)
 */
function registerAllModels() {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'src', 'models');
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.model.js')) require(path.join(dir, f));
  }
}

async function seed() {
  registerAllModels();

  console.log(`Seeding (scale ${SCALE}): ${N_PRODUCTS} products, ${N_SALES} sales, ${N_CUSTOMERS} customers\n`);

  const shopId = oid();
  const branchA = oid();
  const branchB = oid();
  const ownerId = oid();
  const staffId = oid();
  const now = Date.now();

  await mongoose.connection.db.collection('shops').insertOne({
    _id: shopId, name: 'Bench Shop', slug: 'bench-shop-' + now, phone: '01700000000',
    multiBranchEnabled: true, isActive: true,
    subscription: { plan: 'paid', status: 'active', expiresAt: new Date(now + 8.64e7 * 365) },
    settings: { currency: 'BDT', lowStockThreshold: 5, invoicePrefix: 'INV' },
    createdAt: new Date(), updatedAt: new Date(),
  });

  await mongoose.connection.db.collection('branches').insertMany([
    { _id: branchA, shop: shopId, name: 'Dhanmondi', code: 'DHA', isDefault: true, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    { _id: branchB, shop: shopId, name: 'Chattogram', code: 'CTG', isDefault: false, isActive: true, createdAt: new Date(now + 1), updatedAt: new Date() },
  ]);

  await mongoose.connection.db.collection('users').insertMany([
    { _id: ownerId, shop: shopId, name: 'Owner', phone: '01700000000', password: 'x', isOwner: true, isActive: true, branch: null, lastActiveBranch: branchA, createdAt: new Date() },
    { _id: staffId, shop: shopId, name: 'Cashier', phone: '01700000001', password: 'x', isOwner: false, isActive: true, branch: branchA, createdAt: new Date() },
  ]);

  // Customers are shop-wide (product decision #2)
  const customers = Array.from({ length: N_CUSTOMERS }, (_, i) => ({
    _id: oid(), shop: shopId, name: `Customer ${i}`, phone: `018${String(i).padStart(8, '0')}`,
    totalPurchases: 0, totalPaid: 0, totalDue: i % 5 === 0 ? 500 : 0, purchaseCount: 0,
    isActive: true, createdAt: new Date(now - i * 1000), updatedAt: new Date(),
  }));
  await insertBatched('customers', customers, 'customers');

  // Per-branch catalogues (product decision #1): same codes in both branches.
  const perBranch = Math.floor(N_PRODUCTS / 2);
  const products = [];
  for (const [bi, branch] of [branchA, branchB].entries()) {
    for (let i = 0; i < perBranch; i++) {
      products.push({
        _id: oid(), shop: shopId, branch, clonedFrom: null,
        code: `P${String(i).padStart(6, '0')}`,
        name: `Product ${i} ${['Rice', 'Oil', 'Soap', 'Tea', 'Salt'][i % 5]}`,
        buyingPrice: 50 + (i % 200), sellingPrice: 80 + (i % 250),
        stock: (i * 7) % 400, minStock: 5, hasVariants: false, variants: [],
        unit: 'piece', isActive: true, isDeleted: false, totalSold: i % 50,
        batches: [], serials: [], images: [], catalogImages: [], tags: [],
        createdAt: new Date(now - i * 1000 - bi), updatedAt: new Date(),
      });
    }
  }
  await insertBatched('products', products, 'products');

  const prodA = products.filter((p) => String(p.branch) === String(branchA));
  const prodB = products.filter((p) => String(p.branch) === String(branchB));

  // Sales spread across both branches and the last 180 days
  const sales = [];
  for (let i = 0; i < N_SALES; i++) {
    const useA = i % 2 === 0;
    const branch = useA ? branchA : branchB;
    const pool = useA ? prodA : prodB;
    const created = new Date(now - Math.floor(Math.random() * 180) * 8.64e7 - (i % 86400) * 1000);
    const items = Array.from({ length: 1 + (i % 3) }, () => {
      const p = pick(pool);
      const qty = 1 + (i % 4);
      return {
        _id: oid(), product: p._id, productName: p.name, productCode: p.code,
        variantId: null, quantity: qty, unitPrice: p.sellingPrice,
        buyingPrice: p.buyingPrice, discount: 0, total: p.sellingPrice * qty,
      };
    });
    const subtotal = items.reduce((s, it) => s + it.total, 0);
    const cust = i % 3 === 0 ? pick(customers) : null;
    sales.push({
      _id: oid(), shop: shopId, branch,
      invoiceNo: `INV-${useA ? 'DHA' : 'CTG'}-${i}`,
      items, subtotal, discount: 0, discountType: 'fixed', tax: 0, deliveryCharge: 0,
      total: subtotal, paid: i % 7 === 0 ? subtotal / 2 : subtotal,
      due: i % 7 === 0 ? subtotal / 2 : 0,
      profit: items.reduce((s, it) => s + (it.unitPrice - it.buyingPrice) * it.quantity, 0),
      paymentMethod: i % 3 === 0 ? 'cash' : 'bkash',
      status: i % 50 === 0 ? 'cancelled' : 'completed',
      customer: cust?._id || null, customerName: cust?.name || 'Walk-in',
      isOnline: false, channel: 'pos',
      createdBy: i % 2 === 0 ? staffId : ownerId,
      createdAt: created, updatedAt: created,
    });
  }
  await insertBatched('sales', sales, 'sales');

  const expenses = Array.from({ length: N_EXPENSES }, (_, i) => ({
    _id: oid(), shop: shopId, branch: i % 2 === 0 ? branchA : branchB,
    categoryName: ['Rent', 'Salary', 'Utility'][i % 3], amount: 500 + (i % 5000),
    paymentMethod: 'cash', date: new Date(now - (i % 180) * 8.64e7),
    createdBy: ownerId, createdAt: new Date(), updatedAt: new Date(),
  }));
  await insertBatched('expenses', expenses, 'expenses');

  const payments = Array.from({ length: Math.round(5000 * SCALE) }, (_, i) => ({
    _id: oid(), shop: shopId, branch: i % 2 === 0 ? branchA : branchB,
    customer: pick(customers)._id, amount: 200 + (i % 800), method: 'cash',
    type: 'due_collection', receivedBy: ownerId,
    createdAt: new Date(now - (i % 180) * 8.64e7), updatedAt: new Date(),
  }));
  await insertBatched('payments', payments, 'payments');

  console.log(`\n  storage: ${(await dbSizeMB()).toFixed(1)}MB`);
  console.log('\nBuilding indexes from schema declarations...');
  for (const name of mongoose.modelNames()) {
    await mongoose.model(name).syncIndexes().catch(() => {});
  }
  console.log('  done\n');

  return { shopId, branchA, branchB, ownerId, staffId, sampleSaleId: sales[0]._id, prodA };
}

// ── benchmark ───────────────────────────────────────────────────────────────
async function run(ctx) {
  const Shop = require('../src/models/Shop.model');
  const shop = await Shop.findById(ctx.shopId).lean();

  const productService = require('../src/services/product.service');
  const saleService = require('../src/services/sale.service');
  const reportService = require('../src/services/report.service');
  const expenseService = require('../src/services/expense.service');
  const cashRegisterService = require('../src/services/cashRegister.service');

  const reqFor = (branchId, isOwner = true) => ({
    shop: { _id: ctx.shopId, multiBranchEnabled: shop.multiBranchEnabled },
    user: { _id: isOwner ? ctx.ownerId : ctx.staffId, isOwner },
    branch: branchId ? { _id: branchId, code: 'DHA' } : null,
    branchId: branchId || null,
  });

  const staffReq = reqFor(ctx.branchA, false);   // pinned to one branch
  const ownerReq = reqFor(ctx.branchA, true);    // owner on a branch
  const allReq = reqFor(null, true);             // owner, All Branches

  const cases = [
    ['products list (staff, branch)', () => productService.getProducts(ctx.shopId, { limit: 20 }, staffReq)],
    ['products list (owner, all branches)', () => productService.getProducts(ctx.shopId, { limit: 20 }, allReq)],
    ['product search (POS keystroke)', () => productService.searchProductsForSale(ctx.shopId, { search: 'Rice', limit: 30 }, staffReq)],
    ['product by id', () => productService.getProductById(ctx.shopId, ctx.prodA[5]._id, staffReq)],
    ['low stock', () => productService.getLowStockProducts(ctx.shopId, 10, staffReq)],
    ['sales list (branch)', () => saleService.getSales(ctx.shopId, { limit: 20, branchId: ctx.branchA })],
    ['sales list (all branches)', () => saleService.getSales(ctx.shopId, { limit: 20 })],
    ['sale by id', () => saleService.getSaleById(ctx.shopId, ctx.sampleSaleId, ctx.branchA, ownerReq)],
    ['dashboard (branch)', () => reportService.getDashboardStats(ctx.shopId, ctx.branchA)],
    ['dashboard (all branches)', () => reportService.getDashboardStats(ctx.shopId, null)],
    ['daily summary', () => reportService.getDailySummary(ctx.shopId, {}, ctx.branchA)],
    ['profit & loss (30d)', () => reportService.getProfitLoss(ctx.shopId, {
      startDate: new Date(Date.now() - 30 * 8.64e7).toISOString().slice(0, 10),
      endDate: new Date().toISOString().slice(0, 10),
    }, ctx.branchA)],
    ['product report', () => reportService.getProductReport(ctx.shopId, {}, ctx.branchA)],
    ['expenses list', () => expenseService.getExpenses(ctx.shopId, { limit: 20, branchId: ctx.branchA })],
    ['expense summary', () => expenseService.getSummary(ctx.shopId, {}, staffReq)],
    ['cash register today', () => cashRegisterService.getTodayRegister(ctx.shopId, ctx.ownerId, staffReq)],
  ];

  console.log(`Measuring (${ITERATIONS} iterations each, cache disabled between runs)\n`);
  console.log('  ' + 'endpoint'.padEnd(38) + 'p50'.padStart(9) + 'p95'.padStart(9) + 'max'.padStart(9));
  console.log('  ' + '─'.repeat(65));

  const results = [];
  const cacheService = require('../src/services/cache.service');
  for (const [name, fn] of cases) {
    // Reports cache aggressively, so bust the cache between iterations to
    // measure the cold path — the one that has to stay under budget.
    //
    // NOTE: bumpShopCacheVersion() is debounced to once per 30s, so calling it
    // in a tight loop only works the first time and every later iteration would
    // be a cache hit (~0.1ms) — measuring nothing. Increment the version key
    // directly instead.
    const wrapped = async () => {
      await cacheService.incr(`shop:${ctx.shopId}:cachev`).catch(() => {});
      return fn();
    };
    const r = await measure(name, wrapped);
    results.push(r);
    if (r.error) {
      console.log('  ' + name.padEnd(38) + '  ERROR: ' + r.error);
    } else {
      const flag = r.p95 > 500 ? '  <-- OVER BUDGET' : '';
      console.log('  ' + name.padEnd(38) +
        (r.p50.toFixed(1) + 'ms').padStart(9) +
        (r.p95.toFixed(1) + 'ms').padStart(9) +
        (r.max.toFixed(1) + 'ms').padStart(9) + flag);
    }
  }

  const over = results.filter((r) => !r.error && r.p95 > 500);
  const errored = results.filter((r) => r.error);
  console.log('');
  console.log(`  ${results.length - errored.length} measured, ${over.length} over the 500ms p95 budget, ${errored.length} errored`);
  return { results, over, errored };
}

// ── index usage check ───────────────────────────────────────────────────────
async function explainHotQueries(ctx) {
  console.log('\nIndex usage on the hot filters (COLLSCAN here means it will not scale)\n');
  const checks = [
    ['sales', { shop: ctx.shopId, branch: ctx.branchA }, { createdAt: -1 }],
    ['sales', { shop: ctx.shopId, branch: ctx.branchA, status: 'completed' }, { createdAt: -1 }],
    ['products', { shop: ctx.shopId, branch: ctx.branchA, isDeleted: { $ne: true } }, { createdAt: -1 }],
    ['products', { shop: ctx.shopId, branch: ctx.branchA, code: 'P000005' }, null],
    ['expenses', { shop: ctx.shopId, branch: ctx.branchA }, { date: -1 }],
    ['payments', { shop: ctx.shopId, branch: ctx.branchA }, { createdAt: -1 }],
  ];

  const rows = [];
  for (const [coll, filter, sort] of checks) {
    let q = mongoose.connection.db.collection(coll).find(filter);
    if (sort) q = q.sort(sort);
    const ex = await q.limit(20).explain('executionStats');
    const stage = JSON.stringify(ex.queryPlanner.winningPlan);
    const scan = stage.includes('COLLSCAN') ? 'COLLSCAN' : 'IXSCAN';
    const inMemSort = stage.includes('"SORT"') ? ' + in-memory SORT' : '';
    const idx = (stage.match(/"indexName":"([^"]+)"/) || [])[1] || '-';
    rows.push({ coll, scan, idx, inMemSort, examined: ex.executionStats.totalDocsExamined, returned: ex.executionStats.nReturned });
    console.log(`  ${coll.padEnd(10)} ${scan.padEnd(9)}${inMemSort.padEnd(18)} docs examined ${String(ex.executionStats.totalDocsExamined).padStart(7)} -> returned ${ex.executionStats.nReturned}`);
    console.log(`  ${' '.repeat(10)} index: ${idx}`);
  }
  return rows;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const { uri, benchName, prodName } = benchUri();
  console.log(`Benchmark database: ${benchName}  (production is ${prodName} — untouched)\n`);

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000, autoIndex: false, maxPoolSize: 20 });
  require('../src/models');

  if (mongoose.connection.name === prodName) {
    throw new Error('SAFETY ABORT: connected to the production database');
  }

  if (DROP_ONLY) {
    await mongoose.connection.db.dropDatabase();
    console.log('Benchmark database dropped.');
    await mongoose.connection.close();
    return;
  }

  let ctx;
  try {
    await mongoose.connection.db.dropDatabase(); // always start clean
    ctx = await seed();
    const { over, errored } = await run(ctx);
    await explainHotQueries(ctx);

    console.log('');
    if (over.length === 0 && errored.length === 0) {
      console.log('  RESULT: every measured endpoint is within the 500ms p95 budget.');
    } else {
      console.log('  RESULT: budget not met —');
      over.forEach((r) => console.log(`    ${r.name}: p95 ${r.p95.toFixed(0)}ms`));
      errored.forEach((r) => console.log(`    ${r.name}: ERROR ${r.error}`));
    }
  } finally {
    if (!KEEP) {
      await mongoose.connection.db.dropDatabase().catch(() => {});
      console.log('\nBenchmark database dropped.');
    } else {
      console.log(`\nKept ${benchName} (--keep). Drop it with: node scripts/perfBench.js --drop-only`);
    }
    await mongoose.connection.close();
  }
}

main().catch(async (err) => {
  console.error('\nBenchmark failed:', err.message);
  try {
    if (mongoose.connection.readyState === 1 && !KEEP) {
      await mongoose.connection.db.dropDatabase().catch(() => {});
      console.error('Benchmark database dropped.');
    }
    await mongoose.connection.close();
  } catch {}
  process.exit(1);
});
