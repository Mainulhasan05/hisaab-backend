/**
 * User Activity Sync Background Job
 *
 * Runs scheduled batch database sync (write-behind) every 5 minutes.
 * Flushes dirty user lastActive timestamps cached in Redis to MongoDB in bulk.
 */

const userActivityService = require('../services/userActivity.service');
const logger = require('../utils/logger.util');

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let timerHandle = null;

/**
 * Executes a single sync cycle with error logging.
 */
async function runSyncCycle() {
  try {
    const result = await userActivityService.syncToDatabase();
    if (result.syncedCount > 0) {
      logger.info(`Scheduled UserActivitySync job synced ${result.syncedCount} users to database.`);
    }
  } catch (error) {
    logger.error(`Scheduled UserActivitySync job failed: ${error.message}`);
  }
}

/**
 * Starts the background sync job timer (5 minutes interval).
 * Unrefs the timer handle so Node process exit isn't blocked.
 */
function startSyncJob() {
  if (timerHandle) return;

  logger.info('Initializing UserActivitySync background job (5-minute interval)...');
  timerHandle = setInterval(runSyncCycle, SYNC_INTERVAL_MS);
  timerHandle.unref();
}

/**
 * Stops the background sync job timer.
 */
function stopSyncJob() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
    logger.info('Stopped UserActivitySync background job.');
  }
}

module.exports = {
  startSyncJob,
  stopSyncJob,
  runSyncCycle,
  SYNC_INTERVAL_MS
};
