/**
 * The paywall carve-out — the single rule that makes self-serve renewal
 * possible, and the one that keeps it from becoming a hole.
 *
 * ── The problem it solves ───────────────────────────────────────────────────
 *
 * Expiry degrades a shop to read-only: `protect` returns 402 for every non-GET.
 * That is correct, and it has one perverse consequence — RENEWING IS A POST.
 * Left alone, the shops that most need to pay us are precisely the ones the
 * paywall refuses, and every renewal has to go through a phone call, which is
 * the problem the gateway was integrated to remove.
 *
 * `allowWhenExpired` is the exemption, mounted per route. These tests pin what
 * it does and — more importantly — what it must never do:
 *
 *   · it must not exempt anything else. One flag, two routes; a sale, a
 *     product edit, an SMS campaign all stay 402 for the same shop in the same
 *     request cycle.
 *   · it must not survive into the next request. It is set per request by a
 *     middleware, so a flag left on a shared object would silently open the
 *     paywall for everybody.
 *   · it must NOT apply to a blocked shop. A block is a deliberate operator
 *     decision carrying a reason; no payment may quietly undo one. The block
 *     branch returns before this one is ever reached.
 */

jest.mock('../utils/logger.util', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const cacheService = require('../services/cache.service');
const User = require('../models/User.model');
const Shop = require('../models/Shop.model');
const { protect, allowWhenExpired } = require('../middleware/auth.middleware');

const OLD_ENV = process.env;

/** A shop whose subscription ran out three days ago, with no grace. */
function expiredShop(overrides = {}) {
  const shop = new Shop({
    _id: '64b7f9c2e1a4d3b201f5a9c1',
    name: 'মেয়াদ শেষ দোকান',
    phone: '01726315133',
    isActive: true,
    subscription: {
      plan: 'paid',
      status: 'active',
      expiresAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      graceDays: 0,
    },
    access: { blockedAt: null },
    ...overrides,
  });
  return shop;
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function request(method, { blocked = false, allowExpired = false } = {}) {
  const req = {
    method,
    headers: { authorization: 'Bearer token' },
    cookies: {},
    originalUrl: '/api/billing/checkout/subscription',
    baseUrl: '/api/billing',
    path: '/checkout/subscription',
    get: () => undefined,
  };
  if (allowExpired) allowWhenExpired(req, fakeRes(), () => {});

  const shop = blocked
    ? expiredShop({ access: { blockedAt: new Date(), blockReason: 'abuse' } })
    : expiredShop();

  const user = new User({
    _id: '64b7f9c2e1a4d3b201f5a9c2',
    name: 'মালিক',
    phone: '01726315133',
    isActive: true,
  });
  user.shop = shop;
  user.roleDoc = null;
  user.branchList = [];
  // `changedPasswordAfter` is called with the token's iat.
  user.changedPasswordAfter = () => false;

  return { req, user, shop };
}

beforeEach(() => {
  process.env = { ...OLD_ENV, JWT_SECRET: 'test-secret' };
  jest.spyOn(jwt, 'verify').mockReturnValue({
    id: '64b7f9c2e1a4d3b201f5a9c2', iat: Math.floor(Date.now() / 1000),
  });
  jest.spyOn(cacheService, 'get').mockResolvedValue(null);
  jest.spyOn(cacheService, 'set').mockResolvedValue(undefined);
  jest.spyOn(cacheService, 'setNX').mockResolvedValue(false);
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = OLD_ENV;
});

/**
 * Drive `protect` with a fully stubbed user lookup.
 *
 * Resolves when the middleware has actually finished, which is NOT when
 * `protect(...)` returns: `asyncHandler` is `(req,res,next) => { Promise…catch(next) }`
 * — it neither returns nor awaits the promise it creates. Awaiting the call
 * therefore resolves immediately and every assertion runs against a middleware
 * that has not done anything yet. So settle on whichever comes first, `next()`
 * or a response being written.
 */
function runProtect(req, user) {
  jest.spyOn(User, 'findById').mockReturnValue({
    populate: () => ({ populate: async () => user }),
  });

  return new Promise((resolve, reject) => {
    const res = fakeRes();
    const done = (passed) => resolve({ res, passed });

    res.json = (payload) => { res.body = payload; done(false); return res; };

    protect(req, res, (err) => {
      if (err) return reject(err);
      return done(true);
    });

    // A middleware that neither responds nor calls next is a hang in
    // production; surface it as a failure rather than a timeout with no clue.
    setTimeout(() => reject(new Error('protect neither responded nor called next')), 4000).unref();
  });
}

describe('an expired shop', () => {
  test('is refused a write WITHOUT the carve-out — 402, not 403', async () => {
    const { req, user } = request('POST');
    const { res, passed } = await runProtect(req, user);

    expect(passed).toBe(false);
    // 402 specifically: the frontend branches on it to show the renew prompt
    // rather than a generic permissions error.
    expect(res.statusCode).toBe(402);
  });

  test('IS allowed the write WITH the carve-out — this is renewal working', async () => {
    const { req, user } = request('POST', { allowExpired: true });
    const { res, passed } = await runProtect(req, user);

    expect(passed).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  test('can still read either way — expiry degrades, it does not lock out', async () => {
    const { req, user } = request('GET');
    const { passed } = await runProtect(req, user);
    expect(passed).toBe(true);
  });

  test('is still flagged as expired downstream, so nothing thinks it renewed', async () => {
    // The carve-out lets the request through; it must not disguise the state.
    // A service that reads `req.subscriptionExpired` has to keep seeing it.
    const { req, user } = request('POST', { allowExpired: true });
    await runProtect(req, user);
    expect(req.subscriptionExpired).toBe(true);
    expect(req.subscriptionState).toBe('expired');
  });
});

describe('the carve-out is not a general exemption', () => {
  test('the flag does not leak between requests', async () => {
    const exempt = request('POST', { allowExpired: true });
    await runProtect(exempt.req, exempt.user);
    expect(exempt.passed).not.toBe(false);

    // A second, ordinary request — same shop, same user, no carve-out.
    const ordinary = request('POST');
    const { res, passed } = await runProtect(ordinary.req, ordinary.user);

    expect(ordinary.req.allowExpiredWrite).toBeUndefined();
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(402);
  });

  test('every other verb is still refused for the same shop', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const { req, user } = request(method);
      const { res, passed } = await runProtect(req, user);
      expect(passed).toBe(false);
      expect(res.statusCode).toBe(402);
    }
  });
});

describe('a BLOCKED shop', () => {
  test('cannot write even WITH the carve-out — a block is not for sale', async () => {
    const { req, user } = request('POST', { blocked: true, allowExpired: true });
    const { res, passed } = await runProtect(req, user);

    expect(passed).toBe(false);
    // 403 and not 402: this is not a payment problem and must not be presented
    // to the owner as one, or they will pay and stay blocked.
    expect(res.statusCode).toBe(403);
    expect(res.body?.code).toBe('SHOP_BLOCKED');
  });

  test('cannot even READ — a block is total', async () => {
    const { req, user } = request('GET', { blocked: true });
    const { res, passed } = await runProtect(req, user);

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});
