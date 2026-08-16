const mongoose = require('mongoose');
const logger = require('./logger.util');

/**
 * Execute a callback within a MongoDB session/transaction.
 *
 * Fail-safe design: Automatically detects standalone MongoDB instances (no replica set),
 * driver limitations, or cluster topology issues, falling back cleanly to non-transactional
 * execution so user operations are NEVER blocked.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `options.session` — JOIN AN AMBIENT TRANSACTION, DO NOT START A SECOND
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This used to start a NEW session unconditionally, which made every
 * transactional service method non-composable. Calling one from inside another
 * — `reviseSale` calling `createSale`, say — produced two INDEPENDENT atomic
 * units:
 *
 *   - Half the work could commit while the other half rolled back. A revision
 *     whose cancel committed and whose re-create did not leaves the shop with
 *     restored stock and no invoice for money it has already taken.
 *
 *   - Worse, and quieter: under `readConcern: 'snapshot'` the inner session
 *     cannot SEE the outer's uncommitted writes. So the inner `createSale`
 *     would read stock levels from before the cancel restored them and deduct
 *     against figures the outer transaction was in the middle of changing.
 *
 * Passing the caller's session makes this a no-op wrapper that runs the
 * callback inside the transaction already in progress — the standard
 * join-ambient-transaction pattern. The outer `withTransaction` stays the only
 * commit/abort boundary, which is exactly what "one transaction, or it does not
 * happen" requires.
 *
 * A method written as `runInTransaction(cb, { session: opts.session })` is
 * therefore correct BOTH as a top-level entry point (no session passed → it
 * opens its own) and as a nested step. Nothing at the call site changes.
 *
 * @param {Function} callback - Async function(session) to execute within transaction
 * @param {Object} options - Transaction options. `session` joins an existing
 *   transaction instead of opening one; everything else is forwarded to
 *   `withTransaction`.
 * @returns {Promise<any>} - Result returned by the callback
 */
async function runInTransaction(callback, options = {}) {
  const { session: ambientSession, ...txOptions } = options;

  // Already inside someone else's transaction — run in it and let THEM decide
  // whether it commits. Starting a session here would be a second atomic unit.
  if (ambientSession) {
    return await callback(ambientSession);
  }

  let session = null;

  try {
    session = await mongoose.startSession();
  } catch (sessionErr) {
    logger.warn(`[Transaction] Could not start session (${sessionErr.message}). Executing directly.`);
    return await callback(null);
  }

  try {
    let result;
    try {
      await session.withTransaction(async () => {
        result = await callback(session);
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        ...txOptions,
      });
      return result;
    } catch (txError) {
      // Check if error is due to MongoDB topology limitations (standalone mode, single node, or unsupported tx)
      const isTopologyOrTxError = 
        !txError ||
        txError.message?.includes('Transaction numbers are only allowed on a replica set member') ||
        txError.message?.includes('Standalone servers do not support transactions') ||
        txError.message?.includes('Transaction with which this operation should be executed is not in progress') ||
        txError.message?.includes('replica set') ||
        txError.code === 20 ||
        txError.code === 251 ||
        txError.code === 263;

      if (isTopologyOrTxError) {
        logger.warn(`[Transaction] MongoDB transaction unavailable (${txError?.message || 'topology limitation'}). Falling back to direct execution.`);
        return await callback(null);
      }

      // Re-throw genuine application validation errors (e.g. AppError, insufficient stock, duplicate invoice)
      throw txError;
    }
  } finally {
    if (session) {
      try {
        session.endSession();
      } catch (e) {
        // Silently ignore session closing errors
      }
    }
  }
}

module.exports = {
  runInTransaction,
};
