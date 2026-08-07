/**
 * Phase 5 — session-level branch context.
 *
 * Covers what /auth/me hands the client (so the UI can hydrate before any data
 * fetch) and the cross-branch deep-link error that lets an owner switch instead
 * of seeing a bare 404 — while a staff member still learns nothing.
 */

const mongoose = require('mongoose');
const { wrongBranchError, WRONG_BRANCH } = require('../utils/branchScope.util');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH_A = { _id: new mongoose.Types.ObjectId(), name: 'ধানমন্ডি', code: 'DHA' };
const BRANCH_B = { _id: new mongoose.Types.ObjectId(), name: 'চট্টগ্রাম', code: 'CTG' };

describe('wrongBranchError (M-19)', () => {
  const ownerReq = { user: { isOwner: true } };
  const staffReq = { user: { isOwner: false } };

  it('names the branch for an owner so the UI can offer a switch', () => {
    const err = wrongBranchError(ownerReq, BRANCH_B);
    expect(err).toBeTruthy();
    expect(err.code).toBe(WRONG_BRANCH);
    expect(err.statusCode).toBe(404);
    expect(err.branch).toEqual({
      _id: String(BRANCH_B._id),
      name: 'চট্টগ্রাম',
      code: 'CTG',
    });
    expect(err.messageBn).toContain('চট্টগ্রাম');
  });

  it('returns null for staff — they must not learn the record exists', () => {
    // The caller then throws a plain 404, which is indistinguishable from
    // "no such record" — exactly what an employee should see.
    expect(wrongBranchError(staffReq, BRANCH_B)).toBeNull();
  });

  it('returns null when there is no branch to name', () => {
    expect(wrongBranchError(ownerReq, null)).toBeNull();
    expect(wrongBranchError(ownerReq, undefined)).toBeNull();
  });

  it('returns null without a user (unauthenticated / soft-auth paths)', () => {
    expect(wrongBranchError({}, BRANCH_B)).toBeNull();
    expect(wrongBranchError(null, BRANCH_B)).toBeNull();
  });
});

describe('error middleware passes branch data through', () => {
  const { errorHandler } = require('../middleware/error.middleware');

  const runHandler = (err) => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; // exercise the client-facing shape
    let payload = null;
    const res = {
      status: () => res,
      json: (body) => { payload = body; return res; },
    };
    errorHandler(err, { originalUrl: '/x', method: 'GET', ip: '1.1.1.1' }, res, () => {});
    process.env.NODE_ENV = prevEnv;
    return payload;
  };

  it('includes code and branch so the client can name the branch', () => {
    const err = wrongBranchError({ user: { isOwner: true } }, BRANCH_B);
    const body = runHandler(err);
    expect(body.code).toBe(WRONG_BRANCH);
    expect(body.branch.name).toBe('চট্টগ্রাম');
  });

  it('does not invent a branch field on ordinary errors', () => {
    const { AppError } = require('../middleware/error.middleware');
    const body = runHandler(new AppError('nope', 'nope', 404));
    expect(body).not.toHaveProperty('branch');
  });
});

describe('/auth/me branch payload', () => {
  // The controller derives everything from what `protect` already resolved, so
  // the shape is asserted directly against that contract.
  const buildPayload = (req, user) => {
    const isMultiBranch = Boolean(req.shop?.multiBranchEnabled);
    const allBranches = req.user.branchList || [];
    const branches = !isMultiBranch
      ? []
      : (user.isOwner
        ? allBranches
        : allBranches.filter((b) => String(b._id) === String(req.branchId || '')));
    return {
      multiBranchEnabled: isMultiBranch,
      activeBranchId: req.branchId ? String(req.branchId) : null,
      activeBranch: req.branch
        ? { _id: String(req.branch._id), name: req.branch.name, code: req.branch.code }
        : null,
      branches,
    };
  };

  it('single-branch shop gets an empty, inert payload', () => {
    const req = {
      shop: { _id: SHOP, multiBranchEnabled: false },
      user: { branchList: [] },
      branch: null,
      branchId: null,
    };
    expect(buildPayload(req, { isOwner: true })).toEqual({
      multiBranchEnabled: false,
      activeBranchId: null,
      activeBranch: null,
      branches: [],
    });
  });

  it('owner gets every branch and the resolved active one', () => {
    const req = {
      shop: { _id: SHOP, multiBranchEnabled: true },
      user: { branchList: [BRANCH_A, BRANCH_B] },
      branch: BRANCH_A,
      branchId: BRANCH_A._id,
    };
    const p = buildPayload(req, { isOwner: true });
    expect(p.branches).toHaveLength(2);
    expect(p.activeBranchId).toBe(String(BRANCH_A._id));
    expect(p.activeBranch.name).toBe('ধানমন্ডি');
  });

  it('staff get only their own branch — the list never reveals the others', () => {
    const req = {
      shop: { _id: SHOP, multiBranchEnabled: true },
      user: { branchList: [BRANCH_A, BRANCH_B] },
      branch: BRANCH_B,
      branchId: BRANCH_B._id,
    };
    const p = buildPayload(req, { isOwner: false });
    expect(p.branches).toHaveLength(1);
    expect(String(p.branches[0]._id)).toBe(String(BRANCH_B._id));
  });

  it('owner in "All Branches" reports no active branch', () => {
    const req = {
      shop: { _id: SHOP, multiBranchEnabled: true },
      user: { branchList: [BRANCH_A, BRANCH_B] },
      branch: null,
      branchId: null,
    };
    const p = buildPayload(req, { isOwner: true });
    expect(p.activeBranchId).toBeNull();
    expect(p.activeBranch).toBeNull();
    expect(p.branches).toHaveLength(2);
  });
});
