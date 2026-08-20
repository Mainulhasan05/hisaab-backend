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
    //
    // The two /media ones are deliberate additions, and each earns its place:
    //
    //   DELETE /media/:id        does NOT erase anything. It detaches the file
    //                            and stamps `orphanedAt`; the bytes go only
    //                            after the grace period, via the reclamation
    //                            sweep. Same shape as the branch route above —
    //                            a state change spelled as a DELETE — and it is
    //                            what makes "I removed the wrong file"
    //                            recoverable for a week. Hard delete stays
    //                            forbidden (STORAGE_HANDOFF.md §৪.৪).
    //   DELETE /media/folders/:id erases MediaFolder documents, and that is the
    //                            honest description. A folder is pure
    //                            organisation — a name and a parent, no
    //                            history, no money, no tenant data — and the
    //                            files inside it are MOVED to the parent, never
    //                            deleted. Soft-deleting an empty container
    //                            would add an archived state to every listing
    //                            query to protect nothing.
    expect(adminPaths.filter((p) => p.startsWith('DELETE')).sort()).toEqual([
      'DELETE /cache/keys/:key(*)',
      'DELETE /media/:id',
      'DELETE /media/folders/:id',
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

describe('deny-by-default guard for platform-admin DELETEs', () => {
  const { assertAdminMayDelete, isAllowedAdminDelete } = require('../utils/deletionDisabled.util');

  const attempt = (method, originalUrl) => {
    try {
      assertAdminMayDelete({ method, originalUrl, path: originalUrl });
      return null;
    } catch (e) {
      return e;
    }
  };

  it.each([
    ['/api/admin/shops/6a716c62d6c231edf6acfd7d/branches/6a75766fbd7bd54927a32ecc', 'branch deactivation'],
    ['/api/admin/cache/keys/shop%3A123%3Aproducts', 'derived cache data'],
  ])('allows DELETE %s (%s)', (url) => {
    expect(attempt('DELETE', url)).toBeNull();
    expect(isAllowedAdminDelete(url)).toBe(true);
  });

  // The whole shop-facing API is reachable by an admin via x-shop-id, so the
  // guard has to cover it too — this is what route removal alone cannot do.
  it.each([
    '/api/admin/shops/abc',
    '/api/admin/shop-categories/abc',
    '/api/admin/gemini-keys/abc',
    '/api/pages/abc',
    '/api/contact/abc',
    '/api/products/abc',
    '/api/customers/abc',
    '/api/categories/abc',
    '/api/coupons/abc',
    '/api/suppliers/abc',
    '/api/roles/abc',
    '/api/expenses/abc',
    '/api/expenses/categories/abc',
    '/api/held-carts/abc',
    '/api/some/route/invented/next/year',
  ])('refuses DELETE %s', (url) => {
    const err = attempt('DELETE', url);
    expect(err).not.toBeNull();
    expect(err.code).toBe('DELETION_DISABLED');
    expect(err.statusCode).toBe(403);
  });

  it('ignores query strings when matching the allowlist', () => {
    expect(attempt('DELETE', '/api/admin/cache/keys/foo?confirm=1')).toBeNull();
  });

  it.each(['GET', 'POST', 'PATCH', 'PUT'])('leaves %s untouched', (method) => {
    expect(attempt(method, '/api/admin/shops/abc')).toBeNull();
  });
});

describe('the guard is wired into both auth paths, not just one route file', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../middleware/auth.middleware.js'), 'utf8');

  it('protect() and softProtect() both call assertAdminMayDelete', () => {
    // Two call sites: one per auth path. If either is dropped, an admin token
    // regains delete on whichever routes use that path.
    expect(src.match(/assertAdminMayDelete\(req\)/g) || []).toHaveLength(2);
  });

  it('the guard runs where req.isAdmin is set, so new routes are covered', () => {
    const idx = src.indexOf('req.isAdmin = true;');
    const guard = src.indexOf('assertAdminMayDelete(req)');
    expect(idx).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(idx);
  });
});

describe('no destructive code remains where the admin can reach it', () => {
  const fs = require('fs');
  const path = require('path');

  const readAll = (dir) =>
    fs.readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);

  // `.collection.deleteOne` / `.collection.deleteMany` are the driver handles
  // beneath Mongoose and bypass schema middleware — `immutableGuard` cannot see
  // them. That makes them MORE dangerous than the model methods, not less, so
  // they belong in this scan. `purgeProducts` holds the one reviewed use.
  const DESTRUCTIVE =
    /\.(deleteMany|findByIdAndDelete|findOneAndDelete|findByIdAndRemove)\s*\(|\.collection\.delete(One|Many)\s*\(/;

  /**
   * The one sanctioned exception: `purgeProducts` clearing a purged product's
   * stock movements.
   *
   * The rule this file enforces is not "no destructive call ever" — the header
   * says deletion returns "behind step-up authentication". It is "no
   * destructive call that nobody looked at". So the assertion is now: a
   * destructive line must carry this marker, and the marker must be rare enough
   * to read in one sitting.
   *
   * Adding the marker to a new line is deliberate, greppable, and shows up in
   * review as a change to this test's expected count. Removing this allowance
   * entirely is also fine if the purge feature goes away.
   *
   * The purge itself meets the three conditions in
   * `utils/deletionDisabled.util.js`: step-up password re-entry
   * (`_assertStepUp`), a server-computed impact preview that is re-run at
   * submit time (`inspectProductLinks`), and an audit entry with before-state
   * written before the first destructive call (`product_purge_begin`).
   */
  const REVIEWED = /\/\/\s*admin-purge:reviewed\s*$/;
  const MAX_REVIEWED = 2;

  it('admin service and controller contain no UNREVIEWED hard-delete call', () => {
    for (const [name, src] of [
      ['admin.service.js', fs.readFileSync(path.join(__dirname, '../services/admin.service.js'), 'utf8')],
      ['admin.controller.js', fs.readFileSync(path.join(__dirname, '../controllers/admin.controller.js'), 'utf8')],
    ]) {
      const hits = src
        .split('\n')
        .filter((l) => DESTRUCTIVE.test(l) && !l.trim().startsWith('*') && !l.trim().startsWith('//'))
        .filter((l) => !REVIEWED.test(l.trimEnd()));
      expect({ [name]: hits }).toEqual({ [name]: [] });
    }
  });

  it('keeps the reviewed-exception list to two lines', () => {
    // If this number ever climbs, the allowance has become a loophole and the
    // whole approach needs revisiting rather than the number being bumped.
    //
    // It went 1 → 2 when `purgeProducts`' cancelled-invoice branch moved from
    // `Sale.deleteOne` to `Sale.collection.deleteOne`. That was not a new
    // deletion: the old line was already deleting invoices in intent and
    // throwing 403 in fact, because `immutableGuard` covers the query form of
    // `deleteOne` and the call site's comment claimed it did not. The line
    // became visible to this scan, which is where it should always have been.
    const src = fs.readFileSync(path.join(__dirname, '../services/admin.service.js'), 'utf8');
    const marked = src.split('\n').filter((l) => REVIEWED.test(l.trimEnd()));
    expect(marked).toHaveLength(MAX_REVIEWED);
  });

  it('the purge is gated by step-up auth before it reads anything', () => {
    // The condition `deletionDisabled.util.js` names first. A purge that only
    // checked the admin cookie would be exactly the thing that rule forbids.
    const src = fs.readFileSync(path.join(__dirname, '../services/admin.service.js'), 'utf8');
    const stepUp = src.indexOf('await this._assertStepUp(adminId, password)');
    const firstDelete = src.indexOf('deleteMany({ product: id })');
    expect(stepUp).toBeGreaterThan(-1);
    expect(firstDelete).toBeGreaterThan(stepUp);
  });

  it('writes the audit entry with before-state ahead of the destructive write', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/admin.service.js'), 'utf8');
    const intent = src.indexOf("action: 'product_purge_begin'");
    const firstDelete = src.indexOf('deleteMany({ product: id })');
    expect(intent).toBeGreaterThan(-1);
    expect(firstDelete).toBeGreaterThan(intent);
  });

  it('no admin-facing controller hard-deletes', () => {
    const adminFacing = ['shopCategory.controller.js', 'geminiKey.controller.js', 'pageContent.controller.js', 'contact.controller.js'];
    for (const [name, src] of readAll(path.join(__dirname, '../controllers'))) {
      if (!adminFacing.includes(name)) continue;
      const hits = src.split('\n').filter((l) => DESTRUCTIVE.test(l) && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
      expect({ [name]: hits }).toEqual({ [name]: [] });
    }
  });

  it('the hardcoded production purge script is gone and stays gone', () => {
    // src/scripts/purgeTargetShops.js hardcoded 5 live shop ids, connected to
    // MONGODB_URI, ran deleteMany over 16 models on require with no dry-run and
    // no confirmation, and swallowed every error so it kept going.
    expect(fs.existsSync(path.join(__dirname, '../scripts/purgeTargetShops.js'))).toBe(false);
  });

  it('the product seeder refuses to run against the production database', () => {
    const seeder = fs.readFileSync(path.join(__dirname, '../seeds/productSeeder.js'), 'utf8');
    expect(seeder).toContain('Refusing to seed');
    expect(seeder).toMatch(/hisaabDB/);
  });
});
