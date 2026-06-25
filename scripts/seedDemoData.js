/**
 * ═══════════════════════════════════════════════════════════════
 *   Hisaab — Clothing Shop Demo Data Seeder
 *   Clears database and creates 3 months of clothing shop data
 *   Account: 01757995016 / 123456
 * ═══════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// ─── Models ──────────────────────────────────────────────────
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
const SalesReturn = require('../src/models/SalesReturn.model');
const AuditLog = require('../src/models/AuditLog.model');
const Role = require('../src/models/Role.model');

// ─── Helpers ─────────────────────────────────────────────────
const { ROLE_PRESETS } = require('../src/config/permissions');
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

const PRODUCTS = [
  // Men's Clothing (cat 0)
  { name: 'Premium Polo T-Shirt', nameBn: 'প্রিমিয়াম পোলো টি-শার্ট', cat: 0, buy: 350, sell: 650, stock: 80, unit: 'piece', code: 'MEN001' },
  { name: 'Casual Cotton Shirt', nameBn: 'ক্যাজুয়াল সুতি শার্ট', cat: 0, buy: 600, sell: 1200, stock: 60, unit: 'piece', code: 'MEN002' },
  { name: 'Slim Fit Denim Jeans', nameBn: 'স্লিম ফিট ডেনিম জিন্স', cat: 0, buy: 700, sell: 1500, stock: 50, unit: 'piece', code: 'MEN003' },
  { name: 'Gabardine Chino Pant', nameBn: 'গ্যাবার্ডিন চিনো প্যান্ট', cat: 0, buy: 500, sell: 1100, stock: 55, unit: 'piece', code: 'MEN004' },
  { name: 'Premium Semi-Fit Punjabi', nameBn: 'প্রিমিয়াম সেমি-ফিট পাঞ্জাবি', cat: 0, buy: 900, sell: 1800, stock: 40, unit: 'piece', code: 'MEN005' },
  { name: 'Cotton Pajama', nameBn: 'সুতি পায়জামা', cat: 0, buy: 250, sell: 450, stock: 45, unit: 'piece', code: 'MEN006' },
  { name: 'Formal Leather Shoe', nameBn: 'ফরমাল চামড়ার জুতো', cat: 0, buy: 1200, sell: 2500, stock: 25, unit: 'piece', code: 'MEN007' },
  { name: 'Casual Sneaker', nameBn: 'ক্যাজুয়াল স্নিকার', cat: 0, buy: 950, sell: 1950, stock: 30, unit: 'piece', code: 'MEN008' },

  // Women's Clothing (cat 1)
  { name: 'Cotton Three Piece', nameBn: 'সুতি থ্রি-পিস', cat: 1, buy: 900, sell: 1750, stock: 70, unit: 'piece', code: 'WOM001' },
  { name: 'Designer Georgette Kurti', nameBn: 'ডিজাইনার জর্জেট কুর্তি', cat: 1, buy: 700, sell: 1400, stock: 65, unit: 'piece', code: 'WOM002' },
  { name: 'Traditional Silk Saree', nameBn: 'ঐতিহ্যবাহী সিল্ক শাড়ি', cat: 1, buy: 1500, sell: 3200, stock: 35, unit: 'piece', code: 'WOM003' },
  { name: 'Premium Linen Kurti', nameBn: 'প্রিমিয়াম লিনেন কুর্তি', cat: 1, buy: 500, sell: 950, stock: 80, unit: 'piece', code: 'WOM004' },
  { name: 'Ladies Leggings Pant', nameBn: 'লেডিস লেগিংস প্যান্ট', cat: 1, buy: 150, sell: 300, stock: 120, unit: 'piece', code: 'WOM005' },
  { name: 'Handloom Cotton Saree', nameBn: 'তাঁতের সুতি শাড়ি', cat: 1, buy: 600, sell: 1200, stock: 40, unit: 'piece', code: 'WOM006' },
  { name: 'Ladies Designer Tops', nameBn: 'লেডিস ডিজাইনার টপস', cat: 1, buy: 400, sell: 850, stock: 90, unit: 'piece', code: 'WOM007' },
  { name: 'Premium Hijab', nameBn: 'প্রিমিয়াম হিজাব', cat: 1, buy: 180, sell: 380, stock: 150, unit: 'piece', code: 'WOM008' },

  // Kids' Clothing (cat 2)
  { name: 'Baby Boy T-Shirt & Shorts Set', nameBn: 'বেবি বয় টি-শার্ট ও শর্টস সেট', cat: 2, buy: 300, sell: 600, stock: 50, unit: 'set', code: 'KID001' },
  { name: 'Baby Girl Cotton Frock', nameBn: 'বেবি গার্ল সুতি ফ্রক', cat: 2, buy: 400, sell: 850, stock: 60, unit: 'piece', code: 'KID002' },
  { name: 'Kids Denim Pant', nameBn: 'বাচ্চাদের ডেনিম প্যান্ট', cat: 2, buy: 350, sell: 700, stock: 45, unit: 'piece', code: 'KID003' },
  { name: 'Kids Cotton Pajama Set', nameBn: 'বাচ্চাদের সুতি পায়জামা সেট', cat: 2, buy: 200, sell: 400, stock: 80, unit: 'set', code: 'KID004' },
  { name: 'Kids Premium Polo Shirt', nameBn: 'বাচ্চাদের প্রিমিয়াম পোলো শার্ট', cat: 2, buy: 220, sell: 450, stock: 75, unit: 'piece', code: 'KID005' },

  // Accessories (cat 3)
  { name: 'Premium Leather Wallet', nameBn: 'প্রিমিয়াম চামড়ার মানিব্যাগ', cat: 3, buy: 400, sell: 950, stock: 50, unit: 'piece', code: 'ACC001' },
  { name: 'Genuine Leather Belt', nameBn: 'জেনুইন চামড়ার বেল্ট', cat: 3, buy: 350, sell: 750, stock: 60, unit: 'piece', code: 'ACC002' },
  { name: 'Ankle Length Cotton Socks', nameBn: 'অ্যাঙ্কেল সুতি মোজা', cat: 3, buy: 50, sell: 120, stock: 200, unit: 'set', code: 'ACC003' },
  { name: 'Premium Perfume 50ml', nameBn: 'প্রিমিয়াম পারফিউম ৫০মিলি', cat: 3, buy: 600, sell: 1350, stock: 35, unit: 'piece', code: 'ACC004' },
  { name: 'Fashion Sunglasses', nameBn: 'ফ্যাশন সানগ্লাস', cat: 3, buy: 250, sell: 600, stock: 80, unit: 'piece', code: 'ACC005' },
];

const CUSTOMERS = [
  { name: 'Rahim Uddin', phone: '01712345001', address: 'Chapainawabganj Sadar', tags: ['regular'] },
  { name: 'Karim Mia', phone: '01712345002', address: 'Shibganj', tags: ['regular'] },
  { name: 'Abdul Jabbar', phone: '01712345003', address: 'Gomastapur', tags: ['wholesale'] },
  { name: 'Fatema Begum', phone: '01712345004', address: 'Nachole', tags: ['regular'] },
  { name: 'Md. Shahidul Islam', phone: '01712345005', address: 'Bholahat', tags: ['regular'] },
  { name: 'Anwar Hossain', phone: '01712345006', address: 'Chapainawabganj Town', tags: ['regular'] },
  { name: 'Rubina Khatun', phone: '01712345007', address: 'Shibganj Bazar', tags: ['regular'] },
  { name: 'Habibur Rahman', phone: '01712345008', address: 'Kansat', tags: ['wholesale'] },
  { name: 'Nasima Akter', phone: '01712345009', address: 'Rohanpur', tags: ['regular'] },
  { name: 'Mohsin Ali', phone: '01712345010', address: 'Amnura', tags: ['regular'] },
  { name: 'Sumon Chandra', phone: '01712345011', address: 'Godagari Road', tags: ['regular'] },
  { name: 'Jahanara Begum', phone: '01712345012', address: 'Sadar Hospital Road', tags: ['regular'] },
  { name: 'Nur Islam', phone: '01712345013', address: 'Chapainawabganj Bypass', tags: ['regular'] },
  { name: 'Dilip Kumar', phone: '01712345014', address: 'Shibganj', tags: ['regular'] },
  { name: 'Salma Khatun', phone: '01712345015', address: 'Nachole Bazar', tags: ['regular'] },
  { name: 'Raju Ahmed', phone: '01712345016', address: 'Chapainawabganj', tags: ['regular'] },
  { name: 'Moyna Begum', phone: '01712345017', address: 'Kansat Bazar', tags: ['regular'] },
  { name: 'Monirul Haque', phone: '01712345018', address: 'Court Road', tags: ['regular'] },
  { name: 'Shahana Perveen', phone: '01712345019', address: 'Bus Stand Area', tags: ['regular'] },
  { name: 'Belal Hossain', phone: '01712345020', address: 'Chapai New Market', tags: ['wholesale'] },
  { name: 'Khaleda Begum', phone: '01712345021', address: 'Station Road', tags: ['regular'] },
  { name: 'Tariqul Islam', phone: '01712345022', address: 'Gomastapur', tags: ['regular'] },
  { name: 'Shamim Hasan', phone: '01712345023', address: 'College Road', tags: ['regular'] },
  { name: 'Arif Hossain', phone: '01712345024', address: 'Jhilim Mor', tags: ['regular'] },
  { name: 'Kamrunnesa', phone: '01712345025', address: 'Shibganj Sadar', tags: ['regular'] },
];

const SUPPLIERS = [
  { name: 'Dhaka Wholesale Apparel', phone: '01911100001', address: 'Banga Bazar, Dhaka' },
  { name: 'Keraniganj Garments Hub', phone: '01911100002', address: 'Keraniganj, Dhaka' },
  { name: 'Narayanganj Knitwear Suppliers', phone: '01911100003', address: 'Narayanganj' },
  { name: 'Premium Leather Craft (BD)', phone: '01911100004', address: 'Hazaribagh, Dhaka' },
  { name: 'Sadaf Fabrics & Textile', phone: '01911100005', address: 'Islampur, Dhaka' },
  { name: 'Local Boutique Crafter', phone: '01911100006', address: 'Mirpur, Dhaka' },
];

const PAYMENT_METHODS = ['cash', 'bkash', 'nagad', 'card', 'bank'];

// ═════════════════════════════════════════════════════════════
//  MAIN SEED FUNCTION
// ═════════════════════════════════════════════════════════════
async function seed() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   হিসাব — Clothing Shop Demo Data Seeder       ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB\n');

  // ── Step 0: Clear the whole database ────────────────────
  console.log('🗑  Clearing the entire database (dropping)...');
  await mongoose.connection.db.dropDatabase();
  console.log('✅ Database cleared successfully.\n');

  // ── Step 1: Setting up demo user & shop ─────────────
  console.log('── Step 1: Setting up demo user & shop ──');

  let shop, user;
  const demoPhone = '01757995016';

  // Create shop
  shop = await Shop.create({
    name: 'Hisaab Fashion Gallery',
    type: 'cloth',
    address: 'Chapai New Market, Chapainawabganj',
    phone: demoPhone,
    subscription: {
      plan: 'paid',
      status: 'active',
      startedAt: new Date('2026-01-01'),
      expiresAt: new Date('2027-06-01'),
      monthlyPrice: 1000,
    },
  });

  // Create user (pass plaintext password so Mongoose hook hashes it exactly once)
  user = await User.create({
    phone: demoPhone,
    password: '123456',
    name: 'Demo Owner',
    shop: shop._id,
    isOwner: true,
    isActive: true,
    isPhoneVerified: true,
  });

  shop.owner = user._id;
  await shop.save();
  console.log(`   ✅ Created new user & shop: ${shop.name}`);

  const shopId = shop._id;
  const userId = user._id;

  // Seed default roles
  console.log('── Seeding default shop roles ──');
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
  console.log('   ✅ Seeded Manager and Cashier roles');

  // ── Step 2: Categories ──────────────────────────────────
  console.log('\n── Step 2: Creating categories ──');
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

  // ── Step 3: Products ────────────────────────────────────
  console.log('\n── Step 3: Creating products ──');
  const productDocs = [];
  for (const p of PRODUCTS) {
    const doc = await Product.create({
      shop: shopId,
      code: p.code,
      name: p.nameBn || p.name,
      category: categoryDocs[p.cat]._id,
      buyingPrice: p.buy,
      sellingPrice: p.sell,
      stock: p.stock,
      minStock: 5,
      unit: p.unit || 'piece',
      hasVariants: false,
      isActive: true,
      createdBy: userId,
    });
    productDocs.push(doc);
  }
  console.log(`   ✅ Created ${productDocs.length} products`);

  // ── Step 4: Customers ───────────────────────────────────
  console.log('\n── Step 4: Creating customers ──');
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
  console.log('\n── Step 5: Creating suppliers ──');
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

  // ── Step 6: Expense categories (get defaults) ───────────
  console.log('\n── Step 6: Fetching expense categories ──');
  await ExpenseCategory.seedDefaults();
  const expenseCats = await ExpenseCategory.find({ shop: null, isActive: true });
  console.log(`   ✅ Found ${expenseCats.length} expense categories`);

  // ── Step 7: Generate 3 months of transactions ───────────
  console.log('\n── Step 7: Generating 3 months of transactions ──');
  console.log('   This takes a minute...\n');

  const startDate = bdDate(2026, 3, 22); // March 22, 2026
  const endDate = bdDate(2026, 6, 22);   // June 22, 2026
  const allDays = dateRange(startDate, endDate);

  let totalSales = 0;
  let totalPurchases = 0;
  let totalExpenses = 0;
  let totalReturns = 0;
  let saleCounter = 0;
  let purchaseCounter = 0;
  let returnCounter = 0;

  // Track running stock so the numbers make sense
  const stockMap = {};
  for (const p of productDocs) {
    stockMap[p._id.toString()] = p.stock;
  }

  // We'll collect sale docs for later returns
  const allSaleDocs = [];

  for (const day of allDays) {
    const dayStr = day.toISOString().split('T')[0];
    const isWeekend = day.getDay() === 5; // Friday
    const isMonth3 = day.getMonth() === 2; // March – lower traffic
    const multiplier = isWeekend ? 1.4 : 1.0; // Clothing shops spike on weekends
    const monthMult = isMonth3 ? 0.8 : (day.getMonth() === 4 ? 1.3 : 1.0); // May higher (Eid/festive shopping)

    // ─── PURCHASES (every 5-7 days, restock) ───
    const dayIndex = allDays.indexOf(day);
    if (dayIndex % rand(5, 7) === 0) {
      const numItems = rand(3, 8);
      const purchaseItems = [];
      const selectedProducts = [];

      for (let i = 0; i < numItems; i++) {
        const prod = pick(productDocs);
        if (selectedProducts.includes(prod._id.toString())) continue;
        selectedProducts.push(prod._id.toString());

        const qty = rand(15, 80);
        const unitPrice = prod.buyingPrice;
        purchaseItems.push({
          product: prod._id,
          productName: prod.name,
          productCode: prod.code,
          quantity: qty,
          unitPrice,
          total: qty * unitPrice,
        });

        // Update stock
        stockMap[prod._id.toString()] = (stockMap[prod._id.toString()] || 0) + qty;
      }

      if (purchaseItems.length > 0) {
        purchaseCounter++;
        const totalAmount = purchaseItems.reduce((s, i) => s + i.total, 0);
        const paidAmount = Math.random() > 0.3 ? totalAmount : round(totalAmount * 0.7);
        const supplier = pick(supplierDocs);

        const invoiceNo = `PUR${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(purchaseCounter).padStart(4, '0')}`;

        const purchase = new Purchase({
          shop: shopId,
          invoiceNo,
          supplier: supplier._id,
          supplierName: supplier.name,
          items: purchaseItems,
          totalAmount,
          paid: paidAmount,
          due: Math.max(0, totalAmount - paidAmount),
          paymentMethod: pick(['cash', 'bkash', 'bank']),
          date: new Date(day.getTime() + rand(0, 3) * 3600000),
          createdBy: userId,
        });
        await purchase.save();
        totalPurchases++;

        // Update supplier
        supplier.totalPurchases += 1;
        supplier.totalAmount += totalAmount;
        supplier.totalDue += purchase.due;
        await supplier.save();

        // Stock transactions for purchase
        for (const item of purchaseItems) {
          const prevStock = (stockMap[item.product.toString()] || 0) - item.quantity;
          await StockTransaction.create({
            shop: shopId,
            product: item.product,
            productName: item.productName,
            productCode: item.productCode,
            type: 'purchase',
            quantity: item.quantity,
            previousStock: Math.max(0, prevStock),
            newStock: stockMap[item.product.toString()],
            unitCost: item.unitPrice,
            totalCost: item.total,
            reference: { type: 'purchase', id: purchase._id, invoiceNo },
            supplier: supplier.name,
            createdBy: userId,
            createdAt: purchase.date,
          });
        }

        // Payment record for purchase
        if (paidAmount > 0) {
          await Payment.create({
            shop: shopId,
            purchase: purchase._id,
            amount: paidAmount,
            method: purchase.paymentMethod,
            type: 'purchase_payment',
            receivedBy: userId,
            createdAt: purchase.date,
          });
        }
      }
    }

    // ─── SALES (5-15 per day) ───
    const numSales = Math.floor(rand(4, 12) * multiplier * monthMult);
    const daySaleRevenues = [];
    const dayPaymentsForCash = { salesCash: 0, dueCollections: 0 };

    for (let s = 0; s < numSales; s++) {
      saleCounter++;
      const numItems = rand(1, 4);
      const saleItems = [];
      const selectedProds = [];

      for (let i = 0; i < numItems; i++) {
        const prod = pick(productDocs);
        if (selectedProds.includes(prod._id.toString())) continue;
        selectedProds.push(prod._id.toString());

        const availStock = stockMap[prod._id.toString()] || 0;
        if (availStock <= 0) continue;

        const qty = Math.min(rand(1, 3), availStock);
        const discount = Math.random() > 0.8 ? rand(20, 100) : 0; // Clothes discount is higher

        saleItems.push({
          product: prod._id,
          productName: prod.name,
          productCode: prod.code,
          quantity: qty,
          unitPrice: prod.sellingPrice,
          buyingPrice: prod.buyingPrice,
          discount,
          total: qty * prod.sellingPrice - discount,
        });

        stockMap[prod._id.toString()] = Math.max(0, availStock - qty);
      }

      if (saleItems.length === 0) continue;

      const subtotal = saleItems.reduce((sum, item) => sum + item.total, 0);
      const overallDiscount = Math.random() > 0.95 ? rand(50, 200) : 0;
      const total = Math.max(0, subtotal - overallDiscount);

      // Clothes sales are heavily Cash/bKash, and occasionally on credit for regulars (~15%)
      const isFullPaid = Math.random() > 0.15;
      const paid = isFullPaid ? total : round(total * (Math.random() * 0.4 + 0.3));
      const due = round(Math.max(0, total - paid));

      const hasCustomer = Math.random() > 0.4;
      const customer = hasCustomer ? pick(customerDocs) : null;

      const dateStr = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
      const invoiceNo = `INV${dateStr}${String(saleCounter).padStart(4, '0')}`;
      const saleTime = new Date(day.getTime() + rand(2, 14) * 3600000 + rand(0, 59) * 60000);
      const payMethod = pick(['cash', 'cash', 'bkash', 'nagad', 'card']); // bkash/nagad/card common for clothes

      const profit = saleItems.reduce((sum, item) => {
        return sum + (item.unitPrice - (item.buyingPrice || 0)) * item.quantity - item.discount;
      }, 0) - overallDiscount;

      let status = 'completed';
      if (due > 0 && paid > 0) status = 'partial';
      else if (due > 0 && paid === 0) status = 'unpaid';

      const sale = await Sale.create({
        shop: shopId,
        invoiceNo,
        customer: customer?._id || undefined,
        customerName: customer?.name || 'Walk-in Customer',
        customerPhone: customer?.phone,
        items: saleItems,
        subtotal,
        discount: overallDiscount,
        discountType: 'fixed',
        total,
        paid,
        due,
        profit,
        paymentMethod: payMethod,
        status,
        createdBy: userId,
        createdAt: saleTime,
        updatedAt: saleTime,
      });

      allSaleDocs.push(sale);
      daySaleRevenues.push(total);

      if (payMethod === 'cash') {
        dayPaymentsForCash.salesCash += paid;
      }

      // Update customer financials
      if (customer) {
        customer.totalPurchases += total;
        customer.totalPaid += paid;
        customer.totalDue = Math.max(0, customer.totalPurchases - customer.totalPaid);
        customer.purchaseCount += 1;
        customer.lastPurchase = saleTime;
        await customer.save();
      }

      // Stock transactions for sale
      for (const item of saleItems) {
        const newStock = stockMap[item.product.toString()];
        await StockTransaction.create({
          shop: shopId,
          product: item.product,
          productName: item.productName,
          productCode: item.productCode,
          type: 'sale',
          quantity: -item.quantity,
          previousStock: newStock + item.quantity,
          newStock,
          unitPrice: item.unitPrice,
          totalPrice: item.total,
          reference: { type: 'sale', id: sale._id, invoiceNo },
          createdBy: userId,
          createdAt: saleTime,
        });
      }

      // Payment record
      if (paid > 0) {
        await Payment.create({
          shop: shopId,
          sale: sale._id,
          customer: customer?._id,
          amount: paid,
          method: payMethod,
          type: 'sale_payment',
          receivedBy: userId,
          createdAt: saleTime,
        });
      }
    }

    // ─── DUE COLLECTIONS (~1 per day) ───
    const numCollections = rand(0, 1);
    for (let c = 0; c < numCollections; c++) {
      const dueCustomers = customerDocs.filter(cu => cu.totalDue > 10);
      if (dueCustomers.length === 0) break;
      const cust = pick(dueCustomers);
      const collectAmount = Math.min(cust.totalDue, rand(100, 1000));

      cust.totalPaid += collectAmount;
      cust.totalDue = Math.max(0, cust.totalPurchases - cust.totalPaid);
      await cust.save();

      const collectionTime = new Date(day.getTime() + rand(4, 12) * 3600000);
      await Payment.create({
        shop: shopId,
        customer: cust._id,
        amount: collectAmount,
        method: pick(['cash', 'bkash']),
        type: 'due_collection',
        receivedBy: userId,
        createdAt: collectionTime,
      });

      dayPaymentsForCash.dueCollections += collectAmount;
    }

    // ─── EXPENSES (1-2 per day) ───
    const numExpenses = rand(1, 2);
    let dayExpenseTotal = 0;
    for (let e = 0; e < numExpenses; e++) {
      const expCat = pick(expenseCats);
      let amount;
      if (expCat.name === 'দোকান ভাড়া' && day.getDate() === 1) {
        amount = rand(15000, 25000); // Clothes boutique rent is higher
      } else if (expCat.name === 'কর্মচারী বেতন' && day.getDate() === 1) {
        amount = rand(8000, 15000);
      } else if (expCat.name === 'বিদ্যুৎ বিল' && day.getDate() === 15) {
        amount = rand(3000, 6000); // AC and spot lights consume more power
      } else {
        amount = rand(50, 500);
      }

      const expDate = new Date(day.getTime() + rand(3, 10) * 3600000);
      await Expense.create({
        shop: shopId,
        category: expCat._id,
        categoryName: expCat.name,
        amount,
        description: '',
        date: expDate,
        paymentMethod: 'cash',
        createdBy: userId,
        createdAt: expDate,
      });
      dayExpenseTotal += amount;
      totalExpenses++;
    }

    // ─── CASH REGISTER (daily) ───
    const totalCashIn = dayPaymentsForCash.salesCash + dayPaymentsForCash.dueCollections;
    const openingBalance = rand(5000, 15000);
    const expected = openingBalance + totalCashIn - dayExpenseTotal;
    const actualClosing = expected + rand(-100, 100); // small variance

    await CashRegister.create({
      shop: shopId,
      date: day,
      openingBalance,
      cashIn: {
        sales: dayPaymentsForCash.salesCash,
        dueCollections: dayPaymentsForCash.dueCollections,
        other: 0,
      },
      cashOut: {
        expenses: dayExpenseTotal,
        purchases: 0,
        other: 0,
      },
      expectedClosing: expected,
      actualClosing: actualClosing,
      difference: actualClosing - expected,
      status: 'closed',
      closedBy: userId,
      closedAt: new Date(day.getTime() + 14 * 3600000),
      createdBy: userId,
      createdAt: day,
    });

    totalSales += daySaleRevenues.length;

    // Log progress every 15 days
    if (dayIndex % 15 === 0) {
      process.stdout.write(`   📅 ${dayStr} — Sales: ${totalSales}, Purchases: ${totalPurchases}\r`);
    }
  }

  console.log(`\n   ✅ Sales created: ${totalSales}`);
  console.log(`   ✅ Purchases created: ${totalPurchases}`);
  console.log(`   ✅ Expenses created: ${totalExpenses}`);
  console.log(`   ✅ Cash registers created: ${allDays.length}`);

  // ── Step 8: Sales Returns (a few) ───────────────────────
  console.log('\n── Step 8: Creating sales returns ──');
  const eligibleSales = allSaleDocs.filter(s => s.total > 500 && s.items.length > 0 && s.status !== 'cancelled');
  const numReturns = Math.min(10, Math.floor(eligibleSales.length * 0.015));

  for (let r = 0; r < numReturns; r++) {
    const sale = pick(eligibleSales);
    const returnItem = sale.items[0];
    const returnQty = 1; // return 1 piece

    returnCounter++;
    const retDateStr = `${sale.createdAt.getFullYear()}${String(sale.createdAt.getMonth() + 1).padStart(2, '0')}${String(sale.createdAt.getDate()).padStart(2, '0')}`;
    const returnNo = `RET${retDateStr}${String(returnCounter).padStart(4, '0')}`;
    const returnTotal = returnQty * returnItem.unitPrice;
    const profitReduction = returnQty * (returnItem.unitPrice - (returnItem.buyingPrice || 0));
    const returnDate = new Date(sale.createdAt.getTime() + rand(1, 3) * 86400000);

    await SalesReturn.create({
      shop: shopId,
      returnNo,
      sale: sale._id,
      invoiceNo: sale.invoiceNo,
      customer: sale.customer,
      customerName: sale.customerName,
      items: [{
        saleItemId: returnItem._id,
        product: returnItem.product,
        productName: returnItem.productName,
        productCode: returnItem.productCode,
        quantity: returnQty,
        unitPrice: returnItem.unitPrice,
        buyingPrice: returnItem.buyingPrice || 0,
        total: returnTotal,
        profitLoss: profitReduction,
        reason: pick(['size_fit', 'wrong_item', 'customer_change']),
      }],
      totalAmount: returnTotal,
      profitReduction,
      refundMethod: pick(['cash', 'adjustment', 'store_credit']),
      reason: pick(['সাইজ ঠিক নয়', 'ভুল পোশাক', 'পছন্দ পরিবর্তন']),
      createdBy: userId,
      createdAt: returnDate,
    });

    // Restore stock
    const pKey = returnItem.product.toString();
    stockMap[pKey] = (stockMap[pKey] || 0) + returnQty;

    await StockTransaction.create({
      shop: shopId,
      product: returnItem.product,
      productName: returnItem.productName,
      productCode: returnItem.productCode,
      type: 'return',
      quantity: returnQty,
      previousStock: (stockMap[pKey] || 0) - returnQty,
      newStock: stockMap[pKey],
      reference: { type: 'return', id: sale._id, invoiceNo: sale.invoiceNo },
      createdBy: userId,
      createdAt: returnDate,
    });

    totalReturns++;
  }
  console.log(`   ✅ Returns created: ${totalReturns}`);

  // ── Step 9: Update final product stocks ─────────────────
  console.log('\n── Step 9: Syncing product stock levels ──');
  for (const prod of productDocs) {
    const finalStock = Math.max(0, stockMap[prod._id.toString()] || 0);
    await Product.findByIdAndUpdate(prod._id, { stock: finalStock });
  }
  console.log('   ✅ All product stocks synced');

  // ── Step 10: Update shop stats ──────────────────────────
  console.log('\n── Step 10: Updating shop stats ──');
  const totalRevenue = await Sale.aggregate([
    { $match: { shop: shopId, status: { $ne: 'cancelled' } } },
    { $group: { _id: null, total: { $sum: '$total' } } },
  ]);
  await Shop.findByIdAndUpdate(shopId, {
    'stats.totalProducts': productDocs.length,
    'stats.totalCustomers': customerDocs.length,
    'stats.totalSales': totalSales,
    'stats.totalRevenue': totalRevenue[0]?.total || 0,
  });
  console.log('   ✅ Shop stats updated');

  // ── Step 11: Audit Logs (sample) ────────────────────────
  console.log('\n── Step 11: Creating sample audit logs ──');
  const auditActions = [
    { action: 'user_login', actionBn: 'লগইন', desc: 'Demo user logged in' },
    { action: 'product_create', actionBn: 'নতুন পণ্য যোগ', desc: 'Products added during setup' },
    { action: 'sale_create', actionBn: 'নতুন বিক্রয়', desc: 'Sales created' },
    { action: 'expense_create', actionBn: 'নতুন খরচ যোগ', desc: 'Daily expense logged' },
    { action: 'stock_update', actionBn: 'স্টক আপডেট', desc: 'Stock restocked via purchase' },
  ];

  for (let i = 0; i < 30; i++) {
    const act = pick(auditActions);
    const logDate = pick(allDays);
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: act.action,
      actionBn: act.actionBn,
      description: act.desc,
      descriptionBn: act.desc,
      metadata: {
        ip: '103.145.228.' + rand(1, 254),
        userAgent: 'Mozilla/5.0 (Linux; Android 13)',
        browser: 'Chrome',
        os: 'Android',
        device: 'Mobile',
      },
      createdAt: new Date(logDate.getTime() + rand(2, 14) * 3600000),
    });
  }
  console.log('   ✅ 30 sample audit logs created');

  // ── Final Summary ───────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   🎉 SEEDING COMPLETE!                       ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Login: 01757995016 / 123456                 ║`);
  console.log(`║  Shop: ${shop.name.padEnd(37)}║`);
  console.log(`║  Date Range: Mar 22, 2026 → Jun 22, 2026     ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Categories: ${String(categoryDocs.length).padStart(5)}                            ║`);
  console.log(`║  Products:   ${String(productDocs.length).padStart(5)}                            ║`);
  console.log(`║  Customers:  ${String(customerDocs.length).padStart(5)}                            ║`);
  console.log(`║  Suppliers:  ${String(supplierDocs.length).padStart(5)}                            ║`);
  console.log(`║  Sales:      ${String(totalSales).padStart(5)}                            ║`);
  console.log(`║  Purchases:  ${String(totalPurchases).padStart(5)}                            ║`);
  console.log(`║  Expenses:   ${String(totalExpenses).padStart(5)}                            ║`);
  console.log(`║  Returns:    ${String(totalReturns).padStart(5)}                            ║`);
  console.log(`║  Cash Regs:  ${String(allDays.length).padStart(5)}                            ║`);
  console.log('╚══════════════════════════════════════════════╝\n');

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(async (err) => {
  console.error('\n❌ Seeding failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
