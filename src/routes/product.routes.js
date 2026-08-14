const express = require('express');
const router = express.Router();
const productController = require('../controllers/product.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac, rbacAny } = require('../middleware/permission.middleware');
const { validate } = require('../middleware/validate.middleware');
const productValidation = require('../validations/product.validation');
const { requireFeature } = require('../utils/features.util');

const { upload } = require('../middleware/upload.middleware');

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
// The online catalogue screen's write path. Behind `onlineSelling` — the same
// capability that puts the online section on the product form — so a shop
// without it gets a 404 rather than a way in through the side door.
router.post(
  '/bulk-online',
  requireFeature('onlineSelling'),
  rbac('products', 'update'),
  productController.bulkSetOnlineStatus
);
// MUST stay above `/:id` — Express matches in declaration order, and
// `/expiring-batches` is a perfectly good `:id` as far as the router is
// concerned. Registered below it, this route would never be reached and the
// alerts screen would get "Product not found" for a product named
// "expiring-batches".
router.get(
  '/expiring-batches',
  rbac('products', 'view'),
  validate(productValidation.expiringBatches, 'query'),
  productController.getExpiringBatches
);
router.get('/:id', rbac('products', 'view'), productController.getProduct);
router.put('/:id', rbac('products', 'update'), validate(productValidation.updateProduct), productController.updateProduct);
router.delete('/:id', rbac('products', 'delete'), productController.deleteProduct);
router.patch('/:id/stock', rbacAny([['products', 'update'], ['stock', 'manual_adjust']]), validate(productValidation.updateStock), productController.updateStock);
router.patch('/:id/status', rbac('products', 'update'), validate(productValidation.toggleStatus), productController.toggleStatus);
router.get('/:id/stock-transactions', rbacAny([['products', 'view'], ['stock', 'view']]), productController.getStockTransactions);
router.post('/:id/images', rbac('products', 'update'), upload.array('images', 5), productController.uploadProductImages);

// Batch / expiry. Separate from `PUT /:id` on purpose — the product form must
// not be able to overwrite the batch array (see updateProduct's
// `batches: Joi.forbidden()`), and a batch carries a stock claim that has to be
// validated against the owning variant's stock.
router.get('/:id/batches', rbac('products', 'view'), productController.getProductBatches);
router.post('/:id/batches', rbac('products', 'update'), validate(productValidation.addBatch), productController.addProductBatch);
router.put('/:id/batches/:batchId', rbac('products', 'update'), validate(productValidation.updateBatch), productController.updateProductBatch);
router.delete('/:id/batches/:batchId', rbac('products', 'update'), productController.deleteProductBatch);

module.exports = router;
