/**
 * ═══════════════════════════════════════════════════════════════
 *   Hisaab — Clothing Shop 3-Month Demo Data Seeder
 *   Account: 01757995016 / 123456
 *   Shop Type: cloth (হিসাব ফ্যাশন গ্যালারী)
 * ═══════════════════════════════════════════════════════════════
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');

// Models
const User = require('../src/models/User.model');
const Shop = require('../src/models/Shop.model');
const Category = require('../src/models/Category.model');
const Product = require('../src/models/Product.model');
const Customer = require('../src/models/Customer.model');
const Supplier = require('../src/models/Supplier.model');
const Sale = require('../src/models/Sale.model');
const Purchase = require('../src/models/Purchase.model');
const Expense = require('../src/models/Expense.model');
const ExpenseCategory = require('../src/models/ExpenseCategory.model');
const Payment = require('../src/models/Payment.model');
const StockTransaction = require('../src/models/StockTransaction.model');
const CashRegister = require('../src/models/CashRegister.model');
const Role = require('../src/models/Role.model');

const { ROLE_PRESETS } = require('../src/config/permissions');

// Helpers
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rand(0, arr.length - 1)];
const round = (n) => Math.round(n * 100) / 100;

function bdDate(year, month, day, hour = 10, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 6, minute));
}

function dateRange(start, end) {
  const dates = [];
  const cur = new Date(start);
  while (cur <= end) {
    dates.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ─── Data Definitions ────────────────────────────────────────

const CATEGORIES = [
  { name: "Men's Clothing", nameBn: 'ছেলেদের পোশাক' },
  { name: "Women's Clothing", nameBn: 'মেয়েদের পোশাক' },
  { name: "Kids' Clothing", nameBn: 'বাচ্চাদের পোশাক' },
  { name: 'Accessories', nameBn: 'আনুষাঙ্গিক জিনিসপত্র' },
];

/**
 * Exactly 10 Products covering all cases:
 * 1. Regular Product (Low Stock)
 * 2. Regular Product (Out of Stock)
 * 3. Regular Product (Normal Stock)
 * 4. Variant Product (Normal Stock across variants)
 * 5. Variant Product (Low Stock & Out of Stock variants)
 * 6. Regular High Selling Product
 * 7. Regular Women's Kurti
 * 8. Kids Product
 * 9. Accessories Product
 * 10. Batch Tracked Product
 */
const DEMO_PRODUCTS = [
  // 1. Regular Low Stock
  {
    code: 'MEN001',
    name: 'প্রিমিয়াম পোলো টি-শার্ট',
    cat: 0,
    buy: 350,
    sell: 700,
    stock: 3,
    minStock: 5,
    unit: 'piece',
    hasVariants: false,
  },
  // 2. Regular Out of Stock
  {
    code: 'WOM001',
    name: 'ঐতিহ্যবাহী জামদানী শাড়ি',
    cat: 1,
    buy: 1800,
    sell: 3500,
    stock: 0,
    minStock: 5,
    unit: 'piece',
    hasVariants: false,
  },
  // 3. Regular Normal Stock
  {
    code: 'MEN002',
    name: 'ক্যাজুয়াল ডেনিম জিন্স',
    cat: 0,
    buy: 750,
    sell: 1600,
    stock: 45,
    minStock: 5,
    unit: 'piece',
    hasVariants: false,
  },
  // 4. Variant Product (Normal Stock)
  {
    code: 'MEN003',
    name: 'সেমি-ফিট পাঞ্জাবি',
    cat: 0,
    unit: 'piece',
    hasVariants: true,
    minStock: 5,
    variants: [
      { sku: 'MEN003-WHT-M', attributes: { size: 'M', color: 'White' }, buyingPrice: 900, sellingPrice: 1800, stock: 15 },
      { sku: 'MEN003-WHT-L', attributes: { size: 'L', color: 'White' }, buyingPrice: 900, sellingPrice: 1800, stock: 20 },
      { sku: 'MEN003-NVY-XL', attributes: { size: 'XL', color: 'Navy' }, buyingPrice: 950, sellingPrice: 1900, stock: 25 },
    ]
  },
  // 5. Variant Product (Low Stock & Out of Stock Variants)
  {
    code: 'WOM002',
    name: 'সুতি থ্রি-পিস',
    cat: 1,
    unit: 'set',
    hasVariants: true,
    minStock: 5,
    variants: [
      { sku: 'WOM002-RED-M', attributes: { size: 'M', color: 'Red' }, buyingPrice: 850, sellingPrice: 1650, stock: 2 }, // Low stock variant
      { sku: 'WOM002-RED-L', attributes: { size: 'L', color: 'Red' }, buyingPrice: 850, sellingPrice: 1650, stock: 15 },
      { sku: 'WOM002-BLU-XL', attributes: { size: 'XL', color: 'Blue' }, buyingPrice: 850, sellingPrice: 1650, stock: 0 }, // Out of stock variant
    ]
  },
  // 6. Regular High Seller
  {
    code: 'MEN004',
    name: 'সুতি ক্যাজুয়াল শার্ট',
    cat: 0,
    buy: 550,
    sell: 1150,
    stock: 60,
    minStock: 5,
    unit: 'piece',
    hasVariants: false,
  },
  // 7. Regular Women's Designer Kurti
  {
    code: 'WOM003',
    name: 'ডিজাইনার জর্জেট কুর্তি',
    cat: 1,
    buy: 650,
    sell: 1350,
    stock: 35,
    minStock: 5,
    unit: 'piece',
    hasVariants: false,
  },
  // 8. Kids Clothing Set
  {
    code: 'KID001',
    name: 'বেবি বয় টি-শার্ট ও শর্টস সেট',
    cat: 2,
    buy: 300,
    sell: 650,
    stock: 25,
    minStock: 5,
    unit: 'set',
    hasVariants: false,
  },
  // 9. Accessories
  {
    code: 'ACC001',
    name: 'প্রিমিয়াম চামড়ার মানিব্যাগ',
    cat: 3,
    buy: 400,
    sell: 900,
    stock: 40,
    minStock: 5,
    unit: 'piece',
    hasVariants: false,
  },
  // 10. Batch Tracked Product
  {
    code: 'MEN005',
    name: 'প্রিমিয়াম উইন্টার জ্যাকেট',
    cat: 0,
    buy: 1500,
    sell: 3200,
    stock: 18,
    minStock: 5,
    unit: 'piece',
    hasVariants: false,
    trackBatches: true,
    batches: [
      { batchNumber: 'JKT-2026A', quantity: 18, costPrice: 1500, expiryDate: new Date('2027-12-31') }
    ]
  }
];

const CUSTOMERS = [
  { name: 'Rahim Uddin', phone: '01712345001', address: 'Chapainawabganj Sadar', tags: ['regular'] },
  { name: 'Karim Mia', phone: '01712345002', address: 'Shibganj', tags: ['regular'] }, // Will have due
  { name: 'Abdul Jabbar', phone: '01712345003', address: 'Gomastapur', tags: ['wholesale'] }, // Will have due
  { name: 'Fatema Begum', phone: '01712345004', address: 'Nachole', tags: ['regular'] }, // Will have due
  { name: 'Md. Shahidul Islam', phone: '01712345005', address: 'Bholahat', tags: ['regular'] },
  { name: 'Anwar Hossain', phone: '01712345006', address: 'Chapainawabganj Town', tags: ['regular'] },
  { name: 'Rubina Khatun', phone: '01712345007', address: 'Shibganj Bazar', tags: ['regular'] },
  { name: 'Habibur Rahman', phone: '01712345008', address: 'Kansat', tags: ['wholesale'] },
  { name: 'Nasima Akter', phone: '01712345009', address: 'Rohanpur', tags: ['regular'] },
  { name: 'Mohsin Ali', phone: '01712345010', address: 'Amnura', tags: ['regular'] },
];

const SUPPLIERS = [
  { name: 'Dhaka Wholesale Apparel', phone: '01911100001', address: 'Banga Bazar, Dhaka' },
  { name: 'Keraniganj Garments Hub', phone: '01911100002', address: 'Keraniganj, Dhaka' },
  { name: 'Narayanganj Knitwear Suppliers', phone: '01911100003', address: 'Narayanganj' },
  { name: 'Islampur Textile Hub', phone: '01911100005', address: 'Islampur, Dhaka' },
];

// ═════════════════════════════════════════════════════════════
//  MAIN SEED FUNCTION
// ═════════════════════════════════════════════════════════════
async function seed() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   Hisaab — 3-Month Demo Data Seeder          ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB\n');

  const db = mongoose.connection.db;

  const targetPhone = '01757995016';

  // Clear existing shop and user data matching target phone
  const existingUsers = await db.collection('users').find({ phone: { $in: [targetPhone, '88' + targetPhone] } }).toArray();
  const userIds = existingUsers.map(u => u._id);
  const shopIds = existingUsers.map(u => u.shop).filter(Boolean);

  const existingShops = await db.collection('shops').find({
    $or: [{ phone: { $in: [targetPhone, '88' + targetPhone] } }, { owner: { $in: userIds } }, { _id: { $in: shopIds } }]
  }).toArray();
  const allShopIds = existingShops.map(s => s._id);

  console.log('🗑  Purging old records for demo account...');
  const collections = await db.listCollections().toArray();
  for (const col of collections) {
    const colName = col.name;
    if (colName === 'shops') {
      await db.collection(colName).deleteMany({ _id: { $in: allShopIds } });
    } else if (colName === 'users') {
      await db.collection(colName).deleteMany({ $or: [{ shop: { $in: allShopIds } }, { _id: { $in: userIds } }, { phone: targetPhone }] });
    } else {
      await db.collection(colName).deleteMany({ shop: { $in: allShopIds } });
    }
  }
  console.log('✅ Previous demo shop data cleared.\n');

  // ── Step 1: Create Shop & User ────────────────────────────
  console.log('── Step 1: Creating Shop & Demo User ──');
  const shop = await Shop.create({
    name: 'হিসাব ফ্যাশন গ্যালারী',
    type: 'cloth',
    address: 'চাপাইনবাবগঞ্জ নিউ মার্কেট, চাপাইনবাবগঞ্জ',
    phone: targetPhone,
    subscription: {
      plan: 'paid',
      status: 'active',
      startedAt: new Date('2026-01-01'),
      expiresAt: new Date('2027-12-31'),
      monthlyPrice: 1000,
    },
    settings: {
      currency: 'BDT',
      lowStockThreshold: 5,
      invoicePrefix: 'HFG',
      taxEnabled: false,
    }
  });

  const user = await User.create({
    phone: targetPhone,
    password: '123456',
    name: 'মাইনুল হাসান (ডেমো ওনার)',
    shop: shop._id,
    isOwner: true,
    isActive: true,
    isPhoneVerified: true,
  });

  shop.owner = user._id;
  await shop.save();
  console.log(`   ✅ Created Shop: "${shop.name}" and Owner User: ${user.phone}`);

  const shopId = shop._id;
  const userId = user._id;

  // Roles
  const roleDocs = [];
  for (const [key, preset] of Object.entries(ROLE_PRESETS)) {
    roleDocs.push({
      shop: shopId,
      name: preset.name,
      permissions: preset.permissions,
      isDefault: true,
      isActive: true,
    });
  }
  await Role.insertMany(roleDocs);

  // ── Step 2: Categories ──────────────────────────────────
  console.log('\n── Step 2: Creating Categories ──');
  const categoryDocs = [];
  for (const cat of CATEGORIES) {
    const doc = await Category.create({
      shop: shopId,
      name: cat.name,
      nameBn: cat.nameBn,
      order: CATEGORIES.indexOf(cat),
    });
    categoryDocs.push(doc);
  }
  console.log(`   ✅ Created ${categoryDocs.length} categories`);

  // ── Step 3: Products (Exactly 10) ────────────────────────
  console.log('\n── Step 3: Creating Products (10 Curated Items) ──');
  const productDocs = [];
  for (const p of DEMO_PRODUCTS) {
    const pData = {
      shop: shopId,
      code: p.code,
      name: p.name,
      category: categoryDocs[p.cat]._id,
      unit: p.unit || 'piece',
      hasVariants: p.hasVariants || false,
      minStock: p.minStock || 5,
      isActive: true,
      createdBy: userId,
    };

    if (p.hasVariants) {
      pData.variants = p.variants;
    } else {
      pData.buyingPrice = p.buy;
      pData.sellingPrice = p.sell;
      pData.stock = p.stock;
      if (p.trackBatches) {
        pData.trackBatches = true;
        pData.batches = p.batches;
      }
    }

    const doc = await Product.create(pData);
    productDocs.push(doc);
  }
  console.log(`   ✅ Created ${productDocs.length} products (Regular, Variants, Low Stock, Zero Stock, Batch)`);

  // ── Step 4: Customers ───────────────────────────────────
  console.log('\n── Step 4: Creating Customers ──');
  const customerDocs = [];
  for (const c of CUSTOMERS) {
    const doc = await Customer.create({
      shop: shopId,
      phone: c.phone,
      name: c.name,
      address: c.address,
      tags: c.tags,
      isActive: true,
      createdBy: userId,
    });
    customerDocs.push(doc);
  }
  console.log(`   ✅ Created ${customerDocs.length} customers`);

  // ── Step 5: Suppliers ───────────────────────────────────
  console.log('\n── Step 5: Creating Suppliers ──');
  const supplierDocs = [];
  for (const s of SUPPLIERS) {
    const doc = await Supplier.create({
      shop: shopId,
      name: s.name,
      phone: s.phone,
      address: s.address,
      isActive: true,
      createdBy: userId,
    });
    supplierDocs.push(doc);
  }
  console.log(`   ✅ Created ${supplierDocs.length} suppliers`);

  // ── Step 6: Expense Categories ──────────────────────────
  console.log('\n── Step 6: Expense Categories ──');
  await ExpenseCategory.seedDefaults();
  const expenseCats = await ExpenseCategory.find({ shop: null, isActive: true });

  // ── Step 7: Generate 3 Months of Transactions ─────────────
  console.log('\n── Step 7: Generating 3 Months of Transactions (May 4, 2026 to Aug 4, 2026) ──');

  const startDate = bdDate(2026, 5, 4); // May 4, 2026
  const endDate = bdDate(2026, 8, 4);   // August 4, 2026
  const allDays = dateRange(startDate, endDate);

  let saleCounter = 0;
  let purchaseCounter = 0;
  let totalSalesCount = 0;

  for (let dIdx = 0; dIdx < allDays.length; dIdx++) {
    const day = allDays[dIdx];
    const isToday = dIdx === allDays.length - 1;
    const isWeekend = day.getDay() === 5; // Friday peak in BD retail
    const numSalesToday = isToday ? rand(2, 4) : (isWeekend ? rand(5, 8) : rand(3, 5));

    // A. RESTOCK / PURCHASES (every 7 days)
    if (dIdx % 7 === 0 && dIdx > 0) {
      purchaseCounter++;
      const supplier = supplierDocs[dIdx % supplierDocs.length];
      const purProduct = productDocs[dIdx % productDocs.length];
      
      let unitPrice = purProduct.buyingPrice || 700;
      let qty = rand(10, 25);
      let totalAmount = qty * unitPrice;
      let paid = dIdx % 14 === 0 ? totalAmount : round(totalAmount * 0.6); // Some purchases have due

      const purchase = await Purchase.create({
        shop: shopId,
        invoiceNo: `PUR2026${String(purchaseCounter).padStart(4, '0')}`,
        supplier: supplier._id,
        supplierName: supplier.name,
        items: [{
          product: purProduct._id,
          productName: purProduct.name,
          productCode: purProduct.code,
          quantity: qty,
          unitPrice,
          total: totalAmount,
        }],
        totalAmount,
        paid,
        due: Math.max(0, totalAmount - paid),
        paymentMethod: pick(['cash', 'bkash', 'bank']),
        date: day,
        createdBy: userId,
      });

      // Update supplier totals
      supplier.totalPurchases = (supplier.totalPurchases || 0) + 1;
      supplier.totalAmount = (supplier.totalAmount || 0) + totalAmount;
      supplier.totalDue = (supplier.totalDue || 0) + purchase.due;
      await supplier.save();
    }

    // B. DAILY SALES
    for (let s = 0; s < numSalesToday; s++) {
      saleCounter++;
      const customer = pick(customerDocs);
      const prod = pick(productDocs);

      let itemPrice = prod.sellingPrice || 1000;
      let itemCost = prod.buyingPrice || 500;
      let itemVariantSku = null;
      let itemName = prod.name;

      if (prod.hasVariants && prod.variants && prod.variants.length > 0) {
        const v = pick(prod.variants);
        itemPrice = v.sellingPrice;
        itemCost = v.buyingPrice;
        itemVariantSku = v.sku;
        itemName = `${prod.name} (${v.attributes.size || ''} ${v.attributes.color || ''})`;
      }

      const qty = rand(1, 2);
      const subtotal = itemPrice * qty;
      const discount = rand(0, 1) === 1 ? 50 : 0;
      const totalAmount = Math.max(0, subtotal - discount);

      // Customer due scenario: assign specific due to Karim, Abdul, Fatema
      let paidAmount = totalAmount;
      if (['Karim Mia', 'Abdul Jabbar', 'Fatema Begum'].includes(customer.name) && s === 0 && dIdx > 70) {
        paidAmount = round(totalAmount * 0.4); // 60% due
      }

      const dueAmount = Math.max(0, totalAmount - paidAmount);
      const saleDate = new Date(day.getTime() + (s * 3600000 + rand(10, 50) * 60000));
      const pMethod = pick(['cash', 'bkash', 'nagad']);

      const sale = await Sale.create({
        shop: shopId,
        invoiceNo: `HFG2026${String(saleCounter).padStart(5, '0')}`,
        customer: customer._id,
        customerName: customer.name,
        customerPhone: customer.phone,
        items: [{
          product: prod._id,
          productName: itemName,
          productCode: prod.code,
          variantSku: itemVariantSku,
          quantity: qty,
          unitPrice: itemPrice,
          buyingPrice: itemCost,
          discount: 0,
          total: subtotal,
        }],
        subtotal,
        discount,
        total: totalAmount,
        paid: paidAmount,
        due: dueAmount,
        profit: Math.max(0, (itemPrice - itemCost) * qty - discount),
        paymentMethod: pMethod,
        status: dueAmount > 0 ? (paidAmount > 0 ? 'partial' : 'unpaid') : 'completed',
        date: saleDate,
        createdAt: saleDate,
        createdBy: userId,
      });

      totalSalesCount++;

      // Update customer metrics & due balance
      customer.totalSales = (customer.totalSales || 0) + 1;
      customer.totalSpent = (customer.totalSpent || 0) + totalAmount;
      customer.totalDue = (customer.totalDue || 0) + dueAmount;
      await customer.save();

      // Create Payment log for paid amount
      if (paidAmount > 0) {
        await Payment.create({
          shop: shopId,
          sale: sale._id,
          customer: customer._id,
          amount: paidAmount,
          method: pMethod,
          type: 'sale_payment',
          receivedBy: userId,
          createdAt: saleDate,
        });
      }
    }

    // C. MONTHLY EXPENSES (rent, salary, utilities)
    if (day.getDate() === 10) {
      await Expense.create({
        shop: shopId,
        title: 'দোকান ভাড়া (Shop Rent)',
        amount: 12000,
        category: expenseCats[0]?._id,
        categoryName: 'Rent',
        paymentMethod: 'bank',
        date: day,
        createdBy: userId,
      });
      await Expense.create({
        shop: shopId,
        title: 'বিদ্যুৎ বিল (Electricity Bill)',
        amount: 2500,
        category: expenseCats[1]?._id,
        categoryName: 'Utilities',
        paymentMethod: 'bkash',
        date: day,
        createdBy: userId,
      });
    }
  }

  // Final updates to Customer Dues to match exact desired targets
  console.log('\n── Setting Exact Customer & Supplier Due Balances ──');

  const karim = await Customer.findOne({ shop: shopId, name: 'Karim Mia' });
  if (karim) { karim.totalDue = 3500; await karim.save(); }

  const abdul = await Customer.findOne({ shop: shopId, name: 'Abdul Jabbar' });
  if (abdul) { abdul.totalDue = 8200; await abdul.save(); }

  const fatema = await Customer.findOne({ shop: shopId, name: 'Fatema Begum' });
  if (fatema) { fatema.totalDue = 1450; await fatema.save(); }

  const dhakaSupp = await Supplier.findOne({ shop: shopId, name: 'Dhaka Wholesale Apparel' });
  if (dhakaSupp) { dhakaSupp.totalDue = 15000; await dhakaSupp.save(); }

  const islamPurSupp = await Supplier.findOne({ shop: shopId, name: 'Islampur Textile Hub' });
  if (islamPurSupp) { islamPurSupp.totalDue = 24000; await islamPurSupp.save(); }

  console.log('\n═══════════════════════════════════════════════');
  console.log('✅ DEMO DATA SEEDING COMPLETED SUCCESSFULLY!');
  console.log('═══════════════════════════════════════════════');
  console.log(`📱 Login Phone    : ${targetPhone}`);
  console.log(`🔑 Login Password : 123456`);
  console.log(`🏪 Shop Name       : হিসাব ফ্যাশন গ্যালারী`);
  console.log(`🛍️ Total Products  : ${productDocs.length}`);
  console.log(`👥 Total Customers : ${customerDocs.length}`);
  console.log(`🚚 Total Suppliers : ${supplierDocs.length}`);
  console.log(`🧾 Total Sales     : ${totalSalesCount} across 3 months`);
  console.log('═══════════════════════════════════════════════\n');

  await mongoose.disconnect();
}

seed().catch(err => {
  console.error('❌ Seeding Error:', err);
  process.exit(1);
});
