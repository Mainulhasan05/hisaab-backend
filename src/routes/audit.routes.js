const express = require('express');
const router = express.Router();
const auditController = require('../controllers/audit.controller');
const { protect, ownerOnly } = require('../middleware/auth.middleware');

// All routes require authentication and owner access
router.use(protect);
router.use(ownerOnly);

// Audit routes
router.get('/', auditController.getAuditLogs);
router.get('/summary', auditController.getActivitySummary);
router.get('/user/:userId', auditController.getUserActivity);
router.get('/entity/:entityType/:entityId', auditController.getEntityHistory);
router.get('/:id', auditController.getAuditLog);

module.exports = router;
