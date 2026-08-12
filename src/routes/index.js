const express = require('express');
const router = express.Router();

// Import route modules
const authRoutes = require('./auth.routes');
const productRoutes = require('./product.routes');
const customerRoutes = require('./customer.routes');
const saleRoutes = require('./sale.routes');
const smsRoutes = require('./sms.routes');
const reportRoutes = require('./report.routes');
const auditRoutes = require('./audit.routes');
const adminRoutes = require('./admin.routes');
const categoryRoutes = require('./category.routes');
const brandRoutes = require('./brand.routes');
const expenseRoutes = require('./expense.routes');
const supplierRoutes = require('./supplier.routes');
const purchaseRoutes = require('./purchase.routes');
const cashRegisterRoutes = require('./cashRegister.routes');
const salesReturnRoutes = require('./salesReturn.routes');
const heartbeatRoutes = require('./heartbeat.routes');
const contactRoutes = require('./contact.routes');
const pageContentRoutes = require('./pageContent.routes');
const roleRoutes = require('./role.routes');
const staffRoutes = require('./staff.routes');
const couponRoutes = require('./coupon.routes');
const imageRoutes = require('./image.routes');
const branchRoutes = require('./branch.routes');
const shopCategoryRoutes = require('./shopCategory.routes');
const heldCartRoutes = require('./heldCart.routes');
const stockTransferRoutes = require('./stockTransfer.routes');
const imageUploadRoutes = require('./imageUpload.routes');
const mediaRoutes = require('./media.routes');
const userRoutes = require('./user.routes');
const telegramRoutes = require('./telegram.routes');

// Mount routes
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/products', productRoutes);
router.use('/upload', imageUploadRoutes);
// Shop-owned images in the platform R2 pool. Distinct from `/upload` above,
// which is the older ImgBB path and stores nothing of ours — see the header of
// services/media.service.js for how the two coexist.
router.use('/media', mediaRoutes);
router.use('/categories', categoryRoutes);
// Gated end-to-end on `features.brands` inside the router itself.
router.use('/brands', brandRoutes);
router.use('/shop-categories', shopCategoryRoutes);
router.use('/customers', customerRoutes);

router.use('/sales', saleRoutes);
router.use('/sms', smsRoutes);
router.use('/reports', reportRoutes);
router.use('/audit', auditRoutes);
router.use('/admin', adminRoutes);
router.use('/expenses', expenseRoutes);
router.use('/suppliers', supplierRoutes);
router.use('/purchases', purchaseRoutes);
router.use('/cash-register', cashRegisterRoutes);
router.use('/sales-returns', salesReturnRoutes);
router.use('/heartbeat', heartbeatRoutes);
router.use('/contact', contactRoutes);
router.use('/pages', pageContentRoutes);
router.use('/roles', roleRoutes);
router.use('/staff', staffRoutes);
router.use('/coupons', couponRoutes);
router.use('/images', imageRoutes);
router.use('/branches', branchRoutes);
router.use('/held-carts', heldCartRoutes);
router.use('/stock-transfers', stockTransferRoutes);
router.use('/telegram', telegramRoutes);

// API Info
router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Hisaab API',
    messageBn: 'হিসাব এপিআই',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      products: '/api/products',
      categories: '/api/categories',
      customers: '/api/customers',
      sales: '/api/sales',
      sms: '/api/sms',
      reports: '/api/reports',
      audit: '/api/audit',
      admin: '/api/admin',
      expenses: '/api/expenses',
      suppliers: '/api/suppliers',
      purchases: '/api/purchases',
      cashRegister: '/api/cash-register',
      salesReturns: '/api/sales-returns',
      heartbeat: '/api/heartbeat',
      contact: '/api/contact',
      pages: '/api/pages',
      coupons: '/api/coupons',
      images: '/api/images',
      media: '/api/media',
      branches: '/api/branches',
      heldCarts: '/api/held-carts',
      stockTransfers: '/api/stock-transfers',
      telegram: '/api/telegram',
    }
  });
});

module.exports = router;
