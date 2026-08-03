const express = require('express');
const router = express.Router();
const productController = require('../controllers/product.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac, rbacAny } = require('../middleware/permission.middleware');
const { validate } = require('../middleware/validate.middleware');
const productValidation = require('../validations/product.validation');

// All routes require authentication
router.use(protect);

// Product routes
router.get('/', rbac('products', 'view'), productController.getProducts);
router.post('/', rbac('products', 'create'), validate(productValidation.createProduct), productController.createProduct);
router.get('/low-stock', rbac('products', 'view'), productController.getLowStock);
router.get('/search', rbac('products', 'view'), productController.searchProductsForSale);
router.get('/barcode/:code', rbac('products', 'view'), productController.getProductByCode);
router.get('/stock-transactions', rbacAny([['products', 'view'], ['stock', 'view']]), productController.getStockTransactions);
// Manual stock adjustment: products.update grandfathers existing roles;
// stock.manual_adjust is the dedicated permission for it
router.post('/bulk-stock', rbacAny([['products', 'update'], ['stock', 'manual_adjust']]), validate(productValidation.bulkUpdateStock), productController.bulkUpdateStock);
router.post('/bulk-import', rbac('products', 'create'), validate(productValidation.bulkImportProducts), productController.bulkImport);
router.get('/:id', rbac('products', 'view'), productController.getProduct);
router.put('/:id', rbac('products', 'update'), validate(productValidation.updateProduct), productController.updateProduct);
router.delete('/:id', rbac('products', 'delete'), productController.deleteProduct);
router.patch('/:id/stock', rbacAny([['products', 'update'], ['stock', 'manual_adjust']]), validate(productValidation.updateStock), productController.updateStock);
router.patch('/:id/status', rbac('products', 'update'), validate(productValidation.toggleStatus), productController.toggleStatus);
router.get('/:id/stock-transactions', rbacAny([['products', 'view'], ['stock', 'view']]), productController.getStockTransactions);

module.exports = router;
