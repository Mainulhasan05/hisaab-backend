/**
 * The transfer register's read path — period, account, status, and the totals.
 *
 * ── The bugs these close ────────────────────────────────────────────────────
 *
 *   · the screen asked for no page and got the default twenty, with no way to
 *     reach the twenty-first transfer — and the PDF printed those twenty and
 *     footed them as "সর্বমোট";
 *   · `limit` had no ceiling, so one request could pull the whole collection;
 *   · there was no period filter, so "this month's charges" was not askable.
 *
 * REGRESSIONS: the limit ceiling, the date filter, and the CAST in the summary
 * $match (I-3 — uncast, every card reads ৳০ with no error).
 * INVARIANT GUARDS: single-branch filter shape (I-1), defaults unchanged.
 */
const mongoose = require('mongoose');
const AccountTransfer = require('../models/AccountTransfer.model');
const paymentAccountService = require('../services/paymentAccount.service');
const { listTransfers } = require('../validations/paymentAccount.validation');
const { getBangladeshDayRange } = require('../utils/bdTime.util');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();
const ACCOUNT = new mongoose.Types.ObjectId();

const reqFor = ({ multiBranch = false, branchId = null } = {}) => ({
  shop: { _id: SHOP, multiBranchEnabled: multiBranch, features: { fundAccounts: true } },
  branchId,
});

/** Capture what the service hands each query. */
function stubQueries({ rows = [], total = rows.length, totals = [], cancelled = 0 } = {}) {
  const seen = { counts: [] };
  const chain = {
    sort: (s) => { seen.sort = s; return chain; },
    skip: (n) => { seen.skip = n; return chain; },
    limit: (n) => { seen.limit = n; return chain; },
    populate: () => chain,
    lean: async () => rows,
  };
  jest.spyOn(AccountTransfer, 'find').mockImplementation((filter) => { seen.filter = filter; return chain; });
  // Call 1 is the list's total, call 2 the voided count for the cards.
  jest.spyOn(AccountTransfer, 'countDocuments').mockImplementation(async (filter) => {
    seen.counts.push(filter);
    return seen.counts.length === 1 ? total : cancelled;
  });
  jest.spyOn(AccountTransfer, 'aggregate').mockImplementation(async (pipeline) => { seen.pipeline = pipeline; return totals; });
  return seen;
}

afterEach(() => jest.restoreAllMocks());

describe('listTransfers query schema', () => {
  const run = (query) => listTransfers.validate(query, { abortEarly: false, stripUnknown: true });

  it('keeps the old defaults — page 1 of 20, every status', () => {
    const { value, error } = run({});
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ page: 1, limit: 20, status: 'all' });
  });

  it('refuses a limit above the ceiling instead of pulling the whole collection', () => {
    expect(run({ limit: '500' }).error).toBeUndefined();
    expect(run({ limit: '10000000' }).error).toBeDefined();
  });

  it('accepts a blank period — that is "from the beginning"', () => {
    const { value, error } = run({ startDate: '', endDate: '' });
    expect(error).toBeUndefined();
    expect(value.startDate).toBe('');
  });

  it('refuses a timestamp where a Bangladesh calendar day is expected', () => {
    expect(run({ startDate: '2026-09-01T00:00:00Z' }).error).toBeDefined();
  });

  it('refuses a malformed account id rather than letting it reach a cast', () => {
    expect(run({ accountId: 'not-an-id' }).error).toBeDefined();
  });
});

describe('getTransfers', () => {
  it('a single-branch shop with no filters runs the query it always ran (I-1)', async () => {
    const seen = stubQueries();
    await paymentAccountService.getTransfers(SHOP, reqFor(), {});
    expect(seen.filter).toEqual({ shop: SHOP });
    expect(seen.limit).toBe(20);
    expect(seen.skip).toBe(0);
  });

  it('filters by Bangladesh calendar days, both ends inclusive', async () => {
    const seen = stubQueries();
    await paymentAccountService.getTransfers(SHOP, reqFor(), {
      startDate: '2026-09-01', endDate: '2026-09-30',
    });
    expect(seen.filter.date).toEqual({
      $gte: getBangladeshDayRange('2026-09-01').startOfDay,
      $lte: getBangladeshDayRange('2026-09-30').endOfDay,
    });
    // The totals must cover the same period as the list, or the cards and the
    // rows under them describe two different things.
    expect(seen.pipeline[0].$match.date).toEqual(seen.filter.date);
  });

  it('casts every id in the summary $match (I-3)', async () => {
    const seen = stubQueries();
    await paymentAccountService.getTransfers(String(SHOP), reqFor({ multiBranch: true, branchId: String(BRANCH) }), {
      accountId: String(ACCOUNT),
    });
    const match = seen.pipeline[0].$match;
    expect(match.shop).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(match.branch).toBeInstanceOf(mongoose.Types.ObjectId);
    for (const leg of match.$or) {
      const value = leg.fromAccount || leg.toAccount;
      expect(value).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(String(value)).toBe(String(ACCOUNT));
    }
  });

  it('status=live drops voided rows from the list', async () => {
    const seen = stubQueries();
    await paymentAccountService.getTransfers(SHOP, reqFor(), { status: 'live' });
    expect(seen.filter.status).toEqual({ $ne: 'cancelled' });
    expect(seen.counts[0].status).toEqual({ $ne: 'cancelled' });
  });

  it('the cards ignore the list status — they always describe what the money did', async () => {
    const seen = stubQueries();
    await paymentAccountService.getTransfers(SHOP, reqFor(), {
      status: 'live', accountId: String(ACCOUNT), startDate: '2026-09-01',
    });
    // Money sums: live rows only, whatever the list asked for.
    expect(seen.pipeline[0].$match.status).toEqual({ $ne: 'cancelled' });
    // Voided count: the list's own period and account, status swapped.
    const { status, ...rest } = seen.counts[1];
    expect(status).toBe('cancelled');
    const { status: _ignored, ...listRest } = seen.filter;
    expect(rest).toEqual(listRest);
  });

  it('walks pages with skip, so "show all" can reach the last transfer', async () => {
    const seen = stubQueries({ total: 1234 });
    const result = await paymentAccountService.getTransfers(SHOP, reqFor(), { page: 3, limit: 500 });
    expect(seen.skip).toBe(1000);
    // A total order, or skip-paging can repeat one row and lose another.
    expect(seen.sort).toEqual({ date: -1, createdAt: -1, _id: -1 });
    expect(result.pagination).toEqual({ page: 3, limit: 500, total: 1234, pages: 3 });
  });

  it('returns the range totals, and zeros when nothing matched', async () => {
    stubQueries({
      totals: [{ count: 4, amountOut: 111925, amountIn: 111000, charge: 925, firstDate: new Date('2026-01-05') }],
      cancelled: 1,
    });
    const full = await paymentAccountService.getTransfers(SHOP, reqFor(), {});
    expect(full.summary).toMatchObject({ count: 4, cancelledCount: 1, charge: 925 });

    jest.restoreAllMocks();
    stubQueries();
    const empty = await paymentAccountService.getTransfers(SHOP, reqFor(), {});
    expect(empty.summary).toEqual({
      count: 0, cancelledCount: 0, amountOut: 0, amountIn: 0, charge: 0, firstDate: null,
    });
  });
});
