const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const adminStorageController = require('../controllers/adminStorage.controller');
const adminStorefrontController = require('../controllers/adminStorefront.controller');
const adminMediaController = require('../controllers/adminMedia.controller');
const billingController = require('../controllers/billing.controller');
const { protect, adminOnly } = require('../middleware/auth.middleware');
const { upload, handleUploadError } = require('../middleware/upload.middleware');

// Public admin routes
router.post('/login', adminController.login);
router.post('/logout', adminController.logout);

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

// SMS
router.post('/sms/allocate', billingController.allocateSms);
router.get('/sms/logs', adminController.getSMSLogs);
router.get('/sms/allocations', adminController.getSMSAllocations);
router.get('/sms/stats', adminController.getSMSStats);

// Telegram — read-only. Retention is the collection's 90-day TTL index, not a
// clear button: hard deletion from the admin panel is disabled platform-wide.
router.get('/telegram/logs', adminController.getTelegramLogs);
router.get('/telegram/links', adminController.getTelegramLinks);
router.get('/telegram/stats', adminController.getTelegramStats);

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
router.post('/gemini-keys/:id/test', geminiKeyController.testKey);
router.post('/gemini-keys/:id/reset', geminiKeyController.resetUsage);
router.post('/gemini-keys/test-prompt', geminiKeyController.testPrompt);

// Admin management (super admin only)
router.post('/admins', adminController.createAdmin);

module.exports = router;


