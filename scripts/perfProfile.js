/**
 * Phase 6 — round-trip profiler.
 *
 *   node scripts/perfProfile.js        # seed (via perfBench), profile, drop
 *
 * Why this exists alongside perfBench.js
 * -------------------------------------
 * Measured from a dev machine, every Mongo command costs a full WAN round trip
 * to Atlas (~45ms), which dwarfs the query itself: a single findById reads as
 * "49ms" when the server spent under a millisecond on it. Wall-clock numbers
 * from here therefore say almost nothing about production, where the API server
 * sits next to the cluster.
 *
 * What does predict production latency:
 *     server-side execution time  +  (round trips x production RTT)
 *
 * This script measures both. It reuses perfBench's seeded dataset so the two
 * reports describe the same data.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const PROD_RTT_MS = 2; // API server co-located with the cluster
const BUDGET_MS = 500;

const IGNORED = new Set(['ping', 'ismaster', 'hello', 'endSessions', 'buildInfo', 'dbStats', 'listIndexes', 'createIndexes', 'listCollections']);

let counting = false;
let trips = 0;
let driverMs = 0;

function installCounter() {
  const client = mongoose.connection.getClient();
  client.on('commandStarted', (e) => {
    if (counting && !IGNORED.has(e.commandName)) trips++;
  });
  client.on('commandSucceeded', (e) => {
    if (counting && !IGNORED.has(e.commandName)) driverMs += e.duration;
  });
}

async function measureRtt() {
  const db = mongoose.connection.db;
  const t = [];
  for (let i = 0; i < 20; i++) {
    const t0 = process.hrtime.bigint();
    await db.command({ ping: 1 });
    t.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  t.sort((a, b) => a - b);
  return t[Math.floor(t.length / 2)];
}

async function profile(name, fn, rtt) {
  try {
    await fn(); // warm up
  } catch (e) {
    return { name, error: e.message };
  }

  counting = true; trips = 0; driverMs = 0;
  const t0 = process.hrtime.bigint();
  await fn();
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;
  counting = false;

  // Each driver duration includes that command's own RTT; subtract it out.
  const serverMs = Math.max(0, driverMs - trips * rtt);
  const estProd = serverMs + trips * PROD_RTT_MS;
  return { name, wall, trips, serverMs, estProd };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  const [base, query = ''] = uri.split('?');
  const woTrail = base.replace(/\/$/, '');
  const i = woTrail.lastIndexOf('/');
  const prodName = woTrail.slice(i + 1);
  const benchName = `${prodName}PerfBench`;
  const benchUri = `${woTrail.slice(0, i)}/${benchName}${query ? '?' + query : ''}`;

  await mongoose.connect(benchUri, { serverSelectionTimeoutMS: 15000, autoIndex: false, monitorCommands: true, maxPoolSize: 20 });
  if (mongoose.connection.name === prodName) throw new Error('SAFETY ABORT: production database');
  installCounter();

  const { seedForProfile } = require('./perfBenchSeed');
  const ctx = await seedForProfile(mongoose);

  const rtt = await measureRtt();
  console.log(`\nAtlas round-trip from this machine: ~${rtt.toFixed(0)}ms per command`);
  console.log(`Production assumption: API server beside the cluster, ~${PROD_RTT_MS}ms per command\n`);

  const Shop = require('../src/models/Shop.model');
  const shop = await Shop.findById(ctx.shopId).lean();
  const productService = require('../src/services/product.service');
  const saleService = require('../src/services/sale.service');
  const reportService = require('../src/services/report.service');
  const expenseService = require('../src/services/expense.service');
  const cashRegisterService = require('../src/services/cashRegister.service');
  const cacheService = require('../src/services/cache.service');
  const adminService = require('../src/services/admin.service');
  const purchaseService = require('../src/services/purchase.service');

  const reqFor = (branchId, isOwner = true) => ({
    shop: { _id: ctx.shopId, multiBranchEnabled: shop.multiBranchEnabled },
    user: { _id: isOwner ? ctx.ownerId : ctx.staffId, isOwner },
    branch: branchId ? { _id: branchId, code: 'DHA' } : null,
    branchId: branchId || null,
  });
  const staffReq = reqFor(ctx.branchA, false);
  const ownerReq = reqFor(ctx.branchA, true);
  const allReq = reqFor(null, true);

  const bust = () => cacheService.incr(`shop:${ctx.shopId}:cachev`).catch(() => {});

  const cases = [
    ['products list (staff, branch)', () => productService.getProducts(ctx.shopId, { limit: 20 }, staffReq)],
    ['products list (owner, all)', () => productService.getProducts(ctx.shopId, { limit: 20 }, allReq)],
    ['product search (POS keystroke)', () => productService.searchProductsForSale(ctx.shopId, { search: 'Rice', limit: 30 }, staffReq)],
    ['product by id', () => productService.getProductById(ctx.shopId, ctx.sampleProductId, staffReq)],
    ['low stock', () => productService.getLowStockProducts(ctx.shopId, 10, staffReq)],
    ['sales list (branch)', () => saleService.getSales(ctx.shopId, { limit: 20, branchId: ctx.branchA })],
    ['sales list (all branches)', () => saleService.getSales(ctx.shopId, { limit: 20 })],
    ['sale by id', () => saleService.getSaleById(ctx.shopId, ctx.sampleSaleId, ctx.branchA, ownerReq)],
    ['dashboard (branch)', async () => { await bust(); return reportService.getDashboardStats(ctx.shopId, ctx.branchA, true); }],
    ['dashboard (multi, all branches)', async () => { await bust(); return reportService.getDashboardStats(ctx.shopId, null, true); }],
    ['dashboard (single-branch shop)', async () => { await bust(); return reportService.getDashboardStats(ctx.shopId, null, false); }],
    ['daily summary', async () => { await bust(); return reportService.getDailySummary(ctx.shopId, {}, ctx.branchA); }],
    ['profit & loss (30d)', async () => {
      await bust();
      return reportService.getProfitLoss(ctx.shopId, {
        startDate: new Date(Date.now() - 30 * 8.64e7).toISOString().slice(0, 10),
        endDate: new Date().toISOString().slice(0, 10),
      }, ctx.branchA);
    }],
    ['product report', () => reportService.getProductReport(ctx.shopId, {}, ctx.branchA)],
    ['expenses list', () => expenseService.getExpenses(ctx.shopId, { limit: 20, branchId: ctx.branchA })],
    ['expense summary', () => expenseService.getSummary(ctx.shopId, {}, staffReq)],
    ['cash register today', () => cashRegisterService.getTodayRegister(ctx.shopId, ctx.ownerId, staffReq)],

    // ── PERFORMANCE_AUDIT.md suspects ────────────────────────────────────────
    // Added for the Phase 0 baseline. The existing cases above cover the read
    // paths that were optimized previously; these cover the ones that were not.

    // H-1: two queries per shop on the page, and the per-shop aggregate has no
    // date bound. Needs the neighbour shops from the seed to show anything.
    ['ADMIN shop list (page of 20)', () => adminService.getAllShops({ page: 1, limit: 20 })],

    // H-2: counts today's sales on every checkout, so it grows through the day.
    ['H2 invoice number generation', () => saleService.generateInvoiceNumber(ctx.shopId, 'DHA')],

    // M-1: cache keys and TTLs are defined for these three and never used.
    ['M1 sales report (30d, uncached)', () => reportService.getSalesReport(ctx.shopId, {
      startDate: new Date(Date.now() - 30 * 8.64e7).toISOString().slice(0, 10),
      endDate: new Date().toISOString().slice(0, 10),
    }, ctx.branchA)],
    ['M1 customer report (uncached)', () => reportService.getCustomerReport(ctx.shopId, {}, ownerReq)],

    // H-3: findById + save() per line item, sequential, inside a transaction.
    // A write — safe here because this is the throwaway PerfBench database.
    ['H3 purchase receive (20 lines)', () => purchaseService.createPurchase(
      ctx.shopId, ctx.ownerId,
      {
        supplier: null,
        items: ctx.purchaseProductIds.map((pid) => ({
          product: pid, quantity: 5, unitPrice: 40,
        })),
        paid: 0, paymentMethod: 'cash',
      },
      ownerReq
    )],
  ];

  console.log('  ' + 'endpoint'.padEnd(34) + 'wall'.padStart(9) + 'trips'.padStart(7) + 'server'.padStart(9) + 'est.prod'.padStart(10));
  console.log('  ' + '─'.repeat(70));

  const rows = [];
  for (const [name, fn] of cases) {
    const r = await profile(name, fn, rtt);
    rows.push(r);
    if (r.error) {
      console.log('  ' + name.padEnd(34) + '  ERROR: ' + r.error);
      continue;
    }
    const flag = r.estProd > BUDGET_MS ? '  <-- OVER' : '';
    console.log('  ' + name.padEnd(34) +
      (r.wall.toFixed(0) + 'ms').padStart(9) +
      String(r.trips).padStart(7) +
      (r.serverMs.toFixed(0) + 'ms').padStart(9) +
      (r.estProd.toFixed(0) + 'ms').padStart(10) + flag);
  }

  console.log('\n  wall     = measured here; ~' + rtt.toFixed(0) + 'ms of it is WAN latency per round trip');
  console.log('  trips    = Mongo round trips per call');
  console.log('  server   = server-side execution time, network excluded');
  console.log('  est.prod = server + trips x ' + PROD_RTT_MS + 'ms\n');

  const over = rows.filter((r) => !r.error && r.estProd > BUDGET_MS);
  const worstTrips = [...rows].filter((r) => !r.error).sort((a, b) => b.trips - a.trips).slice(0, 3);

  if (over.length === 0) {
    console.log(`  RESULT: all ${rows.length} endpoints within the ${BUDGET_MS}ms budget under production conditions.`);
    console.log('  Highest round-trip counts (the remaining lever): ' +
      worstTrips.map((r) => `${r.name} (${r.trips})`).join(', '));
  } else {
    console.log('  RESULT: over budget under production conditions —');
    over.forEach((r) => console.log(`    ${r.name}: ${r.estProd.toFixed(0)}ms (${r.trips} trips, ${r.serverMs.toFixed(0)}ms server)`));
  }

  await mongoose.connection.db.dropDatabase();
  console.log('\nBenchmark database dropped.');
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error('\nProfile failed:', err.message);
  try {
    if (mongoose.connection.readyState === 1) await mongoose.connection.db.dropDatabase().catch(() => {});
    await mongoose.connection.close();
  } catch {}
  process.exit(1);
});
