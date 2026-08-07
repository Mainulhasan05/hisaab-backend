/**
 * Phase 7 — the per-branch ledger's own arithmetic.
 *
 * The Σ invariant this collection lives or dies by:
 *
 *     Σ CustomerBalance.totalDue  ===  Customer.totalDue
 *
 * Everything here exists to keep that true, so most of these tests are really
 * about what must NOT happen: no row for a single-branch shop, no branch driven
 * negative by a collection it did not earn, no silent loss of a remainder.
 */

const mongoose = require('mongoose');
const CustomerBalance = require('../models/CustomerBalance.model');

const SHOP = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();
const BRANCH_A = new mongoose.Types.ObjectId();
const BRANCH_B = new mongoose.Types.ObjectId();

afterEach(() => jest.restoreAllMocks());

describe('schema', () => {
  it('requires a branch — a null-branch row must be impossible', () => {
    // Absence of a row IS the single-branch state. A null-branch row would be a
    // second way to say the same thing, and the read paths only understand one.
    expect(CustomerBalance.schema.path('branch').isRequired).toBe(true);
  });

  it('is unique on (shop, customer, branch) — the upsert key', () => {
    const indexes = CustomerBalance.schema.indexes();
    const unique = indexes.find(([, opts]) => opts && opts.unique);
    expect(unique[0]).toEqual({ shop: 1, customer: 1, branch: 1 });
  });

  it('indexes (shop, branch, totalDue) so the due list sorts and pages from an index', () => {
    // This is the whole reason the ledger is its own collection rather than an
    // array on Customer, where the same query means $unwind + in-memory sort.
    const keys = CustomerBalance.schema.indexes().map(([k]) => JSON.stringify(k));
    expect(keys).toContain(JSON.stringify({ shop: 1, branch: 1, totalDue: -1 }));
  });
});

describe('applyDelta', () => {
  it('writes nothing when there is no branch — single-branch shops stay untouched', async () => {
    const updateOne = jest.spyOn(CustomerBalance, 'updateOne');
    const result = await CustomerBalance.applyDelta({
      shop: SHOP, customer: CUSTOMER, branch: null, purchases: 500, due: 500,
    });
    expect(result).toBeNull();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('writes nothing for a walk-in with no customer record', async () => {
    const updateOne = jest.spyOn(CustomerBalance, 'updateOne');
    await CustomerBalance.applyDelta({ shop: SHOP, customer: null, branch: BRANCH_A, due: 500 });
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('increments, keyed on the (shop, customer, branch) triple', async () => {
    const updateOne = jest.spyOn(CustomerBalance, 'updateOne').mockResolvedValue({});
    await CustomerBalance.applyDelta({
      shop: SHOP, customer: CUSTOMER, branch: BRANCH_A,
      purchases: 1000, paid: 400, due: 600, count: 1,
    });

    const [filter, update, options] = updateOne.mock.calls[0];
    expect(filter).toEqual({ shop: SHOP, customer: CUSTOMER, branch: BRANCH_A });
    expect(update.$inc).toEqual({ totalPurchases: 1000, totalPaid: 400, totalDue: 600, purchaseCount: 1 });
    expect(options.upsert).toBe(true);
  });

  it('carries negative deltas through unchanged, for cancellations and returns', async () => {
    const updateOne = jest.spyOn(CustomerBalance, 'updateOne').mockResolvedValue({});
    await CustomerBalance.applyDelta({
      shop: SHOP, customer: CUSTOMER, branch: BRANCH_A,
      purchases: -1000, paid: -400, due: -600, count: -1,
    });
    expect(updateOne.mock.calls[0][1].$inc.totalDue).toBe(-600);
  });

  it('still upserts a row for an all-zero delta', async () => {
    // Creating a customer at a branch is a zero delta, and the row is the only
    // thing that makes them visible there.
    const updateOne = jest.spyOn(CustomerBalance, 'updateOne').mockResolvedValue({});
    await CustomerBalance.applyDelta({ shop: SHOP, customer: CUSTOMER, branch: BRANCH_A });

    const [, update, options] = updateOne.mock.calls[0];
    expect(options.upsert).toBe(true);
    expect(update.$inc).toBeUndefined();
    expect(update.$setOnInsert).toEqual({ totalDue: 0 });
  });
});

describe('settleDue — allocating a collection across branches', () => {
  /** Stub CustomerBalance.find(...).sort(...) with rows that record their saves. */
  const stubRows = (rows) => {
    const docs = rows.map((r) => ({ ...r, save: jest.fn().mockResolvedValue(undefined) }));
    jest.spyOn(CustomerBalance, 'find').mockReturnValue({ sort: () => Promise.resolve(docs) });
    return docs;
  };

  it('settles the collecting branch first', async () => {
    const [a, b] = stubRows([
      { branch: BRANCH_B, totalDue: 1000, totalPaid: 0 },
      { branch: BRANCH_A, totalDue: 1000, totalPaid: 0 },
    ]);

    const applied = await CustomerBalance.settleDue({
      shop: SHOP, customer: CUSTOMER, preferBranch: BRANCH_A, amount: 400,
    });

    expect(applied).toEqual([{ branch: BRANCH_A, amount: 400 }]);
    expect(b.totalDue).toBe(600); // BRANCH_A's row, moved to the front
    expect(a.totalDue).toBe(1000); // BRANCH_B untouched
  });

  it('spills to other branches oldest-first once the collecting branch is clear', async () => {
    const [older, collecting] = stubRows([
      { branch: BRANCH_B, totalDue: 1000, totalPaid: 0 },
      { branch: BRANCH_A, totalDue: 300, totalPaid: 0 },
    ]);

    const applied = await CustomerBalance.settleDue({
      shop: SHOP, customer: CUSTOMER, preferBranch: BRANCH_A, amount: 800,
    });

    expect(applied).toEqual([
      { branch: BRANCH_A, amount: 300 },
      { branch: BRANCH_B, amount: 500 },
    ]);
    expect(collecting.totalDue).toBe(0);
    expect(older.totalDue).toBe(500);
  });

  it('never drives a branch negative', async () => {
    // The failure this prevents: crediting a shared-book collection wholesale
    // to the collecting branch leaves it at −৳3,000 while the owing branch
    // stays at +৳3,000. The sum looks right, so nothing appears broken — until
    // the shop flips to separate books and a negative balance appears from
    // nowhere. That would cost the toggle its "flip any time" property.
    const rows = stubRows([
      { branch: BRANCH_B, totalDue: 3000, totalPaid: 0 },
      { branch: BRANCH_A, totalDue: 0, totalPaid: 0 },
    ]);

    await CustomerBalance.settleDue({
      shop: SHOP, customer: CUSTOMER, preferBranch: BRANCH_A, amount: 3000,
    });

    rows.forEach((r) => expect(r.totalDue).toBeGreaterThanOrEqual(0));
    expect(rows.find((r) => r.branch === BRANCH_B).totalDue).toBe(0);
  });

  it('parks a remainder on the collecting branch so the Σ invariant survives', async () => {
    // Real only for history predating Phase 7: shop-wide due with no rows to
    // reduce. Dropping the remainder would break Σ branch === Customer.totalDue.
    stubRows([{ branch: BRANCH_A, totalDue: 100, totalPaid: 0 }]);
    const applyDelta = jest.spyOn(CustomerBalance, 'applyDelta').mockResolvedValue({});

    const applied = await CustomerBalance.settleDue({
      shop: SHOP, customer: CUSTOMER, preferBranch: BRANCH_A, amount: 500,
    });

    expect(applyDelta).toHaveBeenCalledWith(
      expect.objectContaining({ branch: BRANCH_A, paid: 400, due: -400 }),
      null
    );
    expect(applied.reduce((s, a) => s + a.amount, 0)).toBe(500);
  });

  it('does nothing when the shop tracks no branches at all', async () => {
    stubRows([]);
    const applyDelta = jest.spyOn(CustomerBalance, 'applyDelta').mockResolvedValue({});
    expect(await CustomerBalance.settleDue({
      shop: SHOP, customer: CUSTOMER, preferBranch: BRANCH_A, amount: 500,
    })).toEqual([]);
    expect(applyDelta).not.toHaveBeenCalled();
  });
});

describe('recomputeDue', () => {
  it('mirrors the Math.max clamp the Customer rollup uses', async () => {
    // An over-refunded customer clamps at zero on the Customer document. If the
    // branch row $inc'd past zero instead, the two books would drift apart on
    // exactly the customers most likely to be looked at.
    const row = { totalPurchases: 100, totalPaid: 400, totalDue: 0, save: jest.fn() };
    jest.spyOn(CustomerBalance, 'findOne').mockResolvedValue(row);

    await CustomerBalance.recomputeDue({ shop: SHOP, customer: CUSTOMER, branch: BRANCH_A });

    expect(row.totalDue).toBe(0);
    expect(row.save).toHaveBeenCalled();
  });

  it('derives due from purchases minus payments', async () => {
    const row = { totalPurchases: 1000, totalPaid: 250, totalDue: 999, save: jest.fn() };
    jest.spyOn(CustomerBalance, 'findOne').mockResolvedValue(row);
    await CustomerBalance.recomputeDue({ shop: SHOP, customer: CUSTOMER, branch: BRANCH_A });
    expect(row.totalDue).toBe(750);
  });

  it('is a no-op without a branch', async () => {
    const findOne = jest.spyOn(CustomerBalance, 'findOne');
    expect(await CustomerBalance.recomputeDue({ shop: SHOP, customer: CUSTOMER, branch: null })).toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });
});
