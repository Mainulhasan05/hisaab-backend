/**
 * Phase 2 — branch scoping tests.
 *
 * Two things are under test:
 *   1. the helpers behave differently on read vs write paths, and
 *   2. a single-branch shop is completely unaffected — the product's
 *      non-negotiable requirement.
 */

const mongoose = require('mongoose');
const {
  branchFilter,
  branchMatch,
  requireBranch,
  isActiveBranch,
  isAllBranchesView,
  isMultiBranch,
  getBranchCode,
  BRANCH_REQUIRED,
} = require('../utils/branchScope.util');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH_A = new mongoose.Types.ObjectId();
const BRANCH_B = new mongoose.Types.ObjectId();

/** A shop that never enabled multi-branch. */
const singleBranchReq = () => ({
  shop: { _id: SHOP, multiBranchEnabled: false },
  branch: null,
  branchId: null,
});

/** Multi-branch shop with a branch selected (staff, or owner on a branch). */
const branchScopedReq = (branchId = BRANCH_A) => ({
  shop: { _id: SHOP, multiBranchEnabled: true },
  branch: { _id: branchId, code: 'DHA' },
  branchId,
});

/** Multi-branch shop, owner viewing the cross-branch aggregate. */
const allBranchesReq = () => ({
  shop: { _id: SHOP, multiBranchEnabled: true },
  branch: null,
  branchId: null,
});

describe('single-branch shops are untouched', () => {
  it('branchFilter adds no branch predicate', () => {
    expect(branchFilter(singleBranchReq(), { status: 'completed' }))
      .toEqual({ status: 'completed', shop: SHOP });
  });

  it('branchFilter on a find-by-id stays shop-only', () => {
    const f = branchFilter(singleBranchReq(), { _id: 'x', shop: SHOP });
    expect(f).not.toHaveProperty('branch');
  });

  it('requireBranch returns null instead of throwing', () => {
    expect(requireBranch(singleBranchReq())).toBeNull();
  });

  it('branchMatch adds no branch predicate', () => {
    const m = branchMatch(singleBranchReq(), {});
    expect(m).not.toHaveProperty('branch');
    expect(String(m.shop)).toBe(String(SHOP));
  });

  it('isMultiBranch / isAllBranchesView are false', () => {
    expect(isMultiBranch(singleBranchReq())).toBe(false);
    expect(isAllBranchesView(singleBranchReq())).toBe(false);
  });

  it('getBranchCode is null, so invoice numbers keep their current shape', () => {
    expect(getBranchCode(singleBranchReq())).toBeNull();
  });

  it('isActiveBranch is always true — there is only one scope', () => {
    expect(isActiveBranch(singleBranchReq(), BRANCH_A)).toBe(true);
    expect(isActiveBranch(singleBranchReq(), null)).toBe(true);
  });
});

describe('branchFilter (READ)', () => {
  it('scopes to the active branch', () => {
    const f = branchFilter(branchScopedReq(), { status: 'completed' });
    expect(String(f.branch)).toBe(String(BRANCH_A));
    expect(String(f.shop)).toBe(String(SHOP));
  });

  it('does not scope in "All Branches" — that is the aggregate view', () => {
    expect(branchFilter(allBranchesReq(), {})).not.toHaveProperty('branch');
  });

  it('never throws, whatever the state', () => {
    expect(() => branchFilter(allBranchesReq(), {})).not.toThrow();
    expect(() => branchFilter(undefined, {})).not.toThrow();
  });

  it('does not mutate the caller\'s filter', () => {
    const base = { status: 'x' };
    branchFilter(branchScopedReq(), base);
    expect(base).toEqual({ status: 'x' });
  });

  it('respects an explicitly supplied shop', () => {
    const other = new mongoose.Types.ObjectId();
    expect(String(branchFilter(branchScopedReq(), { shop: other }).shop)).toBe(String(other));
  });
});

describe('requireBranch (WRITE)', () => {
  it('returns the active branch', () => {
    expect(String(requireBranch(branchScopedReq()))).toBe(String(BRANCH_A));
  });

  it('throws BRANCH_REQUIRED in "All Branches" instead of picking one', () => {
    // The old behaviour silently booked the write into the oldest branch.
    expect.assertions(3);
    try {
      requireBranch(allBranchesReq());
    } catch (err) {
      expect(err.code).toBe(BRANCH_REQUIRED);
      expect(err.statusCode).toBe(400);
      expect(err.messageBn).toBeTruthy();
    }
  });
});

describe('branchMatch (aggregation)', () => {
  it('casts shop and branch to ObjectId', () => {
    const m = branchMatch(branchScopedReq(), {});
    expect(m.shop).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(m.branch).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it('omits branch in "All Branches"', () => {
    expect(branchMatch(allBranchesReq(), {})).not.toHaveProperty('branch');
  });
});

describe('isActiveBranch / isAllBranchesView', () => {
  it('distinguishes the active branch from another one', () => {
    const req = branchScopedReq(BRANCH_A);
    expect(isActiveBranch(req, BRANCH_A)).toBe(true);
    expect(isActiveBranch(req, BRANCH_B)).toBe(false);
  });

  it('compares by value, not identity', () => {
    expect(isActiveBranch(branchScopedReq(BRANCH_A), String(BRANCH_A))).toBe(true);
  });

  it('is false for every branch while in the aggregate view', () => {
    expect(isActiveBranch(allBranchesReq(), BRANCH_A)).toBe(false);
    expect(isAllBranchesView(allBranchesReq())).toBe(true);
  });
});

describe('the removed helpers are gone', () => {
  it('no longer exports getBranchForCreate or scopeByBranch', () => {
    // getBranchForCreate threw on read paths, which broke the cash register for
    // owners viewing "All Branches" (H-1). Its removal is the fix — a
    // reintroduction would bring the bug back.
    const util = require('../utils/branchScope.util');
    expect(util.getBranchForCreate).toBeUndefined();
    expect(util.scopeByBranch).toBeUndefined();
    expect(util.scopeByBranchForAggregation).toBeUndefined();
  });
});
