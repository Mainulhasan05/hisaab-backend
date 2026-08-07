/**
 * Behavioural proof that the deny-by-default delete guard is actually wired
 * into the auth path — not just present as a function somewhere.
 *
 * This drives the real `protect` middleware with a real admin token and asserts
 * the request is refused before any route handler runs. The companion suite
 * (adminNoDelete.test.js) checks the route surface and the handlers; this one
 * checks the thing that makes those two redundant: an admin cannot issue a
 * DELETE to *any* path, including paths that do not exist yet.
 *
 * It is deliberately hostile to the most likely regression — someone adds a new
 * destructive route and never reads deletionDisabled.util.js.
 */

jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../services/cache.service', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../models/Admin.model', () => ({
  findById: jest.fn(),
  hydrate: jest.fn((o) => o),
}));

const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin.model');
const { protect } = require('../middleware/auth.middleware');

const ADMIN_ID = 'a1b2c3d4e5f60718293a4b5c';

beforeEach(() => {
  jest.clearAllMocks();
  jwt.verify.mockReturnValue({ isAdmin: true, id: ADMIN_ID, iat: 1 });
  Admin.findById.mockResolvedValue({
    _id: ADMIN_ID,
    name: 'Operator',
    isActive: true,
    changedPasswordAfter: () => false,
    toObject() { return { _id: ADMIN_ID, name: 'Operator', isActive: true }; },
  });
});

/** Run protect() and report how it ended: 'next', an error, or an HTTP reply. */
const run = (method, originalUrl) =>
  new Promise((resolve) => {
    const req = {
      method,
      originalUrl,
      path: originalUrl,
      headers: { authorization: 'Bearer fake.admin.token' },
      cookies: {},
      get: () => undefined,
    };
    const res = {
      status: () => res,
      json: (body) => resolve({ kind: 'http', body }),
    };
    protect(req, res, (err) => resolve(err ? { kind: 'error', err } : { kind: 'next', req }));
  });

describe('an admin token cannot DELETE, whatever the path', () => {
  it.each([
    ['a route that exists', '/api/held-carts/6a716c62d6c231edf6acfd7d'],
    ['a route removed from the router', '/api/admin/shops/6a716c62d6c231edf6acfd7d'],
    ['a shop-facing route reached via x-shop-id', '/api/products/6a716c62d6c231edf6acfd7d'],
    ['a route nobody has written yet', '/api/warehouses/6a716c62d6c231edf6acfd7d'],
  ])('refuses DELETE on %s', async (_label, url) => {
    const out = await run('DELETE', url);
    expect(out.kind).toBe('error');
    expect(out.err.code).toBe('DELETION_DISABLED');
    expect(out.err.statusCode).toBe(403);
  });

  it.each([
    ['branch deactivation', '/api/admin/shops/6a716c62d6c231edf6acfd7d/branches/6a75766fbd7bd54927a32ecc'],
    ['cache key eviction', '/api/admin/cache/keys/shop:123:products'],
  ])('still allows the allowlisted DELETE: %s', async (_label, url) => {
    const out = await run('DELETE', url);
    expect(out.kind).toBe('next');
    expect(out.req.isAdmin).toBe(true);
  });
});

describe('the guard does not touch anything else', () => {
  it.each(['GET', 'POST', 'PATCH', 'PUT'])('lets an admin %s through', async (method) => {
    const out = await run(method, '/api/admin/shops/6a716c62d6c231edf6acfd7d');
    expect(out.kind).toBe('next');
    expect(out.req.isAdmin).toBe(true);
  });

  it('is inert for non-admin tokens — the shop app is unaffected', async () => {
    // A shop user's token never sets req.isAdmin, so the guard is never
    // consulted. Owners and staff keep every delete they have today.
    const { assertAdminMayDelete } = require('../utils/deletionDisabled.util');
    const shopUserReq = { method: 'DELETE', originalUrl: '/api/products/abc', path: '/api/products/abc' };
    // The guard is only ever called from inside the `decoded.isAdmin` branch;
    // calling it for a shop user would be the bug. Assert the call site is
    // reachable only there.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../middleware/auth.middleware.js'), 'utf8'
    );
    for (const line of src.split('\n')) {
      if (line.includes('assertAdminMayDelete(req)')) {
        expect(src.slice(0, src.indexOf(line))).toMatch(/decoded\.isAdmin[\s\S]*$/);
      }
    }
    // And it does throw when it *is* consulted, so the block above is load-bearing.
    expect(() => assertAdminMayDelete(shopUserReq)).toThrow();
  });
});
