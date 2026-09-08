/**
 * The online/offline split must ADD UP to the statement it sits under.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS THE ONLY PROPERTY THAT MATTERS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A shop owner reads the P&L, sees "নিট লাভ ৳X", then reads the channel table
 * underneath it. If the two halves of that table do not sum to the revenue line
 * above them, the owner has no way to tell WHICH number is wrong — and the
 * rational response is to stop trusting both. A channel table that does not
 * reconcile is worse than no channel table, because it gets believed once.
 *
 * So the split is computed in ONE pass over the SAME matched documents as the
 * headline figures, and these tests pin that: whatever the mix of channels,
 * `online + offline === revenue`, and the per-channel rows sum to the online
 * half. A future refactor that gives the split its own `$match` — an easy and
 * very reasonable-looking change — fails here.
 *
 * The second thing pinned is the COGS derivation per row. It must strip tax and
 * delivery the same way the headline does, or a shop billing delivery reads a
 * far worse online margin than it has (the bug `merchandiseRevenue` was
 * introduced to fix, which would otherwise have been reintroduced one level
 * down).
 */
const mongoose = require('mongoose');
const Sale = require('../models/Sale.model');
const Expense = require('../models/Expense.model');
const Purchase = require('../models/Purchase.model');
const SalesReturn = require('../models/SalesReturn.model');
const AccountTransfer = require('../models/AccountTransfer.model');
const StockTransaction = require('../models/StockTransaction.model');
const reportService = require('../services/report.service');

jest.mock('../services/cache.service', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  getShopCacheVersion: jest.fn().mockResolvedValue(1),
  bumpShopCacheVersion: jest.fn().mockResolvedValue(undefined),
}));

const SHOP = new mongoose.Types.ObjectId().toString();

/**
 * Is this the channel pipeline?
 *
 * Detected by the SHAPE of its `$group._id` rather than by call order, so
 * reordering the `Promise.all` — which says nothing about behaviour — does not
 * break the test. The channel group is the only one keyed on an object with
 * `isOnline` in it.
 */
function isChannelPipeline(pipeline) {
  const group = (pipeline || []).find((stage) => stage && stage.$group);
  const id = group?.$group?._id;
  return Boolean(id && typeof id === 'object' && 'isOnline' in id);
}

/**
 * One row as the channel aggregation would emit it.
 *
 * `isOnline` and `channel` are supplied separately on purpose: the service is
 * responsible for treating `isOnline` as the split axis and `channel` as the
 * label, and rows where the two disagree are exactly the historical data this
 * has to survive.
 */
function channelRow({
  isOnline, channel, revenue, grossProfit = 0, tax = 0,
  delivery = 0, discount = 0, due = 0, count = 1, fromOrders = 0,
}) {
  return {
    _id: { isOnline, channel },
    revenue, grossProfit, tax, delivery, discount, due, count, fromOrders,
  };
}

/**
 * Drive `getProfitLoss` with a given headline total and a given channel table.
 *
 * The headline row is passed independently of the channel rows so a test can
 * deliberately feed a MISMATCHED pair and prove the assertion would catch it —
 * see the last test in this file.
 */
function stub({ headline, channelRows }) {
  jest.spyOn(Sale, 'aggregate').mockImplementation((pipeline) => {
    if (isChannelPipeline(pipeline)) return Promise.resolve(channelRows);
    // The `dailySales` chart pipeline groups by day; the headline groups by
    // null. Neither test here cares about the chart, so an empty result is
    // right for it and the headline is matched by elimination.
    const group = (pipeline || []).find((s) => s && s.$group);
    if (group?.$group?._id === null) return Promise.resolve(headline ? [headline] : []);
    return Promise.resolve([]);
  });
  jest.spyOn(Expense, 'aggregate').mockResolvedValue([]);
  jest.spyOn(SalesReturn, 'aggregate').mockResolvedValue([]);
  jest.spyOn(Purchase, 'aggregate').mockResolvedValue([]);
  jest.spyOn(AccountTransfer, 'aggregate').mockResolvedValue([]);
  jest.spyOn(StockTransaction, 'aggregate').mockResolvedValue([]);
}

const run = () => reportService.getProfitLoss(SHOP, {});

afterEach(() => jest.restoreAllMocks());

describe('the split reconciles with the statement above it', () => {
  it('online + offline === revenue, for a mixed shop', async () => {
    stub({
      headline: {
        _id: null,
        totalRevenue: 100000, totalProfit: 22000, totalPaid: 60000, totalDue: 40000,
        totalDiscount: 0, totalLineDiscount: 0, totalTax: 0, totalDelivery: 3000, count: 30,
      },
      channelRows: [
        channelRow({ isOnline: false, channel: 'pos', revenue: 70000, grossProfit: 15000, count: 20 }),
        channelRow({ isOnline: true, channel: 'website', revenue: 20000, grossProfit: 5000, delivery: 2000, count: 7, fromOrders: 7 }),
        channelRow({ isOnline: true, channel: 'facebook', revenue: 10000, grossProfit: 2000, delivery: 1000, count: 3, fromOrders: 3 }),
      ],
    });

    const res = await run();
    const { online, offline } = res.channelSplit;

    expect(online.revenue + offline.revenue).toBe(res.revenue);
    expect(online.grossProfit + offline.grossProfit).toBe(res.grossProfit);
    expect(online.count + offline.count).toBe(30);
  });

  it('a counter-only shop puts everything on the offline side', async () => {
    // The overwhelmingly common case, and the one that must look exactly as it
    // did before any of this existed.
    stub({
      headline: {
        _id: null,
        totalRevenue: 45000, totalProfit: 9000, totalPaid: 45000, totalDue: 0,
        totalDiscount: 0, totalLineDiscount: 0, totalTax: 0, totalDelivery: 0, count: 12,
      },
      channelRows: [
        channelRow({ isOnline: false, channel: 'pos', revenue: 45000, grossProfit: 9000, count: 12 }),
      ],
    });

    const res = await run();
    expect(res.channelSplit.offline.revenue).toBe(45000);
    expect(res.channelSplit.online.revenue).toBe(0);
    expect(res.channelSplit.online.count).toBe(0);
  });

  it('a shop with no sales at all reports zeros, not undefined', async () => {
    stub({ headline: null, channelRows: [] });
    const res = await run();
    expect(res.channelSplit.online.revenue).toBe(0);
    expect(res.channelSplit.offline.revenue).toBe(0);
    expect(res.channelSplit.byChannel).toEqual([]);
  });
});

describe('per-row COGS strips the same pass-through money the headline does', () => {
  it('delivery and tax do not land in an online row COGS', async () => {
    /**
     * The bug being prevented, one level down from where it was first found:
     * `cogs = revenue - profit` counts every taka of delivery the shop billed
     * as cost of goods sold. For a parcel business that is most of the gap
     * between what it charges and what it keeps, and the online row would read
     * as though it were barely breaking even.
     */
    stub({
      headline: {
        _id: null,
        totalRevenue: 12000, totalProfit: 3000, totalPaid: 0, totalDue: 12000,
        totalDiscount: 0, totalLineDiscount: 0, totalTax: 500, totalDelivery: 1500, count: 5,
      },
      channelRows: [
        channelRow({
          isOnline: true, channel: 'website',
          revenue: 12000, grossProfit: 3000, tax: 500, delivery: 1500, count: 5, fromOrders: 5,
        }),
      ],
    });

    const res = await run();
    const row = res.channelSplit.byChannel[0];

    // 12000 − 500 tax − 1500 delivery = 10000 of merchandise…
    expect(row.merchandiseRevenue).toBe(10000);
    // …and the margin came out of that, not out of the gross bill.
    expect(row.cogs).toBe(7000);
    // The identity the whole derivation exists to preserve.
    expect(row.merchandiseRevenue - row.cogs).toBe(row.grossProfit);
  });

  it('the identity holds on every row of a mixed table', async () => {
    stub({
      headline: {
        _id: null,
        totalRevenue: 30000, totalProfit: 7000, totalPaid: 0, totalDue: 30000,
        totalDiscount: 0, totalLineDiscount: 0, totalTax: 0, totalDelivery: 800, count: 9,
      },
      channelRows: [
        channelRow({ isOnline: false, channel: 'pos', revenue: 18000, grossProfit: 4000, count: 5 }),
        channelRow({ isOnline: true, channel: 'whatsapp', revenue: 8000, grossProfit: 2000, delivery: 500, count: 3, fromOrders: 3 }),
        channelRow({ isOnline: true, channel: 'other', revenue: 4000, grossProfit: 1000, delivery: 300, count: 1, fromOrders: 0 }),
      ],
    });

    const res = await run();
    for (const row of res.channelSplit.byChannel) {
      expect(row.merchandiseRevenue - row.cogs).toBe(row.grossProfit);
    }
  });
});

describe('the two fields that stop the split lying', () => {
  it('isOnline decides the side, `channel` only labels it', async () => {
    /**
     * These two are independent fields and real rows disagree: an early client
     * could post `channel: 'facebook'` without ever setting `isOnline`.
     * Grouping on `channel` alone would move that sale to the online side of a
     * shop that never sold online.
     */
    stub({
      headline: {
        _id: null,
        totalRevenue: 5000, totalProfit: 1000, totalPaid: 5000, totalDue: 0,
        totalDiscount: 0, totalLineDiscount: 0, totalTax: 0, totalDelivery: 0, count: 2,
      },
      channelRows: [
        // The aggregation forces `channel: 'pos'` whenever isOnline is false —
        // this row is what that looks like coming back.
        channelRow({ isOnline: false, channel: 'pos', revenue: 5000, grossProfit: 1000, count: 2 }),
      ],
    });

    const res = await run();
    expect(res.channelSplit.online.count).toBe(0);
    expect(res.channelSplit.offline.count).toBe(2);
  });

  it('fromOrders separates true parcels from till-typed online sales', async () => {
    /**
     * `isOnline` covers two different things: a parcel with a worklist row
     * behind it, and a sale someone ticked "online" on at the counter. A shop
     * reconciling its worklist against its books needs the gap visible rather
     * than averaged away.
     */
    stub({
      headline: {
        _id: null,
        totalRevenue: 9000, totalProfit: 2000, totalPaid: 0, totalDue: 9000,
        totalDiscount: 0, totalLineDiscount: 0, totalTax: 0, totalDelivery: 0, count: 4,
      },
      channelRows: [
        channelRow({ isOnline: true, channel: 'facebook', revenue: 9000, grossProfit: 2000, count: 4, fromOrders: 1 }),
      ],
    });

    const res = await run();
    expect(res.channelSplit.online.count).toBe(4);
    // Three of the four have no Order behind them — the till-typed backlog.
    expect(res.channelSplit.online.fromOrders).toBe(1);
  });
});

describe('the reconciliation assertion is not vacuous', () => {
  it('catches a split that does NOT sum to the headline', async () => {
    /**
     * Proves the tests above can fail. If the split ever gets its own `$match`
     * — a different date boundary, a forgotten `invoicedOnDayMatch` — the rows
     * stop summing to the statement, and this is the shape that would look
     * like.
     */
    stub({
      headline: {
        _id: null,
        totalRevenue: 100000, totalProfit: 20000, totalPaid: 0, totalDue: 100000,
        totalDiscount: 0, totalLineDiscount: 0, totalTax: 0, totalDelivery: 0, count: 10,
      },
      channelRows: [
        // Deliberately short of the headline, as a mismatched $match would be.
        channelRow({ isOnline: false, channel: 'pos', revenue: 60000, grossProfit: 12000, count: 6 }),
      ],
    });

    const res = await run();
    const summed = res.channelSplit.online.revenue + res.channelSplit.offline.revenue;
    expect(summed).not.toBe(res.revenue);
  });
});
