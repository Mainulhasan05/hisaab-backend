/**
 * `runInTransaction` joins an ambient session instead of opening a second one.
 *
 * ── What breaks without this ─────────────────────────────────────────────────
 *
 * Every transactional service method in this codebase is written as
 * `runInTransaction(async (session) => { … })`. Before the join, calling one
 * from inside another produced TWO independent sessions, and two things went
 * wrong at once:
 *
 *   1. Two commit boundaries. Half the work could land — `reviseSale`'s cancel
 *      committing while its re-create rolled back leaves stock restored and no
 *      invoice for money already taken.
 *
 *   2. Under `readConcern: 'snapshot'`, the inner session cannot see the
 *      outer's uncommitted writes. The inner `createSale` would read pre-cancel
 *      stock and deduct against figures the outer transaction was mid-way
 *      through restoring — silently, with no error to notice.
 *
 * These tests deliberately do NOT mock `transaction.util`: the join is the unit
 * under test. They also never reach `mongoose.startSession()`, which is the
 * point — a call that passes a session must not touch the driver at all.
 */

const mongoose = require('mongoose');
const { runInTransaction } = require('../utils/transaction.util');

afterEach(() => jest.restoreAllMocks());

describe('ambient session join', () => {
  it('passes the SAME session object through, not a copy', async () => {
    const ambient = { id: 'outer-session' };
    let received = null;

    await runInTransaction(async (session) => { received = session; }, { session: ambient });

    // Identity, not equality: the driver keys transaction membership off the
    // session instance, so a structurally-equal clone would still be a second
    // transaction.
    expect(received).toBe(ambient);
  });

  it('starts no second session when one is supplied', async () => {
    const startSession = jest.spyOn(mongoose, 'startSession');

    await runInTransaction(async () => 'done', { session: { id: 'outer' } });

    expect(startSession).not.toHaveBeenCalled();
  });

  it('returns the callback’s value unchanged', async () => {
    const result = await runInTransaction(async () => ({ sale: 'INV-1' }), { session: {} });
    expect(result).toEqual({ sale: 'INV-1' });
  });

  it('lets the callback’s error propagate so the OUTER transaction aborts', async () => {
    // Swallowing here would commit the outer transaction around a failed inner
    // step — the exact "half of it landed" outcome the join exists to prevent.
    await expect(
      runInTransaction(async () => { throw new Error('insufficient stock'); }, { session: {} })
    ).rejects.toThrow('insufficient stock');
  });

  it('opens its own session when none is supplied — top-level callers are unchanged', async () => {
    // The same method must work as an entry point and as a nested step. Here it
    // is an entry point, so it must go to the driver. `startSession` rejecting
    // exercises the existing standalone-MongoDB fallback, which is what proves
    // the driver was consulted.
    jest.spyOn(mongoose, 'startSession').mockRejectedValue(new Error('no replica set'));

    const result = await runInTransaction(async (session) => {
      expect(session).toBeNull();
      return 'fell back';
    });

    expect(result).toBe('fell back');
    expect(mongoose.startSession).toHaveBeenCalled();
  });

  it('does not forward `session` into withTransaction’s options', async () => {
    // `session` is a control flag for this helper, not a transaction option. It
    // used to be spread straight into `withTransaction`, where the driver would
    // either ignore it or reject the whole call.
    const withTransaction = jest.fn(async (fn) => { await fn(); });
    jest.spyOn(mongoose, 'startSession').mockResolvedValue({
      withTransaction,
      endSession: jest.fn(),
    });

    await runInTransaction(async () => 'ok', { maxCommitTimeMS: 5000 });

    const [, options] = withTransaction.mock.calls[0];
    expect(options).not.toHaveProperty('session');
    expect(options.maxCommitTimeMS).toBe(5000);
  });
});
