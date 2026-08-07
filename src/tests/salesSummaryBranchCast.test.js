/**
 * Regression — the sales page listed invoices while every stat card read ৳0.
 *
 * Root cause: the branch list rides in the Redis auth payload, so it comes back
 * through JSON.parse with `_id` as a string. `req.branchId` was taken straight
 * off it, and `_buildQuery` put that string into a filter shared by
 * `Sale.find()` (which casts) and `Sale.aggregate([{ $match }])` (which does
 * not). The list matched; the summary matched nothing and fell back to zeros.
 *
 * Both halves of the fix are pinned here. These assertions are written against
 * STRING ids on purpose — passing an ObjectId would have passed against the
 * broken code too, and protected nothing.
 */

const mongoose = require('mongoose');
const saleService = require('../services/sale.service');
const { hydrateBranchList } = require('../middleware/auth.middleware');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();
const STAFF = new mongoose.Types.ObjectId();

/** What Redis hands back: a JSON round-trip of the .lean() branch projection. */
const cachedBranches = () =>
  JSON.parse(JSON.stringify([
    { _id: BRANCH, name: 'Noyagola Branch', code: 'NAYAGOLA', isActive: true, isDefault: false },
  ]));

describe('hydrateBranchList — the cache round-trip', () => {
  it('gives back an ObjectId _id, not the string Redis stored', () => {
    const raw = cachedBranches();
    expect(typeof raw[0]._id).toBe('string'); // precondition: this is the bug's source

    const [branch] = hydrateBranchList(raw);
    expect(branch._id).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(branch._id)).toBe(String(BRANCH));
  });

  it('keeps the other projected fields untouched', () => {
    const [branch] = hydrateBranchList(cachedBranches());
    expect(branch).toMatchObject({
      name: 'Noyagola Branch',
      code: 'NAYAGOLA',
      isActive: true,
      isDefault: false,
    });
  });

  it('is safe on the single-branch shop payload (empty / missing)', () => {
    expect(hydrateBranchList([])).toEqual([]);
    expect(hydrateBranchList(undefined)).toEqual([]);
    expect(hydrateBranchList(null)).toEqual([]);
  });

  it('leaves a malformed id alone rather than throwing mid-request', () => {
    const [branch] = hydrateBranchList([{ _id: 'not-an-id', name: 'x' }]);
    expect(branch._id).toBe('not-an-id');
  });
});

describe('_buildQuery — $match-safe ids', () => {
  // A string branchId is the exact input the middleware used to produce.
  const stringIds = {
    branchId: String(BRANCH),
    customerId: String(CUSTOMER),
    staffId: String(STAFF),
  };

  it('casts branch, so the summary aggregation matches the same rows as the list', () => {
    const query = saleService._buildQuery(String(SHOP), { branchId: stringIds.branchId });
    expect(query.branch).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(query.branch)).toBe(String(BRANCH));
  });

  it('casts shop', () => {
    const query = saleService._buildQuery(String(SHOP), {});
    expect(query.shop).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it('casts the staff filter — "sales by this seller" zeroed the cards too', () => {
    const query = saleService._buildQuery(String(SHOP), { staffId: stringIds.staffId });
    expect(query.createdBy).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it('casts the customer filter', () => {
    const query = saleService._buildQuery(String(SHOP), { customerId: stringIds.customerId });
    expect(query.customer).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it('leaves every id predicate $match-safe at once', () => {
    const query = saleService._buildQuery(String(SHOP), {
      ...stringIds,
      status: 'completed',
      startDate: '2026-08-07T00:00:00.000Z',
      endDate: '2026-08-07T23:59:59.999Z',
    });
    for (const key of ['shop', 'branch', 'createdBy', 'customer']) {
      expect(query[key]).toBeInstanceOf(mongoose.Types.ObjectId);
    }
  });

  it('adds no branch predicate for a single-branch shop', () => {
    // The pixel-identical guarantee: branchId is null for them, and nothing
    // about their query may change.
    const query = saleService._buildQuery(SHOP, { branchId: null });
    expect(query).not.toHaveProperty('branch');
  });

  it('leaves an invalid id uncast, so Mongoose still raises its own CastError', () => {
    const query = saleService._buildQuery(String(SHOP), { customerId: 'garbage' });
    expect(query.customer).toBe('garbage');
  });

  it('still builds the non-id predicates', () => {
    const query = saleService._buildQuery(String(SHOP), {
      status: 'dues',
      paymentMethod: 'cash',
      isOnline: 'false',
      startDate: '2026-08-07T00:00:00.000Z',
    });
    expect(query.due).toEqual({ $gt: 0 });
    expect(query.status).toEqual({ $ne: 'cancelled' });
    expect(query.paymentMethod).toBe('cash');
    expect(query.isOnline).toBe(false);
    expect(query.createdAt.$gte).toBeInstanceOf(Date);
  });
});
