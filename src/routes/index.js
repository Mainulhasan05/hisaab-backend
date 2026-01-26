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

// Mount routes
router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/customers', customerRoutes);
router.use('/sales', saleRoutes);
router.use('/sms', smsRoutes);
router.use('/reports', reportRoutes);
router.use('/audit', auditRoutes);
router.use('/admin', adminRoutes);

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
      customers: '/api/customers',
      sales: '/api/sales',
      sms: '/api/sms',
      reports: '/api/reports',
      audit: '/api/audit',
      admin: '/api/admin'
    }
  });
});

module.exports = router;
