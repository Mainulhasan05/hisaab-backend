/**
 * Shared benchmark dataset for Phase 6 (perfBench.js / perfProfile.js).
 *
 * A 2-branch shop at the volume named in FEATURE_PLAN.md §9 — 10k products
 * (per-branch catalogues, so 5k each), 50k sales split across both branches and
 * 180 days, 2k shop-wide customers, plus expenses and due collections.
 *
 * Never called against the application database — the callers connect to a
 * separate `<db>PerfBench` database and assert the name before seeding.
 */

const SCALE = Number((process.argv.find((a) => a.startsWith('--scale=')) || '').split('=')[1]) || 1;

const N_PRODUCTS = Math.round(10000 * SCALE);
const N_SALES = Math.round(50000 * SCALE);
const N_CUSTOMERS = Math.round(2000 * SCALE);
const N_EXPENSES = Math.round(4000 * SCALE);
const N_PAYMENTS = Math.round(5000 * SCALE);
const MAX_DB_MB = 250;

// Neighbour shops, so the platform-admin shop list has a full page to render.
// That endpoint runs two queries PER SHOP ON THE PAGE, so the cost only shows
// up once the page is actually full — with one shop seeded it looks fine.
// Each carries its own sales history because the per-shop aggregate is
// unbounded (it sums the shop's entire lifetime, not a date window).
const N_ADMIN_SHOPS = Math.round(24 * SCALE);
const N_ADMIN_SHOP_SALES = Math.round(400 * SCALE);

/** Register every model — src/models/index.js only exports 17 of 29, and the
 *  omitted ones would otherwise be seeded without their indexes. */
function registerAllModels() {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'src', 'models');
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.model.js')) require(path.join(dir, f));
  }
}

async function seedForProfile(mongoose) {
  registerAllModels();
  const db = mongoose.connection.db;
  const oid = () => new mongoose.Types.ObjectId();
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const sizeMB = async () => (await db.stats()).storageSize / 1024 / 1024;

  const insert = async (coll, docs, label) => {
    const BATCH = 1000;
    for (let i = 0; i < docs.length; i += BATCH) {
      await db.collection(coll).insertMany(docs.slice(i, i + BATCH), { ordered: false });
    }
    const mb = await sizeMB();
    if (mb > MAX_DB_MB) throw new Error(`Storage budget exceeded (${mb.toFixed(0)}MB) at ${label}`);
    console.log(`  ${label}: ${docs.length}`);
  };

  await db.dropDatabase();
  console.log(`Seeding (scale ${SCALE}): ${N_PRODUCTS} products, ${N_SALES} sales\n`);

  const shopId = oid(), branchA = oid(), branchB = oid(), ownerId = oid(), staffId = oid();
  const now = Date.now();

  await db.collection('shops').insertOne({
    _id: shopId, name: 'Bench Shop', slug: 'bench-' + now, phone: '01700000000',
    multiBranchEnabled: true, isActive: true,
    subscription: { plan: 'paid', status: 'active', expiresAt: new Date(now + 8.64e7 * 365) },
    settings: { currency: 'BDT', lowStockThreshold: 5, invoicePrefix: 'INV' },
    createdAt: new Date(), updatedAt: new Date(),
  });

  await db.collection('branches').insertMany([
    { _id: branchA, shop: shopId, name: 'Dhanmondi', code: 'DHA', isDefault: true, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    { _id: branchB, shop: shopId, name: 'Chattogram', code: 'CTG', isDefault: false, isActive: true, createdAt: new Date(now + 1), updatedAt: new Date() },
  ]);

  await db.collection('users').insertMany([
    { _id: ownerId, shop: shopId, name: 'Owner', phone: '01700000000', password: 'x', isOwner: true, isActive: true, branch: null, lastActiveBranch: branchA, createdAt: new Date() },
    { _id: staffId, shop: shopId, name: 'Cashier', phone: '01700000001', password: 'x', isOwner: false, isActive: true, branch: branchA, createdAt: new Date() },
  ]);

  const customers = Array.from({ length: N_CUSTOMERS }, (_, i) => ({
    _id: oid(), shop: shopId, name: `Customer ${i}`, phone: `018${String(i).padStart(8, '0')}`,
    totalPurchases: 0, totalPaid: 0, totalDue: i % 5 === 0 ? 500 : 0, purchaseCount: 0,
    isActive: true, createdAt: new Date(now - i * 1000), updatedAt: new Date(),
  }));
  await insert('customers', customers, 'customers');

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
  await insert('products', products, 'products');

  const prodA = products.filter((p) => String(p.branch) === String(branchA));
  const prodB = products.filter((p) => String(p.branch) === String(branchB));

  const sales = [];
  for (let i = 0; i < N_SALES; i++) {
    const useA = i % 2 === 0;
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
      _id: oid(), shop: shopId, branch: useA ? branchA : branchB,
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
  await insert('sales', sales, 'sales');

  await insert('expenses', Array.from({ length: N_EXPENSES }, (_, i) => ({
    _id: oid(), shop: shopId, branch: i % 2 === 0 ? branchA : branchB,
    categoryName: ['Rent', 'Salary', 'Utility'][i % 3], amount: 500 + (i % 5000),
    paymentMethod: 'cash', date: new Date(now - (i % 180) * 8.64e7),
    createdBy: ownerId, createdAt: new Date(), updatedAt: new Date(),
  })), 'expenses');

  await insert('payments', Array.from({ length: N_PAYMENTS }, (_, i) => ({
    _id: oid(), shop: shopId, branch: i % 2 === 0 ? branchA : branchB,
    customer: pick(customers)._id, amount: 200 + (i % 800), method: 'cash',
    type: 'due_collection', receivedBy: ownerId,
    createdAt: new Date(now - (i % 180) * 8.64e7), updatedAt: new Date(),
  })), 'payments');

  // ── Supplier, for the purchase-receive path ──────────────────────────────
  const supplierId = oid();
  await db.collection('suppliers').insertOne({
    _id: supplierId, shop: shopId, name: 'Bench Supplier', phone: '01900000000',
    totalPurchases: 0, totalPaid: 0, totalDue: 0, isActive: true,
    createdAt: new Date(), updatedAt: new Date(),
  });

  // ── Neighbour shops for the platform-admin list ──────────────────────────
  //
  // The admin list is the one endpoint whose cost is driven by how many OTHER
  // tenants exist, so it cannot be measured against a single-shop database.
  const adminShops = [];
  const adminSales = [];
  for (let s = 0; s < N_ADMIN_SHOPS; s++) {
    const sid = oid();
    const sOwner = oid();
    adminShops.push({
      _id: sid, name: `Neighbour Shop ${s}`, slug: `neighbour-${s}-${now}`,
      phone: `0171${String(s).padStart(7, '0')}`, owner: sOwner,
      multiBranchEnabled: false, isActive: true,
      subscription: { plan: 'paid', status: 'active', expiresAt: new Date(now + 8.64e7 * 365) },
      settings: { currency: 'BDT', lowStockThreshold: 5, invoicePrefix: 'INV' },
      stats: { totalSales: N_ADMIN_SHOP_SALES, totalCustomers: 0, totalRevenue: 0 },
      createdAt: new Date(now - s * 8.64e7), updatedAt: new Date(),
    });
    for (let i = 0; i < N_ADMIN_SHOP_SALES; i++) {
      const amt = 100 + (i % 900);
      adminSales.push({
        _id: oid(), shop: sid, branch: null, invoiceNo: `INV-${s}-${i}`,
        items: [], subtotal: amt, discount: 0, discountType: 'fixed', tax: 0,
        deliveryCharge: 0, total: amt, paid: amt, due: 0, profit: amt * 0.2,
        paymentMethod: 'cash', status: i % 50 === 0 ? 'cancelled' : 'completed',
        customer: null, customerName: 'Walk-in', isOnline: false, channel: 'pos',
        createdBy: sOwner,
        createdAt: new Date(now - (i % 180) * 8.64e7), updatedAt: new Date(),
      });
    }
  }
  await insert('shops', adminShops, 'neighbour shops');
  await insert('sales', adminSales, 'neighbour shop sales');

  console.log(`\n  storage: ${(await sizeMB()).toFixed(1)}MB`);
  console.log('Building indexes from schema declarations...');
  for (const name of mongoose.modelNames()) {
    await mongoose.model(name).syncIndexes().catch(() => {});
  }
  console.log('  done');

  return {
    shopId, branchA, branchB, ownerId, staffId, supplierId,
    sampleSaleId: sales[0]._id,
    sampleProductId: prodA[5]._id,
    // A 20-line purchase — enough to make a per-item round-trip loop visible
    // against a batched one, and a realistic size for a wholesale delivery.
    purchaseProductIds: prodA.slice(0, 20).map((p) => p._id),
  };
}

module.exports = { seedForProfile };
