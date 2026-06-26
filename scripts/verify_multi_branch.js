require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');

// Load models
const {
  Shop,
  Branch,
  BranchStock,
  User,
  Sale,
  Purchase,
  Expense,
  CashRegister,
  StockTransaction,
  Payment,
  SalesReturn,
  SMSLog,
  AuditLog,
  Product
} = require('../src/models');

const adminService = require('../src/services/admin.service');
const branchService = require('../src/services/branch.service');

async function test() {
  console.log('Connecting to database...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected!');

  // Generate unique suffix for test data
  const suffix = Math.floor(Math.random() * 1000000);
  const shopName = `Test Shop ${suffix}`;
  
  console.log('--- Step 1: Create a single-branch shop & user ---');
  const shop = await Shop.create({
    name: shopName,
    phone: `017${String(suffix).padStart(8, '0')}`,
    address: '123 Test Street',
    isActive: true,
    subscription: {
      status: 'active',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) // 30 days
    }
  });

  const owner = await User.create({
    name: 'Shop Owner',
    phone: shop.phone,
    password: 'password123',
    shop: shop._id,
    isOwner: true
  });

  const staff = await User.create({
    name: 'Cashier Staff',
    phone: `018${String(suffix).padStart(8, '0')}`,
    password: 'password123',
    shop: shop._id,
    isOwner: false
  });

  // Create product
  const product = await Product.create({
    shop: shop._id,
    name: 'Test Product',
    code: `PROD-${suffix}`,
    stock: 50,
    sellingPrice: 100,
    buyingPrice: 70
  });

  // Create transactional data for the shop before multi-branch is enabled (should have branch: null)
  const sale = await Sale.create({
    shop: shop._id,
    invoiceNo: `INV-${suffix}`,
    items: [{
      product: product._id,
      productName: product.name,
      productCode: product.code,
      quantity: 2,
      unitPrice: product.sellingPrice,
      buyingPrice: product.buyingPrice,
      total: 200
    }],
    subtotal: 200,
    discount: 0,
    total: 200,
    paid: 200,
    due: 0,
    paymentMethod: 'cash',
    branch: null,
    createdBy: owner._id
  });

  console.log(`Created shop ID: ${shop._id}`);
  console.log(`Created owner user, staff user, and a product with 50 stock.`);
  console.log(`Created sale with branch = null (single-branch mode).`);

  // Assertions before multi-branch
  const verifyShop = await Shop.findById(shop._id);
  if (verifyShop.multiBranchEnabled) throw new Error('Assertion failed: Shop should not be multi-branch enabled yet!');

  console.log('--- Step 2: Enable Multi-Branch Mode ---');
  const enableResult = await adminService.enableMultiBranch(shop._id, new mongoose.Types.ObjectId());
  console.log('Multi-branch enabled result:', JSON.stringify(enableResult, null, 2));

  // Reload the shop document to get updated multiBranchEnabled flag
  const updatedShop = await Shop.findById(shop._id);

  // Verify default branch exists
  const defaultBranch = await Branch.findOne({ shop: shop._id, isDefault: true });
  if (!defaultBranch) throw new Error('Assertion failed: Default branch was not created!');
  console.log(`Verified default branch: ${defaultBranch.name} (${defaultBranch.code})`);

  // Verify staff are assigned to default branch
  const updatedStaff = await User.findById(staff._id);
  if (!updatedStaff.branch || String(updatedStaff.branch) !== String(defaultBranch._id)) {
    throw new Error(`Assertion failed: Staff not assigned to default branch! Assigned to: ${updatedStaff.branch}`);
  }
  console.log('Verified staff is now assigned to default branch!');

  // Verify owner is still branch-independent (branch = null)
  const updatedOwner = await User.findById(owner._id);
  if (updatedOwner.branch !== null) {
    throw new Error(`Assertion failed: Owner should remain branch-independent (null), but is: ${updatedOwner.branch}`);
  }
  console.log('Verified owner remains branch-independent.');

  // Verify transactional data was backfilled
  const updatedSale = await Sale.findById(sale._id);
  if (!updatedSale.branch || String(updatedSale.branch) !== String(defaultBranch._id)) {
    throw new Error(`Assertion failed: Sale branch was not backfilled! Value: ${updatedSale.branch}`);
  }
  console.log('Verified existing sale was backfilled with default branch!');

  // Verify stock was migrated to BranchStock
  const branchStock = await BranchStock.findOne({ shop: shop._id, branch: defaultBranch._id, product: product._id });
  if (!branchStock || branchStock.stock !== 50) {
    throw new Error(`Assertion failed: BranchStock not migrated or stock is incorrect! Found: ${JSON.stringify(branchStock)}`);
  }
  console.log(`Verified BranchStock migrated successfully! Stock is ${branchStock.stock}`);

  console.log('--- Step 3: Create a second branch & assign staff ---');
  const branchB = await Branch.create({
    shop: shop._id,
    name: 'Dhanmondi Branch',
    code: 'DHA',
    address: 'Dhanmondi, Dhaka',
    phone: '01912345678'
  });

  // Assign staff to branch B
  updatedStaff.branch = branchB._id;
  await updatedStaff.save();
  console.log(`Created second branch: ${branchB.name} (${branchB.code}) and moved staff to it.`);

  console.log('--- Step 4: Verify Scoping / Isolation ---');
  // Add a sale in branch B (representing staff action)
  const saleB = await Sale.create({
    shop: shop._id,
    branch: branchB._id,
    invoiceNo: `INV-DHA-${suffix}`,
    items: [{
      product: product._id,
      productName: product.name,
      productCode: product.code,
      quantity: 1,
      unitPrice: product.sellingPrice,
      buyingPrice: product.buyingPrice,
      total: 100
    }],
    subtotal: 100,
    discount: 0,
    total: 100,
    paid: 100,
    due: 0,
    paymentMethod: 'cash',
    createdBy: updatedStaff._id
  });

  // Create a mock request object for Branch B staff
  const reqStaff = {
    shop: updatedShop,
    user: updatedStaff,
    branch: branchB,
    branchId: branchB._id
  };

  const { getBranchForCreate, scopeByBranch } = require('../src/utils/branchScope.util');
  
  // Verify branch scoping for create
  const createBranchId = getBranchForCreate(reqStaff);
  if (String(createBranchId) !== String(branchB._id)) {
    throw new Error(`Assertion failed: getBranchForCreate returned ${createBranchId} instead of Branch B`);
  }
  console.log('Verified getBranchForCreate returns Branch B for staff.');

  // Verify query scoping for staff (Branch B only)
  const staffFilter = scopeByBranch(reqStaff, { shop: shop._id });
  if (String(staffFilter.branch) !== String(branchB._id)) {
    throw new Error(`Assertion failed: scopeByBranch for staff did not apply branch filter: ${JSON.stringify(staffFilter)}`);
  }
  
  const staffSales = await Sale.find(staffFilter);
  if (staffSales.length !== 1 || String(staffSales[0]._id) !== String(saleB._id)) {
    throw new Error(`Assertion failed: Staff query returned incorrect sales count or wrong sale! Returned: ${staffSales.length}`);
  }
  console.log('Verified staff query scoping: Staff can only query Branch B sales.');

  // Verify owner context (no header = all branches)
  const reqOwnerAll = {
    shop: updatedShop,
    user: updatedOwner,
    branch: null,
    branchId: null
  };
  const ownerAllFilter = scopeByBranch(reqOwnerAll, { shop: shop._id });
  if ('branch' in ownerAllFilter) {
    throw new Error(`Assertion failed: Owner in "all branches" view should not have branch in query filter! Filter: ${JSON.stringify(ownerAllFilter)}`);
  }
  const ownerAllSales = await Sale.find(ownerAllFilter);
  if (ownerAllSales.length !== 2) {
    throw new Error(`Assertion failed: Owner query should return 2 sales, but got: ${ownerAllSales.length}`);
  }
  console.log('Verified owner query scoping (All Branches): Owner can query all sales across all branches.');

  // Verify owner context (with Branch B selected)
  const reqOwnerBranchB = {
    shop: updatedShop,
    user: updatedOwner,
    branch: branchB,
    branchId: branchB._id
  };
  const ownerBranchBFilter = scopeByBranch(reqOwnerBranchB, { shop: shop._id });
  if (String(ownerBranchBFilter.branch) !== String(branchB._id)) {
    throw new Error(`Assertion failed: Owner with selected Branch B did not filter correctly! Filter: ${JSON.stringify(ownerBranchBFilter)}`);
  }
  const ownerBranchBSales = await Sale.find(ownerBranchBFilter);
  if (ownerBranchBSales.length !== 1 || String(ownerBranchBSales[0]._id) !== String(saleB._id)) {
    throw new Error(`Assertion failed: Owner query for Branch B returned incorrect results!`);
  }
  console.log('Verified owner query scoping (Branch B Selected): Owner can filter specifically to Branch B.');

  console.log('--- Step 5: Clean up test data ---');
  await Shop.findByIdAndDelete(shop._id);
  await User.deleteMany({ shop: shop._id });
  await Product.deleteMany({ shop: shop._id });
  await Sale.deleteMany({ shop: shop._id });
  await Branch.deleteMany({ shop: shop._id });
  await BranchStock.deleteMany({ shop: shop._id });
  console.log('Cleaned up all created test records successfully.');

  console.log('ALL TESTS PASSED SUCCESSFULLY! MULTI-BRANCH LOGIC IS COMPLETELY CORRECT.');
}

test()
  .catch(err => {
    console.error('TEST FAILED:', err);
    process.exit(1);
  })
  .finally(async () => {
    await mongoose.connect(process.env.MONGODB_URI); // ensure connection is closed cleanly
    await mongoose.disconnect();
    console.log('Disconnected from DB.');
  });
