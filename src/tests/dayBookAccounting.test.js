/**
 * The day-book: a closed day must stay closed, and profit is not cash.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO DEFECTS THESE PIN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **1. A day's figures used to change after the day ended.**
 *
 * A return rewrites the ORIGINAL sale — `returnedAmount` up, `profit` down, in
 * place, on an invoice from three weeks ago. Every report built on
 * `netSaleAmountExpr` or a bare `$profit` therefore restated August the moment
 * a customer walked in during October. Worse, a return that emptied an invoice
 * CANCELLED it, and the standard `status: { $ne: 'cancelled' }` filter then
 * dropped that sale out of its own day entirely — August silently lost a whole
 * invoice and an order off its count.
 *
 * The return was then ALSO reported on the day it arrived. So every return was
 * counted twice across the book: once as a silent reduction on the sale's day,
 * once as a returns line on the return's day.
 *
 * This was documented in `getDigestTotals` as "a deliberate accounting choice,
 * not drift". It is not a choice a book can make. A closed day that moves is
 * not a record of anything, and no period whose figures change after it ends
 * can be reconciled against cash, stock or a bank statement.
 *
 * **2. "আসল আয়" — literally "real income" — was profit, not money.**
 *
 * `netEarnings = profit − expenses` books profit when the INVOICE is written,
 * including a fully-বাকি sale where nothing was handed over, while expenses are
 * money that has actually left. A day of 50,000 taka of credit sales and 5,000
 * of rent read as solidly positive while the drawer went 5,000 backwards. For a
 * shopkeeper whose daily question is "how much money is left today?", that is
 * the wrong number under a name that promises the right one.
 *
 * Both books are now reported: `netProfit` (what the day earned) and `netCash`
 * (what the day took). They are different numbers and are supposed to be.
 */
const mongoose = require('mongoose');
const Sale = require('../models/Sale.model');
const Expense = require('../models/Expense.model');
const Payment = require('../models/Payment.model');
const Purchase = require('../models/Purchase.model');
const SalesReturn = require('../models/SalesReturn.model');
const User = require('../models/User.model');
const reportService = require('../services/report.service');

jest.mock('../services/cache.service', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  getShopCacheVersion: jest.fn().mockResolvedValue(1),
  bumpShopCacheVersion: jest.fn().mockResolvedValue(undefined),
}));

const SHOP = new mongoose.Types.ObjectId().toString();
const DATE = '2026-08-08';

/** `Sale.find(...).populate().populate().sort().lean()`. */
function chain(result) {
  const link = { populate: () => link, sort: () => link, lean: () => Promise.resolve(result) };
  return link;
}

/**
 * Wire one day. Every figure defaults to zero so each test names only what it
 * is about — a test that says nothing about purchases is asserting that
 * purchases do not silently move its numbers.
 */
function stubDay({
  sales = 0, profit = 0, paid = 0, due = 0, orders = 0,
  expenses = 0, expenseCount = 0,
  returned = 0, returnedProfit = 0, cashRefund = 0, returnCount = 0,
  collected = 0, collectionCount = 0,
  purchasePaid = 0, purchaseCount = 0,
} = {}) {
  jest.spyOn(Sale, 'find').mockReturnValue(chain([]));
  jest.spyOn(Sale, 'aggregate').mockResolvedValue(
    orders || sales
      ? [{ _id: null, totalSales: sales, totalProfit: profit, totalPaid: paid, totalDue: due, count: orders }]
      : []
  );
  jest.spyOn(Expense, 'aggregate').mockResolvedValue(
    expenses ? [{ _id: null, total: expenses, count: expenseCount }] : []
  );
  jest.spyOn(SalesReturn, 'aggregate').mockResolvedValue(
    returned
      ? [{ _id: null, returnAmount: returned, returnProfitLoss: returnedProfit, cashRefund, count: returnCount }]
      : []
  );
  jest.spyOn(Payment, 'aggregate').mockResolvedValue(
    collected ? [{ _id: null, collected, count: collectionCount }] : []
  );
  jest.spyOn(Purchase, 'aggregate').mockResolvedValue(
    purchasePaid ? [{ _id: null, purchasePaid, purchaseTotal: purchasePaid, count: purchaseCount }] : []
  );
  jest.spyOn(User, 'findOne').mockReturnValue({
    select: () => ({ populate: () => ({ lean: () => Promise.resolve(null) }) }),
  });
}

const day = (opts) => {
  stubDay(opts);
  return reportService.getSalesByDate(SHOP, DATE);
};

afterEach(() => jest.restoreAllMocks());

describe('the day names its sales gross, and its returns separately', () => {
  it('reports the bill as written, not as later reduced', async () => {
    const res = await day({ sales: 50000, profit: 12000, paid: 50000, orders: 20 });
    expect(res.summary.totalSales).toBe(50000);
    expect(res.summary.totalReturns).toBe(0);
    expect(res.summary.netSales).toBe(50000);
  });

  it('deducts returns ONCE, and only from netSales', async () => {
    const res = await day({
      sales: 50000, profit: 12000, paid: 50000, orders: 20,
      returned: 3000, returnedProfit: 700, returnCount: 1,
    });
    // Gross is untouched — this is what stops the same refund being taken off
    // here as well as on the day of the sale it came from.
    expect(res.summary.totalSales).toBe(50000);
    expect(res.summary.totalReturns).toBe(3000);
    expect(res.summary.netSales).toBe(47000);
  });

  it('subtracts the returns profit once, from a gross profit figure', async () => {
    // The trap the old digest comment warned about: subtracting
    // `profitReduction` from an already-net `$profit` double-counts. The
    // service un-nets first (`grossProfitExpr`), so this subtraction is the
    // one and only one.
    const res = await day({
      sales: 50000, profit: 12000, paid: 50000, orders: 20,
      returned: 3000, returnedProfit: 700, returnCount: 1,
      expenses: 2000, expenseCount: 3,
    });
    expect(res.summary.totalProfit).toBe(12000);
    expect(res.summary.returnsLoss).toBe(700);
    expect(res.summary.netProfit).toBe(12000 - 700 - 2000);
  });

  it('keeps the average basket on gross, not on another day s return', async () => {
    // Returns land here from invoices written on other days. Dividing a
    // returns-reduced figure by THIS day's order count would understate the
    // basket of a day that simply happened to receive a return.
    const res = await day({
      sales: 50000, profit: 12000, paid: 50000, orders: 20, returned: 10000, returnCount: 1,
    });
    expect(res.summary.averageOrderValue).toBe(2500);
  });
});

describe('profit and cash are two numbers', () => {
  it('separates a credit-sale day: earned well, took nothing', async () => {
    // The exact case that made the old label a lie: everything sold on credit,
    // rent paid in cash.
    const res = await day({
      sales: 50000, profit: 12000, paid: 0, due: 50000, orders: 20,
      expenses: 5000, expenseCount: 1,
    });
    expect(res.summary.netProfit).toBe(7000);      // earned
    expect(res.summary.cashIn).toBe(0);            // took nothing
    expect(res.summary.cashOut).toBe(5000);
    expect(res.summary.netCash).toBe(-5000);       // drawer went backwards
  });

  it('counts due collections as cash in — money this report could not see', async () => {
    const res = await day({ collected: 8000, collectionCount: 2 });
    expect(res.summary.collected).toBe(8000);
    expect(res.summary.cashIn).toBe(8000);
    // Collecting an old due earns nothing: the profit was booked on the day the
    // invoice was written. A day of pure collection is cash, not performance.
    expect(res.summary.netProfit).toBe(0);
  });

  it('counts supplier payments as cash out', async () => {
    const res = await day({ purchasePaid: 30000, purchaseCount: 2 });
    expect(res.summary.purchasePaid).toBe(30000);
    expect(res.summary.cashOut).toBe(30000);
    expect(res.summary.netCash).toBe(-30000);
    // Buying stock is not an expense — it is inventory. It must not touch
    // profit, or every restocking day reports a loss.
    expect(res.summary.netProfit).toBe(0);
  });

  it('counts only a settled cash refund as money leaving', async () => {
    // A 5,000 return of which only 2,000 was handed back in cash; the rest was
    // an adjustment against the customer's ledger, which moves no money.
    const res = await day({
      returned: 5000, returnedProfit: 1200, cashRefund: 2000, returnCount: 2,
    });
    expect(res.summary.cashOut).toBe(2000);
    // The full 5,000 still comes off the day's sales performance.
    expect(res.summary.netSales).toBe(-5000);
    expect(res.summary.netProfit).toBe(-1200);
  });

  it('adds the cash legs up exactly', async () => {
    const res = await day({
      sales: 40000, profit: 9000, paid: 25000, due: 15000, orders: 11,
      expenses: 3000, expenseCount: 2,
      returned: 1000, returnedProfit: 250, cashRefund: 1000, returnCount: 1,
      collected: 6000, collectionCount: 3,
      purchasePaid: 12000, purchaseCount: 1,
    });
    expect(res.summary.cashIn).toBe(25000 + 6000);
    expect(res.summary.cashOut).toBe(3000 + 12000 + 1000);
    expect(res.summary.netCash).toBe(31000 - 16000);
    expect(res.summary.netProfit).toBe(9000 - 250 - 3000);
    // The two books answer different questions and must not be equal here — if
    // they ever are for these inputs, one of them stopped being computed.
    expect(res.summary.netCash).not.toBe(res.summary.netProfit);
  });
});

describe('a staff-scoped day reports no shop money at all', () => {
  it('zeroes every shop-level book, not just expenses', async () => {
    // Rent, a supplier payment and a customer's old due belong to the shop,
    // not to whoever was standing at the till. Attributing them to one employee
    // makes their day's figures mean nothing.
    stubDay({
      sales: 5000, profit: 1200, paid: 5000, orders: 3,
      expenses: 900, returned: 400, collected: 700, purchasePaid: 2000,
    });
    jest.spyOn(User, 'findOne').mockReturnValue({
      select: () => ({ populate: () => ({ lean: () => Promise.resolve({ _id: 'u1', name: 'Rafiq' }) }) }),
    });

    const res = await reportService.getSalesByDate(SHOP, DATE, null, {
      staffId: new mongoose.Types.ObjectId().toString(),
      includeExpenses: true,
    });

    expect(res.summary.totalExpenses).toBe(0);
    expect(res.summary.totalReturns).toBe(0);
    expect(res.summary.collected).toBe(0);
    expect(res.summary.purchasePaid).toBe(0);
    expect(res.summary.cashOut).toBe(0);
    expect(res.expenses).toBeNull();
    // Their SALES still count — that is the whole point of the staff view.
    expect(res.summary.totalSales).toBe(5000);
  });
});

describe('the expressions that make a day stable', () => {
  const fs = require('fs');
  const path = require('path');
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'report.service.js'), 'utf8'
  );

  it('reconstructs as-invoiced profit from the accumulator pair', () => {
    // `profit` is stored net and `returnedProfit` accumulates what was taken
    // off, in the same update — so their sum is invariant under any number of
    // returns and needs no new field and no backfill.
    expect(body).toContain("$add: ['$profit', { $ifNull: ['$returnedProfit', 0] }]");
  });

  it('keeps a sale that a return later cancelled on its own day', () => {
    // `returnedAmount > 0` is what separates "cancelled BY a return" from a
    // genuine void. Without it, a fully-returned invoice vanishes from the day
    // it was written and the day loses an order it really made.
    expect(body).toContain("{ status: 'cancelled', returnedAmount: { $gt: 0 } }");
  });

  it('does not net returns twice in the day-book paths', () => {
    // `netSaleAmountExpr` still exists and is still correct for "what is this
    // invoice worth now". It must not appear in a day-book aggregation, where
    // the day's own returns are already deducted separately.
    const dayBook = body.slice(body.indexOf('async getDateWiseSummary'));
    const monthAndDay = dayBook.slice(0, dayBook.indexOf('async getTrendingProducts'));
    expect(monthAndDay).not.toContain('netSaleAmountExpr()');
  });
});
