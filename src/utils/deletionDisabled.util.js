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

module.exports = { refuseDeletion, DELETION_DISABLED };
