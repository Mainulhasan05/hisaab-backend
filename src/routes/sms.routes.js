const express = require('express');
const router = express.Router();
const smsController = require('../controllers/sms.controller');
const { protect } = require('../middleware/auth.middleware');
const { canSendSMS } = require('../middleware/permission.middleware');

// All routes require authentication
router.use(protect);

// SMS routes
router.get('/quota', smsController.getQuota);
router.get('/history', smsController.getHistory);
router.get('/templates', smsController.getTemplates);
router.post('/send', canSendSMS, smsController.sendSMS);
router.post('/send-due-reminder', canSendSMS, smsController.sendDueReminder);

module.exports = router;
