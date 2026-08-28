/**
 * A return is subtracted from profit ONCE — and on the day it happened.
 *
 * ── Why this test exists ─────────────────────────────────────────────────────
 *
 * Two comments in `report.service.js` once described this arithmetic wrongly,
 * in opposite directions, and both sat directly on money expressions:
 *
 *   getDigestTotals  "revenue is net of returns while profit is not"
 *   getProfitLoss    "Net profit = Sales profit - Expenses - Returns profit loss"
 *
 * Neither described the code. Either edit made in good faith on the strength of
 * them would have double-counted every return on the platform, showing up as
 * profit quietly drifting below reality on exactly the shops that do the most
 * returns. This file is the part that cannot go stale.
 *
 * ── What changed, and why the arithmetic still lands in the same place ───────
 *
 * `salesReturn.service.createReturn` writes both halves of a return back onto
 * the ORIGINAL Sale:
 *
 *     returnedAmount += refundAmount      → netSaleAmountExpr() nets revenue
 *     profit         -= profitReduction   → $sum:'$profit' is ALREADY net
 *
 * The reports used to read those fields directly, which made them net for free
 * — and made every past period restate itself, because the fields being read
 * belong to the invoice, not to the period. A return raised in October reached
 * back and reduced August. August's statement was a different document every
 * time it was opened.
 *
 * So the P&L now reads GROSS (`grossProfitExpr` un-nets it via the
 * `returnedProfit` accumulator) and subtracts the period's own returns once,
 * itself. Within a period holding both the sale and the return, the two
 * approaches give the SAME net profit — the first test below pins that, because
 * a change of basis that moved the answer would be a bug, not a fix. They part
 * company only at a period boundary, which is the whole point and is what the
 * boundary tests at the bottom describe.
 *
 * ── The rule that survives all of it ─────────────────────────────────────────
 *
 * Which profit figure you are holding decides whether subtracting
 * `SalesReturn.profitReduction` is right:
 *
 *     against `$profit`            → double-counts. Never.
 *     against `grossProfitExpr()`  → correct, and required.
 *
 * They are not interchangeable. Check which one you have before you touch it.
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

// One sale of 1,000 taka at 200 profit; 400 of it returned at 80 profit lost.
//
// The aggregation now reports the sale AS INVOICED, so these are the gross
// figures — what the invoice said on the day it was written, which is what
// `grossSaleAmountExpr` and `grossProfitExpr` reconstruct.
const REVENUE_GROSS = 1000;
const PROFIT_GROSS = 200;
const RETURN_AMOUNT = 400;
const RETURN_PROFIT_LOSS = 80;
const EXPENSES = 50;

/** What the same period used to report when it read the netted Sale fields. */
const REVENUE_NET_OLD = REVENUE_GROSS - RETURN_AMOUNT; // 600
const PROFIT_NET_OLD = PROFIT_GROSS - RETURN_PROFIT_LOSS; // 120

/**
 * @param {number} returnAmount      what came back in this period
 * @param {number} returnProfitLoss  the profit that came back with it
 */
function stubPeriod({ returnAmount = RETURN_AMOUNT, returnProfitLoss = RETURN_PROFIT_LOSS } = {}) {
  jest.spyOn(cacheService, 'get').mockResolvedValue(null);
  jest.spyOn(cacheService, 'set').mockResolvedValue(undefined);
  jest.spyOn(cacheService, 'getShopCacheVersion').mockResolvedValue(1);

  // `getProfitLoss` fires its aggregations eagerly into a Promise.all, so the
  // Nth call on each model is deterministic.
  jest
    .spyOn(Sale, 'aggregate')
    .mockResolvedValueOnce([
      {
        totalRevenue: REVENUE_GROSS,
        totalProfit: PROFIT_GROSS,
        totalPaid: REVENUE_GROSS,
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
    { totalReturns: returnAmount, totalProfitLoss: returnProfitLoss, count: returnAmount ? 1 : 0 },
  ]);

  // No transfers: the shop in this fixture has no fund accounts, so the MFS /
  // bank charge line is 0 and `netProfit` is unchanged — which is exactly what
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
}

afterEach(() => jest.restoreAllMocks());

describe('getProfitLoss — the return is netted once', () => {
  it('lands on the same net profit the old netted basis produced', async () => {
    stubPeriod();
    const result = await reportService.getProfitLoss(SHOP, {});

    // 200 gross − 80 returned − 50 expenses = 70.
    expect(result.netProfit).toBe(70);
    // And that is exactly what the previous basis gave for the same period:
    // 120 already-net − 50 expenses. Changing WHEN a return is recognised must
    // not change the total for a period that contains the whole story.
    expect(result.netProfit).toBe(PROFIT_NET_OLD - EXPENSES);
  });

  it('does not subtract the return twice', async () => {
    stubPeriod();
    const result = await reportService.getProfitLoss(SHOP, {});

    // The failure this file exists for. Subtracting `profitReduction` from an
    // already-net profit would give 40 — the 80 counted a second time.
    expect(result.netProfit).not.toBe(PROFIT_NET_OLD - EXPENSES - RETURN_PROFIT_LOSS);
    expect(result.netProfit).toBe(PROFIT_GROSS - RETURN_PROFIT_LOSS - EXPENSES);
  });

  it('still reports returnsLoss, because an owner cannot read it off a net figure', async () => {
    stubPeriod();
    const result = await reportService.getProfitLoss(SHOP, {});

    expect(result.returnsLoss).toBe(RETURN_PROFIT_LOSS);
    expect(result.returns.profitLoss).toBe(RETURN_PROFIT_LOSS);
  });

  it('reports gross profit gross, and keeps the COGS identity intact', async () => {
    stubPeriod();
    const result = await reportService.getProfitLoss(SHOP, {});

    expect(result.grossProfit).toBe(PROFIT_GROSS);
    // `cogs` is DERIVED as merchandiseRevenue − grossProfit, and that identity
    // is what `Sale.pre('save')` computes per invoice. Both sides moved to
    // gross together, so it still ties out — this is why `revenue` stays gross
    // and `netRevenue` is reported beside it rather than replacing it.
    expect(result.revenue).toBe(REVENUE_GROSS);
    expect(result.cogs).toBe(REVENUE_GROSS - PROFIT_GROSS);
    expect(result.merchandiseRevenue - result.cogs).toBe(result.grossProfit);
  });

  it('reports net sales as the line an owner actually reads', async () => {
    stubPeriod();
    const result = await reportService.getProfitLoss(SHOP, {});

    // Gross sales, less what came back — the "net sales" line of an ordinary
    // statement, and the same figure the old basis put in `revenue`.
    expect(result.netRevenue).toBe(REVENUE_NET_OLD);
    expect(result.netRevenue).toBe(REVENUE_GROSS - RETURN_AMOUNT);
  });
});

describe('a closed period does not restate itself', () => {
  it('reports the sale in full in a period whose returns had not happened yet', async () => {
    // August, as August saw it: the sale is in, the October return is not.
    // Under the old basis this period would have quietly dropped to 120/600 the
    // moment that return was raised, months after the books were read.
    stubPeriod({ returnAmount: 0, returnProfitLoss: 0 });
    const result = await reportService.getProfitLoss(SHOP, {});

    expect(result.grossProfit).toBe(PROFIT_GROSS);
    expect(result.netRevenue).toBe(REVENUE_GROSS);
    expect(result.netProfit).toBe(PROFIT_GROSS - EXPENSES);
  });

  it('takes the whole hit in the period the goods actually came back', async () => {
    // October, which had no sales of its own — only the return. The loss lands
    // here, once, instead of reaching backwards into August.
    jest.spyOn(cacheService, 'get').mockResolvedValue(null);
    jest.spyOn(cacheService, 'set').mockResolvedValue(undefined);
    jest.spyOn(cacheService, 'getShopCacheVersion').mockResolvedValue(1);
    jest.spyOn(Sale, 'aggregate').mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    jest.spyOn(Expense, 'aggregate')
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    jest.spyOn(SalesReturn, 'aggregate').mockResolvedValue([
      { totalReturns: RETURN_AMOUNT, totalProfitLoss: RETURN_PROFIT_LOSS, count: 1 },
    ]);
    jest.spyOn(AccountTransfer, 'aggregate').mockResolvedValue([]);
    jest.spyOn(Purchase, 'aggregate').mockResolvedValue([]);
    jest.spyOn(StockTransaction, 'aggregate').mockResolvedValue([]);

    const result = await reportService.getProfitLoss(SHOP, {});

    expect(result.grossProfit).toBe(0);
    expect(result.returnsLoss).toBe(RETURN_PROFIT_LOSS);
    expect(result.netProfit).toBe(-RETURN_PROFIT_LOSS);
    expect(result.netRevenue).toBe(-RETURN_AMOUNT);
  });
});

describe('the writeback that makes the above possible', () => {
  it('Sale carries returnedAmount, returnedProfit and profit as stored fields', () => {
    // If any of these stops being stored — moved to a lookup, made virtual —
    // every aggregation quoted in this file changes meaning silently, because
    // $sum over a virtual is $sum over nothing. `returnedProfit` matters most:
    // it is the accumulator `grossProfitExpr` adds back to recover the invoice
    // as written, and without it there is no way to un-net a restated profit.
    expect(Sale.schema.path('returnedAmount')).toBeDefined();
    expect(Sale.schema.path('returnedProfit')).toBeDefined();
    expect(Sale.schema.path('profit')).toBeDefined();
  });

  it('SalesReturn keeps profitReduction, now a term in netProfit and not just a line', () => {
    expect(SalesReturn.schema.path('profitReduction')).toBeDefined();
  });
});
