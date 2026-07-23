const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const targetShopIds = [
  '6a3d65b0a7675f73c0dc8303', // Hisaab Fashion Gallery
  '6a3e13b8857980a3b96a5b5b', // Test Shop 22578
  '6a3e14d86b7b242da46ac4b5', // Test Shop 828087
  '6a3e14f08ca602b68dbd132a', // Test Shop 527307
  '6a3f9148c20c0ba2340badfe', // Rahim Chal House
];

async function purgeTargetShops() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected!');

    const shopObjectIds = targetShopIds.map(id => new mongoose.Types.ObjectId(id));

    console.log('--- STARTING PURGE FOR TARGET SHOPS ---');

    const models = [
      { name: 'Product', path: '../models/Product.model' },
      { name: 'Sale', path: '../models/Sale.model' },
      { name: 'SalesReturn', path: '../models/SalesReturn.model' },
      { name: 'Customer', path: '../models/Customer.model' },
      { name: 'Supplier', path: '../models/Supplier.model' },
      { name: 'Expense', path: '../models/Expense.model' },
      { name: 'Purchase', path: '../models/Purchase.model' },
      { name: 'CashRegister', path: '../models/CashRegister.model' },
      { name: 'Category', path: '../models/Category.model' },
      { name: 'Branch', path: '../models/Branch.model' },
      { name: 'Role', path: '../models/Role.model' },
      { name: 'AuditLog', path: '../models/AuditLog.model' },
      { name: 'SMSLog', path: '../models/SMSLog.model' },
      { name: 'SMSQuota', path: '../models/SMSQuota.model' },
      { name: 'User', path: '../models/User.model' },
      { name: 'Shop', path: '../models/Shop.model' },
    ];

    for (const m of models) {
      try {
        const Model = require(m.path);
        const query = m.name === 'Shop' ? { _id: { $in: shopObjectIds } } : { shop: { $in: shopObjectIds } };
        const result = await Model.deleteMany(query);
        console.log(`Successfully deleted ${result.deletedCount} records from ${m.name}`);
      } catch (err) {
        console.log(`Error deleting ${m.name}: ${err.message}`);
      }
    }

    console.log('--- PURGE COMPLETE FOR ALL TARGET SHOPS ---');
  } catch (error) {
    console.error('Purge error:', error);
  } finally {
    await mongoose.disconnect();
  }
}

purgeTargetShops();
