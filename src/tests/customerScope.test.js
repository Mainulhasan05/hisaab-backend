/**
 * Phase 7 — the customer-scope flag itself.
 *
 * Two things are under test:
 *   1. a single-branch shop can never be put into branch scope, whatever is
 *      stored on it — the pixel-identical guarantee, again; and
 *   2. the flag is a platform-admin action, like branch create/delete.
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

const mongoose = require('mongoose');
const { customerScope, isBranchCustomerScope } = require('../utils/branchScope.util');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();

const req = ({ multi = true, scope = 'branch', branchId = BRANCH } = {}) => ({
  shop: { _id: SHOP, multiBranchEnabled: multi, customerScope: scope },
  branchId,
});

describe('single-branch shops are never branch-scoped', () => {
  it('reads as shop scope even when the field says branch', () => {
    // A shop that had multi-branch enabled, was switched to separate books,
    // then had multi-branch disabled still carries customerScope: 'branch'.
    // It must go straight back to behaving like it never had branches.
    expect(customerScope(req({ multi: false, scope: 'branch' }))).toBe('shop');
    expect(isBranchCustomerScope(req({ multi: false, scope: 'branch' }))).toBe(false);
  });

  it('never throws on a partial or absent req', () => {
    expect(customerScope(undefined)).toBe('shop');
    expect(customerScope({})).toBe('shop');
    expect(customerScope({ shop: null })).toBe('shop');
    expect(isBranchCustomerScope(undefined)).toBe(false);
  });
});

describe('multi-branch shops', () => {
  it('respects an explicit shared book', () => {
    expect(customerScope(req({ scope: 'shop' }))).toBe('shop');
    expect(isBranchCustomerScope(req({ scope: 'shop' }))).toBe(false);
  });

  it('respects an explicit separate book', () => {
    expect(customerScope(req({ scope: 'branch' }))).toBe('branch');
    expect(isBranchCustomerScope(req({ scope: 'branch' }))).toBe(true);
  });

  it('defaults to SEPARATE when the field is missing', () => {
    // Fails safe toward separation: an unset flag must not pool one branch's
    // customer list into another's view. The opposite default would leak.
    expect(customerScope(req({ scope: undefined }))).toBe('branch');
    expect(customerScope(req({ scope: null }))).toBe('branch');
    expect(customerScope(req({ scope: 'nonsense' }))).toBe('branch');
  });
});

describe('All-Branches needs no special case', () => {
  it('is not branch-scoped, so reads fall through to the shop-wide rollup', () => {
    // With no branch selected the sum across every branch IS Customer.totalDue,
    // which is maintained in both modes — so the aggregate view is correct
    // without a single line of its own.
    const allBranches = req({ scope: 'branch', branchId: null });
    expect(customerScope(allBranches)).toBe('branch');
    expect(isBranchCustomerScope(allBranches)).toBe(false);
  });
});

describe('the flag is platform-admin only', () => {
  const routesOf = (router) =>
    router.stack
      .filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`));

  it('is mounted on the admin router', () => {
    expect(routesOf(require('../routes/admin.routes')))
      .toContain('PATCH /shops/:id/customer-scope');
  });

  it('is absent from the owner-facing branch router', () => {
    const ownerRoutes = routesOf(require('../routes/branch.routes')).join(' ');
    expect(ownerRoutes).not.toContain('customer-scope');
  });
});

describe('setCustomerScope validation', () => {
  const adminService = require('../services/admin.service');
  const Shop = require('../models/Shop.model');
  const ADMIN = new mongoose.Types.ObjectId();

  afterEach(() => jest.restoreAllMocks());

  it('rejects a value outside the enum before touching the shop', () => {
    jest.spyOn(Shop, 'findById');
    return adminService.setCustomerScope(SHOP, ADMIN, 'everyone')
      .then(() => { throw new Error('should have thrown'); })
      .catch((err) => {
        expect(err.statusCode).toBe(400);
        expect(Shop.findById).not.toHaveBeenCalled();
      });
  });

  it('refuses on a single-branch shop — there is nothing to separate', async () => {
    jest.spyOn(Shop, 'findById').mockResolvedValue({
      _id: SHOP, name: 'Test', multiBranchEnabled: false,
    });
    await expect(adminService.setCustomerScope(SHOP, ADMIN, 'branch'))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('saves, audits and invalidates the auth cache on a real change', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(Shop, 'findById').mockResolvedValue({
      _id: SHOP, name: 'Test', multiBranchEnabled: true, customerScope: 'branch',
      save, toObject: () => ({ customerScope: 'shop' }),
    });

    await adminService.setCustomerScope(SHOP, ADMIN, 'shop');

    expect(save).toHaveBeenCalled();
    expect(require('../models/AuditLog.model').log).toHaveBeenCalled();
    // Without this the flag would sit in every session's cached shop payload
    // for up to the auth TTL, so the toggle would appear not to work.
    expect(require('../utils/authCache.util').invalidateShopAuthCache).toHaveBeenCalledWith(SHOP);
  });

  it('is a no-op when the value is unchanged', async () => {
    const save = jest.fn();
    jest.spyOn(Shop, 'findById').mockResolvedValue({
      _id: SHOP, name: 'Test', multiBranchEnabled: true, customerScope: 'branch',
      save, toObject: () => ({}),
    });

    await adminService.setCustomerScope(SHOP, ADMIN, 'branch');
    expect(save).not.toHaveBeenCalled();
  });
});
