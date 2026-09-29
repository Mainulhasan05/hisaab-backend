const express = require('express');
const router = express.Router();
const ingredientController = require('../controllers/ingredient.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const idempotency = require('../middleware/idempotency.middleware');
const { requireFeature } = require('../utils/features.util');

router.use(protect);

/**
 * The whole resource is behind `features.restaurant`: a shop without it gets a
 * 404 on every verb, so nothing here exists for it (same shape as brands).
 *
 * Rides on the PRODUCTS permission rather than a new module, like brands ride
 * on categories: a new module would leave every existing role with no access
 * until its preset was upgraded. Cost figures are stripped in the service for
 * anyone without `products.view_cost`.
 */
router.use(requireFeature('restaurant'));

router.get('/', rbac('products', 'view'), ingredientController.list);
router.post('/', rbac('products', 'create'), ingredientController.create);
router.get('/movements', rbac('products', 'view'), ingredientController.movements);
router.get('/cost', rbac('products', 'view'), ingredientController.costReport);
// A kitchen sheet is a stock write — idempotent, so a double-tapped save on a
// slow connection cannot deduct the rice twice.
router.post('/issue', idempotency(), rbac('products', 'update'), ingredientController.issue);
router.put('/:id', rbac('products', 'update'), ingredientController.update);
router.post('/:id/adjust', idempotency(), rbac('products', 'update'), ingredientController.adjust);

module.exports = router;
