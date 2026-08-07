/**
 * Phase 4 — branch creation and deletion are platform-admin actions.
 *
 * The product rule: a shop owner asks the platform admin for a branch; the
 * admin creates it from the admin panel. The owner can then see and edit that
 * branch, but can never create, delete, or enable/disable branches.
 */

// branch.service destructures these at module load, so they must be mocked
// before it is required — a later jest.spyOn would not be seen by it.
jest.mock('../utils/authCache.util', () => ({
  invalidateShopAuthCache: jest.fn().mockResolvedValue(undefined),
  invalidateUserAuthCache: jest.fn().mockResolvedValue(undefined),
  invalidateBranchCache: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));

const branchRouter = require('../routes/branch.routes');
const adminRoutes = require('../routes/admin.routes');
const branchService = require('../services/branch.service');

/** Collect [method, path] pairs actually mounted on a router. */
const routesOf = (router) =>
  router.stack
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).map((m) => [m.toUpperCase(), l.route.path]));

describe('owner-facing /api/branches', () => {
  const routes = routesOf(branchRouter);

  it('exposes only read and edit', () => {
    expect(routes.sort()).toEqual([
      ['GET', '/'],
      ['GET', '/:id'],
      ['PATCH', '/:id'],
    ].sort());
  });

  it.each([['POST', '/'], ['DELETE', '/:id'], ['PUT', '/:id']])(
    'does not expose %s %s',
    (method, path) => {
      expect(routes).not.toContainEqual([method, path]);
    }
  );

  it('the routes are removed, not permission-gated', () => {
    // A gated route would still be mounted and would answer 403; a removed one
    // 404s, which is what we want for a guessed URL — it leaks nothing about
    // whether the shop even has multi-branch enabled.
    const paths = routes.map(([m, p]) => `${m} ${p}`);
    expect(paths.filter((p) => p.startsWith('POST'))).toHaveLength(0);
    expect(paths.filter((p) => p.startsWith('DELETE'))).toHaveLength(0);
  });
});

describe('platform-admin routes still own branch lifecycle', () => {
  const routes = routesOf(adminRoutes).map(([m, p]) => `${m} ${p}`);

  it.each([
    'POST /shops/:id/branches',
    'PATCH /shops/:id/branches/:branchId',
    'DELETE /shops/:id/branches/:branchId',
    'POST /shops/:id/enable-multi-branch',
    'POST /shops/:id/disable-multi-branch',
  ])('exposes %s', (route) => {
    expect(routes).toContain(route);
  });
});

describe('branchService surface', () => {
  it('no longer offers create or deactivate to the owner path', () => {
    expect(branchService.createBranch).toBeUndefined();
    expect(branchService.deactivateBranch).toBeUndefined();
  });

  it('still offers read, edit and the deletion-impact check', () => {
    expect(typeof branchService.getBranches).toBe('function');
    expect(typeof branchService.getBranch).toBe('function');
    expect(typeof branchService.updateBranch).toBe('function');
    expect(typeof branchService.getAssignedBranch).toBe('function');
    expect(typeof branchService.getBranchDeletionImpact).toBe('function');
  });
});

describe('owner edits are limited to descriptive fields', () => {
  // code drives invoice numbering and isActive is existence — both admin-only.
  const makeBranch = (over = {}) => ({
    _id: 'b1', name: 'Old', code: 'OLD', address: 'A', phone: '1',
    isActive: true, save: jest.fn().mockResolvedValue(true),
    ...over,
  });

  afterEach(() => jest.restoreAllMocks());

  it('applies name, address and phone', async () => {
    const branch = makeBranch();
    jest.spyOn(branchService, 'getBranch').mockResolvedValue(branch);

    await branchService.updateBranch('b1', 's1',
      { name: 'New', address: 'B', phone: '2' },
      { user: { _id: 'u1' } });

    expect(branch.name).toBe('New');
    expect(branch.address).toBe('B');
    expect(branch.phone).toBe('2');
  });

  it('ignores code and isActive even when sent', async () => {
    const branch = makeBranch();
    jest.spyOn(branchService, 'getBranch').mockResolvedValue(branch);

    await branchService.updateBranch('b1', 's1',
      { name: 'New', code: 'HACKED', isActive: false },
      { user: { _id: 'u1' } });

    expect(branch.code).toBe('OLD');
    expect(branch.isActive).toBe(true);
  });
});
