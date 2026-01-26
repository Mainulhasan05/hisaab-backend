const express = require('express');
const router = express.Router();
const productController = require('../controllers/product.controller');
const { protect } = require('../middleware/auth.middleware');
const { canViewProducts, canCreateProducts, canEditProducts, canDeleteProducts } = require('../middleware/permission.middleware');

// All routes require authentication
router.use(protect);

// Product routes
router.get('/', canViewProducts, productController.getProducts);
router.post('/', canCreateProducts, productController.createProduct);
router.get('/low-stock', canViewProducts, productController.getLowStock);
router.get('/barcode/:code', canViewProducts, productController.getProductByCode);
router.get('/stock-transactions', canViewProducts, productController.getStockTransactions);
router.post('/bulk-stock', canEditProducts, productController.bulkUpdateStock);
router.get('/:id', canViewProducts, productController.getProduct);
router.put('/:id', canEditProducts, productController.updateProduct);
router.delete('/:id', canDeleteProducts, productController.deleteProduct);
router.patch('/:id/stock', canEditProducts, productController.updateStock);
router.get('/:id/stock-transactions', canViewProducts, productController.getStockTransactions);

module.exports = router;
