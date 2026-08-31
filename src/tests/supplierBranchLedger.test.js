/**
 * Per-branch supplier accounting.
 *
 * The requirement in one line: **the branch the goods were bought for is the
 * branch that owes for them, and the branch that pays is the branch whose cash
 * goes down.**
 *
 * Before this, `Supplier.totalDue` was shop-wide and the supplier payment left
 * no branch trace at all — so a branch holding ৳5,000 could hand a supplier
 * ৳3,000 and its till would still expect ৳5,000 at closing.
 *
 * The invariant every test here protects:
 *
 *     Σ SupplierBalance.totalDue  ===  Supplier.totalDue
 */

const mongoose = require('mongoose');
const SupplierBalance = require('../models/SupplierBalance.model');

const SHOP = new mongoose.Types.ObjectId();
const SUPPLIER = new mongoose.Types.ObjectId();
const BRANCH_A = new mongoose.Types.ObjectId();
const BRANCH_B = new mongoose.Types.ObjectId();

afterEach(() => jest.restoreAllMocks());

describe('schema', () => {
  it('requires a branch — a null-branch row must be impossible', () => {
    // Absence of a row IS the single-branch state. A null-branch row would be a
    // second way to say the same thing and the read paths understand only one.
    expect(SupplierBalance.schema.path('branch').isRequired).toBe(true);
  });

  it('is unique on (shop, supplier, branch) — the upsert key', () => {
    const unique = SupplierBalance.schema.indexes().find(([, opts]) => opts && opts.unique);
    expect(unique[0]).toEqual({ shop: 1, supplier: 1, branch: 1 });
  });

  it('indexes (shop, branch, totalDue) so the payables list sorts from an index', () => {
    const keys = SupplierBalance.schema.indexes().map(([k]) => JSON.stringify(k));
    expect(keys).toContain(JSON.stringify({ shop: 1, branch: 1, totalDue: -1 }));
  });

  it('names the money column totalAmount, matching Supplier not Customer', () => {
    // On a supplier, `totalPurchases` is a COUNT. Borrowing the customer
    // meaning here would have this column silently summing the wrong thing.
    expect(SupplierBalance.schema.path('totalAmount')).toBeDefined();
    expect(SupplierBalance.schema.path('purchaseCount')).toBeDefined();
  });
});

describe('applyDelta', () => {
  it('writes nothing for a single-branch shop', async () => {
    const updateOne = jest.spyOn(SupplierBalance, 'updateOne');
    await SupplierBalance.applyDelta({
      shop: SHOP, supplier: SUPPLIER, branch: null, amount: 5000, due: 5000,
    });
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('writes nothing when the purchase has no supplier', async () => {
    const updateOne = jest.spyOn(SupplierBalance, 'updateOne');
    await SupplierBalance.applyDelta({
      shop: SHOP, supplier: null, branch: BRANCH_A, amount: 5000,
    });
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('increments the branch that bought the goods', async () => {
    const updateOne = jest.spyOn(SupplierBalance, 'updateOne').mockResolvedValue({});

    await SupplierBalance.applyDelta({
      shop: SHOP, supplier: SUPPLIER, branch: BRANCH_A,
      amount: 5000, paid: 2000, due: 3000, count: 1,
    });

    const [filter, update, opts] = updateOne.mock.calls[0];
    expect(filter).toEqual({ shop: SHOP, supplier: SUPPLIER, branch: BRANCH_A });
    expect(update.$inc).toEqual({ totalAmount: 5000, totalPaid: 2000, totalDue: 3000, purchaseCount: 1 });
    expect(opts.upsert).toBe(true);
  });

  it('creates a zero row when there is nothing to add', async () => {
    // A supplier reachable from a branch with no purchases yet is a zero row,
    // not a missing one.
    const updateOne = jest.spyOn(SupplierBalance, 'updateOne').mockResolvedValue({});
    await SupplierBalance.applyDelta({ shop: SHOP, supplier: SUPPLIER, branch: BRANCH_A });
    expect(updateOne.mock.calls[0][1].$setOnInsert).toEqual({ totalDue: 0 });
  });
});

describe('recomputeBalances', () => {
  it('mirrors the Math.max clamp the Supplier rollup uses', async () => {
    // An over-paid supplier clamps at zero on the Supplier document. If the
    // branch row went negative instead, the two books would disagree on
    // exactly the vendors most likely to be looked at.
    const row = { totalAmount: 1000, totalPaid: 4000, totalDue: 0, save: jest.fn() };
    jest.spyOn(SupplierBalance, 'findOne').mockResolvedValue(row);

    await SupplierBalance.recomputeBalances({ shop: SHOP, supplier: SUPPLIER, branch: BRANCH_A });

    expect(row.totalDue).toBe(0);
    expect(row.save).toHaveBeenCalled();
  });

  it('derives due from amount minus paid', async () => {
    const row = { totalAmount: 5000, totalPaid: 3000, totalDue: 999, save: jest.fn() };
    jest.spyOn(SupplierBalance, 'findOne').mockResolvedValue(row);
    await SupplierBalance.recomputeBalances({ shop: SHOP, supplier: SUPPLIER, branch: BRANCH_A });
    expect(row.totalDue).toBe(2000);
  });

  it('is a no-op without a branch', async () => {
    const findOne = jest.spyOn(SupplierBalance, 'findOne');
    expect(await SupplierBalance.recomputeBalances({ shop: SHOP, supplier: SUPPLIER, branch: null })).toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe('overlayBranchFigures', () => {
  it('replaces the money but keeps every supplier in the list', async () => {
    // The list stays shop-wide — a supplier hidden from a branch is a supplier
    // that branch cannot record a purchase against.
    jest.spyOn(SupplierBalance, 'find').mockReturnValue({
      lean: async () => [
        { supplier: SUPPLIER, totalAmount: 5000, totalPaid: 2000, totalDue: 3000, purchaseCount: 1 },
      ],
    });

    const other = new mongoose.Types.ObjectId();
    const result = await SupplierBalance.overlayBranchFigures(
      [
        { _id: SUPPLIER, name: 'Vendor A', totalDue: 9000 },
        { _id: other, name: 'Vendor B', totalDue: 4000 },
      ],
      SHOP,
      BRANCH_A
    );

    expect(result).toHaveLength(2);
    expect(result[0].totalDue).toBe(3000);
    // The shop-wide figure survives alongside, so a screen can show both rather
    // than quietly presenting a smaller number than the owner expects.
    expect(result[0].shopWideDue).toBe(9000);
  });

  it('shows zeros, not absence, for a supplier this branch has not bought from', async () => {
    jest.spyOn(SupplierBalance, 'find').mockReturnValue({ lean: async () => [] });

    const [row] = await SupplierBalance.overlayBranchFigures(
      [{ _id: SUPPLIER, name: 'Vendor A', totalDue: 9000 }],
      SHOP,
      BRANCH_A
    );

    expect(row.totalDue).toBe(0);
    expect(row.shopWideDue).toBe(9000);
  });

  it('returns the shop-wide rollup untouched with no branch selected', async () => {
    // All-Branches and single-branch both land here, and the sum across every
    // branch IS the rollup — so both views are the same numbers.
    const find = jest.spyOn(SupplierBalance, 'find');
    const input = [{ _id: SUPPLIER, name: 'Vendor A', totalDue: 9000 }];

    expect(await SupplierBalance.overlayBranchFigures(input, SHOP, null)).toBe(input);
    expect(find).not.toHaveBeenCalled();
  });
});

describe('the cash register counts supplier payments', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../services/cashRegister.service.js'),
    'utf8'
  );

  it("aggregates Payment type 'purchase_payment' as cash out", () => {
    // This was missing entirely: `Purchase.paid` only covers what was settled
    // at the counter, so a later supplier payment left the drawer with nothing
    // recording it and the till read short by exactly that amount.
    expect(src).toMatch(/type:\s*'purchase_payment'/);
  });

  it('branch-matches that aggregation like every other cash flow', () => {
    // Without `...branchMatch` the payment would count against every branch's
    // till, which is worse than not counting it at all.
    const idx = src.indexOf("type: 'purchase_payment'");
    const window = src.slice(Math.max(0, idx - 400), idx);
    expect(window).toContain('...branchMatch');
  });

  it('adds it to the purchases bucket rather than dropping it', () => {
    expect(src).toMatch(/cashSupplierPayments\[0\]\?\.total/);
  });
});

describe('the purchase service tags supplier payments with a branch', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../services/purchase.service.js'),
    'utf8'
  );

  it("sets branch on the Payment row from the purchase's branch", () => {
    // An untagged payment is invisible to every branch's till. Attributed to
    // the purchase's branch, not the caller's, so an owner in All-Branches
    // still books it against the branch that owed the money.
    expect(src).toMatch(/branch:\s*purchase\.branch\s*\|\|\s*null/);
  });

  it('mirrors every Supplier mutation onto SupplierBalance', () => {
    // Three write paths: create, cancel, pay. Miss one and the Σ invariant
    // breaks silently.
    const mirrors = src.match(/SupplierBalance\.applyDelta/g) || [];
    expect(mirrors.length).toBeGreaterThanOrEqual(3);
  });
});
