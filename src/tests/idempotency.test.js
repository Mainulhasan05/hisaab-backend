/**
 * Idempotency — the guard that stops one sale being billed twice.
 *
 * WHY THIS SUITE EXISTS NOW
 * -------------------------
 * The middleware was mounted on `POST /sales`, `POST /purchases`,
 * `POST /sales-returns`, `collect-due` and the payment routes from early on,
 * and **no client had ever sent the header**. Its very first line after the
 * method check is `if (!idempotencyKey) return next()`, so in production every
 * request took that branch: the entire feature was dead code that looked live
 * on every route file.
 *
 * That mattered most for the offline POS. `syncManager` deletes a parked sale
 * from IndexedDB only after its POST resolves, so a request that reaches the
 * server while the RESPONSE is lost — the exact failure a shop on a patchy
 * connection hits, and the only reason the sale is parked at all — is retried
 * on the next sync. Without a key the server cannot tell that retry from a
 * genuine second sale: second invoice, second stock deduction, second entry on
 * the customer's due, for goods that left the shop once.
 *
 * The client now sends `x-idempotency-key`, minted once per parked sale and
 * stored beside it. These tests pin what the server does with it.
 *
 * REGRESSION vs INVARIANT (AGENT_WORKFLOW.md §7.1): "an in-flight duplicate
 * answers 409" is a regression test — it fails against the old code, which
 * called `ApiResponse.error` with positional arguments and answered 500
 * "Something went wrong". Everything else here is an invariant guard: the
 * middleware's non-blocking promise (no key, or a broken cache, must never
 * cost a shopkeeper a sale) already held and must keep holding.
 *
 * THE CLAIM IS `setNX`, NOT `get` THEN `set`
 * ------------------------------------------
 * These tests used to assert the reservation was a `cacheService.set`. It was,
 * and that was the bug: a `get` that missed followed by a `set` is two
 * operations, and two requests arriving together both missed and both wrote.
 * The middleware exists to stop a double-tap, and a double-tap is precisely the
 * case where the two requests are concurrent — so it caught the sequential
 * retry and nothing else.
 *
 * `setNX` makes checking and claiming one atomic operation: exactly one caller
 * is told it won. `setNXWins()` / `setNXLoses()` below name the two sides.
 */

jest.mock('../services/cache.service', () => ({
  get: jest.fn(),
  set: jest.fn().mockResolvedValue(undefined),
  setNX: jest.fn().mockResolvedValue(true),
  delete: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../utils/logger.util', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

const cacheService = require('../services/cache.service');
const idempotency = require('../middleware/idempotency.middleware');

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    writableEnded: false,
    listeners: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
    setHeader(k, v) {
      res.headers[k] = v;
    },
    on(event, fn) {
      res.listeners[event] = fn;
    },
  };
  return res;
}

function mockReq(overrides = {}) {
  return {
    method: 'POST',
    baseUrl: '/api/sales',
    path: '/',
    headers: {},
    user: { shop: 'shop1' },
    ...overrides,
  };
}

const KEY = '2f1c9e7a-0b3d-4f88-9a41-5c0d7e6b2a13';

/** This request is the one that claimed the key — it proceeds to the handler. */
const setNXWins = () => cacheService.setNX.mockResolvedValue(true);

/**
 * Another request already holds the key. `setNX` declines, and the middleware
 * reads what the winner has recorded so far.
 */
const setNXLoses = (existing) => {
  cacheService.setNX.mockResolvedValue(false);
  cacheService.get.mockResolvedValue(existing);
};

beforeEach(() => {
  jest.clearAllMocks();
  cacheService.get.mockResolvedValue(null);
  setNXWins();
});

describe('no key supplied — the non-blocking promise', () => {
  it('passes straight through and touches the cache not at all', async () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await idempotency()(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(cacheService.get).not.toHaveBeenCalled();
    expect(cacheService.set).not.toHaveBeenCalled();
    expect(cacheService.setNX).not.toHaveBeenCalled();
  });

  it('a GET is never gated, even carrying a key', async () => {
    const req = mockReq({ method: 'GET', headers: { 'x-idempotency-key': KEY } });
    const next = jest.fn();

    await idempotency()(req, mockRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(cacheService.get).not.toHaveBeenCalled();
  });

  it('a cache outage lets the sale through rather than blocking the till', async () => {
    cacheService.setNX.mockRejectedValue(new Error('redis down'));
    const req = mockReq({ headers: { 'x-idempotency-key': KEY } });
    const next = jest.fn();

    await idempotency()(req, mockRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('a key is supplied', () => {
  it('claims the key atomically before running the handler', async () => {
    const req = mockReq({ headers: { 'x-idempotency-key': KEY } });
    const next = jest.fn();

    await idempotency()(req, mockRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    // One operation, not a get-then-set. See the header note.
    expect(cacheService.setNX).toHaveBeenCalledTimes(1);

    const [lockKey, value] = cacheService.setNX.mock.calls[0];
    expect(value.status).toBe('processing');
    // The shop is part of the key, so two shops cannot collide on one uuid.
    expect(lockKey).toContain('shop1');
    expect(lockKey).toContain(KEY);
  });

  it('accepts the bare `idempotency-key` spelling too', async () => {
    const req = mockReq({ headers: { 'idempotency-key': KEY } });
    const next = jest.fn();

    await idempotency()(req, mockRes(), next);

    expect(cacheService.setNX).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('the same key from two different shops does not collide', async () => {
    const next = jest.fn();
    await idempotency()(mockReq({ headers: { 'x-idempotency-key': KEY } }), mockRes(), next);
    await idempotency()(
      mockReq({ headers: { 'x-idempotency-key': KEY }, user: { shop: 'shop2' } }),
      mockRes(),
      next
    );

    const first = cacheService.setNX.mock.calls[0][0];
    const second = cacheService.setNX.mock.calls[1][0];
    expect(first).not.toBe(second);
  });

  it('scopes the key by the resolved shop, not a stringified shop document', async () => {
    // `req.shop` is a hydrated Mongoose document on a real request. Reading
    // `req.user.shop` and interpolating it — which is what this used to do —
    // put an entire serialised document into the Redis key.
    const req = mockReq({
      headers: { 'x-idempotency-key': KEY },
      shop: { _id: 'shop-42', name: 'Test Shop', toString: () => '[object Object]' },
      user: { shop: { _id: 'shop-42', name: 'Test Shop' } },
    });

    await idempotency()(req, mockRes(), jest.fn());

    const [lockKey] = cacheService.setNX.mock.calls[0];
    expect(lockKey).toContain('shop-42');
    expect(lockKey).not.toContain('object Object');
    expect(lockKey).not.toContain('Test Shop');
  });
});

describe('a retry of a sale the server already completed', () => {
  it('replays the first response and never re-runs the handler', async () => {
    const original = {
      success: true,
      data: { _id: 'sale1', invoiceNo: 'INV-1', total: 450 },
    };
    setNXLoses({ status: 'completed', statusCode: 201, body: original });

    const req = mockReq({ headers: { 'x-idempotency-key': KEY } });
    const res = mockRes();
    const next = jest.fn();

    await idempotency()(req, res, next);

    // This is the whole point: the sale is NOT written a second time.
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    // And the client sees the original invoice, so `syncManager` resolves and
    // deletes the parked row instead of retrying it for ever.
    expect(res.body).toEqual(original);
    expect(res.headers['X-Cache-Lookup']).toBe('HIT-IDEMPOTENT');
  });
});

describe('a duplicate arriving while the first is still running', () => {
  it('answers 409, not 500', async () => {
    setNXLoses({ status: 'processing', timestamp: Date.now() });

    const req = mockReq({ headers: { 'x-idempotency-key': KEY } });
    const res = mockRes();
    const next = jest.fn();

    await idempotency()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    // Regression: the old code passed positional args to `ApiResponse.error`,
    // so `statusCode` destructured to undefined and the default 500 applied.
    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/being processed/i);
    // And it says so in Bengali, like every other error this app returns.
    expect(typeof res.body.messageBn).toBe('string');
    expect(res.body.messageBn.length).toBeGreaterThan(0);
  });
});

describe('two taps landing at the same instant', () => {
  /**
   * THE REGRESSION THIS FIX EXISTS FOR.
   *
   * A shopkeeper double-taps চেকআউট, or `syncManager` fires a retry while the
   * original request is still in flight. Under the old get-then-set both
   * requests saw an empty cache and both reached the handler — two invoices,
   * two stock deductions, one lot of goods.
   *
   * Modelled the way it actually happens: a real `setNX` answers `true` to
   * exactly one caller and `false` to every other, whatever order they arrive
   * in, because the check and the claim are the same operation.
   */
  it('only one of them reaches the handler', async () => {
    let claimed = false;
    cacheService.setNX.mockImplementation(async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    });
    cacheService.get.mockResolvedValue({ status: 'processing', timestamp: Date.now() });

    const headers = { 'x-idempotency-key': KEY };
    const nextA = jest.fn();
    const nextB = jest.fn();
    const resA = mockRes();
    const resB = mockRes();

    await Promise.all([
      idempotency()(mockReq({ headers }), resA, nextA),
      idempotency()(mockReq({ headers }), resB, nextB),
    ]);

    const reached = nextA.mock.calls.length + nextB.mock.calls.length;
    expect(reached).toBe(1);

    // The loser is told to wait rather than being run or silently dropped.
    const loser = nextA.mock.calls.length === 0 ? resA : resB;
    expect(loser.statusCode).toBe(409);
  });
});

describe('caching the outcome', () => {
  it('stores a 2xx so the retry can replay it', async () => {
    const req = mockReq({ headers: { 'x-idempotency-key': KEY } });
    const res = mockRes();

    await idempotency()(req, res, jest.fn());
    cacheService.set.mockClear();

    res.statusCode = 201;
    res.json({ success: true, data: { _id: 'sale1' } });

    expect(cacheService.set).toHaveBeenCalledTimes(1);
    const [, value, ttl] = cacheService.set.mock.calls[0];
    expect(value).toMatchObject({ status: 'completed', statusCode: 201 });
    expect(ttl).toBe(86400);
  });

  it('stores a 4xx too — a rejected sale must not be retried into acceptance', async () => {
    const req = mockReq({ headers: { 'x-idempotency-key': KEY } });
    const res = mockRes();

    await idempotency()(req, res, jest.fn());
    cacheService.set.mockClear();

    res.statusCode = 409;
    res.json({ success: false, message: 'Insufficient stock' });

    expect(cacheService.set).toHaveBeenCalledTimes(1);
    expect(cacheService.set.mock.calls[0][1].statusCode).toBe(409);
  });

  it('releases the lock on a 5xx so the client can safely try again', async () => {
    const req = mockReq({ headers: { 'x-idempotency-key': KEY } });
    const res = mockRes();

    await idempotency()(req, res, jest.fn());
    cacheService.set.mockClear();
    cacheService.delete.mockClear();

    res.statusCode = 500;
    res.json({ success: false });

    expect(cacheService.set).not.toHaveBeenCalled();
    expect(cacheService.delete).toHaveBeenCalledTimes(1);
  });

  it('releases the lock if the connection dies before a response', async () => {
    const req = mockReq({ headers: { 'x-idempotency-key': KEY } });
    const res = mockRes();

    await idempotency()(req, res, jest.fn());
    cacheService.delete.mockClear();

    res.listeners.close();

    expect(cacheService.delete).toHaveBeenCalledTimes(1);
  });
});
