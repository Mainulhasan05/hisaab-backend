const express = require('express');
const router = express.Router();

const heartbeatController = require('../controllers/heartbeat.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');

// All routes require authentication
router.use(protect);

// Record heartbeat (called every minute from frontend) — self-scoped
router.post('/', heartbeatController.recordHeartbeat);

// Mark offline (called on logout or tab close) — self-scoped
router.post('/offline', heartbeatController.markOffline);

// Staff presence lookups expose the shop roster — require staff.view
router.get('/shop/online', rbac('staff', 'view'), heartbeatController.getShopOnlineUsers);
router.get('/user/:userId', rbac('staff', 'view'), heartbeatController.getUserStatus);
router.post('/users/status', rbac('staff', 'view'), heartbeatController.bulkGetUserStatus);

module.exports = router;
