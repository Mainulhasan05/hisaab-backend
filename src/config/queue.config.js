/**
 * BullMQ connection and queue construction.
 *
 * ── Why this exists alongside redis.config.js ───────────────────────────────
 *
 * There are now two Redis clients in this process, deliberately:
 *
 *   `redis.config.js`  — node-redis v4, for cache, rate limits, idempotency
 *                        locks and presence. Every one of those DEGRADES: when
 *                        Redis is gone they fall back to an in-process Map and
 *                        the app keeps serving, worse but alive.
 *   this file          — ioredis (BullMQ's own, nested), for the SMS queue.
 *                        A queue CANNOT degrade. There is no in-memory fallback
 *                        for durability; that is the entire point of using one.
 *
 * They are separate clients because BullMQ requires ioredis and the rest of the
 * app is on node-redis v4. Upgrading node-redis to v5 to share one client would
 * churn the cache, idempotency and rate-limit layers — a much larger blast
 * radius than a second connection.
 *
 * ── The degradation rule ────────────────────────────────────────────────────
 *
 * When Redis is unreachable the queue does not silently fall back to running
 * work in-process. It REFUSES, and the caller surfaces that. A send that
 * quietly reverts to `setImmediate` is a send that quietly dies on the next
 * deploy — which is the failure this whole change exists to remove, reappearing
 * as a fallback path nobody tests.
 */

const logger = require('../utils/logger.util');

let Queue;
let Worker;
try {
  ({ Queue, Worker } = require('bullmq'));
} catch (err) {
  logger.warn(`BullMQ not installed (${err.message}) — queued work is unavailable`);
}

/** One queue name, one place. Changing it strands whatever is already enqueued. */
const SMS_QUEUE = 'sms-campaign';

let smsQueue = null;
let available = false;

/**
 * Connection options, NOT a client instance.
 *
 * BullMQ constructs its own ioredis connections from these — one for the queue,
 * separate blocking ones per worker. Handing it a shared instance is what
 * produces "Connection is in subscriber mode" errors, because a blocking BRPOP
 * cannot share a socket with ordinary commands.
 *
 * Mirrors the connection modes `redis.config.js` supports, so both clients
 * follow the same environment: a Unix socket on shared hosting, TCP elsewhere.
 */
function connectionOptions() {
  const socketPath = process.env.REDIS_SOCKET;
  const host = process.env.REDIS_HOST;

  const base = {
    // Required by BullMQ workers: its blocking commands must not be capped by
    // a retry limit, or a brief Redis blip kills the worker instead of waiting.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 200, 10000),
  };

  if (socketPath) return { ...base, path: socketPath };

  if (host) {
    return {
      ...base,
      host,
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
    };
  }

  return null;
}

/** Is the queue usable? Callers must check before enqueueing. */
function isQueueEnabled() {
  const useRedis = process.env.USE_REDIS === 'true' || process.env.USE_REDIS === '1';
  const notDisabled = process.env.USE_SMS_QUEUE !== 'false';
  return Boolean(Queue) && useRedis && notDisabled && Boolean(connectionOptions());
}

/**
 * The queue handle, built once.
 *
 * Constructed lazily so requiring this module never opens a socket — the tests
 * and the CLI scripts pull in the SMS service without wanting a Redis
 * connection.
 */
function getSmsQueue() {
  if (!isQueueEnabled()) return null;
  if (smsQueue) return smsQueue;

  try {
    smsQueue = new Queue(SMS_QUEUE, {
      connection: connectionOptions(),
      defaultJobOptions: {
        // Three attempts with exponential backoff. This replaces the hand-rolled
        // single retry inside `sendBatch` for TRANSPORT failures; a gateway that
        // REFUSES (a 200 with a Failed body) is still not retried, because the
        // answer will not change.
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        // Keep a window of finished jobs for diagnosis, then let them go. The
        // SMSLog is the permanent record; these are the queue's own breadcrumbs.
        removeOnComplete: { age: 24 * 3600, count: 500 },
        removeOnFail: { age: 7 * 24 * 3600, count: 500 },
      },
    });

    smsQueue.on('error', (err) => {
      // Never throw from here — an unhandled 'error' on the queue's connection
      // takes the process down, and a Redis blip must not kill the API.
      logger.error(`[queue] sms queue error: ${err.message}`);
    });

    available = true;
    logger.info(
      `[queue] SMS queue ready via ${process.env.REDIS_SOCKET ? 'unix socket' : 'tcp'}`
    );
    return smsQueue;
  } catch (err) {
    logger.error(`[queue] could not create SMS queue: ${err.message}`);
    smsQueue = null;
    available = false;
    return null;
  }
}

/**
 * Build the worker that drains the queue.
 *
 * Called from `src/index.js` on the primary PM2 worker only — see the comment
 * there. `concurrency: 1` because the constraint is the SMS gateway, not this
 * process: MimSMS rate-limits, and the batch pacing inside `runCampaign`
 * already exists to stay under it. Running four campaign jobs at once would
 * defeat that pacing from the outside.
 */
function createSmsWorker(processor) {
  if (!isQueueEnabled()) return null;

  try {
    const worker = new Worker(SMS_QUEUE, processor, {
      connection: connectionOptions(),
      concurrency: Number(process.env.SMS_QUEUE_CONCURRENCY) || 1,
      // A campaign of 5,000 recipients is 50 batches at ~250ms plus gateway
      // time. The default 30s lock would expire mid-run and let a second worker
      // pick up a job that is still going — sending everything twice.
      lockDuration: Number(process.env.SMS_QUEUE_LOCK_MS) || 5 * 60 * 1000,
    });

    worker.on('error', (err) => logger.error(`[queue] sms worker error: ${err.message}`));
    worker.on('failed', (job, err) =>
      logger.error(`[queue] campaign job ${job?.id} failed: ${err?.message}`)
    );
    worker.on('completed', (job) => logger.info(`[queue] campaign job ${job.id} done`));

    logger.info('[queue] SMS worker started');
    return worker;
  } catch (err) {
    logger.error(`[queue] could not start SMS worker: ${err.message}`);
    return null;
  }
}

/** Queue depth, for the admin panel. Never throws. */
async function getQueueStats() {
  const queue = getSmsQueue();
  if (!queue) {
    return { available: false, enabled: isQueueEnabled(), counts: null };
  }
  try {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    return { available: true, enabled: true, counts };
  } catch (err) {
    return { available: false, enabled: true, counts: null, error: err.message };
  }
}

async function closeQueue() {
  if (smsQueue) {
    try {
      await smsQueue.close();
      logger.info('[queue] SMS queue closed');
    } catch (err) {
      logger.error(`[queue] error closing queue: ${err.message}`);
    }
    smsQueue = null;
    available = false;
  }
}

module.exports = {
  SMS_QUEUE,
  isQueueEnabled,
  getSmsQueue,
  createSmsWorker,
  getQueueStats,
  closeQueue,
  connectionOptions,
  isAvailable: () => available,
};
