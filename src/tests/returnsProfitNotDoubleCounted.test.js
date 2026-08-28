/**
 * A return is subtracted from profit ONCE.
 *
 * ── Why this test exists ─────────────────────────────────────────────────────
 *
 * Not because the code was wrong — it is right — but because two comments in
 * `report.service.js` said it was wrong, in opposite directions, and both sat
 * directly on money expressions:
 *
 *   getDigestTotals  "revenue is net of returns while profit is not"
 *   getProfitLoss    "Net profit = Sales profit - Expenses - Returns profit loss"
 *
 * Neither described the code. The first invites someone to subtract
 * `SalesReturn.profitReduction` from the dashboard; the second says the P&L
 * already does, which would make adding it "restoring" a line that was never
 * there. Either edit double-counts every return on the platform, and it would
 * show up as profit quietly drifting below reality on exactly the shops that do
 * the most returns.
 *
 * The comments are fixed. This is the part that cannot go stale.
 *
 * ── The invariant ────────────────────────────────────────────────────────────
 *
 * `salesReturn.service.createReturn` writes both halves of a return back onto
 * the original Sale document:
 *
 *     returnedAmount += refundAmount      → netSaleAmountExpr() nets revenue
 *     profit         -= profitReduction   → $sum:'$profit' is ALREADY net
 *
 * so every downstream reader of `Sale.profit` gets a net figure, and nothing
 * downstream may subtract `SalesReturn.profitReduction` a second time.
 */

const mongoose = require('mongoose');
const Sale = require('../models/Sale.model');
const Expense = require('../models/Expense.model');
const SalesReturn = require('../models/SalesReturn.model');
const Purchase = require('../models/Purchase.model');
const AccountTransfer = require('../models/AccountTransfer.model');
const StockTransaction = require('../models/StockTransaction.model');
const cacheService = require('../services/cache.service');
const reportService = require('../services/report.service');

const SHOP = new mongoose.Types.ObjectId().toString();

// One sale of ৳1,000 at ৳200 profit, ৳400 of it returned at ৳80 profit lost —
// with createReturn's writeback already applied, which is the state any report
// reads.
const REVENUE_NET = 600; // 1000 - 400
const PROFIT_NET = 120; //  200 -  80
const RETURN_PROFIT_LOSS = 80;
const EXPENSES = 50;

beforeEach(() => {
  // The cache is checked before anything is computed; a hit would return a
  // frozen object and the assertions below would be testing nothing.
  jest.spyOn(cacheService, 'get').mockResolvedValue(null);
  jest.spyOn(cacheService, 'set').mockResolvedValue(undefined);
  jest.spyOn(cacheService, 'getShopCacheVersion').mockResolvedValue(1);

  // `getProfitLoss` fires its aggregations eagerly into a Promise.all, so the
  // Nth call on each model is deterministic.
  jest
    .spyOn(Sale, 'aggregate')
    .mockResolvedValueOnce([
      {
        totalRevenue: REVENUE_NET,
        totalProfit: PROFIT_NET,
        totalPaid: REVENUE_NET,
        totalDue: 0,
        totalDiscount: 0,
        count: 1,
      },
    ])
    .mockResolvedValueOnce([]); // dailySales — the chart, not under test

  jest
    .spyOn(Expense, 'aggregate')
    .mockResolvedValueOnce([{ totalExpenses: EXPENSES, count: 1 }])
    .mockResolvedValueOnce([]) // byCategory
    .mockResolvedValueOnce([]); // dailyExpenses

  jest.spyOn(SalesReturn, 'aggregate').mockResolvedValue([
    { totalReturns: 400, totalProfitLoss: RETURN_PROFIT_LOSS, count: 1 },
  ]);

  // No transfers: the shop in this fixture has no fund accounts, so the MFS /
  // bank charge line is ৳0 and `netProfit` is unchanged — which is exactly what
  // these tests assert about it.
  jest.spyOn(AccountTransfer, 'aggregate').mockResolvedValue([]);
  jest.spyOn(Purchase, 'aggregate').mockResolvedValue([
    { totalPurchases: 0, totalPaid: 0, totalDue: 0, count: 0 },
  ]);

  // No write-offs either, for the same reason: this fixture is about RETURNS,
  // and a ক্ষতি row would move `netProfit` by a term these assertions are not
  // describing. Stubbed rather than left alone because `getProfitLoss` queries
  // the stock ledger unconditionally — an unmocked model here reaches for a
  // database that is not there and the suite hangs to its timeout rather than
  // failing with anything readable.
  jest.spyOn(StockTransaction, 'aggregate').mockResolvedValue([]);
});

afterEach(() => jest.restoreAllMocks());

describe('getProfitLoss — returns are netted once, not twice', () => {
  it('does not subtract returnsLoss from netProfit', async () => {
    const result = await reportService.getProfitLoss(SHOP, {});

    // The whole point. Were returnsLoss subtracted again this would be 70 — the
    // ৳80 the shop lost on the return counted a second time.
    expect(result.netProfit).toBe(PROFIT_NET - EXPENSES);
    expect(result.netProfit).toBe(70 + RETURN_PROFIT_LOSS - RETURN_PROFIT_LOSS);
    expect(result.netProfit).toBe(70);
  });

  it('still reports returnsLoss, because an owner cannot read it off a net figure', async () => {
    const result = await reportService.getProfitLoss(SHOP, {});

    expect(result.returnsLoss).toBe(RETURN_PROFIT_LOSS);
    expect(result.returns.profitLoss).toBe(RETURN_PROFIT_LOSS);
  });

  it('reports gross profit as the already-net Sale.profit sum', async () => {
    const result = await reportService.getProfitLoss(SHOP, {});

    expect(result.grossProfit).toBe(PROFIT_NET);
    // COGS is derived as revenue - profit, so it inherits the same netting and
    // must not be re-adjusted for returns either.
    expect(result.cogs).toBe(REVENUE_NET - PROFIT_NET);
  });
});

describe('the writeback that makes the above true', () => {
  it('Sale carries both a returnedAmount and a profit field for reports to read', () => {
    // If either of these ever stops being a stored field on Sale — moved to a
    // lookup, made virtual — every aggregation quoted in this file changes
    // meaning silently, because $sum over a virtual is $sum over nothing.
    expect(Sale.schema.path('returnedAmount')).toBeDefined();
    expect(Sale.schema.path('profit')).toBeDefined();
  });

  it('SalesReturn keeps profitReduction, which is reporting-only downstream', () => {
    expect(SalesReturn.schema.path('profitReduction')).toBeDefined();
  });
});
