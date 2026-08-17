const express = require('express');
const router = express.Router();
const categoryController = require('../controllers/category.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');

router.use(protect);

router.get('/', rbac('categories', 'view'), categoryController.getCategories);
router.post('/', rbac('categories', 'create'), categoryController.createCategory);

/**
 * ⚠️ EVERY LITERAL PATH BELOW MUST STAY ABOVE `/:id`.
 *
 * Express matches in declaration order, so a `GET /categories/suggestions`
 * declared after `GET /:id` never runs — it is swallowed by the parameter
 * route, which then hands "suggestions" to `findOne({_id: ...})` and answers a
 * CastError. The failure looks like a broken database, not a routing mistake.
 */
router.get('/suggestions', rbac('categories', 'view'), categoryController.getSuggestions);
router.get('/usage', rbac('categories', 'view'), categoryController.getUsage);

// Inline creation from the product form — see the controller for why this is
// not the same handler as `POST /`.
router.post('/quick', rbac('categories', 'create'), categoryController.quickCreateCategory);

router.post('/apply-template', rbac('categories', 'create'), categoryController.applyTemplate);
router.post('/bulk-delete', rbac('categories', 'delete'), categoryController.bulkDelete);

router.get('/:id', rbac('categories', 'view'), categoryController.getCategory);
router.put('/:id', rbac('categories', 'update'), categoryController.updateCategory);
router.delete('/:id', rbac('categories', 'delete'), categoryController.deleteCategory);

module.exports = router;
