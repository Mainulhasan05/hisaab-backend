/**
 * The gateway return, driven over REAL HTTP through the whole app.
 *
 * Every other test in this feature exercises a service or a middleware in
 * isolation. This one boots `app.js` and sends actual requests at it, because
 * the failures it guards against are invisible to a unit test — they live in
 * the interaction between middleware, and they only appear on a real request:
 *
 *   · CORS. PayStation may return the customer with a form POST, which carries
 *     `Origin: https://api.paystation.com.bd`. That origin is not in
 *     ALLOWED_ORIGINS and must never be added to it, and the `cors` callback
 *     answers a disallowed origin with an Error → 500. A customer whose money
 *     had already left their wallet would be shown a server error. Caught here
 *     and nowhere else.
 *   · LIMITER STACKING. The route sits on a router that applies
 *     `storefrontLimiter` to everything after it. Registered in the wrong place
 *     it silently gets two budgets, which this codebase says three times must
 *     never happen. Asserted as a header value, because "one bucket" is not
 *     something a unit test can see.
 *   · The redirect target and the refusal of a malformed id.
 *
 * The checkout service is stubbed so the test is fast and deterministic; what
 * is under test is the plumbing around it, not the verification logic (which
 * `platformCheckout.test.js` covers).
 */

jest.mock('../utils/logger.util', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// Stubbed BEFORE app.js is required, so the route picks up the mock.
jest.mock('../services/platformCheckout.service', () => ({
  verifyOrder: jest.fn(async () => ({ ok: true, pending: true })),
}));

const http = require('http');

const OLD_ENV = process.env;
process.env = {
  ...OLD_ENV,
  MONGODB_URI: 'mongodb://127.0.0.1:27017/none',
  JWT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'https://app.hisaabbd.com',
  API_PUBLIC_URL: 'https://api.hisaabbd.com',
  APP_PUBLIC_URL: 'https://app.hisaabbd.com',
  USE_REDIS: 'false',
};

const app = require('../app');
const checkoutService = require('../services/platformCheckout.service');

const ORDER = '64b7f9c2e1a4d3b201f5a9c8';
const RETURN_PATH = `/api/public/payments/paystation/return/${ORDER}`;

let server;

function call({ method = 'GET', path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method, path, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

beforeAll(async () => {
  server = http.createServer(app).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  process.env = OLD_ENV;
});

beforeEach(() => {
  checkoutService.verifyOrder.mockClear();
  checkoutService.verifyOrder.mockResolvedValue({ ok: true, pending: true });
});

describe('the gateway return over HTTP', () => {
  test('a GET redirect lands the customer back in the app', async () => {
    const res = await call({ path: RETURN_PATH });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `https://app.hisaabbd.com/dashboard/billing/return?order=${ORDER}&hint=pending`
    );
  });

  test('a form POST from the GATEWAY origin is not refused by CORS', async () => {
    // The regression this file exists for. Before the CORS delegate, this was a
    // 500 — and only for real payments, only in production, and only if
    // PayStation happens to use POST rather than GET.
    const body = 'trx_status=Success&trx_id=FORGED';
    const res = await call({
      method: 'POST',
      path: RETURN_PATH,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        Origin: 'https://api.paystation.com.bd',
      },
      body,
    });
    expect(res.status).toBe(302);
  });

  test('a forged body changes nothing — the gateway is still asked', async () => {
    const body = 'trx_status=Success&trx_id=FORGED&payment_amount=8000';
    const res = await call({
      method: 'POST',
      path: RETURN_PATH,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });

    // The verdict came from the (stubbed) server-to-server lookup, which said
    // pending — not from the "Success" the caller supplied.
    expect(res.headers.location).toContain('hint=pending');
    expect(res.headers.location).not.toContain('hint=success');
    expect(checkoutService.verifyOrder).toHaveBeenCalledWith(ORDER, { reason: 'return' });
  });

  test('CORS is still enforced on every other public route', async () => {
    const res = await call({
      path: '/api/public/storefront/some-shop',
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('a malformed order id is a 400, not a cast error inside the service', async () => {
    const res = await call({ path: '/api/public/payments/paystation/return/not-an-id' });
    expect(res.status).toBe(400);
    expect(checkoutService.verifyOrder).not.toHaveBeenCalled();
  });

  test('the route carries exactly ONE rate-limit budget', async () => {
    // 60 is `paymentReturnLimiter`. If this ever reads 120 the route has slipped
    // below `router.use(storefrontLimiter)` and is being counted twice — which
    // makes a 429 impossible to attribute and silently applies the tighter of
    // the two ceilings to a customer who has already paid.
    const res = await call({ path: RETURN_PATH });
    expect(res.headers['ratelimit-limit']).toBe('60');
  });

  test('a verification that throws still redirects rather than 500ing', async () => {
    checkoutService.verifyOrder.mockRejectedValue(new Error('mongo is gone'));
    const res = await call({ path: RETURN_PATH });

    // The sweep will finish the order regardless, so the customer is sent on to
    // a page that polls — never shown a stack trace.
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('hint=pending');
  });
});

describe('the owner endpoints are not reachable without a session', () => {
  test('GET /api/billing/me is 401', async () => {
    const res = await call({ path: '/api/billing/me' });
    expect(res.status).toBe(401);
  });

  test('POST /api/billing/checkout/subscription is 401', async () => {
    const body = '{"months":12}';
    const res = await call({
      method: 'POST',
      path: '/api/billing/checkout/subscription',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      body,
    });
    expect(res.status).toBe(401);
  });
});
