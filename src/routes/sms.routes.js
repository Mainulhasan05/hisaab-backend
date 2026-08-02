const express = require('express');
const router = express.Router();
const smsController = require('../controllers/sms.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const { smsLimiter } = require('../middleware/rateLimiter.middleware');

router.use(protect);

router.get('/quota', rbac('sms', 'view'), smsController.getQuota);
router.get('/history', rbac('sms', 'view'), smsController.getHistory);
router.get('/templates', rbac('sms', 'view'), smsController.getTemplates);
router.post('/send', smsLimiter, rbac('sms', 'create'), smsController.sendSMS);
router.post('/send-due-reminder', smsLimiter, rbac('sms', 'create'), smsController.sendDueReminder);

module.exports = router;
