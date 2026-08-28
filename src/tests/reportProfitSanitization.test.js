/**
 * `view_profit` must hold at the payload boundary, not just at the route.
 *
 * The reports that a cashier legitimately opens (`reports.view`) each compute
 * their own profit-derived figures, and `sanitizeReport` filters them by NAME.
 * `netEarnings` (now `netProfit`) — profit minus expenses, returned by the
 * daily summary and the date-wise report — was not on that list, so it
 * shipped to anyone with plain
 * `reports.view`. Because those same payloads carry the expense total beside
 * it, `profit = netEarnings + expenses` reconstructed the withheld figure
 * exactly.
 *
 * The scan below is deliberately name-shaped rather than a fixed list: any new
 * key that reads as profit has to be either stripped or explicitly excused
 * here, so the next derived field cannot slip through the same gap.
 */

const {
  sanitizeReport,
  canViewProfit,
  PROFIT_KEYS,
} = require('../utils/dataSanitizer.util');
const { ROLE_PRESETS } = require('../config/permissions');

// A request as the RBAC middleware leaves it for a preset cashier.
const cashierReq = {
  user: { isOwner: false, permissions: ROLE_PRESETS.cashier.permissions },
};
const managerReq = {
  user: { isOwner: false, permissions: ROLE_PRESETS.manager.permissions },
};
const ownerReq = { user: { isOwner: true } };

// Money figures that read as profit but are not: cash movements and revenue.
// Named explicitly so the scan below cannot be quietly widened to excuse a real
// profit field.
const NOT_PROFIT = new Set(['netCashFlow', 'cashIn', 'cashOut', 'net']);

function profitLookingKeys(data, path = '', found = []) {
  if (Array.isArray(data)) {
    data.forEach((item, i) => profitLookingKeys(item, `${path}[${i}]`, found));
    return found;
  }
  if (data === null || typeof data !== 'object') return found;

  for (const [k, v] of Object.entries(data)) {
    const here = path ? `${path}.${k}` : k;
    if (!NOT_PROFIT.has(k) && /profit|earning|margin|cogs/i.test(k)) {
      found.push(here);
    }
    profitLookingKeys(v, here, found);
  }
  return found;
}

// Payload shapes copied from what the services actually return, trimmed to the
// money fields. Keep these in step with report.service.js.
const DAILY_SUMMARY = {
  date: '2026-08-14',
  netProfit: 4200,
  netSales: 11700,
  netCashFlow: 9100,
  sales: { revenue: 12000, profit: 5000, paid: 9000, due: 3000, count: 14 },
  expenses: { total: 800, count: 3, byCategory: [{ _id: 'rent', total: 800 }] },
  purchases: { total: 2000, paid: 2000, due: 0, count: 1 },
  returns: { total: 300, profitLoss: 120, cashRefund: 300, count: 1 },
  cashFlow: { cashIn: 9100, cashOut: 2800, net: 6300 },
  hourlyData: [{ hour: 11, revenue: 4000, profit: 1500, orders: 5 }],
  topProducts: [{ _id: 'p1', productName: 'চাল', totalQuantity: 10, totalRevenue: 5000 }],
};

const DATE_WISE = {
  month: '2026-08',
  days: [
    {
      date: '2026-08-01',
      sales: 5000, returns: 200, netSales: 4800, expenses: 500,
      profit: 1200, returnsLoss: 60, netProfit: 640,
      cashIn: 4200, cashOut: 900, netCash: 3300,
      salesPaid: 4000, collected: 200, purchasePaid: 200, cashRefund: 200,
      orderCount: 6,
    },
    {
      date: '2026-08-02',
      sales: 0, returns: 0, netSales: 0, expenses: 0,
      profit: 0, returnsLoss: 0, netProfit: 0,
      cashIn: 0, cashOut: 0, netCash: 0,
      salesPaid: 0, collected: 0, purchasePaid: 0, cashRefund: 0,
      orderCount: 0,
    },
  ],
  monthTotal: {
    sales: 5000, returns: 200, netSales: 4800, expenses: 500,
    profit: 1200, returnsLoss: 60, netProfit: 640,
    cashIn: 4200, cashOut: 900, netCash: 3300,
    orderCount: 6,
  },
};

const SALES_BY_DATE = {
  date: '2026-08-14',
  sales: [{ invoiceNo: 'INV-1', total: 500, profit: 90 }],
  expenses: [{ categoryName: 'দোকান ভাড়া', amount: 40, paymentMethod: 'cash' }],
  summary: {
    totalSales: 500,
    totalProfit: 90,
    totalReturns: 20,
    netSales: 480,
    returnsLoss: 5,
    totalExpenses: 40,
    netProfit: 45,
    cashIn: 500,
    cashOut: 60,
    netCash: 440,
    salesPaid: 500,
    collected: 0,
    purchasePaid: 0,
    cashRefund: 20,
    averageOrderValue: 500,
  },
};

const RETURNS_SUMMARY = {
  totalReturns: 300,
  totalProfitLoss: 120,
  count: 1,
  pendingRefundAmount: 300,
  pendingRefundCount: 1,
};

const RETURN_DOC = {
  returnNo: 'RET-1',
  invoiceNo: 'INV-1',
  totalAmount: 300,
  profitReduction: 120,
  items: [{ productName: 'চাল', quantity: 1, unitPrice: 300, buyingPrice: 180 }],
};

const PAYLOADS = {
  'daily summary': DAILY_SUMMARY,
  'date-wise month': DATE_WISE,
  'date-wise day': SALES_BY_DATE,
  'returns summary': RETURNS_SUMMARY,
  'return document': RETURN_DOC,
};

describe('A cashier sees no profit figure on any report they can open', () => {
  it('holds reports.view but not view_profit — the premise of every case below', () => {
    const cashier = ROLE_PRESETS.cashier.permissions;
    expect(cashier.reports.view).toBe(true);
    expect(cashier.sales.view).toBe(true);
    expect(canViewProfit(cashierReq)).toBe(false);
  });

  for (const [name, payload] of Object.entries(PAYLOADS)) {
    it(`strips every profit-shaped key from the ${name}`, () => {
      const out = sanitizeReport(payload, cashierReq);
      expect(profitLookingKeys(out)).toEqual([]);
    });
  }

  it('strips netProfit specifically — the field that leaked, under its new name', () => {
    // Was `netEarnings`. Renamed when the day-book split performance from cash;
    // it is the same figure and the same leak, so it stays stripped.
    const daily = sanitizeReport(DAILY_SUMMARY, cashierReq);
    expect(daily.netProfit).toBeUndefined();

    const month = sanitizeReport(DATE_WISE, cashierReq);
    expect(month.monthTotal.netProfit).toBeUndefined();
    month.days.forEach((d) => expect(d.netProfit).toBeUndefined());

    const day = sanitizeReport(SALES_BY_DATE, cashierReq);
    expect(day.summary.netProfit).toBeUndefined();
  });

  it('strips the returns side of the subtraction too', () => {
    // `netProfit = profit − returnsLoss − expenses`. Withholding netProfit and
    // profit while leaving `returnsLoss` beside them is only safe because it is
    // stripped as well — otherwise a cashier who sees two of three terms of a
    // published identity is one subtraction away from the third.
    const day = sanitizeReport(SALES_BY_DATE, cashierReq);
    expect(day.summary.returnsLoss).toBeUndefined();

    const month = sanitizeReport(DATE_WISE, cashierReq);
    expect(month.monthTotal.returnsLoss).toBeUndefined();
    month.days.forEach((d) => expect(d.returnsLoss).toBeUndefined());
  });

  it('leaves the CASH figures intact — they are money, not profit', () => {
    // The whole reason the day-book reports two books. A cashier may know what
    // came into the drawer and what left it; that is the job. None of it
    // reveals margin: cash in and out are gross movements with no cost basis
    // anywhere in them.
    const day = sanitizeReport(SALES_BY_DATE, cashierReq);
    expect(day.summary.cashIn).toBe(500);
    expect(day.summary.cashOut).toBe(60);
    expect(day.summary.netCash).toBe(440);
    expect(day.summary.collected).toBe(0);
    expect(day.summary.purchasePaid).toBe(0);

    const month = sanitizeReport(DATE_WISE, cashierReq);
    expect(month.monthTotal.cashIn).toBe(4200);
    expect(month.monthTotal.netCash).toBe(3300);
    // Sales and returns survive too — neither carries a cost.
    expect(month.monthTotal.sales).toBe(5000);
    expect(month.monthTotal.returns).toBe(200);
    expect(month.monthTotal.netSales).toBe(4800);
  });

  it('leaves nothing behind that reconstructs profit by subtraction', () => {
    // The whole point: revenue and expenses may stay, because profit cannot be
    // derived from them. netEarnings + expenses could be, so it may not.
    const out = sanitizeReport(DAILY_SUMMARY, cashierReq);
    expect(out.sales.revenue).toBe(12000);
    expect(out.expenses.total).toBe(800);
    expect(out.netProfit).toBeUndefined();
    expect(out.sales.profit).toBeUndefined();
  });

  it('keeps the figures a cashier does need', () => {
    const out = sanitizeReport(DAILY_SUMMARY, cashierReq);
    expect(out.netCashFlow).toBe(9100);
    expect(out.cashFlow).toEqual({ cashIn: 9100, cashOut: 2800, net: 6300 });
    expect(out.sales.paid).toBe(9000);
    expect(out.sales.due).toBe(3000);
    expect(out.hourlyData[0].revenue).toBe(4000);
    expect(out.topProducts[0].totalRevenue).toBe(5000);
  });

  it('strips the buying price from return line items too', () => {
    // Same request, the other permission: a cashier has no products.view_cost.
    const out = sanitizeReport(RETURN_DOC, cashierReq);
    expect(out.items[0].buyingPrice).toBeUndefined();
    expect(out.items[0].unitPrice).toBe(300);
  });
});

describe('Nobody entitled to profit loses it', () => {
  it('returns the payload untouched for an owner', () => {
    expect(sanitizeReport(DAILY_SUMMARY, ownerReq)).toBe(DAILY_SUMMARY);
  });

  it('keeps every profit figure for a manager, who holds view_profit', () => {
    expect(canViewProfit(managerReq)).toBe(true);
    const out = sanitizeReport(DAILY_SUMMARY, managerReq);
    expect(out.netProfit).toBe(4200);
    expect(out.sales.profit).toBe(5000);
    expect(out.returns.profitLoss).toBe(120);

    const month = sanitizeReport(DATE_WISE, managerReq);
    expect(month.monthTotal.netProfit).toBe(640);
    expect(month.monthTotal.returnsLoss).toBe(60);

    const returns = sanitizeReport(RETURNS_SUMMARY, managerReq);
    expect(returns.totalProfitLoss).toBe(120);
  });

  it('denies profit when no user is resolved at all', () => {
    expect(canViewProfit(null)).toBe(false);
    expect(canViewProfit({})).toBe(false);
    expect(sanitizeReport(DAILY_SUMMARY, {}).netProfit).toBeUndefined();
  });
});

describe('The daily summary is withheld from a cashier at the door', () => {
  // The page is the day's profit picture end to end, so it is gated whole
  // rather than shown with its centre removed. The client mirrors this in
  // lib/capabilities.js; check-capabilities.mjs asserts that half.
  const routeGates = () => {
    const gates = {};
    jest.isolateModules(() => {
      jest.doMock('../middleware/auth.middleware', () => ({ protect: (req, res, next) => next() }));
      jest.doMock('../middleware/permission.middleware', () => ({
        rbac: (moduleKey, action) => {
          const mw = (req, res, next) => next();
          mw._gate = `${moduleKey}.${action}`;
          return mw;
        },
      }));
      jest.doMock('../controllers/report.controller', () => new Proxy({}, {
        get: () => (req, res) => res,
      }));

      const router = require('../routes/report.routes');
      for (const layer of router.stack) {
        if (!layer.route) continue;
        const gate = layer.route.stack.find((s) => s.handle._gate);
        if (gate) gates[layer.route.path] = gate.handle._gate;
      }
    });
    return gates;
  };

  it('gates /daily-summary on reports.view_profit, not reports.view', () => {
    expect(routeGates()['/daily-summary']).toBe('reports.view_profit');
  });

  it('leaves the reports a cashier still needs on plain reports.view', () => {
    const gates = routeGates();
    // date-wise stays open: with its profit columns hidden it is sales,
    // expenses and order counts — figures the cashier rings up themselves.
    expect(gates['/date-wise']).toBe('reports.view');
    expect(gates['/date-wise/:date']).toBe('reports.view');
    expect(gates['/dashboard']).toBe('reports.view');
  });

  it('keeps the P&L statement on view_profit', () => {
    expect(routeGates()['/profit-loss']).toBe('reports.view_profit');
  });
});

describe('PROFIT_KEYS covers the derived names, not just the obvious ones', () => {
  it('lists every profit-shaped key the reports emit', () => {
    // Guards the denylist itself: if a service starts returning a new
    // profit-flavoured name, adding it to the payloads above fails here until
    // it is also added to PROFIT_KEYS.
    const emitted = new Set(
      Object.values(PAYLOADS).flatMap((p) => profitLookingKeys(p)).map((path) => path.split('.').pop())
    );
    for (const key of emitted) {
      expect(PROFIT_KEYS.has(key)).toBe(true);
    }
  });
});
