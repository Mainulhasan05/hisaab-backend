/**
 * Branch Scope Utility
 *
 * The single sanctioned way to apply branch scope to a query. Services must not
 * read `req.branchId` directly — use these helpers, so the rules live in one
 * place and read paths cannot accidentally get write semantics.
 *
 * Two functions, named so they cannot be confused:
 *
 *   branchFilter(req, base)   READ  — adds `branch` only when one is active.
 *                                     NEVER throws. Safe on every read.
 *   requireBranch(req)        WRITE — returns the branch to write into, or
 *                                     throws 400 BRANCH_REQUIRED.
 *
 * This replaces the earlier three-way split (`scopeByBranch`,
 * `getBranchForCreate`, hand-written `if (options.branchId)`). The old
 * `getBranchForCreate` threw when no branch was selected, and was wired into six
 * READ paths — which 403'd the cash register for any owner viewing "All
 * Branches" (FEATURE_AUDIT.md H-1).
 *
 * Single-branch shops never reach any of this: `req.branchId` is null for them,
 * so `branchFilter` is a no-op and `requireBranch` returns null.
 */
const { AppError } = require('../middleware/error.middleware');
const mongoose = require('mongoose');

/** Error code the frontend keys on to prompt for a branch. */
const BRANCH_REQUIRED = 'BRANCH_REQUIRED';

/** Error code for "this record exists, but in another branch". Owner only. */
const WRONG_BRANCH = 'WRONG_BRANCH';

/**
 * READ scope. Adds `branch` to a filter only when a specific branch is active.
 *
 * - single-branch shop        → { shop }                  (unchanged behaviour)
 * - multi-branch, branch set  → { shop, branch }
 * - multi-branch, "All"       → { shop }                  (owner aggregate view)
 *
 * @param {Object} req
 * @param {Object} baseFilter
 * @returns {Object}
 */
function branchFilter(req, baseFilter = {}) {
  const filter = { ...baseFilter };

  if (!filter.shop && req?.shop) {
    filter.shop = req.shop._id;
  }

  if (req?.branchId) {
    filter.branch = req.branchId;
  }

  return filter;
}

/**
 * READ scope for aggregation pipelines — same rules as branchFilter, but casts
 * to ObjectId, which $match requires.
 *
 * @param {Object} req
 * @param {Object} baseMatch
 * @returns {Object}
 */
function branchMatch(req, baseMatch = {}) {
  const match = { ...baseMatch };

  if (!match.shop && req?.shop) {
    match.shop = new mongoose.Types.ObjectId(req.shop._id);
  }

  if (req?.branchId) {
    match.branch = new mongoose.Types.ObjectId(req.branchId);
  }

  return match;
}

/**
 * WRITE target. The branch a new record belongs to.
 *
 * - single-branch shop        → null   (nothing to tag)
 * - multi-branch, branch set  → that branch
 * - multi-branch, "All"       → throws 400 BRANCH_REQUIRED
 *
 * The throw is deliberate and is the product rule: an owner viewing "All
 * Branches" must pick one before writing. Previously the auth middleware
 * silently defaulted writes to the oldest branch, so an owner could book a sale
 * into a branch they weren't looking at, with no indication of which.
 *
 * @param {Object} req
 * @returns {ObjectId|null}
 * @throws {AppError} 400 BRANCH_REQUIRED
 */
function requireBranch(req) {
  if (!req?.shop?.multiBranchEnabled) {
    return null;
  }

  if (!req.branchId) {
    const error = new AppError(
      'Select a branch before making changes',
      'পরিবর্তন করার আগে শাখা নির্বাচন করুন',
      400
    );
    error.code = BRANCH_REQUIRED;
    throw error;
  }

  return req.branchId;
}

/**
 * True when the given branch id is the one currently active.
 * Always true for single-branch shops (there is only one scope).
 * For an owner in "All Branches" this is false — callers that need to allow the
 * aggregate view must check `isAllBranchesView` themselves.
 *
 * @param {Object} req
 * @param {ObjectId|string|null} branchId
 * @returns {boolean}
 */
function isActiveBranch(req, branchId) {
  if (!req?.shop?.multiBranchEnabled) return true;
  if (!req.branchId) return false;
  return String(req.branchId) === String(branchId || '');
}

/** Owner is viewing the cross-branch aggregate (multi-branch, no branch picked). */
function isAllBranchesView(req) {
  return Boolean(req?.shop?.multiBranchEnabled) && !req?.branchId;
}

/**
 * Whether this shop has multi-branch turned on.
 * @param {Object} req
 * @returns {boolean}
 */
function isMultiBranch(req) {
  return req?.shop?.multiBranchEnabled === true;
}

/**
 * Branch code for invoice/reference numbering. Null for single-branch shops, so
 * their invoice numbers keep exactly today's shape.
 *
 * @param {Object} req
 * @returns {string|null}
 */
function getBranchCode(req) {
  if (!req?.shop?.multiBranchEnabled || !req.branch) {
    return null;
  }
  return req.branch.code || null;
}

/**
 * Explain a cross-branch deep link instead of a bare 404.
 *
 * Only ever raised for owners: a staff member must never learn that a record
 * exists in a branch they cannot see, so their lookups stay a plain 404.
 * The `branch` payload lets the client offer a one-click switch.
 *
 * @param {Object} req
 * @param {Object} branch - the branch the record actually belongs to
 * @returns {AppError|null} null when the caller should 404 instead
 */
function wrongBranchError(req, branch) {
  if (!req?.user?.isOwner || !branch) return null;

  const error = new AppError(
    `This record belongs to ${branch.name}. Switch to that branch to open it.`,
    `এই রেকর্ডটি "${branch.name}" শাখার। খুলতে ওই শাখায় যান।`,
    404
  );
  error.code = WRONG_BRANCH;
  error.branch = { _id: String(branch._id), name: branch.name, code: branch.code };
  return error;
}

module.exports = {
  branchFilter,
  branchMatch,
  requireBranch,
  isActiveBranch,
  isAllBranchesView,
  isMultiBranch,
  getBranchCode,
  wrongBranchError,
  BRANCH_REQUIRED,
  WRONG_BRANCH,
};
