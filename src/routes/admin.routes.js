const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const adminStorageController = require('../controllers/adminStorage.controller');
const adminStorefrontController = require('../controllers/adminStorefront.controller');
const adminMediaController = require('../controllers/adminMedia.controller');
const adminLandingController = require('../controllers/adminLanding.controller');
const billingController = require('../controllers/billing.controller');
const platformSmsController = require('../controllers/platformSms.controller');
const smsProviderController = require('../controllers/smsProvider.controller');
const adminTelegramController = require('../controllers/adminTelegram.controller');
const adminSecurityController = require('../controllers/adminSecurity.controller');
const { protect, adminOnly } = require('../middleware/auth.middleware');
const { upload, handleUploadError } = require('../middleware/upload.middleware');
const { smsLimiter, passwordResetLimiter } = require('../middleware/rateLimiter.middleware');

// Public admin routes
router.post('/login', adminController.login);
router.post('/logout', adminController.logout);

// ── Admin lockout recovery ─────────────────────────────────────────────────
//
// Public by necessity: the whole premise is an admin who cannot sign in. Safe
// to expose because the SMS code goes to the FOUNDER's number regardless of
// what the caller types, so knowing an admin's phone buys nothing — see
// adminSecurity.service.js.
//
// `passwordResetLimiter` rather than `authLimiter` for the reason the shop-side
// forgot-password flow gives: one honest recovery costs three requests, and
// sharing a limiter with login would 429 the recovery flow on the screen people
// reach precisely because they are already stuck. The controls that matter are
// keyed on the admin account and live in the service.
router.post('/forgot-password', passwordResetLimiter, adminSecurityController.requestPasswordReset);
router.post('/forgot-password/verify', passwordResetLimiter, adminSecurityController.verifyPasswordReset);
router.post('/forgot-password/reset', passwordResetLimiter, adminSecurityController.completePasswordReset);

// Protected admin routes (require admin authentication)
// protect: verifies token and sets req.isAdmin
// adminOnly: checks that user is admin
router.use(protect, adminOnly);

// Stats
router.get('/stats', adminController.getStats);
router.get('/top-performers', adminController.getTopPerformers);
router.get('/system-metrics', adminController.getSystemMetrics);

// Shops management
router.get('/shops', adminController.getShops);
router.get('/shops/:id', adminController.getShopDetails);
router.patch('/shops/:id/status', adminController.updateShopStatus);
router.patch('/shops/:id/subscription', adminController.updateShopSubscription);
router.patch('/shops/:id/settings', adminController.updateShopSettings);
router.post('/shops/:id/restrict', adminController.restrictShop);
router.post('/shops/:id/enable-multi-branch', adminController.enableMultiBranch);
router.post('/shops/:id/disable-multi-branch', adminController.disableMultiBranch);
// Whether the shop's branches share one customer book. Admin-only for the same
// reason branch create/delete is: it changes what every branch can see.
router.patch('/shops/:id/customer-scope', adminController.setCustomerScope);
// Opt-in capabilities (Shop.features). ONE generic pair for every feature —
// resist adding /enable-<feature> routes, which is how multi-branch ended up
// with a method per verb. New capabilities need no route change at all.
router.get('/shops/:id/features', adminController.getShopFeatures);
router.patch('/shops/:id/features/:key', adminController.setShopFeature);
// AI message allowance. Distinct from the `aiExpense` capability toggle above,
// the same way storage quota is distinct from `features.productImages`: the
// toggle decides whether the shop has the feature, this decides how much of it
// they get. The LIMIT is per shop; the COUNTER the GET reports is per branch.
router.get('/shops/:id/ai', adminController.getShopAi);
router.patch('/shops/:id/ai', adminController.setShopAiLimit);
router.post('/shops/:id/ai/reset', adminController.resetShopAiUsage);
// Which storefront templates this shop may pick from. Distinct from the
// capability toggle above: `features.storefront` decides whether the shop has a
// website at all, this decides which designs it may choose. The GET reports
// what is currently applied so the panel can warn before a grant is revoked.
router.get('/shops/:id/storefront/templates', adminStorefrontController.getShopTemplates);
router.put('/shops/:id/storefront/templates', adminStorefrontController.setShopTemplates);
// The platform kill switch. Takes ONE storefront dark without touching the
// shop's POS — they keep trading at the counter. See adminStorefront.service.
router.patch('/shops/:id/storefront/pause', adminStorefrontController.setStorefrontPause);
router.get('/shops/:id/branches', adminController.getShopBranches);
router.post('/shops/:id/branches', adminController.addShopBranch);
router.patch('/shops/:id/branches/:branchId', adminController.updateShopBranch);
// Deactivation, not deletion — flips isActive after an impact check.
router.delete('/shops/:id/branches/:branchId', adminController.deleteShopBranch);

// DELETE /shops/:id (purgeShop) is deliberately NOT mounted. Hard deletion is
// disabled panel-wide and returns later behind step-up auth; suspend the shop
// via PATCH /shops/:id/status instead. See utils/deletionDisabled.util.js.

// Users (all shops) — list + impersonation
router.get('/users', adminController.getAllUsers);
router.post('/users/:id/impersonate', adminController.impersonateUser);

// Customers (all shops)
router.get('/customers', adminController.getAllCustomers);

// Sales (all shops)
router.get('/sales', adminController.getAllSales);

// Products (all shops)
router.get('/products', adminController.getAllProducts);
// Read-only: what these products are still attached to. Safe to call freely.
router.post('/products/inspect-links', adminController.inspectProductLinks);
// Destructive and irreversible — soft-deleted products only, and the service
// re-verifies every id against live invoices before erasing anything.
router.post('/products/purge', adminController.purgeProducts);

// Online users (from heartbeat)
router.get('/online-users', adminController.getOnlineUsers);
// Dashboard activity: active users (from lastActiveAt, not the heartbeat set)
// + catalogue totals + recent product changes, in one call.
router.get('/activity-overview', adminController.getActivityOverview);

// ── Image storage (R2 pool) ───────────────────────────────────────────────
// Two halves: the account pool (what we have) and per-shop allocation (what we
// have promised). The summary endpoint reports both, because the ratio between
// them is the number that predicts a full bucket. See R2_STORAGE_PLAN.md.
router.get('/storage/summary', adminStorageController.getSummary);
router.get('/storage/accounts', adminStorageController.listAccounts);
router.post('/storage/accounts', adminStorageController.createAccount);
// Verify a credential BEFORE it is saved — nothing is persisted by this route.
router.post('/storage/accounts/test', adminStorageController.testDraftAccount);
router.patch('/storage/accounts/:id', adminStorageController.updateAccount);
router.post('/storage/accounts/:id/test', adminStorageController.testAccount);
// Draining stops new allocation but keeps serving reads — the safe way to
// retire a bucket.
router.post('/storage/accounts/:id/drain', adminStorageController.setAccountDraining);
// Retiring an account is `draining` then `isActive: false` (PATCH above), never
// a DELETE. Two reasons, and the second one is the real one:
//   1. panel policy — hard deletion is disabled platform-wide, and
//      `assertAdminMayDelete` would 403 the route even if it were mounted
//      (see adminNoDelete.test.js).
//   2. the account row is the ONLY map from a stored object back to the bucket
//      holding it. Erase it and every file it ever held becomes unreachable —
//      no URL to rebuild, no key to delete, no way to count what was lost.
// Keeping a retired row costs one document and preserves that map forever.

// Per-shop allocation table + the per-shop controls.
router.get('/storage/shops', adminStorageController.listShopStorage);
router.get('/shops/:id/storage', adminStorageController.getShopStorage);
router.patch('/shops/:id/storage', adminStorageController.setShopStorage);
router.post('/shops/:id/storage/recalculate', adminStorageController.recalculateShopStorage);

// ── Platform media library (admin-only gallery) ───────────────────────────
//
// A second tenant of the same R2 pool: files the PLATFORM owns, charged to no
// shop and visible on no shop-facing surface (MEDIA_GALLERY_PLAN.md I-20).
// There is deliberately no counterpart of these routes outside /api/admin.
//
// ORDER MATTERS. `/media/folders` and `/media/usage` are declared before
// `/media/:id`, or Express matches the parameterised route first and every
// folder call arrives as a lookup for a file whose id is the string "folders".
router.get('/media/folders', adminMediaController.listFolders);
router.post('/media/folders', adminMediaController.createFolder);
router.patch('/media/folders/:id', adminMediaController.updateFolder);
router.patch('/media/folders/:id/move', adminMediaController.moveFolder);
router.delete('/media/folders/:id', adminMediaController.removeFolder);

router.get('/media/usage', adminMediaController.usage);
router.post('/media/recalculate', adminMediaController.recalculate);

router.get('/media', adminMediaController.list);
// `handleUploadError` sits between multer and the controller so an oversized
// file or a wrong field name is a 400 that names the problem, not a bare 500.
router.post(
  '/media',
  upload.single('image'),
  handleUploadError,
  adminMediaController.upload
);
router.get('/media/:id', adminMediaController.detail);
router.patch('/media/:id', adminMediaController.update);
// Detaches and starts the grace clock; it does not delete bytes. Hard delete is
// forbidden platform-wide — STORAGE_HANDOFF.md §৪.৪.
router.delete('/media/:id', adminMediaController.remove);

// ── Landing pages (সিজন পেজ) ──────────────────────────────────────────────
//
// The platform AUTHORS these and assigns them to a shop (D1/D11), so every verb
// is admin-only and there is no shop-facing counterpart for authoring. The shop
// gets its own routes for working the orders, gated on `features.landingPages`.
router.get('/landing-pages', adminLandingController.list);
router.post('/landing-pages', adminLandingController.create);
router.get('/landing-pages/:id', adminLandingController.detail);
// Save REPORTS contract problems; publish REFUSES them. An author working
// through generated HTML has to be able to save an unfinished page.
router.patch('/landing-pages/:id', adminLandingController.save);
router.post('/landing-pages/:id/publish', adminLandingController.publish);
router.patch('/landing-pages/:id/schedule', adminLandingController.schedule);
router.post('/landing-pages/:id/renew', adminLandingController.renew);
router.patch('/landing-pages/:id/pause', adminLandingController.setPause);
router.get('/landing-pages/:id/orders', adminLandingController.orders);

// ── Online storefront (template catalogue + oversight) ────────────────────
//
// The per-shop grant routes live up with the other /shops/:id verbs. These are
// the platform-wide ones: the catalogue itself, and the list answering "who is
// actually using this feature".
//
// There is no DELETE. A template is retired, never erased — it keeps rendering
// for every shop already on it. See StorefrontTemplate.model.js.
router.get('/storefront/templates', adminStorefrontController.listTemplates);
router.post('/storefront/templates', adminStorefrontController.createTemplate);
router.patch('/storefront/templates/:id', adminStorefrontController.updateTemplate);
router.post('/storefront/templates/:id/publish', adminStorefrontController.publishTemplate);
router.post('/storefront/templates/:id/retire', adminStorefrontController.retireTemplate);
router.get('/storefront/shops', adminStorefrontController.listStorefronts);

// Cache/Redis management
router.get('/cache/stats', adminController.getCacheStats);
router.get('/cache/summary', adminController.getCacheSummary);
router.get('/cache/keys', adminController.listCacheKeys);
router.get('/cache/keys/:key(*)', adminController.getCacheKeyDetails);
router.delete('/cache/keys/:key(*)', adminController.deleteCacheKey);
router.post('/cache/delete-pattern', adminController.deleteCachePattern);
router.post('/cache/flush', adminController.flushCache);

// Legacy route (keep for backward compatibility)
router.get('/cache-stats', adminController.getCacheStats);

// ── Subscription & billing ────────────────────────────────────────────────
// The lifecycle lives in billing.controller / billing.service; the admin
// service keeps only the shop CRUD it always had. See SUBSCRIPTION_PLAN.md §9.
//
// Blocking and unblocking are ONE route with one permission: a shop that can be
// switched off must always be switchable back on by whoever can reach here.
router.get('/subscriptions', billingController.getWorklist);
router.get('/billing/summary', billingController.getSummary);
router.get('/billing/payments', billingController.listPayments);
router.post('/billing/payments', billingController.recordPayment);
// Correcting a mis-keyed detail (usually the received date) vs undoing a
// payment that should not exist. There is no DELETE: hard deletion is refused
// for admins platform-wide by utils/deletionDisabled.util.js, and the ledger
// carries immutableGuard on top of that.
router.patch('/billing/payments/:paymentId', billingController.amendPayment);
router.post('/billing/payments/:paymentId/reverse', billingController.reversePayment);
router.get('/shops/:id/billing', billingController.getShopBilling);
router.post('/shops/:id/trial', billingController.startTrial);
router.post('/shops/:id/subscription/extend', billingController.extendSubscription);
router.post('/shops/:id/access', billingController.setAccess);
router.patch('/shops/:id/billing', billingController.updateBillingProfile);

// Platform defaults (trial length, standard prices, SMS tiers, support phone).
// Settings, not policy enforcement — the per-shop negotiated figures always win.
router.get('/settings/platform', billingController.getPlatformSettings);
router.patch('/settings/platform', billingController.updatePlatformSettings);

// Payments — the pre-billing routes. Kept mounted and pointed at the new
// service so the existing admin screens keep working; new work should call
// /billing/payments above.
router.get('/payments', billingController.listPayments);
router.post('/payments', billingController.recordPayment);

// SMS — selling credits to shops, and reading what everyone sent.
router.post('/sms/allocate', billingController.allocateSms);
router.get('/sms/logs', adminController.getSMSLogs);
router.get('/sms/allocations', adminController.getSMSAllocations);
router.get('/sms/stats', adminController.getSMSStats);
// The platform's own float at the gateway. Credits are sold against it, so it
// belongs next to the allocation route rather than buried in the broadcast set.
router.get('/sms/gateway-balance', platformSmsController.getGatewayBalance);

// ── Gateway routing: which provider sends, and who catches it ─────────────
//
// Platform-wide, so these are operator settings rather than per-shop ones. The
// PATCH merges: a body naming only `primaryProvider` leaves the failover
// configuration alone, because treating an omitted field as a clear is how a
// platform silently loses its backup gateway.
//
// `/test` sits inside `smsLimiter` because it costs a real message, and it
// sends with failover DISABLED — a test that quietly succeeds on the other
// gateway reports the opposite of what was asked.
router.get('/sms/providers', smsProviderController.listProviders);
router.get('/sms/providers/routing', smsProviderController.getRouting);
router.patch('/sms/providers/routing', smsProviderController.updateRouting);
router.patch('/sms/providers/costs', smsProviderController.updateCosts);
router.post('/sms/providers/:name/test', smsLimiter, smsProviderController.testProvider);

// Revenue, gateway cost and margin. Read from the permanent earnings ledger
// rather than from SMSLog, which expires after 60 days.
router.get('/sms/earnings', smsProviderController.getEarnings);

// ── Broadcasts: the platform texting the shopkeepers ──────────────────────
//
// Audiences are resolved server-side from a NAME (`expiring`, `low_sms`, …) and
// never from a client-supplied phone list — a client that names its own
// recipients can text anyone from the platform's masked sender ID, at the
// platform's expense. `manual` is the narrow exception and is capped in the
// service. See platformSms.service.js for the full reasoning.
//
// `preview` sits outside `smsLimiter`: it only reads, and the composer calls it
// on every edit of the message body. `send` sits inside it — ten broadcasts a
// minute is already far more than anyone should be firing at the whole tenant
// base. Progress polling is outside for the same reason the shop-side campaign
// route is (see sms.routes.js).
router.get('/sms/audiences', platformSmsController.getAudiences);
router.post('/sms/broadcast/preview', platformSmsController.previewBroadcast);
router.post('/sms/broadcast', smsLimiter, platformSmsController.sendBroadcast);
router.get('/sms/broadcast/history', platformSmsController.getBroadcastHistory);
router.get('/sms/broadcast/:id', platformSmsController.getBroadcast);

// Telegram — read-only. Retention is the collection's 90-day TTL index, not a
// clear button: hard deletion from the admin panel is disabled platform-wide.
router.get('/telegram/logs', adminController.getTelegramLogs);
router.get('/telegram/links', adminController.getTelegramLinks);
router.get('/telegram/stats', adminController.getTelegramStats);

// ── The operator's OWN alert channel ───────────────────────────────────────
//
// Distinct from the three routes above, which report on what shop owners
// receive. These configure what the person reading this console receives:
// signups, logins, security events and the daily platform pulse.
//
// `/alerts/*` rather than `/telegram/*` because the channel is the mechanism,
// not the subject — a second transport later (WhatsApp is on the roadmap) would
// slot in behind the same paths rather than needing a parallel set.
router.get('/alerts/status', adminTelegramController.getStatus);
router.get('/alerts/link-token', adminTelegramController.getLinkToken);
router.post('/alerts/unlink', adminTelegramController.unlink);
router.put('/alerts/preferences', adminTelegramController.updatePreferences);
router.post('/alerts/test', adminTelegramController.sendTest);
router.post('/alerts/pulse', adminTelegramController.sendPulseNow);

// ── Admin's own password, behind an SMS code to the founder ────────────────
//
// Three steps, mirroring the shop-user reset: request (proves the current
// password), verify (spends the code for a single-use token), change (spends
// the token). `smsLimiter` guards the one step that costs a message; the
// service's own per-admin throttle is the control that actually protects the
// founder's phone from being buried.
router.get('/security/password/destination', adminSecurityController.getDestination);
router.post('/security/password/request', smsLimiter, adminSecurityController.requestPasswordChange);
router.post('/security/password/verify', adminSecurityController.verifyPasswordChange);
router.post('/security/password/change', adminSecurityController.completePasswordChange);

const shopCategoryController = require('../controllers/shopCategory.controller');

const geminiKeyController = require('../controllers/geminiKey.controller');

// Audit logs
router.get('/audit-logs', adminController.getAuditLogs);

// Shop Categories Management (Admin)
router.get('/shop-categories', shopCategoryController.getAllShopCategories);
router.get('/shop-categories/:id', shopCategoryController.getShopCategoryById);
router.post('/shop-categories', shopCategoryController.createShopCategory);
router.put('/shop-categories/:id', shopCategoryController.updateShopCategory);
// No DELETE — retire a category with PUT { isActive: false }.

// Gemini AI Keys Management & Usage Tracking (Admin)
router.get('/gemini-keys', geminiKeyController.getAllKeys);
router.post('/gemini-keys', geminiKeyController.createKey);
router.put('/gemini-keys/:id', geminiKeyController.updateKey);
// No DELETE — retire a key with PUT { isActive: false }.
// Re-ask Google what every key can serve. The button to press after a model
// retirement — `generateContent` self-heals one key at a time when a shopkeeper
// hits the 404, this repairs the whole pool before anyone does.
// Declared BEFORE `/:id/test`, or "refresh-models" is matched as an :id.
router.post('/gemini-keys/refresh-models', geminiKeyController.refreshModels);
router.post('/gemini-keys/:id/test', geminiKeyController.testKey);
router.post('/gemini-keys/:id/reset', geminiKeyController.resetUsage);
router.post('/gemini-keys/test-prompt', geminiKeyController.testPrompt);

// Admin management (super admin only)
router.post('/admins', adminController.createAdmin);

module.exports = router;


