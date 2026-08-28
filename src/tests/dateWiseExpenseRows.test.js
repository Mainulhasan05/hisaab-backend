/**
 * The day drill-down itemises its খরচ total — under a permission of its own.
 *
 * ── What this pins ──────────────────────────────────────────────────────────
 *
 * `/reports/date-wise/:date` returned an expense TOTAL and nothing behind it,
 * so "খরচ ৳৪,৫০০" was a figure the shopkeeper could not decompose. The rows are
 * now attached — but the route is gated `reports.view`, and an expense row is a
 * strictly larger disclosure than its total: the amount says the shop spent
 * ৳4,500, the row says who was paid, for what, out of which account.
 *
 * `reports.view` without `expenses.view` is a real, grantable combination — the
 * salesperson preset has neither, but nothing stops an owner building a role
 * with the first and not the second, and the presets already differ on exactly
 * this axis. So the rows ride on `expenses.view`, asked at the controller and
 * honoured at source.
 *
 * They cannot be stripped after the fact the way profit and cost are:
 * `sanitizeReport` filters by field NAME, and the revealing fields here are
 * `amount` and `description` — names that appear all over payloads the same
 * requester is entitled to. Stripping those globally would gut the response.
 * Hence `includeExpenses`, and hence this suite.
 */
const mongoose = require('mongoose');
const Sale = require('../models/Sale.model');
const Expense = require('../models/Expense.model');
const Payment = require('../models/Payment.model');
const Purchase = require('../models/Purchase.model');
const SalesReturn = require('../models/SalesReturn.model');
const User = require('../models/User.model');
const reportService = require('../services/report.service');
const { canViewExpenses } = require('../utils/dataSanitizer.util');
const { ROLE_PRESETS } = require('../config/permissions');

jest.mock('../services/cache.service', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  getShopCacheVersion: jest.fn().mockResolvedValue(1),
  bumpShopCacheVersion: jest.fn().mockResolvedValue(undefined),
}));

const SHOP = new mongoose.Types.ObjectId().toString();
const DATE = '2026-08-08';

const EXPENSE_ROWS = [
  {
    _id: 'e1',
    categoryName: 'দোকান ভাড়া',
    amount: 4000,
    description: 'আগস্ট মাসের ভাড়া',
    paymentMethod: 'cash',
    date: new Date('2026-08-08T04:00:00.000Z'),
  },
  {
    _id: 'e2',
    categoryName: 'বিদ্যুৎ বিল',
    amount: 500,
    description: '',
    paymentMethod: 'bkash',
    date: new Date('2026-08-08T09:00:00.000Z'),
  },
];

/** `Sale.find(...).populate().populate().sort().lean()` as a stub. */
function chain(result) {
  const link = {
    populate: () => link,
    sort: () => link,
    lean: () => Promise.resolve(result),
  };
  return link;
}

let expenseFind;

beforeEach(() => {
  jest.spyOn(Sale, 'find').mockReturnValue(chain([{ _id: 's1', invoiceNo: 'INV-1', total: 900 }]));
  jest.spyOn(Sale, 'aggregate').mockResolvedValue([
    { _id: null, totalSales: 900, totalProfit: 200, totalPaid: 900, totalDue: 0, count: 1 },
  ]);
  jest.spyOn(Expense, 'aggregate').mockResolvedValue([{ _id: null, total: 4500, count: 2 }]);
  // The day's other three books. Empty here — this suite is about the expense
  // ROWS and their permission; `dayBookAccounting.test.js` is what exercises
  // the money these carry.
  jest.spyOn(SalesReturn, 'aggregate').mockResolvedValue([]);
  jest.spyOn(Payment, 'aggregate').mockResolvedValue([]);
  jest.spyOn(Purchase, 'aggregate').mockResolvedValue([]);
  expenseFind = jest.spyOn(Expense, 'find').mockReturnValue(chain(EXPENSE_ROWS));
  jest.spyOn(User, 'findOne').mockReturnValue({
    select: () => ({ populate: () => ({ lean: () => Promise.resolve({ _id: 'u1', name: 'রফিক', isOwner: false }) }) }),
  });
});

afterEach(() => jest.restoreAllMocks());

describe('canViewExpenses', () => {
  it('lets an owner through without consulting permissions at all', () => {
    expect(canViewExpenses({ user: { isOwner: true } })).toBe(true);
  });

  it('lets the preset cashier through — they already hold expenses.view', () => {
    const cashier = ROLE_PRESETS.cashier.permissions;
    // The premise: this role can open the report AND read the expense ledger,
    // so attaching rows changes nothing for them.
    expect(cashier.reports.view).toBe(true);
    expect(cashier.expenses.view).toBe(true);
    expect(canViewExpenses({ user: { isOwner: false, permissions: cashier } })).toBe(true);
  });

  it('refuses a role holding reports.view but not expenses.view', () => {
    // The combination this gate exists for. Built by hand because no preset
    // ships it — an owner composing a custom role reaches it easily.
    const perms = { reports: { view: true }, expenses: { view: false } };
    expect(canViewExpenses({ user: { isOwner: false, permissions: perms } })).toBe(false);
  });

  it('refuses a request with no user rather than throwing', () => {
    expect(canViewExpenses(undefined)).toBe(false);
    expect(canViewExpenses({})).toBe(false);
  });
});

describe('getSalesByDate attaches expense rows only when asked', () => {
  it('omits them by default — an unaware caller cannot leak the ledger', async () => {
    const res = await reportService.getSalesByDate(SHOP, DATE);
    expect(res.expenses).toBeNull();
    expect(expenseFind).not.toHaveBeenCalled();
    // The TOTAL is unaffected: it was always part of this payload and is gated
    // at the route, not here.
    expect(res.summary.totalExpenses).toBe(4500);
    expect(res.summary.expenseCount).toBe(2);
  });

  it('returns the rows when includeExpenses is true', async () => {
    const res = await reportService.getSalesByDate(SHOP, DATE, null, { includeExpenses: true });
    expect(res.expenses).toHaveLength(2);
    expect(res.expenses[0].categoryName).toBe('দোকান ভাড়া');
    // The rows must add up to the total beside them, or the page shows a
    // itemisation that visibly fails to reconcile.
    const summed = res.expenses.reduce((acc, e) => acc + e.amount, 0);
    expect(summed).toBe(res.summary.totalExpenses);
  });

  it('scopes the row query to the same shop, branch and BD day as the total', async () => {
    const branch = new mongoose.Types.ObjectId().toString();
    await reportService.getSalesByDate(SHOP, DATE, branch, { includeExpenses: true });

    const rowQuery = expenseFind.mock.calls[0][0];
    const totalMatch = Expense.aggregate.mock.calls[0][0][0].$match;

    expect(String(rowQuery.shop)).toBe(String(totalMatch.shop));
    expect(String(rowQuery.branch)).toBe(String(totalMatch.branch));
    expect(rowQuery.date.$gte.toISOString()).toBe(totalMatch.date.$gte.toISOString());
    expect(rowQuery.date.$lte.toISOString()).toBe(totalMatch.date.$lte.toISOString());
    // 8 August in Dhaka starts at 18:00 UTC on the 7th.
    expect(rowQuery.date.$gte.toISOString()).toBe('2026-08-07T18:00:00.000Z');
  });

  it('never attaches rows to a staff-scoped day, even when asked', async () => {
    // A staff day already zeroes the expense TOTAL — an expense belongs to the
    // shop, not to whoever was at the till. Rows would reintroduce exactly the
    // attribution the total refuses to make.
    const staffId = new mongoose.Types.ObjectId().toString();
    const res = await reportService.getSalesByDate(SHOP, DATE, null, {
      staffId,
      includeExpenses: true,
    });
    expect(res.expenses).toBeNull();
    expect(res.summary.totalExpenses).toBe(0);
    expect(expenseFind).not.toHaveBeenCalled();
  });
});
