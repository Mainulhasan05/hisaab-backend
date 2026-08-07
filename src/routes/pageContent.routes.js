const express = require('express');
const router = express.Router();
const pageContentController = require('../controllers/pageContent.controller');
const { protect, adminOnly } = require('../middleware/auth.middleware');

// Public route - get page by slug
router.get('/public/:slug', pageContentController.getPageBySlug);

// Admin routes
router.get('/', protect, adminOnly, pageContentController.getAllPages);
router.get('/:id', protect, adminOnly, pageContentController.getPageForEdit);
router.post('/', protect, adminOnly, pageContentController.createPage);
router.patch('/:id', protect, adminOnly, pageContentController.updatePage);
// No DELETE — unpublish a page with PATCH { isActive: false }.
router.post('/seed', protect, adminOnly, pageContentController.seedDefaultPages);

module.exports = router;
