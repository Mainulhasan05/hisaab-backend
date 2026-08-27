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
const paymentAccountRoutes = require('./paymentAccount.routes');
const salesReturnRoutes = require('./salesReturn.routes');
const purchaseReturnRoutes = require('./purchaseReturn.routes');
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
const storefrontRoutes = require('./storefront.routes');
const orderRoutes = require('./order.routes');
const landingRoutes = require('./landing.routes');
const publicRoutes = require('./public.routes');

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
// Fund accounts. Gated end-to-end on `features.fundAccounts` inside the router
// itself, so a shop without the capability 404s on every verb.
router.use('/accounts', paymentAccountRoutes);
router.use('/sales-returns', salesReturnRoutes);
// কেনা ফেরত — goods going back to the SUPPLIER. Its own prefix rather than a
// verb under `/purchases`, mirroring `/sales-returns`: the two are lists in
// their own right and each has a screen of its own.
router.use('/purchase-returns', purchaseReturnRoutes);
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
// The shop's own storefront management. Gated end-to-end on
// `features.storefront` inside the router itself. The PUBLIC storefront reads
// are a separate, unauthenticated router and do not live here — see
// ECOMMERCE_PLAN.md §13 for why that surface is treated as its own workstream.
router.use('/storefront', storefrontRoutes);
// The merchant order worklist. `/online-orders`, not `/orders`, so the name
// says which side of the trust boundary it serves — `/public/.../orders` is
// where strangers write, this is where staff read and act. Gated end-to-end on
// `features.onlineOrders` inside the router itself.
router.use('/online-orders', orderRoutes);

/**
 * The shop's seasonal-page panel. `/landing`, not `/pages` — `/pages` is
 * already the platform's static content (privacy policy, terms), and two
 * unrelated resources under one prefix is how a route gets mounted in the wrong
 * order a year from now. Gated end-to-end on `features.landingPages` inside the
 * router itself.
 */
router.use('/landing', landingRoutes);

/**
 * The public storefront reads — mounted LAST, and mounted here rather than in
 * `app.js`, because every router above applies `protect` itself. There is no
 * enclosing protected tree to be "outside" of; being outside it means carrying
 * no guard, which is what `public.routes.js` does and documents.
 *
 * `/public` is its own prefix so that the boundary is legible in a URL: anything
 * under it is readable by a stranger, and anything not under it is not. `app.js`
 * keys its rate-limiter skip off exactly this prefix.
 */
router.use('/public', publicRoutes);

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
      purchaseReturns: '/api/purchase-returns',
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
      storefront: '/api/storefront',
      landing: '/api/landing',
      public: '/api/public',
    }
  });
});

module.exports = router;
