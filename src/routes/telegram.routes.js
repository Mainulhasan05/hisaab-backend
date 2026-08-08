const express = require('express');
const router = express.Router();
const telegramController = require('../controllers/telegram.controller');
const { protect, ownerOnly } = require('../middleware/auth.middleware');
const { telegramLinkLimiter } = require('../middleware/rateLimiter.middleware');

/**
 * Telegram notification settings — shop owners only.
 *
 * `ownerOnly` is applied to the whole router rather than per route so a route
 * added later cannot accidentally be reachable by staff. The digest carries
 * shop-wide revenue and profit; the RBAC matrix gates those behind
 * `view_profit`, and this must not become a way around it.
 */
router.use(protect, ownerOnly);

// GET, so it stays reachable in the read-only grace mode an expired
// subscription drops the shop into — the settings screen must still be able to
// render the current state rather than erroring.
router.get('/status', telegramController.getStatus);

router.get('/link-token', telegramLinkLimiter, telegramController.getLinkToken);
router.post('/unlink', telegramController.unlink);
router.put('/preferences', telegramController.updatePreferences);
router.post('/test', telegramLinkLimiter, telegramController.sendTest);

module.exports = router;
