const express = require('express');
const router = express.Router();
const productController = require('../controllers/product.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');

// All routes require authentication
router.use(protect);

// Product routes
router.get('/', rbac('products', 'view'), productController.getProducts);
router.post('/', rbac('products', 'create'), productController.createProduct);
router.get('/low-stock', rbac('products', 'view'), productController.getLowStock);
router.get('/barcode/:code', rbac('products', 'view'), productController.getProductByCode);
router.get('/stock-transactions', rbac('products', 'view'), productController.getStockTransactions);
router.post('/bulk-stock', rbac('products', 'update'), productController.bulkUpdateStock);
router.get('/:id', rbac('products', 'view'), productController.getProduct);
router.put('/:id', rbac('products', 'update'), productController.updateProduct);
router.delete('/:id', rbac('products', 'delete'), productController.deleteProduct);
router.patch('/:id/stock', rbac('products', 'update'), productController.updateStock);
router.patch('/:id/status', rbac('products', 'update'), productController.toggleStatus);
router.get('/:id/stock-transactions', rbac('products', 'view'), productController.getStockTransactions);

module.exports = router;
