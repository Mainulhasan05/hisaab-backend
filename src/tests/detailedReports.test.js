/**
 * The three printable documents.
 *
 * What these tests are actually defending:
 *
 *   1. A statement's closing balance is the opening balance plus the movements
 *      printed under it. If those disagree, the shopkeeper is holding a piece
 *      of paper whose own arithmetic is wrong — the single worst failure this
 *      feature can have, because it is handed to a customer.
 *
 *   2. A cash refund moves the balance the OTHER way from a payment. The two
 *      are both `Payment` rows and differ only by `type`, which is exactly the
 *      kind of distinction a later refactor collapses.
 *
 *   3. A purchase settled at the counter prints as bill + payment, not as an
 *      unpaid bill. `createPurchase` writes no Payment row for money handed
 *      over on delivery, so the credit has to be derived — and a shop that pays
 *      cash on delivery would otherwise get a statement claiming it owes for
 *      every delivery it ever settled.
 *
 *   4. Goods detail is opt-in and adds NO key when it is off. It multiplies the
 *      payload by roughly ten, so a default run has to be the payload it always
 *      was — not merely one with the same numbers in it.
 *
 *   5. A purchase line's rate IS the shop's buying price, so the goods lines on
 *      a SUPPLIER statement carry it under names `sanitizeReport` strips. Named
 *      `unitPrice`/`total` like their source fields, they would hand anyone
 *      with plain `reports.view` the cost of every product the shop has ever
 *      bought.
 *
 *   6. The stock report's money columns are named the keys `sanitizeReport`
 *      strips. A rename to something more readable (`costValue`,
 *      `potentialProfit`) sails straight past the sanitiser and hands a cashier
 *      the shop's margin on every line.
 */

const mongoose = require('mongoose');

const service = require('../services/detailedReport.service');
const Sale = require('../models/Sale.model');
const SalesReturn = require('../models/SalesReturn.model');
const Payment = require('../models/Payment.model');
const Customer = require('../models/Customer.model');
const DueAdjustment = require('../models/DueAdjustment.model');
const Supplier = require('../models/Supplier.model');
const SupplierDueAdjustment = require('../models/SupplierDueAdjustment.model');
const Purchase = require('../models/Purchase.model');
const Product = require('../models/Product.model');
const { COST_KEYS, PROFIT_KEYS } = require('../utils/dataSanitizer.util');

const SHOP = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();
const SUPPLIER = new mongoose.Types.ObjectId();

/** A `find().select().sort().limit().lean()` chain resolving to `rows`. */
function mockChain(rows) {
  const chain = {
    select: () => chain,
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    lean: () => Promise.resolve(rows),
    then: (resolve) => Promise.resolve(rows).then(resolve),
  };
  return chain;
}

const d = (iso) => new Date(iso);

afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
describe('customer statement', () => {
  /**
   * @param {object} opts  aggregate results keyed by collection, plus the
   *                       documents the range finds should return
   */
  function stubCustomerData({ openings = {}, sales = [], payments = [], adjustments = [], returns = [] }) {
    jest.spyOn(Customer, 'find').mockReturnValue(mockChain([
      { _id: CUSTOMER, name: 'রহিম স্টোর', phone: '01711000000', totalDue: 3000, openingDue: 0 },
    ]));

    // The opening pass aggregates; the range pass finds. Both hit the same
    // models, so the aggregate stubs answer only the opening question.
    jest.spyOn(Sale, 'aggregate').mockResolvedValue(openings.sales || []);
    jest.spyOn(Payment, 'aggregate').mockResolvedValue(openings.payments || []);
    jest.spyOn(DueAdjustment, 'aggregate').mockResolvedValue(openings.adjustments || []);
    // SalesReturn.aggregate serves BOTH passes, so it is stubbed per call:
    // first the opening group, then the in-range rows.
    jest.spyOn(SalesReturn, 'aggregate')
      .mockResolvedValueOnce(openings.returns || [])
      .mockResolvedValueOnce(returns);

    jest.spyOn(Sale, 'find').mockReturnValue(mockChain(sales));
    jest.spyOn(Payment, 'find').mockReturnValue(mockChain(payments));
    jest.spyOn(DueAdjustment, 'find').mockReturnValue(mockChain(adjustments));
  }

  const RANGE = { startDate: '2026-08-01', endDate: '2026-08-31' };

  it('carries a balance in, walks the movements, and closes on their sum', async () => {
    stubCustomerData({
      openings: {
        sales: [{ _id: CUSTOMER, total: 10000 }],
        payments: [{ _id: CUSTOMER, total: -8000 }], // signed: credits are negative
      },
      sales: [{ customer: CUSTOMER, invoiceNo: 'INV-1', total: 5000, createdAt: d('2026-08-05') }],
      payments: [{
        customer: CUSTOMER, amount: 3000, type: 'due_collection',
        method: 'cash', createdAt: d('2026-08-10'),
      }],
    });

    const report = await service.getCustomerStatements(SHOP, RANGE, null);
    const [statement] = report.statements;

    expect(statement.openingBalance).toBe(2000);

    // The running balance is the whole point of the document: 2000 + 5000
    // (invoice) − 3000 (collection) = 4000, in that order.
    expect(statement.entries.map((e) => e.balance)).toEqual([7000, 4000]);
    expect(statement.totals.closingBalance).toBe(4000);

    // Closing must be reproducible from the printed lines alone, or the paper
    // does not add up in the reader's hand.
    const { debit, credit } = statement.totals;
    expect(statement.openingBalance + debit - credit).toBe(statement.totals.closingBalance);
  });

  it('books a refund as a debit — cash handed back reverses the credit', async () => {
    stubCustomerData({
      payments: [
        { customer: CUSTOMER, amount: 1000, type: 'sale_payment', createdAt: d('2026-08-02') },
        { customer: CUSTOMER, amount: 400, type: 'refund', createdAt: d('2026-08-06') },
      ],
    });

    const report = await service.getCustomerStatements(SHOP, RANGE, null);
    const [payment, refund] = report.statements[0].entries;

    expect(payment.credit).toBe(1000);
    expect(refund.type).toBe('refund');
    expect(refund.debit).toBe(400);
    expect(refund.credit).toBe(0);
    expect(report.statements[0].totals.closingBalance).toBe(-600);
  });

  it('books a settled return as a credit, dated by settlement not by receipt', async () => {
    // A store-credit return settled a week after the goods came back credits
    // the account on the day the money moved. Dating it by `createdAt` would
    // put the credit before an invoice it should follow.
    stubCustomerData({
      returns: [{
        customer: CUSTOMER, returnNo: 'RET-1', totalAmount: 750,
        effectiveDate: d('2026-08-20'),
      }],
      sales: [{ customer: CUSTOMER, invoiceNo: 'INV-9', total: 750, createdAt: d('2026-08-15') }],
    });

    const report = await service.getCustomerStatements(SHOP, RANGE, null);
    const entries = report.statements[0].entries;

    expect(entries.map((e) => e.type)).toEqual(['sale', 'return']);
    expect(entries[1].credit).toBe(750);
    expect(report.statements[0].totals.closingBalance).toBe(0);
  });

  it('ranks an opening adjustment before the same day’s invoice', async () => {
    // The order the shopkeeper thinks in: the খাতা balance is what was there
    // before today's sale, even when both were entered this morning.
    stubCustomerData({
      sales: [{ customer: CUSTOMER, invoiceNo: 'INV-2', total: 100, createdAt: d('2026-08-03T10:00:00Z') }],
      adjustments: [{ customer: CUSTOMER, amount: 900, kind: 'opening', createdAt: d('2026-08-03T10:00:00Z') }],
    });

    const report = await service.getCustomerStatements(SHOP, RANGE, null);
    expect(report.statements[0].entries.map((e) => e.type)).toEqual(['opening', 'sale']);
  });

  it('drops a party with no movement and no balance unless asked for', async () => {
    stubCustomerData({});
    jest.spyOn(Customer, 'find').mockReturnValue(mockChain([
      { _id: CUSTOMER, name: 'নিষ্ক্রিয়', phone: null, totalDue: 0, openingDue: 0 },
    ]));

    const quiet = await service.getCustomerStatements(SHOP, RANGE, null);
    expect(quiet.statements).toHaveLength(0);
  });

  it('adds no items key at all when goods detail was not asked for', async () => {
    stubCustomerData({
      sales: [{ customer: CUSTOMER, invoiceNo: 'INV-4', total: 500, createdAt: d('2026-08-04') }],
    });

    const report = await service.getCustomerStatements(SHOP, RANGE, null);
    // `toHaveProperty` and not `items === undefined`: a key present and empty
    // still ships on every entry of every statement in the shop, which is the
    // cost this flag exists to avoid.
    expect(report.statements[0].entries[0]).not.toHaveProperty('items');
  });

  it('hangs the invoice lines under the invoice when asked, and selects no cost', async () => {
    const items = [
      { productName: 'চাল', quantity: 5, unit: 'kg', unitPrice: 60, total: 300 },
    ];
    stubCustomerData({
      sales: [{
        customer: CUSTOMER, invoiceNo: 'INV-5', total: 300,
        createdAt: d('2026-08-04'), items,
      }],
    });
    const select = jest.fn().mockReturnThis();
    jest.spyOn(Sale, 'find').mockReturnValue({
      select, sort: () => ({ limit: () => ({ lean: () => Promise.resolve([{
        customer: CUSTOMER, invoiceNo: 'INV-5', total: 300,
        createdAt: d('2026-08-04'), items,
      }]) }) }),
    });

    const report = await service.getCustomerStatements(
      SHOP, { ...RANGE, withItems: true }, null
    );

    expect(report.statements[0].entries[0].items).toEqual(items);

    // The projection must never ask for `buyingPrice`. It sits beside
    // `unitPrice` on the same sub-document, so a lazy `.select('items')` would
    // pull the shop's cost into a customer-facing document.
    const projection = select.mock.calls[0][0];
    expect(projection).toContain('items.productName');
    expect(projection).not.toContain('buyingPrice');
  });

  it('surfaces the stored due beside the computed one rather than reconciling them', async () => {
    // A gap means a write path updated one book and not the other. Hiding it
    // behind the computed figure is how that goes unnoticed for months.
    stubCustomerData({
      sales: [{ customer: CUSTOMER, invoiceNo: 'INV-3', total: 500, createdAt: d('2026-08-04') }],
    });

    const report = await service.getCustomerStatements(SHOP, RANGE, null);
    expect(report.statements[0].totals.closingBalance).toBe(500);
    expect(report.statements[0].totals.recordedDue).toBe(3000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('supplier statement', () => {
  function stubSupplierData({ purchases = [], payments = [], adjustments = [], openings = {} }) {
    jest.spyOn(Supplier, 'find').mockReturnValue(mockChain([
      { _id: SUPPLIER, name: 'ঢাকা ট্রেডার্স', phone: '01811000000', totalDue: 0, openingDue: 0 },
    ]));

    jest.spyOn(Purchase, 'aggregate')
      .mockResolvedValueOnce(openings.bills || [])
      .mockResolvedValueOnce(purchases);
    jest.spyOn(Payment, 'aggregate')
      .mockResolvedValueOnce(openings.payments || [])
      .mockResolvedValueOnce(payments);
    jest.spyOn(SupplierDueAdjustment, 'aggregate').mockResolvedValue(openings.adjustments || []);
    jest.spyOn(SupplierDueAdjustment, 'find').mockReturnValue(mockChain(adjustments));
  }

  const RANGE = { startDate: '2026-08-01', endDate: '2026-08-31' };

  it('prints a counter-settled purchase as bill AND payment, not as an unpaid bill', async () => {
    // ৳5,000 of goods, ৳2,000 handed over on delivery. `createPurchase` records
    // that only as `paid` on the purchase — there is no Payment row for it, so
    // the credit is derived. Without it this supplier would appear to be owed
    // the full 5,000.
    stubSupplierData({
      purchases: [{
        supplier: SUPPLIER, invoiceNo: 'PUR-1', totalAmount: 5000,
        paidAtPurchase: 2000, date: d('2026-08-07'), itemCount: 3,
      }],
    });

    const report = await service.getSupplierStatements(SHOP, RANGE, null);
    const entries = report.statements[0].entries;

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: 'purchase', debit: 5000, credit: 0 });
    expect(entries[1]).toMatchObject({ type: 'payment', debit: 0, credit: 2000 });
    // The bill is ranked before the settlement on the same date, so the pair
    // reads top-down the way it happened.
    expect(entries[0].balance).toBe(5000);
    expect(report.statements[0].totals.closingBalance).toBe(3000);
  });

  it('emits no settlement line when nothing was paid on delivery', async () => {
    stubSupplierData({
      purchases: [{
        supplier: SUPPLIER, invoiceNo: 'PUR-2', totalAmount: 4000,
        paidAtPurchase: 0, date: d('2026-08-09'), itemCount: 1,
      }],
    });

    const report = await service.getSupplierStatements(SHOP, RANGE, null);
    expect(report.statements[0].entries).toHaveLength(1);
    expect(report.statements[0].totals.closingBalance).toBe(4000);
  });

  it('lowers the payable with a later payment against that bill', async () => {
    stubSupplierData({
      purchases: [{
        supplier: SUPPLIER, invoiceNo: 'PUR-3', totalAmount: 6000,
        paidAtPurchase: 0, date: d('2026-08-02'), itemCount: 2,
      }],
      payments: [{
        supplier: SUPPLIER, invoiceNo: 'PUR-3', amount: 2500,
        method: 'bkash', createdAt: d('2026-08-18'),
      }],
    });

    const report = await service.getSupplierStatements(SHOP, RANGE, null);
    expect(report.statements[0].entries.map((e) => e.balance)).toEqual([6000, 3500]);
    expect(report.statements[0].totals.closingBalance).toBe(3500);
  });

  it('carries the pre-window payable in, net of what had been paid by then', async () => {
    // Billed 9,000 before the window, 1,000 settled at delivery, 3,000 paid
    // later but still before the window opened → 5,000 carried in.
    stubSupplierData({
      openings: {
        bills: [{ _id: SUPPLIER, billed: 9000, paidAtPurchase: 1000 }],
        payments: [{ _id: SUPPLIER, total: 3000 }],
      },
    });

    const report = await service.getSupplierStatements(SHOP, RANGE, null);
    expect(report.statements[0].openingBalance).toBe(5000);
    expect(report.statements[0].totals.closingBalance).toBe(5000);
  });

  it('narrows "only who we owe" in the query, not after the page cap', async () => {
    // Filtering in JS after fetching the first N name-ordered vendors would
    // compute "who we owe" from the alphabetically first page and silently drop
    // every debt below it.
    stubSupplierData({});
    const find = jest.spyOn(Supplier, 'find').mockReturnValue(mockChain([]));

    await service.getSupplierStatements(SHOP, { ...RANGE, withDueOnly: true }, null);

    expect(find.mock.calls[0][0]).toMatchObject({ totalDue: { $gt: 0 } });
  });

  it('names every money field on a goods line a key the cost sanitiser strips', async () => {
    // The trap this defends: a purchase line's rate is the shop's buying price
    // for that product. `sanitizeReport` is a denylist over field NAMES, so a
    // line shipped as `unitPrice`/`total` — the names on the source document —
    // walks straight past it and hands anyone holding plain `reports.view` the
    // cost of everything the shop buys. Same rule as the stock report's
    // columns, and the same test.
    const MONEY = ['unitCost', 'packUnitCost', 'totalCost'];
    for (const key of MONEY) {
      expect(COST_KEYS.has(key)).toBe(true);
    }

    stubSupplierData({
      purchases: [{
        supplier: SUPPLIER, invoiceNo: 'PUR-4', totalAmount: 1200,
        paidAtPurchase: 0, date: d('2026-08-11'), itemCount: 1,
        items: [{
          productName: 'সয়াবিন তেল', quantity: 10, unit: 'litre',
          unitCost: 120, totalCost: 1200,
        }],
      }],
    });

    const report = await service.getSupplierStatements(
      SHOP, { ...RANGE, withItems: true }, null
    );
    const [item] = report.statements[0].entries[0].items;

    // Nothing money-shaped may reach the line under a name outside that set.
    const priced = Object.keys(item).filter((k) => /price|cost|total|amount/i.test(k));
    expect(priced.sort()).toEqual(['totalCost', 'unitCost']);
    expect(priced.every((k) => COST_KEYS.has(k))).toBe(true);
  });

  it('leaves the derived counter-settlement line free of goods', async () => {
    // The bill and the money handed over on delivery are two entries built from
    // ONE purchase. Attaching the items to both would print every product twice
    // — once under the bill, once under the payment that settled it.
    stubSupplierData({
      purchases: [{
        supplier: SUPPLIER, invoiceNo: 'PUR-5', totalAmount: 900,
        paidAtPurchase: 900, date: d('2026-08-12'), itemCount: 1,
        items: [{ productName: 'চিনি', quantity: 3, unitCost: 300, totalCost: 900 }],
      }],
    });

    const report = await service.getSupplierStatements(
      SHOP, { ...RANGE, withItems: true }, null
    );
    const [bill, settlement] = report.statements[0].entries;

    expect(bill.items).toHaveLength(1);
    expect(settlement).not.toHaveProperty('items');
  });

  it('adds a pre-software payable from the opening-due ledger', async () => {
    stubSupplierData({
      openings: { adjustments: [{ _id: SUPPLIER, total: 12000 }] },
    });

    const report = await service.getSupplierStatements(SHOP, RANGE, null);
    expect(report.statements[0].openingBalance).toBe(12000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('stock report', () => {
  function stubAggregate(facet) {
    jest.spyOn(Product, 'aggregate').mockResolvedValue([{
      rows: [],
      summary: [],
      byCategory: [],
      ...facet,
    }]);
  }

  it('names its money columns exactly the keys the sanitiser strips', async () => {
    // This is the test that stops a well-meaning rename from leaking cost. If
    // it fails, either restore the key name or add the new one to the
    // sanitiser's sets — never just update this assertion.
    stubAggregate({
      rows: [{ _id: 'p1', name: 'চাল', buyingPrice: 40, sellingPrice: 55, totalCost: 400, totalRetail: 550 }],
      summary: [{ totalProducts: 1, totalUnits: 10, totalBuyingValue: 400, totalRetailValue: 550 }],
    });

    const report = await service.getStockReport(SHOP, {}, null);

    expect(COST_KEYS.has('buyingPrice')).toBe(true);
    expect(COST_KEYS.has('totalCost')).toBe(true);
    expect(COST_KEYS.has('totalBuyingValue')).toBe(true);
    expect(PROFIT_KEYS.has('totalProfit')).toBe(true);

    expect(report.rows[0]).toHaveProperty('totalCost');
    expect(report.summary).toHaveProperty('totalBuyingValue');
    expect(report.summary).toHaveProperty('totalProfit');
  });

  it('derives the locked-up margin from retail less cost', async () => {
    stubAggregate({
      summary: [{ totalProducts: 3, totalUnits: 40, totalBuyingValue: 12000, totalRetailValue: 18500 }],
    });

    const report = await service.getStockReport(SHOP, {}, null);
    expect(report.summary.totalProfit).toBe(6500);
  });

  it('reads stock off the variants when a product has them', async () => {
    // A product with variants holds no stock of its own. Summing `$stock` would
    // report every variant product as out of stock — and the "out" filter would
    // then list the entire variant catalogue.
    const pipeline = await capturePipeline({ status: 'all' });
    const valuation = pipeline.find((stage) => stage.$addFields?.effectiveStock);

    expect(valuation.$addFields.effectiveStock.$cond[0]).toEqual({ $eq: ['$hasVariants', true] });
    expect(valuation.$addFields.effectiveStock.$cond[1]).toEqual({ $sum: { $ifNull: ['$variants.stock', []] } });
  });

  it('filters "low" on the reorder point, excluding what is already at zero', async () => {
    // Zero stock is its own status. Folding it into "low" would bury the items
    // that cannot be sold at all among the ones merely running down.
    const pipeline = await capturePipeline({ status: 'low' });
    const filter = pipeline.find((stage) => stage.$match?.$expr);

    expect(filter.$match.$expr.$and).toEqual([
      { $gt: ['$effectiveStock', 0] },
      { $lt: ['$effectiveStock', '$minStock'] },
    ]);
  });

  it('computes the totals off the whole filtered set, not the capped page', async () => {
    // The rows are capped and the totals are not — a summary computed after the
    // limit would report the value of the first N products as the value of the
    // shop.
    const pipeline = await capturePipeline({ limit: 5 });
    const facet = pipeline.find((stage) => stage.$facet).$facet;

    expect(facet.rows.some((stage) => stage.$limit)).toBe(true);
    expect(facet.summary.some((stage) => stage.$limit)).toBe(false);
    expect(facet.byCategory.some((stage) => stage.$limit)).toBe(false);
  });

  it('excludes soft-deleted products and scopes to the active branch', async () => {
    const branch = new mongoose.Types.ObjectId();
    const pipeline = await capturePipeline({}, { branchId: branch });
    const match = pipeline[0].$match;

    expect(match.isDeleted).toEqual({ $ne: true });
    expect(String(match.branch)).toBe(String(branch));
    expect(match.isActive).toBe(true);
  });

  async function capturePipeline(options, req = null) {
    let captured = null;
    jest.spyOn(Product, 'aggregate').mockImplementation((pipeline) => {
      captured = pipeline;
      return Promise.resolve([{ rows: [], summary: [], byCategory: [] }]);
    });
    await service.getStockReport(SHOP, options, req);
    return captured;
  }
});
