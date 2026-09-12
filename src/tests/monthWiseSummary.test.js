/**
 * The month book — `getMonthWiseSummary`.
 *
 * Four things about this report can be wrong in ways nobody notices for months,
 * because every one of them produces a plausible-looking number:
 *
 *   1. THE WINDOW. It is resolved from a count, a pair of dates, or neither,
 *      and the resolution has to happen in Dhaka time. A window computed from
 *      the server's own clock puts an owner in Dhaka on the wrong month for six
 *      hours a day, at the exact hour — late evening — that a shop closes its
 *      books.
 *
 *   2. THE BUCKETS. `$dateToString` defaults to UTC and does not warn, which is
 *      the defect `reportDateBuckets.test.js` exists for. Here it would move
 *      the first six hours of every month into the month before it — so a shop
 *      that trades late would see its 1st-of-the-month evening land in the
 *      previous row, every month, forever.
 *
 *   3. THE BRANCH AXIS. The shop-wide row is summed from the branch cells, so
 *      a branch missing from the axis does not produce an obvious hole — it
 *      quietly reduces the shop total. A branch that closed still sold goods
 *      before it closed, and the axis therefore comes from the aggregation and
 *      not from the branch list.
 *
 *   4. THE TIE-OUT. This report's whole claim is that it agrees with
 *      `getDateWiseSummary` for any month they both cover. That only holds
 *      while the five books are matched and keyed identically, which is a
 *      property of two pipelines in two methods and nothing enforces it but
 *      this file.
 *
 * Asserted on the emitted PIPELINE and on the assembled RESULT, never on a
 * database: a stubbed aggregate returns correct-looking rows for a wrong
 * pipeline, which is how defect 2 survived its first review.
 *
 *     npx jest monthWiseSummary
 */
const mongoose = require('mongoose');
const Sale = require('../models/Sale.model');
const Expense = require('../models/Expense.model');
const SalesReturn = require('../models/SalesReturn.model');
const Payment = require('../models/Payment.model');
const Purchase = require('../models/Purchase.model');
const Branch = require('../models/Branch.model');
const reportService = require('../services/report.service');
const { BD_TZ } = require('../utils/bdTime.util');

jest.mock('../services/cache.service', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  getShopCacheVersion: jest.fn().mockResolvedValue(1),
  bumpShopCacheVersion: jest.fn().mockResolvedValue(undefined),
}));

const SHOP = new mongoose.Types.ObjectId().toString();
const BRANCH_A = new mongoose.Types.ObjectId();
const BRANCH_B = new mongoose.Types.ObjectId();

/** Every `$dateToString` anywhere in a pipeline, however deeply nested. */
function collectDateToString(node, found = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectDateToString(n, found));
    return found;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$dateToString') found.push(value);
      collectDateToString(value, found);
    }
  }
  return found;
}

/**
 * Run the report against canned aggregation output.
 *
 * `rows` is keyed by model name; anything omitted comes back empty, which is
 * also the shape a shop with no trade in the window produces.
 */
async function run(options, { branchId = null, split = false, rows = {}, branches = [] } = {}) {
  const captured = {};
  const stub = (model, name) => jest.spyOn(model, 'aggregate').mockImplementation((p) => {
    captured[name] = p;
    return Promise.resolve(rows[name] || []);
  });

  stub(Sale, 'sales');
  stub(Expense, 'expenses');
  stub(SalesReturn, 'returns');
  stub(Payment, 'collections');
  stub(Purchase, 'purchases');
  jest.spyOn(Branch, 'getShopBranches').mockResolvedValue(branches);

  const result = await reportService.getMonthWiseSummary(SHOP, options, branchId, split);
  return { result, captured };
}

afterEach(() => jest.restoreAllMocks());

describe('the window', () => {
  it('defaults to twelve months ending with the current one', () => {
    const { from, to } = reportService._monthWindow({});
    const bdNow = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const nowKey = `${bdNow.getUTCFullYear()}-${String(bdNow.getUTCMonth() + 1).padStart(2, '0')}`;

    // The current month is the LAST row, not one before it. An owner opening
    // this in September is asking about September.
    expect(to).toBe(nowKey);
    expect(span(from, to)).toBe(12);
  });

  it('is anchored on the Dhaka month, not the server\'s', () => {
    // 30 September, 20:00 UTC — which is already 1 October in Dhaka. A window
    // built from the server's own clock reports September as the current month
    // and silently drops the first day of October for six hours every night.
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-30T20:00:00.000Z'));
    expect(reportService._monthWindow({}).to).toBe('2026-10');
  });

  it('honours an explicit range', () => {
    expect(reportService._monthWindow({ from: '2026-01', to: '2026-06' }))
      .toEqual({ from: '2026-01', to: '2026-06' });
  });

  it('treats a reversed range as a typo rather than as zero rows', () => {
    expect(reportService._monthWindow({ from: '2026-06', to: '2026-01' }))
      .toEqual({ from: '2026-01', to: '2026-06' });
  });

  it('clamps a too-wide range from the START, keeping the recent months', () => {
    // An owner who asks for ten years wants this year and last, not 2016.
    const { from, to } = reportService._monthWindow({ from: '2016-01', to: '2026-09' });
    expect(to).toBe('2026-09');
    expect(span(from, to)).toBe(36);
  });

  it('clamps an unbounded month count the same way', () => {
    const { from, to } = reportService._monthWindow({ months: 9999, to: '2026-09' });
    expect(span(from, to)).toBe(36);
  });

  it('ignores a malformed month rather than building a window from NaN', () => {
    // `new Date(Date.UTC(NaN, ...))` is an Invalid Date, and the boundaries
    // built from it match nothing at all — an empty report with no error.
    const { to } = reportService._monthWindow({ to: '2026-13' });
    expect(to).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    expect(reportService._monthWindow({ from: 'rubbish', months: 6 }).from)
      .toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });
});

describe('the buckets', () => {
  it('groups by Bangladesh month in every one of the five books', async () => {
    const { captured } = await run({ from: '2026-01', to: '2026-03' });

    expect(Object.keys(captured).sort())
      .toEqual(['collections', 'expenses', 'purchases', 'returns', 'sales']);

    for (const [name, pipeline] of Object.entries(captured)) {
      const buckets = collectDateToString(pipeline);
      expect(buckets).toHaveLength(1);
      // `%Y-%m` and `+06:00` — the second is the whole of defect 2. Without it
      // the first six hours of every month land in the month before.
      expect(buckets[0]).toMatchObject({ format: '%Y-%m', timezone: BD_TZ });
      expect(name).toBeTruthy();
    }
  });

  it('bounds the window on the Dhaka month edges, not the UTC ones', async () => {
    const { captured } = await run({ from: '2026-08', to: '2026-08' });
    const match = captured.sales.find((s) => s.$match).$match;

    // 1 August 00:00 Dhaka is 31 July 18:00 UTC, and the window ends the
    // instant before 1 September 00:00 Dhaka.
    expect(match.createdAt.$gte.toISOString()).toBe('2026-07-31T18:00:00.000Z');
    expect(match.createdAt.$lte.toISOString()).toBe('2026-08-31T17:59:59.999Z');
  });

  it('keys each book on the date that book actually happened on', async () => {
    const { captured } = await run({ from: '2026-08', to: '2026-08' });
    const dateField = (pipeline) => collectDateToString(pipeline)[0].date;

    // Lifted from getDateWiseSummary and must stay lifted — the two reports
    // are read against each other.
    expect(dateField(captured.sales)).toBe('$createdAt');      // invoice date
    expect(dateField(captured.returns)).toBe('$createdAt');    // the day it came back
    expect(dateField(captured.expenses)).toBe('$date');        // business date
    expect(dateField(captured.purchases)).toBe('$date');       // business date
    // Collections key on the effective paid-at, so a Saturday collection
    // entered on Monday lands in the right month at a month boundary.
    expect(dateField(captured.collections)).not.toBe('$createdAt');
  });

  it('counts sales GROSS, so a return does not restate a closed month', async () => {
    const { captured } = await run({ from: '2026-08', to: '2026-08' });
    const group = captured.sales.find((s) => s.$group).$group;

    // `$total`, not `total - returnedAmount`; and profit reconstructed as
    // invoiced. The DAY-STABLE ACCOUNTING note at the top of report.service
    // has the why — a month book that changes when a customer walks in months
    // later is not a book.
    expect(group.totalSales).toEqual({ $sum: '$total' });
    expect(group.totalProfit).toEqual({
      $sum: { $add: ['$profit', { $ifNull: ['$returnedProfit', 0] }] },
    });

    // A sale cancelled BY a return stays counted in its own month; a plain
    // void does not.
    const match = captured.sales.find((s) => s.$match).$match;
    expect(match.$or).toEqual([
      { status: { $ne: 'cancelled' } },
      { status: 'cancelled', returnedAmount: { $gt: 0 } },
    ]);
  });

  it('adds the branch key only when a breakdown was asked for', async () => {
    const flat = await run({ from: '2026-08', to: '2026-08' });
    expect(flat.captured.sales.find((s) => s.$group).$group._id.branch).toBeUndefined();

    const split = await run({ from: '2026-08', to: '2026-08' }, { split: true });
    expect(split.captured.sales.find((s) => s.$group).$group._id.branch).toBe('$branch');
  });
});

describe('the rows', () => {
  it('emits every month in the window, including the empty ones', async () => {
    const { result } = await run({ from: '2026-01', to: '2026-04' });

    // A gap would read as "no data"; what it means is "we sold nothing".
    expect(result.months.map((m) => m.month))
      .toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    expect(result.months.every((m) => m.sales === 0)).toBe(true);
  });

  it('keeps performance and cash as two separate books', async () => {
    const { result } = await run({ from: '2026-08', to: '2026-08' }, {
      rows: {
        // ৳10,000 sold, only ৳2,000 of it paid — a month of বাকি.
        sales: [{
          _id: { month: '2026-08' },
          totalSales: 10000, totalProfit: 3000, totalPaid: 2000, totalDue: 8000, orderCount: 4,
        }],
        expenses: [{ _id: { month: '2026-08' }, totalExpenses: 1000, expenseCount: 2 }],
        // ...against ৳5,000 collected on invoices from earlier months.
        collections: [{ _id: { month: '2026-08' }, collected: 5000, collectionCount: 3 }],
      },
    });

    const m = result.months[0];
    // Book 1: what the month EARNED. Untouched by who paid.
    expect(m.sales).toBe(10000);
    expect(m.profit).toBe(3000);
    expect(m.netProfit).toBe(2000);          // 3000 − 0 returns − 1000 expenses

    // Book 2: what the drawer DID. Untouched by what was earned.
    expect(m.cashIn).toBe(7000);             // 2000 paid + 5000 collected
    expect(m.cashOut).toBe(1000);            // expenses only
    expect(m.netCash).toBe(6000);

    // The two disagree, and that is the point: reporting either alone is what
    // made a credit month read as a healthy one while the drawer emptied.
    expect(m.netProfit).not.toBe(m.netCash);
  });

  it('books returns in the month they arrived and counts only cash refunds as cash', async () => {
    const { result } = await run({ from: '2026-08', to: '2026-08' }, {
      rows: {
        sales: [{
          _id: { month: '2026-08' },
          totalSales: 10000, totalProfit: 3000, totalPaid: 10000, totalDue: 0, orderCount: 4,
        }],
        returns: [{
          _id: { month: '2026-08' },
          returnAmount: 2000, returnProfitLoss: 600, cashRefund: 500, returnCount: 1,
        }],
      },
    });

    const m = result.months[0];
    expect(m.sales).toBe(10000);             // gross survives
    expect(m.netSales).toBe(8000);           // subtraction visible, not baked in
    expect(m.netProfit).toBe(2400);          // 3000 − 600
    // Only the ৳500 actually refunded in cash left the drawer. A store credit
    // or a খাতা adjustment moves no money and must not appear here.
    expect(m.cashOut).toBe(500);
  });
});

describe('the branch axis', () => {
  const branches = [{ _id: BRANCH_A, name: 'প্রধান শাখা' }];

  /** Two branches trading in one month; only one of them still exists. */
  const twoBranchRows = {
    sales: [
      {
        _id: { month: '2026-08', branch: BRANCH_A },
        totalSales: 6000, totalProfit: 2000, totalPaid: 6000, totalDue: 0, orderCount: 3,
      },
      {
        _id: { month: '2026-08', branch: BRANCH_B },
        totalSales: 4000, totalProfit: 1000, totalPaid: 4000, totalDue: 0, orderCount: 2,
      },
    ],
    expenses: [{ _id: { month: '2026-08', branch: BRANCH_B }, totalExpenses: 300, expenseCount: 1 }],
  };

  it('keeps a CLOSED branch in the axis, so the shop total still adds up', async () => {
    const { result } = await run({ from: '2026-08', to: '2026-08' }, {
      split: true, branches, rows: twoBranchRows,
    });

    // Branch B is not in `getShopBranches` — it was deactivated. Dropping it
    // would quietly reduce the shop total by ৳4,000 with nothing to show for
    // it, which is the one failure this report must not have.
    expect(result.byBranch).toHaveLength(2);
    expect(result.byBranch.map((b) => b.isActive)).toEqual([true, false]);
    expect(result.byBranch.find((b) => !b.isActive).netSales).toBe(4000);
    expect(result.months[0].sales).toBe(10000);
  });

  it('sums the shop row FROM the branch cells, so the two cannot disagree', async () => {
    const { result } = await run({ from: '2026-08', to: '2026-08' }, {
      split: true, branches, rows: twoBranchRows,
    });

    const month = result.months[0];
    const fromBranches = month.branches.reduce((n, b) => n + b.netSales, 0);
    expect(month.netSales).toBe(fromBranches);
    expect(month.expenses).toBe(300);

    // And the window total is the sum of the months, by the same construction.
    expect(result.total.netSales).toBe(10000);
    expect(result.total.netSales)
      .toBe(result.byBranch.reduce((n, b) => n + b.netSales, 0));
  });

  it('orders branches by the branch list, so columns do not shuffle between loads', async () => {
    const rows = {
      // Branch B appears FIRST in the aggregation output, as Mongo is free to
      // return it. The listed branch must still lead.
      sales: [
        {
          _id: { month: '2026-08', branch: BRANCH_B },
          totalSales: 4000, totalProfit: 1000, totalPaid: 4000, totalDue: 0, orderCount: 2,
        },
        {
          _id: { month: '2026-08', branch: BRANCH_A },
          totalSales: 6000, totalProfit: 2000, totalPaid: 6000, totalDue: 0, orderCount: 3,
        },
      ],
    };
    const { result } = await run({ from: '2026-08', to: '2026-08' }, {
      split: true, branches, rows,
    });
    expect(result.byBranch[0].branchName).toBe('প্রধান শাখা');
  });

  it('reports no branch dimension at all when the shop is not split', async () => {
    const { result } = await run({ from: '2026-08', to: '2026-08' });

    // `multiBranch: false` is the server's answer and not something the client
    // should infer from an empty array — a single-branch shop and a split shop
    // with no trade would otherwise look identical.
    expect(result.multiBranch).toBe(false);
    expect(result.byBranch).toEqual([]);
    expect(result.months[0].branches).toBeUndefined();
  });

  it('does not fetch the branch list when there is no breakdown to label', async () => {
    await run({ from: '2026-08', to: '2026-08' });
    expect(Branch.getShopBranches).not.toHaveBeenCalled();
  });
});

describe('branch scoping', () => {
  it('narrows every book to the branch the reader is pinned to', async () => {
    const { captured } = await run({ from: '2026-08', to: '2026-08' }, {
      branchId: BRANCH_A.toString(),
    });

    for (const pipeline of Object.values(captured)) {
      const match = pipeline.find((s) => s.$match).$match;
      expect(String(match.branch)).toBe(BRANCH_A.toString());
    }
  });
});

/** Inclusive month span, the same arithmetic `_monthWindow` clamps on. */
function span(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am) + 1;
}
