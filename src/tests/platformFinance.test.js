/**
 * The platform's own books, pinned.
 *
 * Every rule here decides what the operator is told they earned. Each test is
 * a way of being wrong that would look perfectly plausible on the page: a
 * January renewal booked in December, a reversed advance still earning, a
 * pending payment counted as cash, an annual bill sinking one month.
 */

jest.mock('../utils/logger.util', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const PlatformPayment = require('../models/PlatformPayment.model');
const PlatformExpense = require('../models/PlatformExpense.model');
const billingService = require('../services/billing.service');
const finance = require('../services/platformFinance.service');
const { endOfBangladeshDay } = require('../utils/bdTime.util');

const {
  spreadMonthly, coverOf, earnedScheduleFor, expenseScheduleFor, buildLedger, parseBdDate,
} = finance;

const SHOP = '507f1f77bcf86cd799439011';
const ACTOR = { kind: 'admin', id: '507f1f77bcf86cd799439099', name: 'Ops' };

/** A Dhaka calendar date at noon — unambiguous in every timezone. */
const bd = (ymd) => parseBdDate(ymd, 'test');

function payment(overrides = {}) {
  return {
    _id: overrides._id || `p${Math.random().toString(16).slice(2, 10)}`,
    shop: SHOP,
    type: 'subscription',
    status: 'paid',
    reversalOf: null,
    ...overrides,
  };
}

/** Freeze "today" for getBangladeshTodayStr without faking timers Mongoose uses. */
function today(ymd) {
  jest.spyOn(Date, 'now').mockReturnValue(bd(ymd).getTime());
}

function withLedgers(payments, expenses = []) {
  jest.spyOn(PlatformPayment, 'find').mockReturnValue({
    select: () => ({ lean: async () => payments.filter((p) => p.status !== 'pending') }),
  });
  jest.spyOn(PlatformExpense, 'find').mockReturnValue({
    select: () => ({ lean: async () => expenses }),
  });
  jest.spyOn(billingService, 'getSummary').mockResolvedValue({
    mrr: 8000, activeShops: 10, trialShops: 0, arpu: 800, overdueShops: 1, overdueAmount: 800,
  });
}

afterEach(() => jest.restoreAllMocks());

describe('spreadMonthly', () => {
  test('shares always sum back to the amount, remainder on the last month', () => {
    const out = spreadMonthly(1000, '2026-11', 3);
    expect(out).toEqual([
      { month: '2026-11', amount: 333.33 },
      { month: '2026-12', amount: 333.33 },
      { month: '2027-01', amount: 333.34 },
    ]);
    expect(out.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(1000, 10);
  });

  test('crosses year boundaries and handles a single month', () => {
    expect(spreadMonthly(800, '2026-12', 1)).toEqual([{ month: '2026-12', amount: 800 }]);
    expect(spreadMonthly(2400, '2026-11', 3).map((x) => x.month)).toEqual(['2026-11', '2026-12', '2027-01']);
  });

  test('a negative amount (a reversal) spreads symmetrically', () => {
    expect(spreadMonthly(-1000, '2026-11', 3).map((x) => x.amount)).toEqual([-333.33, -333.33, -333.34]);
  });
});

describe('when a subscription payment is earned', () => {
  /**
   * The nudge. `periodStart` is the old expiry — the LAST instant of a day the
   * previous payment already bought. Read naively, a shop paid through
   * 31 December renewing for January has January's money booked in December.
   */
  test('a renewal starting from an old expiry on the 31st is January revenue, not December', () => {
    const cover = coverOf(payment({
      periodStart: endOfBangladeshDay('2026-12-31'),
      periodEnd: endOfBangladeshDay('2027-01-31'),
      months: 1,
    }));
    expect(cover).toEqual({ startKey: '2027-01', months: 1 });
  });

  test('an ordinary monthly payment is earned in the month it was received', () => {
    const p = payment({
      amount: 800,
      receivedAt: bd('2026-10-16'),
      periodStart: bd('2026-10-16'),
      periodEnd: endOfBangladeshDay('2026-11-16'),
      months: 1,
    });
    expect(earnedScheduleFor(p)).toEqual([{ month: '2026-10', amount: 800 }]);
  });

  test('six months paid in advance are earned one month at a time', () => {
    const p = payment({
      amount: 4800,
      receivedAt: bd('2026-10-05'),
      periodStart: endOfBangladeshDay('2026-10-31'),
      periodEnd: endOfBangladeshDay('2027-04-30'),
      months: 6,
    });
    const s = earnedScheduleFor(p);
    expect(s.map((x) => x.month)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04']);
    expect(s.every((x) => x.amount === 800)).toBe(true);
  });

  test('a row with no months field derives them from its period', () => {
    const p = payment({
      amount: 2400,
      receivedAt: bd('2026-01-10'),
      periodStart: bd('2026-01-10'),
      periodEnd: endOfBangladeshDay('2026-04-10'),
    });
    expect(earnedScheduleFor(p)).toHaveLength(3);
  });

  test('money that buys no period (SMS, setup) is earned the month it arrived', () => {
    const p = payment({ type: 'sms', amount: 500, receivedAt: bd('2026-09-30') });
    expect(earnedScheduleFor(p)).toEqual([{ month: '2026-09', amount: 500 }]);
  });
});

describe('the ledger', () => {
  const advance = payment({
    _id: 'adv',
    amount: 4800,
    receivedAt: bd('2026-10-05'),
    periodStart: endOfBangladeshDay('2026-10-31'),
    periodEnd: endOfBangladeshDay('2027-04-30'),
    months: 6,
  });

  test('a reversed advance nets to zero in every month it covered, while cash shows both movements', () => {
    const reversal = payment({
      _id: 'rev', amount: -4800, status: 'refunded', reversalOf: 'adv', receivedAt: bd('2026-12-02'),
    });
    const ledger = buildLedger({ payments: [advance, reversal] });

    for (const k of ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04']) {
      expect(ledger.get(k).earned).toBeCloseTo(0, 10);
    }
    expect(ledger.get('2026-10').cashIn).toBe(4800);
    expect(ledger.get('2026-12').cashIn).toBe(-4800);
  });

  test('a pending payment is not money yet', () => {
    const pending = payment({ type: 'sms', amount: 999, status: 'pending', receivedAt: bd('2026-10-05') });
    const ledger = buildLedger({ payments: [pending] });
    expect(ledger.size).toBe(0);
  });

  test('a waived ৳0 payment changes no figure', () => {
    const waived = payment({ amount: 0, status: 'waived', receivedAt: bd('2026-10-05') });
    const ledger = buildLedger({ payments: [waived] });
    expect(ledger.get('2026-10').earned).toBe(0);
    expect(ledger.get('2026-10').cashIn).toBe(0);
  });

  test('an annual bill is cost in each month it covers and cash in the month it was paid', () => {
    const server = { category: 'hosting', amount: 12000, paidAt: bd('2026-01-20'), coverageMonths: 12 };
    expect(expenseScheduleFor(server).every((x) => x.amount === 1000)).toBe(true);

    const ledger = buildLedger({ expenses: [server] });
    expect(ledger.get('2026-01').expensesPaid).toBe(12000);
    expect(ledger.get('2026-01').expensed).toBe(1000);
    expect(ledger.get('2026-12').expensed).toBe(1000);
    expect(ledger.get('2026-06').expensedByCategory.hosting).toBe(1000);
  });

  test('a renewal paid early starts costing from its coverage start, not its paid date', () => {
    const domain = {
      category: 'domain', amount: 1800, paidAt: bd('2026-10-25'), coverageStart: bd('2026-11-14'), coverageMonths: 12,
    };
    const s = expenseScheduleFor(domain);
    expect(s[0].month).toBe('2026-11');
    expect(s[11].month).toBe('2027-10');
  });
});

describe('getOverview', () => {
  test('collected = earned to date + advance held, and paid = expensed + prepaid — to the paisa', async () => {
    today('2026-12-15');
    withLedgers(
      [
        payment({
          amount: 4800, receivedAt: bd('2026-10-05'), months: 6,
          periodStart: endOfBangladeshDay('2026-10-31'), periodEnd: endOfBangladeshDay('2027-04-30'),
        }),
        payment({
          amount: 1000, receivedAt: bd('2026-11-03'), months: 3,
          periodStart: bd('2026-11-03'), periodEnd: endOfBangladeshDay('2027-02-03'),
        }),
        payment({ type: 'sms', amount: 300, receivedAt: bd('2026-12-01') }),
        payment({ type: 'sms', amount: 999, status: 'pending', receivedAt: bd('2026-12-01') }),
      ],
      [
        { category: 'hosting', amount: 12000, paidAt: bd('2026-07-01'), coverageMonths: 12 },
        { category: 'marketing', amount: 2500, paidAt: bd('2026-12-10'), coverageMonths: 1 },
      ]
    );

    const o = await finance.getOverview();
    const L = o.lifetime;

    expect(L.collected).toBe(6100);
    expect(L.earned + L.advanceHeld).toBeCloseTo(L.collected, 10);
    // Nov+Dec of the 6-month advance and Nov+Dec of the 3-month one, plus SMS.
    expect(L.earned).toBeCloseTo(800 * 2 + 333.33 * 2 + 300, 2);
    expect(L.advanceHeld).toBeCloseTo(800 * 4 + 333.34, 2);

    expect(L.paidOut).toBe(14500);
    expect(L.expensed + L.prepaidExpenses).toBeCloseTo(L.paidOut, 10);
    expect(L.expensed).toBe(1000 * 6 + 2500);

    expect(L.netProfit).toBeCloseTo(L.earned - L.expensed, 2);
    expect(o.thisMonth.month).toBe('2026-12');
    expect(o.months).toHaveLength(12);
    expect(o.months[11].month).toBe('2026-12');
    expect(o.subscription.arr).toBe(96000);
  });

  test('the range bounds the table, never the lifetime block', async () => {
    today('2026-12-15');
    withLedgers([payment({ type: 'setup', amount: 5000, receivedAt: bd('2025-03-01') })]);
    const o = await finance.getOverview({ from: '2026-10', to: '2026-12' });
    expect(o.months.map((m) => m.month)).toEqual(['2026-10', '2026-11', '2026-12']);
    expect(o.rangeTotals.earned).toBe(0);
    expect(o.lifetime.earned).toBe(5000);
    expect(o.lifetime.firstMonth).toBe('2025-03');
  });

  test('"all time" starts the table at the first month anything happened', async () => {
    today('2026-12-15');
    withLedgers([payment({ type: 'setup', amount: 5000, receivedAt: bd('2026-08-20') })]);
    const o = await finance.getOverview({ from: 'all' });
    expect(o.range).toEqual({ from: '2026-08', to: '2026-12' });
    expect(o.months).toHaveLength(5);
  });

  test('"all time" on an empty book is just this month', async () => {
    today('2026-12-15');
    withLedgers([]);
    const o = await finance.getOverview({ from: 'all' });
    expect(o.months.map((m) => m.month)).toEqual(['2026-12']);
  });

  test('a margin on zero revenue is reported as unknown, not 0%', async () => {
    today('2026-12-15');
    withLedgers([], [{ category: 'domain', amount: 1500, paidAt: bd('2026-12-02'), coverageMonths: 1 }]);
    const o = await finance.getOverview();
    expect(o.thisMonth.margin).toBeNull();
    expect(o.thisMonth.netProfit).toBe(-1500);
  });

  test('rejects a range that runs backwards', async () => {
    withLedgers([]);
    await expect(finance.getOverview({ from: '2026-12', to: '2026-01' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('getAdvances', () => {
  test('lists only shops still holding prepaid months, with the release schedule', async () => {
    today('2026-12-15');
    withLedgers([
      payment({
        _id: 'a', amount: 4800, receivedAt: bd('2026-10-05'), months: 6,
        periodStart: endOfBangladeshDay('2026-10-31'), periodEnd: endOfBangladeshDay('2027-04-30'),
      }),
      // A monthly payer: nothing held.
      payment({
        shop: '507f1f77bcf86cd799439012', amount: 800, receivedAt: bd('2026-12-01'), months: 1,
        periodStart: bd('2026-12-01'), periodEnd: endOfBangladeshDay('2027-01-01'),
      }),
    ]);
    const Shop = require('../models/Shop.model');
    jest.spyOn(Shop, 'find').mockReturnValue({
      select: () => ({ populate: () => ({ lean: async () => [{ _id: SHOP, name: 'রহিম স্টোর' }] }) }),
    });

    const a = await finance.getAdvances();
    expect(a.total).toBe(3200);
    expect(a.shops).toHaveLength(1);
    expect(a.shops[0]).toMatchObject({ held: 3200, monthsAhead: 4, coveredThrough: '2027-04', nextMonthRelease: 800 });
    expect(a.schedule.map((r) => r.month)).toEqual(['2027-01', '2027-02', '2027-03', '2027-04']);
  });
});

describe('the expense book', () => {
  beforeEach(() => {
    jest.spyOn(PlatformExpense, 'create').mockImplementation(async (doc) => doc);
  });

  test('records with the typed date at Dhaka noon, so the 1st stays in its own month', async () => {
    today('2026-10-16');
    const e = await finance.createExpense(ACTOR, {
      category: 'domain', title: 'hisaabbd.com renewal', amount: '1650.5', paidAt: '2026-10-01', coverageMonths: 12,
    });
    expect(require('../utils/bdTime.util').toBangladeshMonthStr(e.paidAt)).toBe('2026-10');
    expect(e.amount).toBe(1650.5);
    expect(e.coverageMonths).toBe(12);
    expect(e.method).toBe('cash');
    expect(e.recordedBy).toMatchObject({ name: 'Ops' });
  });

  test.each([
    ['a future date', { paidAt: '2026-10-17' }],
    ['a zero amount', { amount: 0 }],
    ['an unknown category', { category: 'coffee' }],
    ['no description', { title: '   ' }],
    ['fractional coverage', { coverageMonths: 1.5 }],
    ['coverage over 60 months', { coverageMonths: 61 }],
    ['an unknown method', { method: 'cheque' }],
  ])('refuses %s', async (_label, override) => {
    today('2026-10-16');
    await expect(finance.createExpense(ACTOR, {
      category: 'hosting', title: 'VPS', amount: 1200, paidAt: '2026-10-16', ...override,
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('the amount is never editable — that is a void and a re-entry', async () => {
    await expect(finance.amendExpense(ACTOR, SHOP, { amount: 1 })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('a correction is stamped with the old and new values', async () => {
    today('2026-10-16');
    const doc = {
      voidedAt: null, title: 'VPS', category: 'hosting', paidAt: bd('2026-10-02'), amendments: [],
      save: jest.fn().mockResolvedValue(true),
    };
    jest.spyOn(PlatformExpense, 'findById').mockResolvedValue(doc);

    await finance.amendExpense(ACTOR, SHOP, { title: 'VPS (Hostinger)', paidAt: '2026-10-02', reason: 'typo' });

    expect(doc.title).toBe('VPS (Hostinger)');
    expect(doc.amendments).toHaveLength(1);
    // The unchanged date is not reported as a change.
    expect(doc.amendments[0].after).toEqual({ title: 'VPS (Hostinger)' });
    expect(doc.amendments[0].before).toEqual({ title: 'VPS' });
    expect(doc.save).toHaveBeenCalled();
  });

  test('a void needs a reason', async () => {
    await expect(finance.voidExpense(ACTOR, SHOP, '  ')).rejects.toMatchObject({ statusCode: 400 });
  });

  test('voiding twice is refused rather than overwriting the first reason', async () => {
    jest.spyOn(PlatformExpense, 'findOneAndUpdate').mockResolvedValue(null);
    jest.spyOn(PlatformExpense, 'exists').mockResolvedValue({ _id: SHOP });
    await expect(finance.voidExpense(ACTOR, SHOP, 'duplicate')).rejects.toMatchObject({ statusCode: 409 });
  });
});
