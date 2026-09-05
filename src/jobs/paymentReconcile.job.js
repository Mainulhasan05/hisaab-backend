/**
 * Payment reconciliation — asking the gateway about payments nobody told us
 * about.
 *
 * ── This is not a safety net. It is a primary delivery path. ────────────────
 *
 * PayStation returns the customer's BROWSER to us after checkout, and that is
 * the only notification we get — there is no server-side IPN. Which means every
 * customer who does one of the following gets nothing, forever, unless this job
 * runs:
 *
 *   · pays inside the bKash app and never switches back to the browser tab
 *   · loses signal between the gateway's confirmation and our redirect
 *   · closes the tab the moment their money leaves, which people do
 *   · is on a phone that killed the browser to free memory mid-payment
 *
 * On mobile in Bangladesh that is not the edge case. So the honest framing is
 * that the redirect is an OPTIMISATION — it makes fulfilment instant for the
 * people who happen to come back — and this loop is what actually guarantees a
 * shop gets what it paid for.
 *
 * The sweep is also the only thing that clears a `paid` order whose fulfilment
 * threw. See `platformCheckout.service.reconcile`.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 *
 * Tick on a fixed interval rather than at a Bangladesh clock hour, which is
 * what every other job here does — those report on a day that has finished,
 * this one chases money that is in flight right now. Five minutes is the
 * longest a shop should wait for a subscription it has already paid for.
 */

const checkoutService = require('../services/platformCheckout.service');
const logger = require('../utils/logger.util');

/** How often to sweep. */
const TICK_INTERVAL_MS = Number(process.env.PAYMENT_RECONCILE_INTERVAL_MS) || 5 * 60 * 1000;

let timerHandle = null;
let running = false;

/**
 * One pass. Never rejects.
 *
 * A throw here would kill the interval's callback and, worse, do it silently —
 * leaving paid shops unfulfilled with nothing in the log to say the sweep had
 * stopped running.
 */
async function runReconcilePass() {
  // A slow pass must not overlap the next tick. Gateway lookups are sequential
  // and a hundred of them can outlast five minutes; two passes racing would
  // double every outbound call and have both fight over the same claim.
  if (running) {
    logger.warn('[reconcile] previous pass still running — skipping this tick');
    return null;
  }
  running = true;

  try {
    const summary = await checkoutService.reconcile();

    // Log a pass that did something, and a periodic heartbeat otherwise. "The
    // sweep ran and found nothing" and "the sweep is not running" have to be
    // distinguishable in the log — that distinction is the difference between
    // a quiet day and a silent outage that is costing shops their renewals.
    if (summary.checked || summary.fulfilled || summary.failed || summary.abandoned) {
      logger.info(
        `[reconcile] checked ${summary.checked}, fulfilled ${summary.fulfilled}, ` +
        `failed ${summary.failed}, still pending ${summary.pending}, abandoned ${summary.abandoned}`
      );
    }
    return summary;
  } catch (err) {
    logger.error(`[reconcile] pass failed: ${err.message}`);
    return null;
  } finally {
    running = false;
  }
}

function startPaymentReconcileJob() {
  if (timerHandle) return;
  logger.info(`Initializing payment reconciliation sweep (every ${Math.round(TICK_INTERVAL_MS / 1000)}s)...`);
  timerHandle = setInterval(() => { runReconcilePass(); }, TICK_INTERVAL_MS);
  // Must never be the reason the process refuses to exit.
  timerHandle.unref();
}

function stopPaymentReconcileJob() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
    logger.info('Stopped payment reconciliation sweep.');
  }
}

module.exports = {
  startPaymentReconcileJob,
  stopPaymentReconcileJob,
  runReconcilePass,
  TICK_INTERVAL_MS,
  // Test seam: `running` is module state, and a test that could not reset it
  // would pass or fail depending on the order the suite ran in.
  _setRunning: (v) => { running = v; },
};
