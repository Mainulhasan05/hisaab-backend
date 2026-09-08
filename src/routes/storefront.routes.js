const express = require('express');
const router = express.Router();
const storefrontController = require('../controllers/storefront.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const { requireFeature } = require('../utils/features.util');
const { aiParseLimiter } = require('../middleware/rateLimiter.middleware');

router.use(protect);

/**
 * The whole resource sits behind the capability, so a shop without
 * `features.storefront` gets a 404 on every verb — the API cannot serve a
 * feature the shop has not been given even if a client asks for it directly.
 *
 * 404 rather than 403 is `requireFeature`'s deliberate choice: to a shop
 * without the capability the resource does not exist, and a 403 would advertise
 * that it does.
 *
 * Note what is NOT here: no route can grant a template to a shop. The grant
 * lives on `Shop.storefront.allowedTemplates` and is written only by
 * `/api/admin/shops/:id/storefront/templates`. Following the pattern
 * AGENT_WORKFLOW.md §12 records for branches, the owner-facing router simply
 * does not carry the route — a guessed URL 404s and leaks nothing.
 */
router.use(requireFeature('storefront'));

router.get('/', rbac('storefront', 'view'), storefrontController.getStorefront);
router.get('/templates', rbac('storefront', 'view'), storefrontController.getTemplates);

// Applying a template edits the DRAFT, so it is `update`, not `publish`. A
// shop may try every template it has been granted without anything reaching a
// customer.
router.post('/template', rbac('storefront', 'update'), storefrontController.applyTemplate);
router.patch('/draft', rbac('storefront', 'update'), storefrontController.updateDraft);
router.patch('/settings', rbac('storefront', 'update'), storefrontController.updateSettings);

// Outward-facing, so separately permissioned — see config/permissions.js.
router.post('/publish', rbac('storefront', 'publish'), storefrontController.publish);
router.post('/rollback/:version', rbac('storefront', 'publish'), storefrontController.rollback);
router.patch('/status', rbac('storefront', 'publish'), storefrontController.setStatus);

// ── SEO ─────────────────────────────────────────────────────────────────────
//
// Reading the SEO block is `storefront:view` and writing it is the ordinary
// `PATCH /draft` — this router adds no write verb of its own, because SEO text
// is staged content like every other block and must go through the same draft →
// publish path. A dedicated `PUT /seo` would be a second way to write the same
// document, and the second way is the one that forgets to stage.
router.get('/seo', rbac('storefront', 'view'), storefrontController.getSeo);

/**
 * The AI writer.
 *
 * Gated on `aiSeo` ON TOP of the router-wide `storefront` gate, so a shop with
 * a website but no AI grant gets a 404 here and the buttons never render. Both
 * routes are `update`, not `view`: they spend a real allowance and produce text
 * meant for the draft, so a role that may only look at the storefront must not
 * be able to burn the shop's daily messages.
 *
 * `aiParseLimiter` is the same 10-per-minute bucket the expense parser uses. The
 * daily allowance is the budget; this is the burst guard, and they answer
 * different questions — a shop with 50 messages a day should still not be able
 * to fire all 50 in four seconds.
 */
router.get(
  '/ai/usage',
  requireFeature('aiSeo'),
  rbac('storefront', 'view'),
  storefrontController.getAiUsage
);
router.post(
  '/ai/seo',
  requireFeature('aiSeo'),
  rbac('storefront', 'update'),
  aiParseLimiter,
  storefrontController.aiGenerateSeo
);
router.post(
  '/ai/product-description/:productId',
  requireFeature('aiSeo'),
  rbac('storefront', 'update'),
  aiParseLimiter,
  storefrontController.aiGenerateProductDescription
);

module.exports = router;
