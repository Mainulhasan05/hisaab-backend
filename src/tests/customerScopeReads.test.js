/**
 * Phase 7 — every customer read consults the flag, and the same call site
 * behaves exactly as it did before Phase 7 whenever the book is shared.
 *
 * The failure these guard against is a read path that was missed: it keeps
 * returning shop-wide figures, so a branch quietly sees another branch's
 * customers and dues while everything around it is correctly scoped.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));

const mongoose = require('mongoose');
const customerService = require('../services/customer.service');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Sale = require('../models/Sale.model');
const Payment = require('../models/Payment.model');

const SHOP = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();

const separate = () => ({ shop: { _id: SHOP, multiBranchEnabled: true, customerScope: 'branch' }, branchId: BRANCH });
const shared = () => ({ shop: { _id: SHOP, multiBranchEnabled: true, customerScope: 'shop' }, branchId: BRANCH });
const singleBranch = () => ({ shop: { _id: SHOP, multiBranchEnabled: false }, branchId: null });

/** Chainable Customer.find(...) stub matching the shop-wide code path. */
const stubCustomerFind = (docs = []) => {
  const chain = {
    select: () => chain, sort: () => chain, skip: () => chain, limit: () => chain,
    lean: () => Promise.resolve(docs), then: (r) => Promise.resolve(docs).then(r),
  };
  jest.spyOn(Customer, 'find').mockReturnValue(chain);
  jest.spyOn(Customer, 'countDocuments').mockResolvedValue(docs.length);
  return chain;
};

const stubBalanceAggregate = (rows = []) =>
  jest.spyOn(CustomerBalance, 'aggregate').mockResolvedValue(rows);

afterEach(() => jest.restoreAllMocks());

describe('the customer list', () => {
  it('is built from this branch\'s ledger under separate books', async () => {
    const agg = stubBalanceAggregate([{ data: [{ _id: CUSTOMER, name: 'করিম', totalDue: 500 }], count: [{ total: 1 }] }]);
    const find = jest.spyOn(Customer, 'find');

    const result = await customerService.getCustomers(SHOP, {}, separate());

    expect(find).not.toHaveBeenCalled();
    expect(result.data[0].totalDue).toBe(500);
    // Starting the pipeline from CustomerBalance is what excludes customers who
    // have never transacted here — the visibility rule, not a filter bolted on.
    const [pipeline] = agg.mock.calls[0];
    expect(String(pipeline[0].$match.branch)).toBe(String(BRANCH));
  });

  it('is shop-wide under a shared book', async () => {
    stubCustomerFind([{ _id: CUSTOMER, totalDue: 500 }]);
    const agg = jest.spyOn(CustomerBalance, 'aggregate');

    await customerService.getCustomers(SHOP, {}, shared());

    expect(Customer.find).toHaveBeenCalled();
    expect(agg).not.toHaveBeenCalled();
  });

  it('is shop-wide for a single-branch shop', async () => {
    stubCustomerFind([]);
    const agg = jest.spyOn(CustomerBalance, 'aggregate');
    await customerService.getCustomers(SHOP, {}, singleBranch());
    expect(agg).not.toHaveBeenCalled();
  });

  it('is shop-wide with no req at all — internal callers keep today\'s behaviour', async () => {
    stubCustomerFind([]);
    const agg = jest.spyOn(CustomerBalance, 'aggregate');
    await customerService.getCustomers(SHOP, {});
    expect(agg).not.toHaveBeenCalled();
  });
});

describe('a single customer', () => {
  const stubFindOne = (doc) =>
    jest.spyOn(Customer, 'findOne').mockReturnValue({ populate: () => Promise.resolve(doc) });

  it('shows this branch\'s figures, not the shop-wide ones', async () => {
    stubFindOne({ _id: CUSTOMER, name: 'করিম', totalDue: 5000, toObject() { return { _id: CUSTOMER, name: 'করিম', totalDue: 5000 }; } });
    jest.spyOn(CustomerBalance, 'findOne').mockReturnValue({ lean: () => Promise.resolve({ totalDue: 1200, totalPaid: 300, totalPurchases: 1500, purchaseCount: 2 }) });

    const customer = await customerService.getCustomerById(SHOP, CUSTOMER, separate());

    expect(customer.totalDue).toBe(1200);
  });

  it('404s for a customer this branch has never served', async () => {
    stubFindOne({ _id: CUSTOMER, toObject() { return {}; } });
    jest.spyOn(CustomerBalance, 'findOne').mockReturnValue({ lean: () => Promise.resolve(null) });

    // A plain 404, deliberately — not the WRONG_BRANCH hint a sale gets.
    // Naming the branch would disclose exactly what separate books hide.
    await expect(customerService.getCustomerById(SHOP, CUSTOMER, separate()))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns the shop-wide document untouched under a shared book', async () => {
    const doc = { _id: CUSTOMER, totalDue: 5000 };
    stubFindOne(doc);
    const balance = jest.spyOn(CustomerBalance, 'findOne');

    expect(await customerService.getCustomerById(SHOP, CUSTOMER, shared())).toBe(doc);
    expect(balance).not.toHaveBeenCalled();
  });
});

describe('lookup by phone — the till', () => {
  it('resolves shop-wide even under separate books', async () => {
    // Option (ক): one human stays one record. Failing to find them here is how
    // the same phone ends up with two customer documents, which is what makes
    // the scope toggle irreversible.
    const doc = { _id: CUSTOMER, phone: '01700000000', toObject: () => ({ _id: CUSTOMER, phone: '01700000000' }) };
    jest.spyOn(Customer, 'findOne').mockResolvedValue(doc);
    jest.spyOn(CustomerBalance, 'findOne').mockReturnValue({ lean: () => Promise.resolve(null) });

    const found = await customerService.getCustomerByPhone(SHOP, '01700000000', separate());

    expect(found).toBeTruthy();
    expect(String(found._id)).toBe(String(CUSTOMER));
  });

  it('zeroes the figures for a first visit rather than leaking another branch\'s due', async () => {
    jest.spyOn(Customer, 'findOne').mockResolvedValue({
      _id: CUSTOMER, totalDue: 5000, toObject: () => ({ _id: CUSTOMER, totalDue: 5000 }),
    });
    jest.spyOn(CustomerBalance, 'findOne').mockReturnValue({ lean: () => Promise.resolve(null) });

    const found = await customerService.getCustomerByPhone(SHOP, '01700000000', separate());
    expect(found.totalDue).toBe(0);
  });

  it('returns null when the phone belongs to nobody', async () => {
    jest.spyOn(Customer, 'findOne').mockResolvedValue(null);
    expect(await customerService.getCustomerByPhone(SHOP, '01700000000', separate())).toBeNull();
  });
});

describe('purchase history', () => {
  const stubHistory = () => {
    jest.spyOn(Customer, 'findOne').mockReturnValue({ populate: () => Promise.resolve({ _id: CUSTOMER, toObject: () => ({ _id: CUSTOMER }) }) });
    const chain = (docs) => ({ sort: () => chain(docs), skip: () => chain(docs), limit: () => chain(docs), lean: () => Promise.resolve(docs) });
    jest.spyOn(Sale, 'find').mockImplementation(() => chain([]));
    jest.spyOn(Payment, 'find').mockImplementation(() => chain([]));
    jest.spyOn(Sale, 'countDocuments').mockResolvedValue(0);
    jest.spyOn(Payment, 'countDocuments').mockResolvedValue(0);
  };

  it('narrows to this branch under separate books', async () => {
    stubHistory();
    jest.spyOn(CustomerBalance, 'findOne').mockReturnValue({ lean: () => Promise.resolve({ totalDue: 0 }) });

    await customerService.getCustomerHistory(SHOP, CUSTOMER, {}, separate());

    expect(Sale.find.mock.calls[0][0]).toMatchObject({ branch: BRANCH });
  });

  it('stays shop-wide under a shared book — a branch SHOULD see other branches\' invoices', async () => {
    // This is the product promise for shared mode, not an oversight.
    stubHistory();
    await customerService.getCustomerHistory(SHOP, CUSTOMER, {}, shared());
    expect(Sale.find.mock.calls[0][0]).not.toHaveProperty('branch');
  });
});

describe('the due list', () => {
  it('reads the branch ledger, sorted and limited before the join', async () => {
    const agg = stubBalanceAggregate([{ _id: CUSTOMER, totalDue: 900 }]);

    const result = await customerService.getCustomersWithDue(SHOP, { limit: 50 }, separate());

    expect(result.summary.totalDue).toBe(900);
    const [pipeline] = agg.mock.calls[0];
    const sortIdx = pipeline.findIndex((s) => s.$sort);
    const lookupIdx = pipeline.findIndex((s) => s.$lookup);
    // Sorting after the $lookup would join every row in the branch first.
    expect(sortIdx).toBeLessThan(lookupIdx);
  });

  it('reads the shop-wide rollup under a shared book', async () => {
    stubCustomerFind([{ _id: CUSTOMER, totalDue: 900 }]);
    const agg = jest.spyOn(CustomerBalance, 'aggregate');
    await customerService.getCustomersWithDue(SHOP, {}, shared());
    expect(agg).not.toHaveBeenCalled();
  });
});

describe('due aging', () => {
  it('filters by branch only under separate books', async () => {
    const agg = jest.spyOn(Sale, 'aggregate').mockResolvedValue([]);

    await customerService.getDueAging(SHOP, separate());
    expect(agg.mock.calls[0][0][0].$match).toHaveProperty('branch');

    agg.mockClear();
    // It used to branch-filter whenever a branch was active, which was wrong
    // under a shared book: one book must age as one book.
    await customerService.getDueAging(SHOP, shared());
    expect(agg.mock.calls[0][0][0].$match).not.toHaveProperty('branch');
  });
});
