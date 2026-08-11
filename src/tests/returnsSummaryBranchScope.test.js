/**
 * Regression — the returns page showed "২টি ফেরত" over an empty table.
 *
 * Root cause: `getReturns` was branch-scoped and `getReturnsSummary` was not.
 * The list filtered on `{ shop, branch }`; the summary aggregation matched on
 * `{ shop }` alone. A branch with no returns of its own therefore displayed
 * ANOTHER branch's count, total and pending-refund amount above its own empty
 * list — including the amber "টাকা ফেরত দেওয়া বাকি" banner, which invited the
 * shopkeeper to settle a debt belonging to a different branch.
 *
 * Both halves are pinned here: the match must carry `branch`, and it must carry
 * it as an ObjectId. The branchId assertions use STRING ids on purpose — the
 * branch list rides through Redis as JSON, so a string is what actually arrives,
 * and `$match` does not cast the way `find()` does. Passing an ObjectId would
 * have passed against the broken code too. See salesSummaryBranchCast.test.js,
 * which pins the identical failure for sales.
 */

const mongoose = require('mongoose');
const SalesReturn = require('../models/SalesReturn.model');
const salesReturnService = require('../services/salesReturn.service');
const salesReturnController = require('../controllers/salesReturn.controller');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();
const OTHER_BRANCH = new mongoose.Types.ObjectId();

const START = new Date('2026-08-01T00:00:00.000Z');
const END = new Date('2026-08-31T23:59:59.999Z');

/** Capture the $match the static hands to aggregate(), without touching Mongo. */
const captureMatch = () => {
  const spy = jest.spyOn(SalesReturn, 'aggregate').mockResolvedValue([]);
  return {
    spy,
    match: () => spy.mock.calls[0][0][0].$match,
  };
};

afterEach(() => jest.restoreAllMocks());

describe('SalesReturn.getReturnsSummary — branch predicate', () => {
  it('scopes the aggregation to the branch, so the cards count the rows the list shows', async () => {
    const { match } = captureMatch();
    await SalesReturn.getReturnsSummary(String(SHOP), START, END, String(BRANCH));

    expect(match().branch).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(match().branch)).toBe(String(BRANCH));
  });

  it('casts a STRING branchId — $match compares raw BSON and would match nothing', async () => {
    const { match } = captureMatch();
    // Precondition: this is the shape the Redis auth payload actually yields.
    const asString = String(BRANCH);
    expect(typeof asString).toBe('string');

    await SalesReturn.getReturnsSummary(String(SHOP), START, END, asString);
    expect(match().branch).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it('adds no branch predicate for a single-branch shop', async () => {
    // The unchanged-behaviour guarantee: branchId is null for them, and nothing
    // about their summary may change.
    const { match } = captureMatch();
    await SalesReturn.getReturnsSummary(String(SHOP), START, END, null);
    expect(match()).not.toHaveProperty('branch');
  });

  it('adds no branch predicate for an owner viewing All Branches', async () => {
    // No branch selected is the deliberate cross-branch rollup, not a bug.
    const { match } = captureMatch();
    await SalesReturn.getReturnsSummary(String(SHOP), START, END);
    expect(match()).not.toHaveProperty('branch');
  });

  it('still carries shop and the date window', async () => {
    const { match } = captureMatch();
    await SalesReturn.getReturnsSummary(String(SHOP), START, END, String(BRANCH));

    expect(match().shop).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(match().createdAt).toEqual({ $gte: START, $lte: END });
  });

  /**
   * The second half of the same disagreement. The list defaults to all time;
   * this defaulted to the current calendar month, so the "সব সময়" filter the
   * page opens on printed one month's totals over every return ever recorded.
   */
  it('is unbounded when neither date is given — the list default', async () => {
    const { match } = captureMatch();
    await SalesReturn.getReturnsSummary(String(SHOP), null, null, String(BRANCH));
    expect(match()).not.toHaveProperty('createdAt');
  });

  it('applies a lone start bound without inventing an end', async () => {
    const { match } = captureMatch();
    await SalesReturn.getReturnsSummary(String(SHOP), START, null, null);
    expect(match().createdAt).toEqual({ $gte: START });
  });

  it('applies a lone end bound without inventing a start', async () => {
    const { match } = captureMatch();
    await SalesReturn.getReturnsSummary(String(SHOP), null, END, null);
    expect(match().createdAt).toEqual({ $lte: END });
  });

  it('returns the zero row rather than undefined when a branch has no returns', async () => {
    jest.spyOn(SalesReturn, 'aggregate').mockResolvedValue([]);
    const summary = await SalesReturn.getReturnsSummary(String(SHOP), START, END, String(BRANCH));

    expect(summary).toEqual({
      totalReturns: 0,
      totalProfitLoss: 0,
      count: 0,
      pendingRefundAmount: 0,
      pendingRefundCount: 0,
    });
  });
});

describe('salesReturnService.getReturnsSummary — forwards the branch', () => {
  it('passes branchId through to the static', async () => {
    const spy = jest.spyOn(SalesReturn, 'getReturnsSummary').mockResolvedValue({});
    await salesReturnService.getReturnsSummary(String(SHOP), {
      startDate: START.toISOString(),
      endDate: END.toISOString(),
      branchId: String(BRANCH),
    });

    expect(spy.mock.calls[0][3]).toBe(String(BRANCH));
  });

  it('defaults to null when no branch is active', async () => {
    const spy = jest.spyOn(SalesReturn, 'getReturnsSummary').mockResolvedValue({});
    await salesReturnService.getReturnsSummary(String(SHOP), {});

    expect(spy.mock.calls[0][3]).toBeNull();
  });

  it('passes null dates through rather than falling back to this month', async () => {
    const spy = jest.spyOn(SalesReturn, 'getReturnsSummary').mockResolvedValue({});
    await salesReturnService.getReturnsSummary(String(SHOP), {});

    expect(spy.mock.calls[0][1]).toBeNull();
    expect(spy.mock.calls[0][2]).toBeNull();
  });

  it('uses the end instant it was given, with no end-of-day grace', async () => {
    // The list applies the timestamp verbatim; widening it here made the
    // summary's window wider than the list's.
    const spy = jest.spyOn(SalesReturn, 'getReturnsSummary').mockResolvedValue({});
    const endInstant = '2026-08-11T09:30:00.000Z';
    await salesReturnService.getReturnsSummary(String(SHOP), { endDate: endInstant });

    expect(spy.mock.calls[0][2].toISOString()).toBe(endInstant);
  });
});

describe('controller — branch comes from scope, never the query string', () => {
  const res = () => ({ status: () => res(), json: () => {} });

  const run = async (req) => {
    const spy = jest.spyOn(salesReturnService, 'getReturnsSummary').mockResolvedValue({});
    await salesReturnController.getReturnsSummary(
      { shop: { _id: SHOP }, query: {}, ...req },
      res(),
      () => {}
    );
    return spy.mock.calls[0][1];
  };

  it('uses the resolved branch', async () => {
    expect(await run({ branchId: BRANCH })).toMatchObject({ branchId: BRANCH });
  });

  it('ignores a branchId smuggled in through the query string', async () => {
    // The scope is null, so the answer is null — not the branch that was asked
    // for. This is the difference between an owner's rollup and a caller
    // reading a branch the scope never granted.
    const options = await run({ branchId: null, query: { branchId: String(OTHER_BRANCH) } });
    expect(options.branchId).toBeNull();
  });

  it('still forwards the date window', async () => {
    const options = await run({
      branchId: BRANCH,
      query: { startDate: START.toISOString(), endDate: END.toISOString() },
    });
    expect(options).toMatchObject({
      startDate: START.toISOString(),
      endDate: END.toISOString(),
    });
  });
});

describe('list endpoint — the same scope the summary now uses', () => {
  const res = () => ({ status: () => res(), json: () => {} });

  const run = async (req) => {
    const spy = jest.spyOn(salesReturnService, 'getReturns')
      .mockResolvedValue({ data: [], pagination: {} });
    await salesReturnController.getReturns(
      { shop: { _id: SHOP }, query: {}, ...req },
      res(),
      () => {}
    );
    return spy.mock.calls[0][1];
  };

  it('overwrites a query-string branchId with the resolved scope', async () => {
    const options = await run({ branchId: null, query: { branchId: String(OTHER_BRANCH) } });
    expect(options.branchId).toBeNull();
  });

  it('keeps the other query filters', async () => {
    const options = await run({ branchId: BRANCH, query: { search: 'RET', refundStatus: 'pending' } });
    expect(options).toMatchObject({ search: 'RET', refundStatus: 'pending', branchId: BRANCH });
  });
});
