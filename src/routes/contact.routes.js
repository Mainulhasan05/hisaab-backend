const express = require('express');
const router = express.Router();
const contactController = require('../controllers/contact.controller');
const { protect, adminOnly } = require('../middleware/auth.middleware');

// Public route - submit contact form
router.post('/', contactController.submitContact);

// Admin routes
router.get('/', protect, adminOnly, contactController.getContacts);
router.get('/stats', protect, adminOnly, contactController.getContactStats);
router.get('/:id', protect, adminOnly, contactController.getContact);
router.patch('/:id', protect, adminOnly, contactController.updateContactStatus);
router.delete('/:id', protect, adminOnly, contactController.deleteContact);

module.exports = router;
