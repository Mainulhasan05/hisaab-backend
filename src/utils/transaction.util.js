const mongoose = require('mongoose');
const logger = require('./logger.util');

/**
 * Execute a callback within a MongoDB session/transaction.
 * 
 * Fail-safe design: Automatically detects standalone MongoDB instances (no replica set),
 * driver limitations, or cluster topology issues, falling back cleanly to non-transactional 
 * execution so user operations are NEVER blocked.
 * 
 * @param {Function} callback - Async function(session) to execute within transaction
 * @param {Object} options - Optional transaction options
 * @returns {Promise<any>} - Result returned by the callback
 */
async function runInTransaction(callback, options = {}) {
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
        ...options,
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
