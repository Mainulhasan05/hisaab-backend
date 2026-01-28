const express = require('express');
const router = express.Router();

const heartbeatController = require('../controllers/heartbeat.controller');
const { protect, ownerOnly } = require('../middleware/auth.middleware');

// All routes require authentication
router.use(protect);

// Record heartbeat (called every minute from frontend)
router.post('/', heartbeatController.recordHeartbeat);

// Mark offline (called on logout or tab close)
router.post('/offline', heartbeatController.markOffline);

// Get shop's online users (Owner/Manager only)
router.get('/shop/online', heartbeatController.getShopOnlineUsers);

// Get specific user's status
router.get('/user/:userId', heartbeatController.getUserStatus);

// Get multiple users' status
router.post('/users/status', heartbeatController.bulkGetUserStatus);

module.exports = router;
