const express = require('express');
const router = express.Router();
const categoryController = require('../controllers/category.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');

router.use(protect);

router.get('/', rbac('categories', 'view'), categoryController.getCategories);
router.post('/', rbac('categories', 'create'), categoryController.createCategory);
router.get('/:id', rbac('categories', 'view'), categoryController.getCategory);
router.put('/:id', rbac('categories', 'update'), categoryController.updateCategory);
router.delete('/:id', rbac('categories', 'delete'), categoryController.deleteCategory);

module.exports = router;
