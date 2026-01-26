const express = require('express');
const router = express.Router();
const categoryController = require('../controllers/category.controller');
const { protect } = require('../middleware/auth.middleware');
const { canViewCategories, canManageCategories } = require('../middleware/permission.middleware');

// All routes require authentication
router.use(protect);

// Category routes
router.get('/', canViewCategories, categoryController.getCategories);
router.post('/', canManageCategories, categoryController.createCategory);
router.get('/:id', canViewCategories, categoryController.getCategory);
router.put('/:id', canManageCategories, categoryController.updateCategory);
router.delete('/:id', canManageCategories, categoryController.deleteCategory);

module.exports = router;
