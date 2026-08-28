const mongoose = require('mongoose');
const logger = require('./logger.util');

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NON-TRANSACTIONAL FALLBACK, AND WHY IT IS NARROW NOW
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * When `withTransaction` fails, the fallback below RE-RUNS the entire callback
 * without a session. For a money path that callback is a Sale, a stock
 * decrement, a Payment, a `PaymentAccount` delta and an invoice counter — so a
 * partial first run followed by a complete second one is precisely the shape of
 * every drift bug this repo keeps a `recalc-*` script for.
 *
 * The matcher used to be far too broad to sit in front of that. It fell back on:
 *
 *   · `!txError`        — ANY falsy throw
 *   · `code === 251`    — NoSuchTransaction, which is not only a topology state
 *   · `.includes('replica set')` — a loose substring against a message the
 *                                  driver composes and is free to change
 *
 * Each of those could fire on something that was not a standalone server, and
 * when it did the result was a second, non-atomic execution that returned
 * success and logged at `warn`. No metric, no alert, nothing to notice.
 *
 * What is left is the two EXACT messages MongoDB emits for a server that cannot
 * do transactions at all, plus the two codes that accompany them. Anything else
 * — including a transient abort — now propagates, which is the safe direction:
 * a failed checkout is recoverable at the till, a double-posted one is found
 * months later by reconciling a supplier statement.
 */

/**
 * Is this the server saying "I cannot do transactions", as opposed to "this
 * transaction did not work"? Only the first justifies running without one.
 *
 * Deliberately NOT tolerant of a falsy error: an unrecognised failure must
 * propagate rather than be treated as a topology limitation.
 */
function isTopologyError(err) {
  if (!err) return false;
  const msg = typeof err.message === 'string' ? err.message : '';
  return (
    msg.includes('Transaction numbers are only allowed on a replica set member') ||
    msg.includes('Standalone servers do not support transactions') ||
    err.code === 20 ||   // IllegalOperation — what a standalone answers
    err.code === 263     // OperationNotSupportedInTransaction
  );
}

/**
 * May this deployment run a money mutation without a transaction?
 *
 * Off in production unless an operator says otherwise, on everywhere else. A
 * developer's standalone Mongo raises a topology error on every write and would
 * otherwise be unusable; production is Atlas, a replica set, where a genuine
 * topology error cannot occur — so refusing there costs nothing real and
 * prevents the one failure mode that silently duplicates money.
 *
 * `=== 'true'`, not truthiness. `'false'`, `'0'` and `'no'` are all truthy
 * strings, and reading this loosely would turn every one of them into "yes" —
 * on the flag whose entire job is to be hard to turn on by accident.
 *
 * Read per call rather than captured at module load. The load-time version
 * bought a marginal guarantee about requests in flight and cost the ability to
 * test either branch without re-requiring the module, which on a money-safety
 * gate is the wrong side of that trade.
 */
function fallbackAllowed() {
  return (
    process.env.NODE_ENV !== 'production' ||
    process.env.ALLOW_NON_TRANSACTIONAL === 'true'
  );
}

/**
 * Say it loudly, once per occurrence.
 *
 * `logger.error`, not `warn` — the old level is why this could happen for
 * months without anyone looking. The founder channel is told as well, because
 * the person who needs to know that a deployment lost its replica set is not
 * reading log files.
 *
 * Both are best-effort: an alert that threw would take down the very checkout
 * the fallback is trying to rescue.
 */
function reportFallback(txError) {
  const reason = txError?.message || 'topology limitation';
  logger.error(`[Transaction] Ran a money mutation WITHOUT a transaction: ${reason}`);

  // Not under test. The notifier queries `AdminTelegramLink` to find its
  // audience, and with no database attached that query buffers for ten seconds
  // and holds the Jest process open past the run — an alert about a fallback
  // that only fires in tests is noise that costs ten seconds of every suite.
  if (process.env.NODE_ENV === 'test') return;

  try {
    // Required lazily. This util is imported by services, scripts and seeders;
    // pulling the notifier in at module scope would drag Telegram and the whole
    // config chain into every one of them.
    const platformNotify = require('../services/platformNotify.service');
    platformNotify.adminActivity({
      title: 'Money written without a transaction',
      lines: [
        `Reason: ${reason}`,
        'A write ran non-atomically. Partial writes are possible — check the recalc scripts.',
      ],
      urgent: true,
    });
  } catch (_) {
    // No notifier available (a script, a seeder, a test). The log line stands.
  }
}

/**
 * Execute a callback within a MongoDB session/transaction.
 *
 * Detects a MongoDB that cannot do transactions at all (a standalone server, or
 * a driver/topology that refuses them) and — OFF PRODUCTION, or with
 * `ALLOW_NON_TRANSACTIONAL=true` — falls back to running the callback directly
 * so a developer's standalone Mongo stays usable.
 *
 * It used to say "user operations are NEVER blocked", and that was the wrong
 * promise to make on a money path: the fallback re-runs the whole callback with
 * no session, so keeping a checkout alive could mean posting it twice. In
 * production the operation is now blocked instead. See the header above for
 * which errors qualify and why the list shrank.
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
    // Same gate as the fallback below, and for the same reason: this path also
    // runs the money mutation with no transaction around it. It is safer than
    // that one — nothing has executed yet, so there is no partial write to
    // duplicate — but "no session at all" in production still means the
    // durability guarantee every service assumes is not there.
    if (!fallbackAllowed()) {
      logger.error(
        `[Transaction] REFUSING to run without a session in production ` +
        `(${sessionErr.message}). Set ALLOW_NON_TRANSACTIONAL=true only if this ` +
        `deployment genuinely has no replica set.`
      );
      throw sessionErr;
    }
    reportFallback(sessionErr);
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
      if (isTopologyError(txError)) {
        /**
         * ── The fallback RE-RUNS the whole callback, non-atomically ─────────
         *
         * That is what makes it dangerous and why it is gated. `callback` is a
         * money mutation — Sale, stock decrement, Payment, PaymentAccount
         * delta, invoice counter — and running it a second time after a
         * partial first run is exactly the shape of every drift bug this
         * codebase has a `recalc-*` script for.
         *
         * On a replica set (which production is) a genuine topology error
         * cannot happen, so refusing here costs nothing and a silent double
         * post costs a shop real money. On a developer's standalone Mongo it
         * happens on every write, so refusing there would make the app
         * unrunnable. Hence: allowed off production, and in production only if
         * an operator has said so out loud.
         */
        if (!fallbackAllowed()) {
          logger.error(
            `[Transaction] REFUSING non-transactional fallback in production ` +
            `(${txError?.message || 'topology limitation'}). Set ` +
            `ALLOW_NON_TRANSACTIONAL=true only if this deployment genuinely ` +
            `has no replica set — it permits partial writes.`
          );
          throw txError;
        }

        reportFallback(txError);
        return await callback(null);
      }

      // Re-throw genuine application validation errors (e.g. AppError,
      // insufficient stock, duplicate invoice) AND anything unrecognised.
      // Unrecognised is the important half: the old matcher's `!txError` arm
      // meant any falsy throw fell through to a silent re-run.
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
