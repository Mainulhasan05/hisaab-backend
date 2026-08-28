/**
 * The non-transactional fallback — when it may run, and when it must not.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * On a failed `withTransaction`, `runInTransaction` RE-RUNS the whole callback
 * with no session. On a money path that callback is a Sale, a stock decrement,
 * a Payment, a `PaymentAccount` delta and an invoice counter — so a partial
 * first run followed by a complete second one is exactly the shape of every
 * drift bug this repo keeps a `recalc-*` script for.
 *
 * The matcher in front of it accepted `!txError` (any falsy throw), code 251
 * (NoSuchTransaction — not only a topology state) and a loose substring match
 * on `'replica set'`. Each could fire on something that was not a standalone
 * server, and when it did the second execution returned success and logged at
 * `warn`. Nothing counted it, nothing alerted.
 *
 * ── What these tests pin ────────────────────────────────────────────────────
 *
 *   A. THE NARROWED MATCHER — only "this server cannot do transactions"
 *      qualifies. "This transaction did not work" propagates.
 *   B. PRODUCTION REFUSES — a failed checkout is recoverable at the till; a
 *      double-posted one is found months later on a supplier statement.
 *   C. THE ESCAPE HATCH — an operator who genuinely runs standalone can say so.
 */

/**
 * The founder alert is stubbed rather than relied on being skipped.
 *
 * `reportFallback` skips it when `NODE_ENV === 'test'`, but section C
 * deliberately runs with `NODE_ENV=production` — so without this mock those
 * cases reach the real notifier, which queries `AdminTelegramLink`, buffers for
 * ten seconds against a database that is not there, and holds Jest open past
 * the run.
 */
jest.mock('../services/platformNotify.service', () => ({
  adminActivity: jest.fn(),
}));

const mongoose = require('mongoose');
const { runInTransaction } = require('../utils/transaction.util');
const platformNotify = require('../services/platformNotify.service');

/**
 * Set the environment for one test and restore it afterwards.
 *
 * `fallbackAllowed()` reads `process.env` per call, so no module juggling is
 * needed. An earlier draft used `jest.isolateModules` and it did not work: a
 * fresh registry hands the util a fresh `mongoose` too, so the `startSession`
 * spy below applied to a different module instance and every test reached for a
 * real database.
 */
const savedEnv = { ...process.env };
const withEnv = (env) => {
  Object.assign(process.env, env);
};
afterEach(() => {
  process.env.NODE_ENV = savedEnv.NODE_ENV;
  process.env.ALLOW_NON_TRANSACTIONAL = savedEnv.ALLOW_NON_TRANSACTIONAL;
  if (savedEnv.ALLOW_NON_TRANSACTIONAL === undefined) delete process.env.ALLOW_NON_TRANSACTIONAL;
});

/** A session whose `withTransaction` always fails with the given error. */
const failingSession = (err) => ({
  withTransaction: jest.fn().mockRejectedValue(err),
  endSession: jest.fn(),
});

const mkErr = (message, code) => Object.assign(new Error(message), code ? { code } : {});

afterEach(() => jest.restoreAllMocks());

// ── A. The narrowed matcher ─────────────────────────────────────────────────

describe('A · only "this server cannot do transactions" earns a fallback', () => {
  it.each([
    ['the standalone message', mkErr('Transaction numbers are only allowed on a replica set member or mongos')],
    ['the other standalone message', mkErr('Standalone servers do not support transactions')],
    ['code 20 (IllegalOperation)', mkErr('nope', 20)],
    ['code 263 (OperationNotSupportedInTransaction)', mkErr('nope', 263)],
  ])('falls back on %s', async (_label, err) => {
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(failingSession(err));
    withEnv({ NODE_ENV: 'test' });

    const cb = jest.fn().mockResolvedValue('ok');
    await expect(runInTransaction(cb)).resolves.toBe('ok');
    // Once inside the transaction (which threw), once without a session.
    expect(cb).toHaveBeenCalledWith(null);
  });

  it.each([
    ['a falsy throw', null],
    ['code 251 (NoSuchTransaction)', mkErr('No such transaction', 251)],
    ['a message merely mentioning a replica set', mkErr('could not reach the replica set primary')],
    ['a WriteConflict', mkErr('WriteConflict', 112)],
    ['an application error', mkErr('পর্যাপ্ত স্টক নেই')],
  ])('propagates %s instead of re-running the callback', async (_label, err) => {
    // THE REGRESSION. Every one of these used to reach the fallback, and the
    // fallback re-executes a money mutation that may already have half run.
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(failingSession(err));
    withEnv({ NODE_ENV: 'test' });

    const cb = jest.fn().mockResolvedValue('ok');
    await expect(runInTransaction(cb)).rejects.toBeDefined();
    // Never invoked outside the transaction.
    expect(cb).not.toHaveBeenCalledWith(null);
  });
});

// ── B. Production refuses ───────────────────────────────────────────────────

describe('B · production would rather fail the checkout than post it twice', () => {
  it('refuses the fallback even for a genuine topology error', async () => {
    // Production is Atlas, a replica set, where this cannot legitimately
    // happen. So refusing costs nothing real, and the thing it prevents costs a
    // shop money it will not find for months.
    const err = mkErr('Standalone servers do not support transactions');
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(failingSession(err));
    withEnv({ NODE_ENV: 'production', ALLOW_NON_TRANSACTIONAL: '' });

    const cb = jest.fn().mockResolvedValue('ok');
    await expect(runInTransaction(cb)).rejects.toThrow(/Standalone servers/);
    expect(cb).not.toHaveBeenCalledWith(null);
  });

  it('refuses when a session cannot be started at all', async () => {
    // The safer of the two paths — nothing has run yet, so there is no partial
    // write to duplicate — but "no session" in production still means the
    // durability guarantee every service assumes is absent.
    jest.spyOn(mongoose, 'startSession').mockRejectedValue(mkErr('no sessions here'));
    withEnv({ NODE_ENV: 'production', ALLOW_NON_TRANSACTIONAL: '' });

    const cb = jest.fn();
    await expect(runInTransaction(cb)).rejects.toThrow(/no sessions here/);
    expect(cb).not.toHaveBeenCalled();
  });
});

// ── C. The escape hatch ─────────────────────────────────────────────────────

describe('C · an operator who really runs standalone can say so', () => {
  it('allows the fallback in production with ALLOW_NON_TRANSACTIONAL=true', async () => {
    const err = mkErr('Standalone servers do not support transactions');
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(failingSession(err));
    withEnv({
      NODE_ENV: 'production', ALLOW_NON_TRANSACTIONAL: 'true',
    });

    const cb = jest.fn().mockResolvedValue('ok');
    await expect(runInTransaction(cb)).resolves.toBe('ok');
    expect(cb).toHaveBeenCalledWith(null);

    // And the founder hears about it. Running money non-atomically in
    // production is a thing someone has to know happened, even when they asked
    // for it — the old code did this silently at `warn` level, which is why it
    // could have been happening for months.
    expect(platformNotify.adminActivity).toHaveBeenCalledWith(
      expect.objectContaining({ urgent: true })
    );
  });

  it('is opt-in by exact string, not by truthiness', async () => {
    // `'false'`, `'0'` and `'no'` are all truthy strings. Reading this as a
    // boolean would turn every one of them into "yes".
    const err = mkErr('Standalone servers do not support transactions');
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(failingSession(err));
    withEnv({
      NODE_ENV: 'production', ALLOW_NON_TRANSACTIONAL: 'false',
    });

    await expect(runInTransaction(jest.fn())).rejects.toBeDefined();
  });
});

// ── The ambient-session contract is untouched ───────────────────────────────

describe('joining an ambient transaction still bypasses all of this', () => {
  it('runs in the caller\'s session and never opens its own', async () => {
    const start = jest.spyOn(mongoose, 'startSession');
    withEnv({ NODE_ENV: 'test' });

    const ambient = { id: 'outer' };
    const cb = jest.fn().mockResolvedValue('inner');

    await expect(runInTransaction(cb, { session: ambient })).resolves.toBe('inner');
    expect(cb).toHaveBeenCalledWith(ambient);
    expect(start).not.toHaveBeenCalled();
  });
});
