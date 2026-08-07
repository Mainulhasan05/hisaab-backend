/**
 * Hard deletion is disabled across the admin panel.
 *
 * The operator console can read, create and edit. Anything that needs to stop
 * being used is deactivated / soft-deleted / closed — never erased. Deletion
 * will return later as its own piece of work, behind step-up authentication.
 *
 * Two reasons this is a hard refusal in the handler and not just an unmounted
 * route:
 *
 *   1. The routes are removed, so nothing reaches these handlers today. If one
 *      is re-added carelessly, it must fail closed rather than silently work.
 *   2. `purgeShop` in particular was not merely dangerous, it was broken: its
 *      delete loop ran `Product.deleteMany` first and `Sale.deleteMany` second,
 *      and `immutableGuard` rejects deleteMany on the four ledger models with a
 *      403. It erased a shop's entire catalogue, threw, and left the shop, its
 *      sales and its users in place. Any reimplementation must start from that
 *      fact — see the checklist below.
 *
 * Re-enabling any of these requires, at minimum:
 *   - step-up authentication distinct from the admin session
 *   - a server-computed impact preview shown before confirmation
 *   - an audit entry written BEFORE the destructive write, with before-state
 *   - for shop purge: a strategy for the four immutableGuard'd ledger models,
 *     and coverage of the 7 collections the old loop never listed at all
 *     (`Coupon`, `HeldCart`, `StockTransfer`, `ExpenseCategory`, `Payment`,
 *     `StockTransaction`, `Contact`) — Phase 0 found 2,830 orphan rows from a
 *     shop deleted by that loop.
 */
const { AppError } = require('../middleware/error.middleware');

const DELETION_DISABLED = 'DELETION_DISABLED';

/**
 * The only DELETE requests a platform admin may make.
 *
 * Deny-by-default: anything not listed here is refused for an admin token, so a
 * destructive route added later is blocked before anyone has to remember this
 * rule. Adding an entry is a deliberate, reviewable act.
 *
 * Both entries are non-destructive despite the verb:
 *   - branch "delete" flips `isActive` after an impact check; the branch and
 *     all of its history stay.
 *   - a cache key is derived data that rebuilds on the next read.
 *
 * Matched against `req.path` (no query string, no /api prefix stripping — the
 * patterns below are anchored on the full mounted path).
 */
const ADMIN_DELETE_ALLOWLIST = [
  /^\/api\/admin\/shops\/[^/]+\/branches\/[^/]+$/,
  /^\/api\/admin\/cache\/keys\/.+$/,
];

/**
 * True when a platform admin is allowed to issue this DELETE.
 *
 * @param {string} path - req.path / req.originalUrl without the query string
 * @returns {boolean}
 */
function isAllowedAdminDelete(path) {
  const clean = String(path || '').split('?')[0];
  return ADMIN_DELETE_ALLOWLIST.some((re) => re.test(clean));
}

/**
 * Refuse a deletion attempt. Always throws.
 *
 * @param {string} what - the thing that would have been deleted, for the message
 * @param {string} instead - the soft alternative the operator should use
 * @throws {AppError} 403 with code DELETION_DISABLED
 */
function refuseDeletion(what, instead) {
  const error = new AppError(
    `Deleting ${what} is disabled in the admin panel. ${instead}`,
    `অ্যাডমিন প্যানেল থেকে ${what} মুছে ফেলা বন্ধ রাখা হয়েছে। ${instead}`,
    403
  );
  error.code = DELETION_DISABLED;
  throw error;
}

/**
 * Deny-by-default guard for platform-admin requests.
 *
 * Called from `protect`/`softProtect` the moment `req.isAdmin` is set, so it
 * covers every route an admin can reach — including the whole shop-facing API,
 * which an admin enters with `x-shop-id`, and including routes that do not
 * exist yet. Route-by-route removal cannot give that guarantee; this can.
 *
 * Shop owners and employees never carry `req.isAdmin`, so this is inert for
 * them and the shop-facing app is untouched.
 *
 * @param {Object} req
 * @throws {AppError} 403 DELETION_DISABLED
 */
function assertAdminMayDelete(req) {
  if (req.method !== 'DELETE') return;
  if (isAllowedAdminDelete(req.originalUrl || req.path)) return;

  refuseDeletion(
    'records',
    'Deactivate, void or close the record instead — see utils/deletionDisabled.util.js.'
  );
}

module.exports = {
  refuseDeletion,
  assertAdminMayDelete,
  isAllowedAdminDelete,
  ADMIN_DELETE_ALLOWLIST,
  DELETION_DISABLED,
};
