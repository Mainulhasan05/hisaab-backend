/**
 * The public auth routes are actually reachable without a session.
 *
 * ── WHY THIS TEST EXISTS ────────────────────────────────────────────────────
 *
 * `auth.routes.js` is a single router that switches from public to protected
 * halfway down, with a bare `router.use(protect)`. A bare `use()` matches every
 * path, so the ONLY thing making `/forgot-password` public is that its
 * `router.post` sits above that line. Nothing enforces that. Move it, or add a
 * new public route below it, and the route does not 404 — it falls through to
 * `protect` and answers:
 *
 *     401 { messageBn: "এই রিসোর্স অ্যাক্সেস করতে লগইন করুন" }
 *
 * which is a spectacularly misleading thing to tell someone who cannot log in
 * BECAUSE they forgot their password. The service-level tests cannot see this:
 * they call the service directly and never touch the router.
 *
 * So this drives the real Express stack over real HTTP, with only the service
 * stubbed. It asserts both halves — public routes reachable, protected routes
 * still guarded — because a test that only checked the first would pass just as
 * happily if someone deleted `router.use(protect)` entirely.
 */

jest.mock('../services/auth.service', () => ({
  requestPasswordReset: jest.fn().mockResolvedValue({
    cooldownSeconds: 60,
    expiresInSeconds: 300,
  }),
  verifyPasswordResetCode: jest.fn().mockResolvedValue({
    resetToken: 'a'.repeat(64),
    expiresInSeconds: 600,
    accounts: [],
  }),
  resetPassword: jest.fn().mockResolvedValue({
    message: 'Password reset successfully',
    accountsUpdated: 1,
    shopCount: 1,
  }),
}));

const express = require('express');
const cookieParser = require('cookie-parser');

const PHONE = '01712345678';

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // Mounted exactly as `routes/index.js` mounts it, so the paths under test are
  // the paths the browser actually calls.
  app.use('/api/auth', require('../routes/auth.routes'));

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

const post = async (path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

describe('the forgot-password routes need no session', () => {
  it('POST /api/auth/forgot-password is reachable signed out', async () => {
    const res = await post('/api/auth/forgot-password', { phone: PHONE });

    // The exact regression: falling through to `protect` answers 401 with
    // "এই রিসোর্স অ্যাক্সেস করতে লগইন করুন" — told to log in, on the endpoint
    // for people who cannot.
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it('POST /api/auth/forgot-password/verify is reachable signed out', async () => {
    const res = await post('/api/auth/forgot-password/verify', {
      phone: PHONE,
      otp: '123456',
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it('POST /api/auth/reset-password is reachable signed out', async () => {
    const res = await post('/api/auth/reset-password', {
      phone: PHONE,
      resetToken: 'a'.repeat(64),
      newPassword: 'notun1234',
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it('validates the body rather than the session when input is wrong', async () => {
    // A 400 here proves the request reached `validate()`, which sits after the
    // route matched and before any auth. A 401 would mean it never got there.
    const res = await post('/api/auth/forgot-password', { phone: 'nonsense' });
    expect(res.status).toBe(400);
  });
});

describe('the protected half of the same router is still protected', () => {
  it('POST /api/auth/change-password still 401s without a session', async () => {
    const res = await post('/api/auth/change-password', {
      currentPassword: 'purano123',
      newPassword: 'notun1234',
    });
    expect(res.status).toBe(401);
  });
});

describe('an auth path that does not exist says so, instead of demanding a login', () => {
  const patch = async (path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  it('404s an unknown path rather than 401ing it', async () => {
    // The exact shape of the incident: a route that is not on this server
    // (unshipped, renamed, typo'd) used to fall through to the blanket
    // `protect` and answer "log in". It cost a morning of debugging.
    const res = await post('/api/auth/does-not-exist', {});

    expect(res.status).toBe(404);
    expect(res.body.messageBn).not.toMatch(/লগইন করুন/);
  });

  it('404s a path that only LOOKS like the reset flow', async () => {
    // e.g. a client on an older contract calling a name we never shipped.
    const res = await post('/api/auth/forgot-password/confirm', {});
    expect(res.status).toBe(404);
  });

  it('404s a real path called with the wrong method', async () => {
    // GET /login is not a route. Matching on path alone would let this reach
    // `protect` and 401 — technically true, uselessly misleading.
    const res = await fetch(`${baseUrl}/api/auth/login`);
    expect(res.status).toBe(404);
  });

  it('lets real protected paths through to the auth check, nested ones included', async () => {
    // The guard must not become the thing that hides the security gate. A
    // two-segment path proves the regexp match handles more than one level.
    const res = await patch('/api/auth/shop/settings', { name: 'x' });
    expect(res.status).toBe(401);
  });

  it('still 401s — not 404s — every protected route', async () => {
    // If the guard's stack introspection ever stopped seeing routes registered
    // AFTER it, everything protected would 404 and the whole app would look
    // broken while reporting nothing was wrong.
    for (const path of ['/api/auth/logout', '/api/auth/verify-password']) {
      const res = await post(path, {});
      expect(res.status).toBe(401);
    }
    expect((await patch('/api/auth/profile', { name: 'ok' })).status).toBe(401);
  });
});
