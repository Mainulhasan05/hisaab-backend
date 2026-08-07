/**
 * The admin panel must not be able to destroy data.
 *
 * Hard deletion is being removed from the operator console entirely and will be
 * reintroduced later behind step-up authentication. Until then, every record
 * that needs to stop being used is deactivated / soft-deleted / closed, never
 * erased.
 *
 * This suite locks three things:
 *
 *   1. The destructive routes are REMOVED from their routers, not gated. A
 *      removed route 404s and leaks nothing; a gated one still answers 403 and
 *      confirms the resource exists. Same reasoning as Phase 4's branch routes
 *      (see branchAdminOnly.test.js).
 *   2. The handlers behind them refuse even if a route is re-added carelessly.
 *   3. The soft alternative that replaces each one is still reachable, so the
 *      operator is never left without a way to retire a record.
 *
 * It also pins the defect that made this urgent — see the purgeShop block.
 */

jest.mock('../utils/authCache.util', () => ({
  invalidateShopAuthCache: jest.fn().mockResolvedValue(undefined),
  invalidateUserAuthCache: jest.fn().mockResolvedValue(undefined),
  invalidateBranchCache: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));

const adminRoutes = require('../routes/admin.routes');
const pageContentRoutes = require('../routes/pageContent.routes');
const contactRoutes = require('../routes/contact.routes');

const adminService = require('../services/admin.service');
const adminController = require('../controllers/admin.controller');
const shopCategoryController = require('../controllers/shopCategory.controller');
const geminiKeyController = require('../controllers/geminiKey.controller');
const pageContentController = require('../controllers/pageContent.controller');
const contactController = require('../controllers/contact.controller');

/** Collect "METHOD /path" strings actually mounted on a router. */
const routesOf = (router) =>
  router.stack
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`));

const adminPaths = routesOf(adminRoutes);
const pagePaths = routesOf(pageContentRoutes);
const contactPaths = routesOf(contactRoutes);

describe('no destructive route is mounted on the admin surface', () => {
  it.each([
    ['DELETE /shops/:id', 'shop purge — erased an entire tenant'],
    ['DELETE /shop-categories/:id', 'ShopCategory.findByIdAndDelete'],
    ['DELETE /gemini-keys/:id', 'GeminiKey.findByIdAndDelete'],
  ])('/api/admin no longer exposes %s (%s)', (route) => {
    expect(adminPaths).not.toContain(route);
  });

  it('/api/pages no longer exposes DELETE /:id', () => {
    expect(pagePaths).not.toContain('DELETE /:id');
  });

  it('/api/contact no longer exposes DELETE /:id', () => {
    expect(contactPaths).not.toContain('DELETE /:id');
  });

  it('the only DELETE left on /api/admin are non-destructive', () => {
    // Branch "delete" flips isActive; cache keys are derived data that rebuilds.
    expect(adminPaths.filter((p) => p.startsWith('DELETE')).sort()).toEqual([
      'DELETE /cache/keys/:key(*)',
      'DELETE /shops/:id/branches/:branchId',
    ]);
  });
});

describe('the soft alternative to each removed delete is still reachable', () => {
  it.each([
    ['PATCH /shops/:id/status', 'suspend a shop instead of purging it'],
    ['PUT /shop-categories/:id', 'isActive: false'],
    ['PUT /gemini-keys/:id', 'isActive: false'],
    ['DELETE /shops/:id/branches/:branchId', 'branch deactivation, impact-checked'],
  ])('/api/admin still exposes %s (%s)', (route) => {
    expect(adminPaths).toContain(route);
  });

  it('/api/pages still exposes PATCH /:id for isActive: false', () => {
    expect(pagePaths).toContain('PATCH /:id');
  });

  it("/api/contact still exposes PATCH /:id for status: 'closed'", () => {
    expect(contactPaths).toContain('PATCH /:id');
  });
});

describe('the handlers refuse even if a route is re-added', () => {
  const res = () => {
    const r = {};
    r.status = jest.fn(() => r);
    r.json = jest.fn(() => r);
    return r;
  };

  // asyncHandler forwards a rejection to next(), so the refusal surfaces there.
  const callHandler = (handler, req = {}) =>
    new Promise((resolve) => handler(req, res(), resolve));

  it.each([
    ['adminController.purgeShop', () => adminController.purgeShop, { params: { id: 'x' }, admin: { _id: 'a' } }],
    ['shopCategoryController.deleteShopCategory', () => shopCategoryController.deleteShopCategory, { params: { id: 'x' } }],
    ['geminiKeyController.deleteKey', () => geminiKeyController.deleteKey, { params: { id: 'x' } }],
    ['pageContentController.deletePage', () => pageContentController.deletePage, { params: { id: 'x' } }],
    ['contactController.deleteContact', () => contactController.deleteContact, { params: { id: 'x' } }],
  ])('%s refuses with DELETION_DISABLED', async (_name, get, req) => {
    const err = await callHandler(get(), req);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('DELETION_DISABLED');
    expect(err.statusCode).toBe(403);
  });

  it('adminService.purgeShop refuses before touching any collection', async () => {
    await expect(adminService.purgeShop('admin1', 'shop1')).rejects.toMatchObject({
      code: 'DELETION_DISABLED',
      statusCode: 403,
    });
  });
});

describe('why purgeShop had to go, pinned so a naive rewrite cannot repeat it', () => {
  // The old implementation looped Model.deleteMany({shop}) over 15 models with
  // Product first and Sale second. immutableGuard rejects deleteMany on the
  // four ledger models with a 403, so the loop erased the entire product
  // catalogue, threw, and left the shop and everything else in place.
  //
  // No DB connection is needed: mongoose pre-hooks run before the driver.
  const Sale = require('../models/Sale.model');
  const Expense = require('../models/Expense.model');
  const Purchase = require('../models/Purchase.model');
  const Payment = require('../models/Payment.model');

  it.each([['Sale', Sale], ['Expense', Expense], ['Purchase', Purchase], ['Payment', Payment]])(
    '%s.deleteMany is blocked by immutableGuard',
    async (_name, Model) => {
      await expect(Model.deleteMany({ shop: '000000000000000000000000' })).rejects.toMatchObject({
        statusCode: 403,
      });
    }
  );
});
