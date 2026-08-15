/**
 * Storage pool housekeeping.
 *
 * `storage.service` ships two repair routines that nothing was calling. Both
 * fix state that is invisible until it has already broken an upload, which is
 * exactly the kind of thing that must not depend on someone remembering to run
 * a script:
 *
 *   releaseStaleReservations()  A process killed between `reserve()` and its
 *                               `finally` leaves `reservedBytes` inflated
 *                               forever. Enough of those and an account reports
 *                               itself full while holding no bytes — allocation
 *                               skips it, and nothing anywhere says why.
 *   rollMonthlyOps()            Class A/B counters are what the admin panel uses
 *                               to judge distance from Cloudflare's free-tier
 *                               ceiling. Never reset, they only ever read as
 *                               "about to blow the limit".
 *
 * It also runs the two reclamation sweeps, which are the only thing anywhere
 * that gives storage back:
 *
 *   sweepStagedMedia()          Images uploaded into a form that was never
 *                               saved. Charged to the shop from the moment they
 *                               were written, so without this an abandoned tab
 *                               costs a shop quota permanently.
 *   sweepOrphanedMedia()        Images whose last reference went away — a photo
 *                               replaced, a product deleted — past their grace
 *                               period.
 *
 * Hourly rather than daily. The reservation TTL is one hour (RESERVATION_TTL_MS),
 * so a daily sweep would leave a leak sitting for up to 24h past the point it
 * became provably dead — and a leak is at its most expensive on a small pool,
 * where one stuck account is 20% of capacity. The reclamation sweeps do not need
 * that cadence (their windows are 48h and 7 days) but they are bounded per pass,
 * so running them hourly is how a backlog drains instead of accumulating into
 * one enormous nightly pass.
 *
 * Runs on the primary PM2 worker only, like every other job here. The counter
 * routines are idempotent `updateMany`s and the sweeps claim each row with a
 * conditional delete, so a second worker running them concurrently would be
 * harmless — just wasted round trips.
 */

const storageService = require('../services/storage.service');
const mediaService = require('../services/media.service');
const platformMediaService = require('../services/platformMedia.service');
const logger = require('../utils/logger.util');

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Long enough after boot that it never competes with connection setup or the
// seeders, short enough that a restart-loop still gets a sweep in.
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000; // 2 minutes

let timerHandle = null;
let firstRunHandle = null;

/**
 * One maintenance pass.
 *
 * Each routine is caught separately: a failure in the month roll (a stray write
 * conflict, say) must not skip the reservation sweep, which is the half that
 * actually unblocks uploads.
 *
 * Never throws — it runs from a timer, where an unhandled rejection takes the
 * process down.
 */
async function runMaintenanceCycle() {
  let released = 0;
  let rolled = 0;
  let staged = null;
  let orphaned = null;
  let platformStaged = null;
  let platformOrphaned = null;

  try {
    released = await storageService.releaseStaleReservations();
  } catch (err) {
    logger.error(`Storage maintenance: releasing stale reservations failed: ${err.message}`);
  }

  try {
    rolled = await storageService.rollMonthlyOps();
  } catch (err) {
    logger.error(`Storage maintenance: monthly ops roll failed: ${err.message}`);
  }

  // Sequential, not parallel: both sweeps delete objects through the same pool
  // of S3 clients and both decrement the same account counters. Running them
  // together buys nothing — each is already batched per bucket — and would make
  // the log impossible to read when one of them fails.
  try {
    staged = await mediaService.sweepStagedMedia();
  } catch (err) {
    logger.error(`Storage maintenance: staged media sweep failed: ${err.message}`);
  }

  try {
    orphaned = await mediaService.sweepOrphanedMedia();
  } catch (err) {
    logger.error(`Storage maintenance: orphaned media sweep failed: ${err.message}`);
  }

  // The platform's own tenant — the admin media library. Same two sweeps, same
  // pool, its own collection and its own byte counters
  // (MEDIA_GALLERY_PLAN.md §7). Wrapped separately so a failure in the
  // library's sweep cannot stop the shop-side one, or the reverse: the two
  // tenants share a bucket and nothing else.
  //
  // These are the sweeps that run the I-18 consumer check, which is why they
  // can report `protected` — files whose refCount says zero but which a
  // consumer still claims.
  try {
    platformStaged = await platformMediaService.sweepStaged();
  } catch (err) {
    logger.error(`Storage maintenance: platform staged sweep failed: ${err.message}`);
  }

  try {
    platformOrphaned = await platformMediaService.sweepOrphaned();
  } catch (err) {
    logger.error(`Storage maintenance: platform orphaned sweep failed: ${err.message}`);
  }

  // Quiet on a healthy pool. A released reservation is worth a line because it
  // means a process died mid-upload, which is a thing worth being able to grep
  // for after the fact. The sweeps log their own totals, and only when they did
  // something.
  if (rolled > 0) {
    logger.info(`Storage maintenance: rolled monthly op counters on ${rolled} account(s)`);
  }

  return { released, rolled, staged, orphaned, platformStaged, platformOrphaned };
}

/** Start the hourly sweep. Idempotent — a second call is a no-op. */
function startStorageMaintenanceJob() {
  if (timerHandle) return;

  logger.info('Initializing storage maintenance background job (1-hour interval)...');

  firstRunHandle = setTimeout(() => {
    firstRunHandle = null;
    runMaintenanceCycle();
  }, FIRST_RUN_DELAY_MS);
  firstRunHandle.unref();

  timerHandle = setInterval(runMaintenanceCycle, MAINTENANCE_INTERVAL_MS);
  timerHandle.unref();
}

/** Stop the sweep, including a pending first run. */
function stopStorageMaintenanceJob() {
  if (firstRunHandle) {
    clearTimeout(firstRunHandle);
    firstRunHandle = null;
  }
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
    logger.info('Stopped storage maintenance background job.');
  }
}

module.exports = {
  startStorageMaintenanceJob,
  stopStorageMaintenanceJob,
  runMaintenanceCycle,
  MAINTENANCE_INTERVAL_MS,
  FIRST_RUN_DELAY_MS,
};
