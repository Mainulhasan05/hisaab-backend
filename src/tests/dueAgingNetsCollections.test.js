/**
 * Aging must show what is still owed — once, and only once.
 *
 * ── The bug this file used to describe ───────────────────────────────────────
 *
 * Khata collections (বাকি আদায়, and the surplus settled at a later checkout)
 * reduced `Customer.totalDue` and the branch rows and deliberately never touched
 * `Sale.due`. Aging is built from `Sale.due` plus `DueAdjustment.amount`, so
 * every ৳ collected stayed in the buckets forever — a shop that invoiced ৳50,000
 * and collected ৳50,000 read ৳0 everywhere else and ৳50,000 here, quietly ageing
 * into the red bucket. This is the screen shops chase customers from, so the
 * disagreement landed as a phone call to someone who had already paid.
 *
 * ── Why the fix is not here any more ─────────────────────────────────────────
 *
 * The remedy at the time was to re-subtract every `Payment{due_collection}` from
 * these buckets, oldest-first, inside `getDueAging`. It made THIS screen right
 * and left the other nine readers of `Sale.due` — eight in `report.service`,
 * `staffReport.service`, `sale.service.getSalesSummary` — exactly as wrong as
 * before. It also only ever looked correct because the same money was being
 * subtracted twice, in two different places, to cancel out once.
 *
 * `dueSettlement.reallocateCustomerInvoices` now allocates every collection onto
 * the invoices that hold the debt, so `Sale.due` IS the truth and every reader
 * inherits it. The subtraction here was deleted, and what these tests pin is the
 * thing that would silently break if anyone reinstated it: aging must take the
 * buckets as it finds them. Subtracting collections again would now deduct the
 * same money a SECOND time and drop real debtors off the chase list — the
 * original bug, sign reversed, and harder to notice because the total looks
 * plausible.
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

describe('collections are already netted, so aging must not net them again', () => {
  it('reads the buckets as it finds them', async () => {
    // ৳4,000 of this customer's ৳6,000 has been collected, so the invoices
    // themselves already read ৳2,000 — the allocator cleared the oldest first.
    // Aging's job is to bucket that, not to re-derive it.
    stubAging({
      sales: [aged(CUSTOMER, { totalDue: 2000, due60plus: 0, due31to60: 1000, due0to30: 1000 })],
    });

    const { customers, summary } = await customerService.getDueAging(SHOP, shared());

    expect(customers[0].due60plus).toBe(0);
    expect(customers[0].due31to60).toBe(1000);
    expect(customers[0].due0to30).toBe(1000);
    expect(customers[0].totalDue).toBe(2000);
    expect(summary.totalDue).toBe(2000);
  });

  it('never subtracts due collections a second time', async () => {
    // THE REGRESSION. A collection has already come off `Sale.due` by the time
    // this report runs. Re-subtracting it here would halve a real debt — and
    // this is the screen a shop decides who to call from, so the customer who
    // owes the most is the one who would quietly stop appearing.
    //
    // Asserted as "does not query for them at all", which is the only phrasing
    // that survives someone reintroducing the subtraction with different
    // arithmetic.
    const pay = jest.spyOn(Payment, 'aggregate').mockResolvedValue([
      { _id: CUSTOMER, paid: 4000 },
    ]);
    jest.spyOn(Sale, 'aggregate').mockResolvedValue([aged()]);
    jest.spyOn(DueAdjustment, 'aggregate').mockResolvedValue([]);
    jest.spyOn(Customer, 'find').mockReturnValue({ select: () => ({ lean: async () => [] }) });

    const { customers, summary } = await customerService.getDueAging(SHOP, shared());

    expect(pay).not.toHaveBeenCalled();
    expect(customers[0].totalDue).toBe(6000);
    expect(summary.totalDue).toBe(6000);
  });

  it('drops a customer whose invoices are settled', async () => {
    // Leaving them at ৳0 pads the chase list with rows there is nothing to
    // chase on — and the customer most likely to be called is the one who just
    // paid. Reached now by their invoices reading zero, not by a subtraction.
    stubAging({
      sales: [aged(CUSTOMER, { totalDue: 0, due0to30: 0, due31to60: 0, due60plus: 0 })],
    });

    const { customers, summary } = await customerService.getDueAging(SHOP, shared());

    expect(customers).toHaveLength(0);
    expect(summary.totalDue).toBe(0);
    expect(summary.customerCount).toBe(0);
  });

  it('leaves a customer who has paid nothing at their full debt', async () => {
    stubAging({ sales: [aged(), aged(OTHER)] });

    const { customers } = await customerService.getDueAging(SHOP, shared());

    const other = customers.find((c) => String(c._id) === String(OTHER));
    expect(other.totalDue).toBe(6000);
    expect(other.due60plus).toBe(3000);
  });

  it('sorts the work queue by what is still owed', async () => {
    stubAging({
      sales: [aged(CUSTOMER, { totalDue: 1000 }), aged(OTHER, { totalDue: 5000, due60plus: 2000 })],
    });

    const { customers } = await customerService.getDueAging(SHOP, shared());

    expect(String(customers[0]._id)).toBe(String(OTHER));
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
