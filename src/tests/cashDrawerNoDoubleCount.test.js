/**
 * The till must count each taka once.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUG THESE PIN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Checkout money is recorded twice by design: inside `Sale.payments[]` (what
 * makes split payments legible) and as a `Payment` row (what makes the invoice's
 * payment history complete). `_calculateCashFlows` reads BOTH — `cashSales` sums
 * the legs, `cashDueCollections` sums every cash `Payment{type:'sale_payment'}`.
 *
 * So every cash sale was counted twice and `expectedClosing` ran over by
 * essentially the whole day's cash takings. The shopkeeper saw a drawer short by
 * exactly the money that was in it, every single day, with nothing to attribute
 * it to. The comment at the aggregation asserted the two streams were "disjoint
 * by construction"; `createSale` had always written into both.
 *
 * `Payment.atCheckout` is the discriminator. These tests pin the query shape
 * rather than the arithmetic, because the arithmetic was never wrong — the
 * population it ran over was.
 */

const mongoose = require('mongoose');
const Sale = require('../models/Sale.model');
const Payment = require('../models/Payment.model');
const Expense = require('../models/Expense.model');
const Purchase = require('../models/Purchase.model');
const CashRegister = require('../models/CashRegister.model');
const cashRegisterService = require('../services/cashRegister.service');
const { getBangladeshDayRange, toBangladeshDateStr } = require('../utils/bdTime.util');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();

/** Every aggregate stubbed empty; we assert on the pipelines that were built. */
function stubAggregates() {
  const payment = jest.fn().mockResolvedValue([]);
  jest.spyOn(Sale, 'aggregate').mockResolvedValue([]);
  jest.spyOn(Expense, 'aggregate').mockResolvedValue([]);
  jest.spyOn(Purchase, 'aggregate').mockResolvedValue([]);
  jest.spyOn(Payment, 'aggregate').mockImplementation(payment);
  return payment;
}

/** The $match of the Payment pipeline that filters on the given types. */
function matchForTypes(paymentAgg, predicate) {
  const call = paymentAgg.mock.calls.find(([pipeline]) => predicate(pipeline[0].$match));
  return call ? call[0][0].$match : null;
}

afterEach(() => jest.restoreAllMocks());

describe('checkout cash is not counted twice', () => {
  it('excludes atCheckout rows from the collections bucket', async () => {
    const paymentAgg = stubAggregates();
    const { start, end } = { start: new Date(0), end: new Date() };

    await cashRegisterService._calculateCashFlows(SHOP, start, end, BRANCH);

    const collections = matchForTypes(paymentAgg, (m) => Array.isArray(m.type?.$in));
    expect(collections).not.toBeNull();
    expect(collections.type.$in).toEqual(expect.arrayContaining(['due_collection', 'sale_payment']));
    // The whole fix: rows already counted inside `Sale.payments[]` are skipped.
    expect(collections.atCheckout).toEqual({ $ne: true });
  });

  it('uses $ne so later collections and legacy rows both still count', async () => {
    // `recordPayment` and `collectDuePayment` leave `atCheckout` false; rows
    // written before the field existed have it absent. `$ne: true` matches both,
    // where `$eq: false` would silently drop every legacy row — losing cash that
    // was genuinely in the drawer while fixing the double count.
    const paymentAgg = stubAggregates();

    await cashRegisterService._calculateCashFlows(SHOP, new Date(0), new Date(), BRANCH);

    const collections = matchForTypes(paymentAgg, (m) => Array.isArray(m.type?.$in));
    expect(collections.atCheckout).toEqual({ $ne: true });
    expect(collections.atCheckout.$eq).toBeUndefined();
  });

  it('does not filter refunds or supplier payments on atCheckout', async () => {
    // Those buckets have no counterpart inside the Sale document, so excluding
    // anything from them would simply lose cash that left the drawer.
    const paymentAgg = stubAggregates();

    await cashRegisterService._calculateCashFlows(SHOP, new Date(0), new Date(), BRANCH);

    const refunds = matchForTypes(paymentAgg, (m) => m.type === 'refund');
    const supplier = matchForTypes(paymentAgg, (m) => m.type === 'purchase_payment');
    expect(refunds.atCheckout).toBeUndefined();
    expect(supplier.atCheckout).toBeUndefined();
  });

  it('createSale stamps its checkout row and recordPayment does not', () => {
    // Read from source: the flag has to be set at exactly one of the two call
    // sites, and a test that stubs the whole sale path would not notice if the
    // stamp moved.
    const source = require('fs').readFileSync(
      require.resolve('../services/sale.service.js'), 'utf8'
    );
    expect(source.match(/atCheckout:\s*true/g)).toHaveLength(1);
  });
});

describe('the register uses the Bangladesh day on the WRITE path too', () => {
  it('stamps a new register with the start of the Bangladesh day', async () => {
    // This was server-local midnight while every lookup used Bangladesh time.
    // On a UTC host the two diverge between 00:00 and 06:00 Dhaka: the register
    // was written outside the range that finds it, so `getTodayRegister` said
    // none existed — and the unique index then refused to create a second one.
    stubAggregates();

    const created = jest.fn().mockResolvedValue({
      cashIn: {}, cashOut: {}, save: jest.fn(), toJSON: () => ({}),
    });
    jest.spyOn(CashRegister, 'findOne').mockResolvedValue(null);
    jest.spyOn(CashRegister, 'create').mockImplementation(created);
    jest.spyOn(require('../models/AuditLog.model'), 'create').mockResolvedValue({});

    const req = { shop: { _id: SHOP }, branchId: BRANCH, user: {} };
    await cashRegisterService.openRegister(SHOP, new mongoose.Types.ObjectId(), 500, req);

    const { startOfDay } = getBangladeshDayRange(toBangladeshDateStr(new Date()));
    expect(created.mock.calls[0][0].date.getTime()).toBe(startOfDay.getTime());
  });
});
