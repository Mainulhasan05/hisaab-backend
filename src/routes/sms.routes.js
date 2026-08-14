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
router.get('/audience', rbac('sms', 'view'), smsController.getAudienceCounts);

// Campaign progress is polled every couple of seconds while a big send runs, so
// it sits OUTSIDE `smsLimiter` — that limiter allows ten requests a minute,
// which a single campaign's progress bar would exhaust in twenty seconds and
// then look frozen. It only reads, and it is shop-scoped.
router.get('/campaign/:id', rbac('sms', 'view'), smsController.getCampaign);

router.post('/send', smsLimiter, rbac('sms', 'create'), smsController.sendSMS);
router.post('/campaign', smsLimiter, rbac('sms', 'create'), smsController.sendCampaign);
router.post('/send-due-reminder', smsLimiter, rbac('sms', 'create'), smsController.sendDueReminder);

module.exports = router;
