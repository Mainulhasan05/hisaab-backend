const express = require('express');
const router = express.Router();
const shopCategoryController = require('../controllers/shopCategory.controller');

// Public route for onboarding shop categories
router.get('/', shopCategoryController.getPublicShopCategories);

module.exports = router;
