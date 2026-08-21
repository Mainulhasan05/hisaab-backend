/**
 * Every screen that answers "how much is owed" must answer it the same way.
 *
 * The bug these guard against is not a wrong formula — each figure below was
 * individually defensible. It is that four screens counted four different
 * populations and no two of them agreed, which to a shop owner reads as the
 * software losing their money. One real shop:
 *
 *   dashboard, All branches   ৳15,513,302   Customer, isActive: true
 *   dashboard, আক্কেলপুর      ৳14,980,592   CustomerBalance, no isActive filter
 *   dashboard, নয়াগোলা          ৳639,015   ditto
 *   customer list, আক্কেলপুর     ৳788,947   sum of the twenty rows on screen
 *
 * The branch tiles summed to ৳15,619,607 against an All-Branches ৳15,513,302,
 * and the list figure changed on every re-sort.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));

jest.mock('../utils/transaction.util', () => ({
  runInTransaction: (fn) => fn(null),
}));

const mongoose = require('mongoose');
const customerService = require('../services/customer.service');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const DueAdjustment = require('../models/DueAdjustment.model');

const SHOP = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();
const BRANCH_A = new mongoose.Types.ObjectId();
const BRANCH_B = new mongoose.Types.ObjectId();

const separate = () => ({
  shop: { _id: SHOP, multiBranchEnabled: true, customerScope: 'branch' },
  branchId: BRANCH_A,
  user: { isOwner: true },
});
const shared = () => ({
  shop: { _id: SHOP, multiBranchEnabled: true, customerScope: 'shop' },
  branchId: BRANCH_A,
  user: { isOwner: true },
});

afterEach(() => jest.restoreAllMocks());

describe('the customer list totals the book, not the page', () => {
  it('reports the whole filtered set under separate books', async () => {
    // Twenty rows on screen, ৳14,871,082 owed across 127 debtors. The old code
    // returned no summary at all and the page summed what it could see.
    jest.spyOn(CustomerBalance, 'aggregate').mockResolvedValue([{
      data: [{ _id: CUSTOMER, name: 'করিম', totalDue: 5000 }],
      count: [{ total: 127 }],
      totals: [{ totalDue: 14871082, totalPurchases: 0, customersWithDue: 127 }],
    }]);

    const result = await customerService.getCustomers(SHOP, { hasDue: 'true' }, separate());

    expect(result.summary.totalDue).toBe(14871082);
    expect(result.summary.customersWithDue).toBe(127);
    // The rows stay paginated — only the totals describe everything.
    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(127);
  });

  it('asks the same question over the whole set that it applies to the page', async () => {
    const agg = jest.spyOn(CustomerBalance, 'aggregate').mockResolvedValue([{}]);

    await customerService.getCustomers(SHOP, { hasDue: 'true' }, separate());

    const [pipeline] = agg.mock.calls[0];
    const facet = pipeline.find((s) => s.$facet).$facet;
    // The totals sit INSIDE the same $facet as `data` and `count`, downstream of
    // the one $match and the one isActive join. A second pipeline could drift
    // from the filter it is supposed to be describing; this cannot.
    expect(facet.totals).toBeDefined();
    expect(facet.data).toBeDefined();
    expect(facet.count).toBeDefined();
  });

  it('zero-fills rather than returning undefined for an empty branch', async () => {
    // A branch with no customers must read ৳0, not blank.
    jest.spyOn(CustomerBalance, 'aggregate').mockResolvedValue([{ data: [], count: [], totals: [] }]);

    const result = await customerService.getCustomers(SHOP, {}, separate());

    expect(result.summary).toEqual({ totalDue: 0, totalPurchases: 0, customersWithDue: 0 });
  });

  it('returns the same shape under a shared book', async () => {
    // Both modes hand the page an identical `summary` so it never branches.
    const chain = {
      select: () => chain, sort: () => chain, skip: () => chain, limit: () => chain,
      lean: () => Promise.resolve([{ _id: CUSTOMER, totalDue: 500 }]),
    };
    jest.spyOn(Customer, 'find').mockReturnValue(chain);
    jest.spyOn(Customer, 'countDocuments').mockResolvedValue(90);
    jest.spyOn(Customer, 'aggregate').mockResolvedValue([
      { totalDue: 15513302, totalPurchases: 12000, customersWithDue: 142 },
    ]);

    const result = await customerService.getCustomers(SHOP, {}, shared());

    expect(result.summary).toEqual({
      totalDue: 15513302, totalPurchases: 12000, customersWithDue: 142,
    });
  });

  it('casts the shop id for the aggregation, which will not coerce it', async () => {
    // `find` coerces a string id; the aggregation framework does not, and an
    // unmatched $match here reads as "this shop is owed ৳0" rather than erroring.
    const chain = {
      select: () => chain, sort: () => chain, skip: () => chain, limit: () => chain,
      lean: () => Promise.resolve([]),
    };
    jest.spyOn(Customer, 'find').mockReturnValue(chain);
    jest.spyOn(Customer, 'countDocuments').mockResolvedValue(0);
    const agg = jest.spyOn(Customer, 'aggregate').mockResolvedValue([]);

    await customerService.getCustomers(String(SHOP), {}, shared());

    const [[match]] = agg.mock.calls[0];
    expect(match.$match.shop).toBeInstanceOf(mongoose.Types.ObjectId);
  });
});

describe('getCustomersWithDue counts every debtor, not the top fifty', () => {
  it('summarises the whole book while returning a capped list', async () => {
    jest.spyOn(customerService, '_topBranchBalances').mockResolvedValue(
      Array.from({ length: 50 }, () => ({ _id: CUSTOMER, totalDue: 1000 }))
    );
    jest.spyOn(CustomerBalance, 'aggregate').mockResolvedValue([
      { totalDue: 14871082, count: 127 },
    ]);

    const result = await customerService.getCustomersWithDue(SHOP, {}, separate());

    expect(result.summary.totalDue).toBe(14871082);
    expect(result.summary.count).toBe(127);
    // The size of the slice is still knowable, just no longer mistaken for the
    // size of the book.
    expect(result.summary.returned).toBe(50);
    expect(result.customers).toHaveLength(50);
  });
});

describe('a due reduction lands on the branch that holds the debt', () => {
  const stubCustomer = (doc) => {
    const customer = { ...doc, save: jest.fn().mockResolvedValue(true) };
    jest.spyOn(Customer, 'findOne').mockReturnValue({ session: () => customer });
    return customer;
  };

  const row = (branch, amount) => ({
    branch,
    totalDue: amount,
    openingDue: amount,
    save: jest.fn().mockResolvedValue(true),
  });

  beforeEach(() => {
    jest.spyOn(DueAdjustment, 'create').mockResolvedValue([{ _id: new mongoose.Types.ObjectId() }]);
    // `_applyDueAdjustment` re-derives the branch row after moving the opening
    // figure, rather than `$inc`-ing its due — see the netting note there. It is
    // a real read, so it has to be stubbed alongside `applyDelta` or these
    // tests hang on a database that is not there.
    jest.spyOn(CustomerBalance, 'recomputeBalances').mockResolvedValue(null);
  });

  it('does not push the correcting branch negative', async () => {
    // The original failure: ৳3,835 of opening due typed at BRANCH_B, corrected
    // from BRANCH_A. `applyDelta` put −৳3,835 on A and left B at +৳3,835 —
    // shop-wide nets to zero so nothing alerted, while one branch dashboard was
    // overstated and the other showed a due below zero.
    const customer = stubCustomer({ _id: CUSTOMER, openingDue: 3835, totalDue: 3835, isActive: true });
    const rowA = row(BRANCH_A, 0);
    const rowB = row(BRANCH_B, 3835);
    jest.spyOn(CustomerBalance, 'find').mockReturnValue({ sort: () => [rowA, rowB] });
    const applyDelta = jest.spyOn(CustomerBalance, 'applyDelta').mockResolvedValue(null);

    await customerService._applyDueAdjustment(
      SHOP, new mongoose.Types.ObjectId(), CUSTOMER,
      { amount: -3835, kind: 'adjustment' },
      shared() // shared book: the reduction may cross branches
    );

    expect(rowA.totalDue).toBe(0);      // untouched — it never held the debt
    expect(rowB.totalDue).toBe(0);      // where the money actually was
    expect(rowB.openingDue).toBe(0);
    // The blanket write is what caused the bug; the allocator replaces it.
    expect(applyDelta).not.toHaveBeenCalled();
    expect(customer.totalDue).toBe(0);  // Σ branches === Customer.totalDue
  });

  it('under separate books a branch may only write down its own receivable', async () => {
    // Same rule `collectDuePayment` already enforces for cash. Here BRANCH_A
    // holds ৳1,000 and asks to remove ৳3,835; only its own ৳1,000 may go.
    const customer = stubCustomer({ _id: CUSTOMER, openingDue: 4835, totalDue: 4835, isActive: true });
    const rowA = row(BRANCH_A, 1000);
    const find = jest.spyOn(CustomerBalance, 'find').mockReturnValue({ sort: () => [rowA] });

    const { applied } = await customerService._applyDueAdjustment(
      SHOP, new mongoose.Types.ObjectId(), CUSTOMER,
      { amount: -3835, kind: 'adjustment' },
      separate()
    );

    // The query itself is narrowed to this branch — the other branch's row is
    // never even loaded, so it cannot be reached by a later change here.
    expect(find.mock.calls[0][0].branch).toBe(BRANCH_A);
    expect(applied).toBe(-1000);
    expect(rowA.totalDue).toBe(0);
    expect(customer.totalDue).toBe(3835); // BRANCH_B's ৳3,835 is untouched
  });

  it('cannot take back more opening debt than a branch still holds', async () => {
    // The branch's opening due reads ৳5,000 but ৳4,000 has since been paid, so
    // only ৳1,000 of claim remains to give back.
    stubCustomer({ _id: CUSTOMER, openingDue: 5000, totalDue: 1000, isActive: true });
    const rowA = { branch: BRANCH_A, totalDue: 1000, openingDue: 5000, save: jest.fn() };
    jest.spyOn(CustomerBalance, 'find').mockReturnValue({ sort: () => [rowA] });

    const { applied } = await customerService._applyDueAdjustment(
      SHOP, new mongoose.Types.ObjectId(), CUSTOMER,
      { amount: -5000, kind: 'adjustment' },
      separate()
    );

    expect(applied).toBe(-1000);
    expect(rowA.totalDue).toBe(0);
    expect(rowA.openingDue).toBe(4000);
  });

  it('still charges an INCREASE to the branch entering it', async () => {
    // New debt is incurred where it is recorded; only reductions are allocated.
    const customer = stubCustomer({ _id: CUSTOMER, openingDue: 0, totalDue: 0, isActive: true });
    const applyDelta = jest.spyOn(CustomerBalance, 'applyDelta').mockResolvedValue(null);

    await customerService._applyDueAdjustment(
      SHOP, new mongoose.Types.ObjectId(), CUSTOMER,
      { amount: 5000, kind: 'opening' },
      separate()
    );

    // `opening` only — no `due` delta. The row's due is DERIVED right after, so
    // that an increase applied to a branch holding customer credit nets against
    // the credit instead of leaving the row owing and in credit at once.
    expect(applyDelta.mock.calls[0][0]).toMatchObject({ branch: BRANCH_A, opening: 5000 });
    expect(applyDelta.mock.calls[0][0].due).toBeUndefined();
    expect(CustomerBalance.recomputeBalances).toHaveBeenCalledWith(
      expect.objectContaining({ branch: BRANCH_A }),
      null
    );
    expect(customer.totalDue).toBe(5000);
  });

  it('falls back to the shop-wide floor when no branch rows exist at all', async () => {
    // Pre-Phase-7 history. Refusing outright would make the correction silently
    // do nothing, which is worse than the drift it is fixing.
    stubCustomer({ _id: CUSTOMER, openingDue: 2000, totalDue: 2000, isActive: true });
    jest.spyOn(CustomerBalance, 'find').mockReturnValue({ sort: () => [] });
    const applyDelta = jest.spyOn(CustomerBalance, 'applyDelta').mockResolvedValue(null);

    const { applied } = await customerService._applyDueAdjustment(
      SHOP, new mongoose.Types.ObjectId(), CUSTOMER,
      { amount: -2000, kind: 'adjustment' },
      separate()
    );

    expect(applied).toBe(-2000);
    expect(applyDelta).toHaveBeenCalled();
  });
});

describe('debt cannot be written onto a deleted customer', () => {
  it('refuses to add due to a soft-deleted customer', async () => {
    // The exact sequence one shop hit: create → opening ৳106,305 → correct to
    // ৳0 → delete (allowed, the guard saw ৳0) → add ৳106,305 again on the page
    // still open behind them. The result was ৳106,305 that the all-branches
    // dashboard filtered out and the branch dashboard counted.
    jest.spyOn(Customer, 'findOne').mockReturnValue({
      session: () => ({ _id: CUSTOMER, isActive: false, openingDue: 0, totalDue: 0 }),
    });

    await expect(
      customerService._applyDueAdjustment(
        SHOP, new mongoose.Types.ObjectId(), CUSTOMER,
        { amount: 106305, kind: 'opening' },
        separate()
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('still allows a REDUCTION on a deleted customer', async () => {
    // Clearing the balance is how such a record gets cleaned up. Blocking it
    // would leave the money stranded with no way to write it off.
    const customer = {
      _id: CUSTOMER, isActive: false, openingDue: 500, totalDue: 500,
      save: jest.fn().mockResolvedValue(true),
    };
    jest.spyOn(Customer, 'findOne').mockReturnValue({ session: () => customer });
    jest.spyOn(CustomerBalance, 'find').mockReturnValue({
      sort: () => [{ branch: BRANCH_A, totalDue: 500, openingDue: 500, save: jest.fn() }],
    });
    jest.spyOn(DueAdjustment, 'create').mockResolvedValue([{ _id: new mongoose.Types.ObjectId() }]);

    const { applied } = await customerService._applyDueAdjustment(
      SHOP, new mongoose.Types.ObjectId(), CUSTOMER,
      { amount: -500, kind: 'adjustment' },
      separate()
    );

    expect(applied).toBe(-500);
    expect(customer.totalDue).toBe(0);
  });
});

describe('setOpeningDue measures against the figure on screen', () => {
  it('uses the BRANCH opening due under separate books', async () => {
    // The form shows what `getCustomerById` returned, which under separate books
    // is the branch's figure. Restating ৳5,000 to ৳5,000 must be a no-op, not a
    // ৳10,000 write-down computed against a shop-wide ৳15,000.
    jest.spyOn(Customer, 'findOne').mockReturnValue({
      lean: async () => ({ _id: CUSTOMER, openingDue: 15000 }),
    });
    jest.spyOn(CustomerBalance, 'findOne').mockReturnValue({
      lean: async () => ({ openingDue: 5000 }),
    });
    const apply = jest.spyOn(customerService, '_applyDueAdjustment').mockResolvedValue({ applied: 0 });

    const result = await customerService.setOpeningDue(
      SHOP, new mongoose.Types.ObjectId(), CUSTOMER, { openingDue: 5000 }, separate()
    );

    expect(apply).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
  });

  it('computes the branch delta, not the shop-wide one', async () => {
    jest.spyOn(Customer, 'findOne').mockReturnValue({
      lean: async () => ({ _id: CUSTOMER, openingDue: 15000 }),
    });
    jest.spyOn(CustomerBalance, 'findOne').mockReturnValue({
      lean: async () => ({ openingDue: 5000 }),
    });
    const apply = jest.spyOn(customerService, '_applyDueAdjustment').mockResolvedValue({ applied: 2000 });

    await customerService.setOpeningDue(
      SHOP, new mongoose.Types.ObjectId(), CUSTOMER, { openingDue: 7000 }, separate()
    );

    expect(apply.mock.calls[0][3].amount).toBe(2000);
  });

  it('still uses the shop-wide figure under a shared book', async () => {
    jest.spyOn(Customer, 'findOne').mockReturnValue({
      lean: async () => ({ _id: CUSTOMER, openingDue: 15000 }),
    });
    const balance = jest.spyOn(CustomerBalance, 'findOne');
    const apply = jest.spyOn(customerService, '_applyDueAdjustment').mockResolvedValue({ applied: -5000 });

    await customerService.setOpeningDue(
      SHOP, new mongoose.Types.ObjectId(), CUSTOMER, { openingDue: 10000 }, shared()
    );

    expect(balance).not.toHaveBeenCalled();
    expect(apply.mock.calls[0][3].amount).toBe(-5000);
  });
});

describe('CustomerBalance.reduceOpening', () => {
  it('reports null — not zero — when the customer has no rows', async () => {
    // The caller needs these apart: "nothing to allocate against" falls back to
    // the shop-wide floor, "rows exist but hold nothing" must not.
    jest.spyOn(CustomerBalance, 'find').mockReturnValue({ sort: () => [] });

    const result = await CustomerBalance.reduceOpening({
      shop: SHOP, customer: CUSTOMER, preferBranch: BRANCH_A, amount: 100,
    });

    expect(result).toBeNull();
  });

  it('settles the collecting branch first, then the oldest debt', async () => {
    const oldest = { branch: BRANCH_B, totalDue: 1000, openingDue: 1000, save: jest.fn() };
    const own = { branch: BRANCH_A, totalDue: 600, openingDue: 600, save: jest.fn() };
    // `find` returns oldest-first; the preference re-sort runs on top of it.
    jest.spyOn(CustomerBalance, 'find').mockReturnValue({ sort: () => [oldest, own] });

    const applied = await CustomerBalance.reduceOpening({
      shop: SHOP, customer: CUSTOMER, preferBranch: BRANCH_A, amount: 800,
    });

    expect(applied).toBe(800);
    expect(own.totalDue).toBe(0);       // own book cleared first
    expect(oldest.totalDue).toBe(800);  // remaining ৳200 came off the oldest
  });

  it('never takes a row below zero', async () => {
    const only = { branch: BRANCH_A, totalDue: 300, openingDue: 300, save: jest.fn() };
    jest.spyOn(CustomerBalance, 'find').mockReturnValue({ sort: () => [only] });

    const applied = await CustomerBalance.reduceOpening({
      shop: SHOP, customer: CUSTOMER, preferBranch: BRANCH_A, amount: 5000,
    });

    expect(applied).toBe(300);
    expect(only.totalDue).toBe(0);
  });
});
