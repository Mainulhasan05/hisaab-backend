/**
 * Aging must net off money the shop has already collected.
 *
 * `collectDuePayment` is the one payment with no invoice behind it: it reduces
 * `Customer.totalDue` and the branch rows, and deliberately never touches
 * `Sale.due`. Aging is built from `Sale.due` plus `DueAdjustment.amount`, so
 * every ৳ collected stayed in the buckets forever — a shop that invoiced
 * ৳50,000 and collected ৳50,000 read ৳0 everywhere else and ৳50,000 here,
 * quietly ageing into the red bucket. This is the screen shops chase customers
 * from, so the disagreement lands as a phone call to someone who has paid.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));

const mongoose = require('mongoose');
const customerService = require('../services/customer.service');
const Customer = require('../models/Customer.model');
const Sale = require('../models/Sale.model');
const Payment = require('../models/Payment.model');
const DueAdjustment = require('../models/DueAdjustment.model');

const SHOP = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();
const OTHER = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();

const shared = () => ({ shop: { _id: SHOP, multiBranchEnabled: true, customerScope: 'shop' }, branchId: BRANCH });
const separate = () => ({ shop: { _id: SHOP, multiBranchEnabled: true, customerScope: 'branch' }, branchId: BRANCH });

/** A customer owing across all three buckets. */
const aged = (id = CUSTOMER, over = {}) => ({
  _id: id,
  customerName: 'করিম',
  customerPhone: '01711223344',
  totalDue: 6000,
  due0to30: 1000,
  due31to60: 2000,
  due60plus: 3000,
  oldestDue: new Date(0),
  saleCount: 4,
  ...over,
});

const stubAging = ({ sales = [], adjustments = [], payments = [], deleted = [] }) => {
  jest.spyOn(Sale, 'aggregate').mockResolvedValue(sales);
  jest.spyOn(DueAdjustment, 'aggregate').mockResolvedValue(adjustments);
  jest.spyOn(Payment, 'aggregate').mockResolvedValue(payments);
  jest.spyOn(Customer, 'find').mockImplementation((filter) => ({
    select: () => ({ lean: async () => (filter?.isActive === false ? deleted : []) }),
  }));
};

afterEach(() => jest.restoreAllMocks());

describe('collections come off the aging buckets', () => {
  it('settles the oldest debt first', async () => {
    // ৳4,000 collected against ৳6,000 owed: it clears the 60+ bucket (৳3,000)
    // then eats ৳1,000 of the 31-60. FIFO, matching the order
    // `CustomerBalance.settleDue` allocates cash in — so what aging shows
    // outstanding is what the ledger still holds.
    stubAging({ sales: [aged()], payments: [{ _id: CUSTOMER, paid: 4000 }] });

    const { customers, summary } = await customerService.getDueAging(SHOP, shared());

    expect(customers[0].due60plus).toBe(0);
    expect(customers[0].due31to60).toBe(1000);
    expect(customers[0].due0to30).toBe(1000);
    expect(customers[0].totalDue).toBe(2000);
    expect(summary.totalDue).toBe(2000);
  });

  it('drops a customer who has paid in full', async () => {
    // Leaving them at ৳0 pads the chase list with rows there is nothing to
    // chase on — and the customer most likely to be called is the one who just
    // paid.
    stubAging({ sales: [aged()], payments: [{ _id: CUSTOMER, paid: 6000 }] });

    const { customers, summary } = await customerService.getDueAging(SHOP, shared());

    expect(customers).toHaveLength(0);
    expect(summary.totalDue).toBe(0);
    expect(summary.customerCount).toBe(0);
  });

  it('never reports a negative bucket when a customer has overpaid', async () => {
    // An overpayment is a credit. This report answers "what is still owed", not
    // "what is the net position", and a negative here would subtract from the
    // shop's total and understate every other customer's debt.
    stubAging({ sales: [aged()], payments: [{ _id: CUSTOMER, paid: 10000 }] });

    const { customers, summary } = await customerService.getDueAging(SHOP, shared());

    expect(customers).toHaveLength(0);
    expect(summary.totalDue).toBe(0);
  });

  it('leaves customers who have paid nothing untouched', async () => {
    stubAging({ sales: [aged(), aged(OTHER)], payments: [{ _id: CUSTOMER, paid: 1000 }] });

    const { customers } = await customerService.getDueAging(SHOP, shared());

    const other = customers.find((c) => String(c._id) === String(OTHER));
    expect(other.totalDue).toBe(6000);
    expect(other.due60plus).toBe(3000);
  });

  it('re-sorts after netting, so the largest remaining debt leads', async () => {
    // The list is a work queue. Sorting before the subtraction put a customer
    // who had paid most of it off at the top.
    stubAging({
      sales: [aged(CUSTOMER, { totalDue: 6000 }), aged(OTHER, { totalDue: 5000, due60plus: 2000 })],
      payments: [{ _id: CUSTOMER, paid: 5000 }],
    });

    const { customers } = await customerService.getDueAging(SHOP, shared());

    expect(String(customers[0]._id)).toBe(String(OTHER));
  });

  it('scopes collections to the branch under separate books', async () => {
    // Netting a shop-wide collection against one branch's aged debt would show
    // that branch a due it does not hold — the same cross-branch leak the whole
    // scope flag exists to prevent.
    const pay = jest.fn().mockResolvedValue([]);
    jest.spyOn(Sale, 'aggregate').mockResolvedValue([]);
    jest.spyOn(DueAdjustment, 'aggregate').mockResolvedValue([]);
    jest.spyOn(Payment, 'aggregate').mockImplementation(pay);
    jest.spyOn(Customer, 'find').mockReturnValue({ select: () => ({ lean: async () => [] }) });

    await customerService.getDueAging(SHOP, separate());
    expect(pay.mock.calls[0][0][0].$match).toHaveProperty('branch');

    pay.mockClear();
    await customerService.getDueAging(SHOP, shared());
    expect(pay.mock.calls[0][0][0].$match).not.toHaveProperty('branch');
  });

  it('counts only due collections, never invoice payments', async () => {
    // A `sale_payment` is already inside `Sale.due`. Subtracting it here would
    // take the same money off twice.
    jest.spyOn(Sale, 'aggregate').mockResolvedValue([]);
    jest.spyOn(DueAdjustment, 'aggregate').mockResolvedValue([]);
    const pay = jest.spyOn(Payment, 'aggregate').mockResolvedValue([]);
    jest.spyOn(Customer, 'find').mockReturnValue({ select: () => ({ lean: async () => [] }) });

    await customerService.getDueAging(SHOP, shared());

    expect(pay.mock.calls[0][0][0].$match.type).toBe('due_collection');
  });
});

describe('aging counts the same population as every other due screen', () => {
  it('drops soft-deleted customers', async () => {
    // Otherwise the aging total is the one figure on the page that still counts
    // deleted customers, and a shop reconciling it against the dashboard finds a
    // gap with nothing to explain it.
    stubAging({
      sales: [aged(), aged(OTHER)],
      deleted: [{ _id: OTHER }],
    });

    const { customers, summary } = await customerService.getDueAging(SHOP, shared());

    expect(customers).toHaveLength(1);
    expect(String(customers[0]._id)).toBe(String(CUSTOMER));
    expect(summary.customerCount).toBe(1);
  });

  it('keeps walk-in debt, which has no customer document at all', async () => {
    // A walk-in sale groups under `_id: null`. The filter asks which ids are
    // DELETED rather than which are live, precisely so this row survives —
    // inverting it would silently drop the debt.
    stubAging({ sales: [aged(null), aged()], deleted: [] });

    const { customers } = await customerService.getDueAging(SHOP, shared());

    expect(customers).toHaveLength(2);
  });
});
