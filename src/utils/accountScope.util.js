/**
 * Branch scoping for fund accounts — the one shape I-2 does not cover.
 *
 * ── Why `branchFilter` is wrong here ────────────────────────────────────────
 *
 * `branchFilter` adds `{ branch: <active> }`. Applied to `PaymentAccount` that
 * would hide every SHARED account — the bank accounts and bKash numbers, which
 * carry `branch: null` by design (FUND_ACCOUNT_PLAN D-3, and the long note in
 * the model). The list would silently show only the cash box, and money paid
 * from the bank would have nowhere to go.
 *
 * That is precisely the failure mode I-2 exists to prevent (a branch predicate
 * on rows that do not carry that branch matches nothing, with no error), so the
 * fix is the same as I-2 prescribes for `stockTransfer`'s `$or` across
 * `fromBranch`/`toBranch`: a genuinely different shape gets its own named
 * helper, not a hand-rolled filter at each call site.
 *
 * **This file is the only place the `$or` is written.** If you find yourself
 * building it inline, you are about to introduce the bug.
 */

const mongoose = require('mongoose');

/**
 * READ filter — "accounts this caller may see".
 *
 * Shared accounts always, plus the active branch's own cash box. Never throws,
 * exactly like `branchFilter`, so an owner in All-Branches view (no active
 * branch) correctly sees every account in the shop.
 *
 * A single-branch shop has no active branch, so this returns the base filter
 * untouched and the collection behaves as if branches did not exist (I-1).
 */
function accountFilter(req, baseFilter = {}) {
  const filter = { ...baseFilter };

  if (!req?.shop?.multiBranchEnabled || !req.branchId) return filter;

  filter.$or = [{ branch: null }, { branch: req.branchId }];
  return filter;
}

/**
 * The same, for an aggregation `$match`.
 *
 * I-3: `$match` does not cast. A branch id arriving as a string from
 * `req.branchId` matches zero documents and reports ৳0 with no error, so the
 * cast happens here rather than being remembered at each call site.
 */
function accountMatch(req, baseMatch = {}) {
  const match = { ...baseMatch };

  if (!req?.shop?.multiBranchEnabled || !req.branchId) return match;

  match.$or = [
    { branch: null },
    { branch: new mongoose.Types.ObjectId(String(req.branchId)) },
  ];
  return match;
}

/**
 * Is this account usable from the caller's current position?
 *
 * Used on the WRITE paths, where "visible" is not enough — a payment must not
 * be booked against another branch's cash drawer even by an owner who can see
 * it. Shared accounts pass from anywhere; a cash box passes only from its own
 * branch.
 */
function canUseAccount(req, account) {
  if (!account) return false;
  if (!account.branch) return true;
  if (!req?.shop?.multiBranchEnabled) return true;
  return String(account.branch) === String(req.branchId || '');
}

module.exports = {
  accountFilter,
  accountMatch,
  canUseAccount,
};
