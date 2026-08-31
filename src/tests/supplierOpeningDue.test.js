/**
 * Pre-software payables — the supplier-side term with no purchase behind it.
 *
 * The mirror of `openingDue.test.js`, guarding the same class of silent bug on
 * the other side of the book:
 *
 *     totalDue = max(0, totalAmount + openingDue − totalPaid)
 *
 * Every path that RE-DERIVES supplier due rather than `$inc`-ing it has to
 * carry the opening term. There is exactly one such path in the app
 * (`SupplierBalance.recomputeBalances`, reached from purchase-cancel) and one in the
 * repair script, and dropping the term in either is invisible until a shop's
 * carried-over debt quietly disappears from a branch's book.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue([{}]),
}));

// Same stub the customer ledger tests use. Without it every `_applyOpeningDue`
// case spends ten seconds waiting for `startSession` on a database that is not
// there, then falls back — which is the real behaviour, just not one worth
// paying for in a unit test.
jest.mock('../utils/transaction.util', () => ({
  runInTransaction: (fn) => fn(null),
}));

const mongoose = require('mongoose');
const Supplier = require('../models/Supplier.model');
const SupplierBalance = require('../models/SupplierBalance.model');
const SupplierDueAdjustment = require('../models/SupplierDueAdjustment.model');

const SHOP = new mongoose.Types.ObjectId();
const SUPPLIER = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();

afterEach(() => jest.restoreAllMocks());

describe('Supplier schema', () => {
  it('keeps the company name out of the identity, and optional', () => {
    // `{shop, name}` is the unique key. Two reps of one firm are two suppliers,
    // and a firm whose rep changed is not a new supplier — which only holds if
    // the company is its own field.
    const doc = new Supplier({ shop: SHOP, name: 'করিম ভাই' });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.companyName).toBeUndefined();
  });

  it('trims the company name', () => {
    const doc = new Supplier({ shop: SHOP, name: 'করিম', companyName: '  মেসার্স রহমান ট্রেডার্স  ' });
    expect(doc.companyName).toBe('মেসার্স রহমান ট্রেডার্স');
  });

  it('defaults openingDue to zero for every supplier that existed before it', () => {
    // Shops that predate the field must keep their exact figures — a missing
    // value reading as NaN would poison every aggregate summing the column.
    const doc = new Supplier({ shop: SHOP, name: 'করিম' });
    expect(doc.openingDue).toBe(0);
  });
});

describe('SupplierBalance mirrors the formula', () => {
  it('recomputeBalances carries the opening term', async () => {
    // This is the purchase-cancel path. Without the term, cancelling any
    // purchase from a supplier the shop already owed would recompute that
    // branch's due from purchases alone and wipe the carried-over payable,
    // while `Supplier.totalDue` — which only ever $inc's — kept it.
    const row = { totalAmount: 1000, openingDue: 5000, totalPaid: 200, totalDue: 0, save: jest.fn() };
    jest.spyOn(SupplierBalance, 'findOne').mockResolvedValue(row);

    await SupplierBalance.recomputeBalances({ shop: SHOP, supplier: SUPPLIER, branch: BRANCH });

    expect(row.totalDue).toBe(5800);
    expect(row.save).toHaveBeenCalled();
  });

  it('still clamps at zero when the shop has overpaid', async () => {
    const row = { totalAmount: 100, openingDue: 50, totalPaid: 400, totalDue: 0, save: jest.fn() };
    jest.spyOn(SupplierBalance, 'findOne').mockResolvedValue(row);

    await SupplierBalance.recomputeBalances({ shop: SHOP, supplier: SUPPLIER, branch: BRANCH });

    expect(row.totalDue).toBe(0);
  });

  it('applyDelta increments openingDue when asked', async () => {
    const updateOne = jest.spyOn(SupplierBalance, 'updateOne').mockResolvedValue({});

    await SupplierBalance.applyDelta({
      shop: SHOP, supplier: SUPPLIER, branch: BRANCH, opening: 5000, due: 5000,
    });

    const [, update] = updateOne.mock.calls[0];
    expect(update.$inc).toEqual({ totalDue: 5000, openingDue: 5000 });
  });

  it('writes nothing for a single-branch shop', async () => {
    const updateOne = jest.spyOn(SupplierBalance, 'updateOne');
    await SupplierBalance.applyDelta({ shop: SHOP, supplier: SUPPLIER, branch: null, opening: 5000 });
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe('SupplierDueAdjustment schema', () => {
  it('refuses a zero amount', () => {
    const doc = new SupplierDueAdjustment({
      shop: SHOP, supplier: SUPPLIER, amount: 0, createdBy: USER,
    });
    expect(doc.validateSync().errors.amount).toBeTruthy();
  });

  it('allows a negative amount — corrections are rows, not edits', () => {
    const doc = new SupplierDueAdjustment({
      shop: SHOP, supplier: SUPPLIER, amount: -500, createdBy: USER,
    });
    expect(doc.validateSync()).toBeUndefined();
  });

  it('cannot be hard-deleted', () => {
    const doc = new SupplierDueAdjustment({
      shop: SHOP, supplier: SUPPLIER, amount: 100, createdBy: USER,
    });
    return expect(doc.deleteOne()).rejects.toThrow(/cannot be deleted/i);
  });

  it('is a separate collection from the customer ledger', () => {
    // Load-bearing: `customer.service.getDueAging` aggregates `DueAdjustment`
    // on {shop, branch} with NO customer predicate. A supplier row sharing that
    // collection would turn money the shop owes into money it is owed, in the
    // report an owner trusts most.
    const DueAdjustment = require('../models/DueAdjustment.model');
    expect(SupplierDueAdjustment.collection.name).not.toBe(DueAdjustment.collection.name);
  });
});

describe('createSupplier opening due', () => {
  const supplierService = require('../services/supplier.service');

  const baseReq = (isOwner) => ({
    shop: { _id: SHOP, multiBranchEnabled: false },
    user: { isOwner },
  });

  it('refuses a non-zero opening due from a non-owner', async () => {
    // The route only checks `suppliers.create`, which a cashier holds. Writing
    // a payable out of nothing is the part that must be owner-only, so the
    // check lives on the field rather than the endpoint.
    await expect(
      supplierService.createSupplier(SHOP, USER,
        { name: 'করিম', openingDue: 5000 }, baseReq(false))
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects a negative opening due', async () => {
    await expect(
      supplierService.createSupplier(SHOP, USER, { name: 'করিম', openingDue: -1 }, baseReq(true))
    ).rejects.toThrow();
  });

  it('lets a non-owner create a supplier with no opening due', async () => {
    jest.spyOn(Supplier, 'findOne').mockResolvedValue(null);
    jest.spyOn(Supplier, 'create').mockResolvedValue({ _id: SUPPLIER, name: 'করিম' });
    jest.spyOn(SupplierBalance, 'applyDelta').mockResolvedValue(null);
    const apply = jest.spyOn(supplierService, '_applyOpeningDue');

    await supplierService.createSupplier(SHOP, USER, { name: 'করিম' }, baseReq(false));

    expect(apply).not.toHaveBeenCalled();
  });

  it('opens a zero balance row for the creating branch', async () => {
    // Without it the supplier is invisible at the branch that just added them
    // until their first purchase.
    jest.spyOn(Supplier, 'findOne').mockResolvedValue(null);
    jest.spyOn(Supplier, 'create').mockResolvedValue({ _id: SUPPLIER, name: 'করিম' });
    const delta = jest.spyOn(SupplierBalance, 'applyDelta').mockResolvedValue(null);

    await supplierService.createSupplier(SHOP, USER, { name: 'করিম' }, {
      shop: { _id: SHOP, multiBranchEnabled: true },
      branchId: BRANCH,
      user: { isOwner: true },
    });

    expect(delta).toHaveBeenCalledWith({ shop: SHOP, supplier: SUPPLIER, branch: BRANCH });
  });

  it('lets an owner in All-Branches add a supplier with no branch selected', async () => {
    // Suppliers are shop-wide — every branch buys from the same vendors — so
    // unlike `createCustomer` this must NOT demand a branch. Only the opening
    // due does, because only it lands in one branch's book.
    jest.spyOn(Supplier, 'findOne').mockResolvedValue(null);
    jest.spyOn(Supplier, 'create').mockResolvedValue({ _id: SUPPLIER, name: 'করিম' });
    const delta = jest.spyOn(SupplierBalance, 'applyDelta').mockResolvedValue(null);

    const supplier = await supplierService.createSupplier(SHOP, USER, { name: 'করিম' }, {
      shop: { _id: SHOP, multiBranchEnabled: true },
      branchId: null,
      user: { isOwner: true },
    });

    expect(supplier._id).toBe(SUPPLIER);
    expect(delta).toHaveBeenCalledWith({ shop: SHOP, supplier: SUPPLIER, branch: null });
  });

  it('still demands a branch when an opening due is attached', async () => {
    jest.spyOn(Supplier, 'findOne').mockResolvedValue(null);
    jest.spyOn(Supplier, 'create').mockResolvedValue({ _id: SUPPLIER, name: 'করিম', isActive: true });
    jest.spyOn(SupplierBalance, 'applyDelta').mockResolvedValue(null);

    await expect(
      supplierService.createSupplier(SHOP, USER, { name: 'করিম', openingDue: 5000 }, {
        shop: { _id: SHOP, multiBranchEnabled: true },
        branchId: null,
        user: { isOwner: true },
      })
    ).rejects.toMatchObject({ code: 'BRANCH_REQUIRED' });
  });

  it('stores the company name alongside the person', async () => {
    jest.spyOn(Supplier, 'findOne').mockResolvedValue(null);
    jest.spyOn(SupplierBalance, 'applyDelta').mockResolvedValue(null);
    const create = jest.spyOn(Supplier, 'create').mockResolvedValue({ _id: SUPPLIER, name: 'করিম' });

    await supplierService.createSupplier(SHOP, USER,
      { name: '  করিম ভাই ', companyName: '  রহমান ট্রেডার্স ' }, baseReq(true));

    expect(create.mock.calls[0][0]).toMatchObject({
      name: 'করিম ভাই',
      companyName: 'রহমান ট্রেডার্স',
    });
  });
});

describe('setOpeningDue', () => {
  const supplierService = require('../services/supplier.service');
  const ownerReq = { shop: { _id: SHOP, multiBranchEnabled: false }, user: { isOwner: true } };

  it('takes a target figure and applies the difference', async () => {
    // The owner answers "খাতায় কত দিতে হতো", not "কত বাড়াতে হবে".
    jest.spyOn(Supplier, 'findOne').mockReturnValue({ lean: async () => ({ _id: SUPPLIER, openingDue: 2000 }) });
    const apply = jest.spyOn(supplierService, '_applyOpeningDue').mockResolvedValue({ applied: 3000 });

    await supplierService.setOpeningDue(SHOP, USER, SUPPLIER, { openingDue: 5000 }, ownerReq);

    expect(apply.mock.calls[0][3].amount).toBe(3000);
  });

  it('measures the delta against the BRANCH figure the owner was shown', async () => {
    // The list and detail overlay a branch's `openingDue`, so subtracting the
    // shop-wide one turns "no change" into a large write-down — the exact bug
    // documented on `customer.service.setOpeningDue`.
    jest.spyOn(Supplier, 'findOne').mockReturnValue({
      lean: async () => ({ _id: SUPPLIER, openingDue: 15000 }),
    });
    jest.spyOn(SupplierBalance, 'findOne').mockReturnValue({
      lean: async () => ({ openingDue: 5000 }),
    });
    const apply = jest.spyOn(supplierService, '_applyOpeningDue').mockResolvedValue({ applied: 0 });

    await supplierService.setOpeningDue(SHOP, USER, SUPPLIER, { openingDue: 5000 }, {
      shop: { _id: SHOP, multiBranchEnabled: true },
      branchId: BRANCH,
      user: { isOwner: true },
    });

    expect(apply).not.toHaveBeenCalled();
  });

  it('writes nothing when the figure is unchanged', async () => {
    jest.spyOn(Supplier, 'findOne').mockReturnValue({ lean: async () => ({ _id: SUPPLIER, openingDue: 2000 }) });
    const apply = jest.spyOn(supplierService, '_applyOpeningDue');

    const result = await supplierService.setOpeningDue(SHOP, USER, SUPPLIER, { openingDue: 2000 }, ownerReq);

    expect(apply).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
  });

  it('rejects a negative target — this shop does not track supplier advances', async () => {
    await expect(
      supplierService.setOpeningDue(SHOP, USER, SUPPLIER, { openingDue: -100 }, ownerReq)
    ).rejects.toThrow();
  });

  it('refuses a non-owner even though the route is the gate', async () => {
    await expect(
      supplierService.setOpeningDue(SHOP, USER, SUPPLIER, { openingDue: 100 }, {
        shop: { _id: SHOP, multiBranchEnabled: false }, user: { isOwner: false },
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('_applyOpeningDue', () => {
  const supplierService = require('../services/supplier.service');
  const ownerReq = { shop: { _id: SHOP, multiBranchEnabled: false }, user: { isOwner: true } };

  const stubSupplier = (doc) => {
    jest.spyOn(Supplier, 'findOne').mockReturnValue({ session: () => Promise.resolve(doc) });
  };

  it('moves openingDue and totalDue together', async () => {
    const doc = { _id: SUPPLIER, name: 'করিম', isActive: true, openingDue: 0, totalDue: 0, save: jest.fn() };
    stubSupplier(doc);
    jest.spyOn(SupplierDueAdjustment, 'create').mockResolvedValue([{ _id: new mongoose.Types.ObjectId() }]);
    jest.spyOn(SupplierBalance, 'applyDelta').mockResolvedValue(null);

    const { applied } = await supplierService._applyOpeningDue(
      SHOP, USER, SUPPLIER, { amount: 5000, kind: 'opening' }, ownerReq
    );

    expect(applied).toBe(5000);
    expect(doc.openingDue).toBe(5000);
    expect(doc.totalDue).toBe(5000);
  });

  it('caps a reduction at what is actually owed', async () => {
    // Otherwise `openingDue` lands at −৳300 while `totalDue` clamps at 0, and
    // the two rollups disagree forever.
    const doc = { _id: SUPPLIER, name: 'করিম', isActive: true, openingDue: 200, totalDue: 200, save: jest.fn() };
    stubSupplier(doc);
    jest.spyOn(SupplierDueAdjustment, 'create').mockResolvedValue([{ _id: new mongoose.Types.ObjectId() }]);
    jest.spyOn(SupplierBalance, 'applyDelta').mockResolvedValue(null);

    const { applied } = await supplierService._applyOpeningDue(
      SHOP, USER, SUPPLIER, { amount: -500, kind: 'adjustment' }, ownerReq
    );

    expect(applied).toBe(-200);
    expect(doc.openingDue).toBe(0);
    expect(doc.totalDue).toBe(0);
  });

  it('caps a reduction against the BRANCH row when one is active', async () => {
    const doc = { _id: SUPPLIER, name: 'করিম', isActive: true, openingDue: 15000, totalDue: 15000, save: jest.fn() };
    stubSupplier(doc);
    // Read twice, in two shapes: `.lean()` for the reduction floor, and as a
    // savable document by `recomputeBalances`, which re-derives both halves
    // after the delta lands. One fixture answers both.
    jest.spyOn(SupplierBalance, 'findOne').mockReturnValue({
      openingDue: 5000, totalDue: 5000, totalAmount: 0, totalPaid: 0, advanceBalance: 0,
      save: jest.fn().mockResolvedValue(undefined),
      lean: async () => ({ openingDue: 5000, totalDue: 5000 }),
    });
    jest.spyOn(SupplierDueAdjustment, 'create').mockResolvedValue([{ _id: new mongoose.Types.ObjectId() }]);
    jest.spyOn(SupplierBalance, 'applyDelta').mockResolvedValue(null);

    const { applied } = await supplierService._applyOpeningDue(
      SHOP, USER, SUPPLIER, { amount: -9000, kind: 'adjustment' },
      { shop: { _id: SHOP, multiBranchEnabled: true }, branchId: BRANCH, user: { isOwner: true } }
    );

    // Only this branch's ৳5,000 could be given up — the other branch's debt is
    // not this correction's to erase.
    expect(applied).toBe(-5000);
  });

  it('writes no row when the reduction cannot move anything', async () => {
    const doc = { _id: SUPPLIER, name: 'করিম', isActive: true, openingDue: 0, totalDue: 0, save: jest.fn() };
    stubSupplier(doc);
    const create = jest.spyOn(SupplierDueAdjustment, 'create');

    const { applied } = await supplierService._applyOpeningDue(
      SHOP, USER, SUPPLIER, { amount: -500, kind: 'adjustment' }, ownerReq
    );

    expect(applied).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('refuses to add debt to a soft-deleted supplier', async () => {
    // Reachable from the other side: delete at ৳0, then add the opening due on
    // a page still open behind you, and the shop owes money no `isActive`
    // screen will ever show.
    stubSupplier({ _id: SUPPLIER, name: 'করিম', isActive: false, openingDue: 0, totalDue: 0, save: jest.fn() });

    await expect(
      supplierService._applyOpeningDue(SHOP, USER, SUPPLIER, { amount: 500, kind: 'opening' }, ownerReq)
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
