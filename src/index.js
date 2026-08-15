require('dotenv').config();
const { validateEnv } = require('./config/env');
validateEnv();

const app = require('./app');
const connectDB = require('./config/database');
const { initializeRedis, closeConnection: closeRedis } = require('./config/redis.config');
const logger = require('./utils/logger.util');

const { startSyncJob, stopSyncJob } = require('./jobs/userActivitySync.job');
const { startDigestJob, stopDigestJob } = require('./jobs/dailyDigest.job');
const {
  startStorageMaintenanceJob,
  stopStorageMaintenanceJob,
} = require('./jobs/storageMaintenance.job');
const telegramService = require('./services/telegram.service');
const smsService = require('./services/sms.service');
const { createSmsWorker, closeQueue } = require('./config/queue.config');

// Register all models early so Mongoose can resolve populate refs
require('./models/Role.model');

/**
 * Every consumer announces itself to the media library.
 *
 * The library keeps no list of its consumers — the dependency points one way
 * (MEDIA_GALLERY_PLAN.md §4.3), so registration is a call the consumer makes.
 * It runs at require time, in EVERY worker rather than only the primary,
 * because it is not a job: without it a request served by worker 3 would find
 * an empty "যেখানে ব্যবহৃত" list and, worse, the I-18 `confirmInUse` backstop
 * would not run — the reclamation sweep would then delete images off a live,
 * ad-funded page and report success.
 */
require('./services/landingPage.service').registerAsMediaConsumer();
require('./services/adminStorefront.service').registerAsMediaConsumer();

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT EXCEPTION! 💥 Shutting down...');
  logger.error(err.stack || err);
  process.exit(1);
});

const PORT = process.env.PORT || 5000;
let server = null;
let smsWorker = null;

// PM2 sets NODE_APP_INSTANCE per worker in cluster mode ('0', '1', …). When it
// is absent the process was started directly, which is a single process and so
// is itself the primary. See ecosystem.config.js.
const isPrimaryWorker =
  !process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0';

async function runSeeders() {
  try {
    const ExpenseCategory = require('./models/ExpenseCategory.model');
    await ExpenseCategory.seedDefaults();
    logger.info('Default expense categories seeded');
  } catch (err) {
    logger.warn('Expense category seeding skipped:', err.message);
  }

  // Seed super admin
  try {
    const { seedSuperAdmin } = require('./seeds/adminSeeder');
    const result = await seedSuperAdmin();
    if (result.created) {
      logger.info('Super admin seeded successfully');
    }
  } catch (err) {
    logger.warn('Super admin seeding skipped:', err.message);
  }

  // Seed default page content
  try {
    const PageContent = require('./models/PageContent.model');
    await PageContent.seedDefaults();
    logger.info('Default page content seeded');
  } catch (err) {
    logger.warn('Page content seeding skipped:', err.message);
  }

  // Seed shop categories
  try {
    const { seedShopCategories } = require('./seeds/shopCategorySeeder');
    await seedShopCategories();
    logger.info('Default shop categories seeded');
  } catch (err) {
    logger.warn('Shop category seeding skipped:', err.message);
  }
}

/**
 * Say at boot whether images can be uploaded.
 *
 * Storage is optional, so a deploy missing `STORAGE_ENC_KEY` or holding no
 * active R2 account starts perfectly cleanly and serves every other route. The
 * first sign of trouble is an admin getting a 503 on an image upload, possibly
 * days later and a long way from the deploy that caused it. One line here turns
 * that into something visible in the startup log.
 *
 * Never throws: this is a diagnostic, and a diagnostic must not be the reason a
 * server fails to boot.
 */
async function reportStorageReadiness() {
  try {
    const { uploadBlocker } = require('./utils/uploadReadiness.util');
    const blocker = await uploadBlocker();

    if (blocker) {
      logger.warn(`Image uploads are DISABLED — ${blocker.code}: ${blocker.detail}`);
    } else {
      logger.info('Image uploads ready — image pipeline and R2 pool are both configured');
    }
  } catch (err) {
    logger.warn(`Could not determine image upload readiness: ${err.message}`);
  }
}

async function start() {
  // Redis init runs in parallel with Mongo — it has an in-memory fallback and
  // must not delay startup, but the HTTP listener waits for Mongo: accepting
  // traffic before the DB is up just buffers requests into 10s timeouts.
  const redisInit = initializeRedis()
    .then((connected) => {
      logger.info(connected ? 'Redis cache initialized' : 'Using in-memory cache (Redis not available)');
    })
    .catch((err) => {
      logger.warn('Redis initialization error, using in-memory cache:', err.message);
    });

  await connectDB();
  await redisInit;

  server = app.listen(PORT, () => {
    logger.info(`
    ╔═══════════════════════════════════════════════════════╗
    ║                                                       ║
    ║   হিসাব - Hisaab Backend Server                       ║
    ║                                                       ║
    ║   Environment: ${process.env.NODE_ENV || 'development'}                           ║
    ║   Port: ${PORT}                                          ║
    ║   URL: http://localhost:${PORT}                          ║
    ║                                                       ║
    ╚═══════════════════════════════════════════════════════╝
    `);
  });

  // Must exceed any upstream proxy's keepalive (nginx default 75s is on the
  // proxy side; what matters is Node's timeout being LONGER than the proxy's
  // idle reuse window to avoid sporadic 502s from closed-connection reuse)
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  // Seeders run after the server is accepting traffic — they're idempotent
  // and must not delay startup. Only the primary worker runs them: they are
  // idempotent, but four workers racing to seed the same defaults at boot is
  // pointless write contention on every restart.
  if (isPrimaryWorker) {
    runSeeders().catch((err) => logger.warn('Seeding error:', err.message));
    reportStorageReadiness();
  }

  // ── Background jobs: primary worker only ──────────────────────────────────
  //
  // Under PM2 cluster mode (ecosystem.config.js) this file runs once per core.
  // These are interval timers, not request handlers, so running them in every
  // worker multiplies the work without doing anything useful:
  //
  //   - the digest job would tick N times a minute instead of once. Duplicate
  //     SENDS are already prevented — TelegramLink.claimDigest claims the date
  //     atomically — so this is waste rather than breakage, but it is waste
  //     that queries every candidate link N times a minute, forever.
  //   - the activity sync would have N workers reading the same Redis dirty set
  //     and issuing the same bulkWrite.
  //
  // NODE_APP_INSTANCE is set by PM2 ('0', '1', …). Unset means a plain
  // `node src/index.js`, which is a single process and therefore primary.
  if (isPrimaryWorker) {
    // Start 5-minute background user activity database sync job
    startSyncJob();

    // Telegram. Started outside the Redis path on purpose — a Redis blip at boot
    // must not leave the process with no bot until the next restart. initialize()
    // never throws; with no token it logs and returns, and the digest job then
    // no-ops on every tick.
    telegramService.initialize().catch((err) => logger.warn(`Telegram init error: ${err.message}`));
    startDigestJob();

    // Hourly R2 pool repair: hands back byte reservations leaked by crashed
    // uploads and resets the monthly Class A/B counters. Without it a killed
    // process permanently shrinks a bucket's usable capacity, and the symptom
    // is "uploads started failing" with nothing in the logs. See the job file.
    startStorageMaintenanceJob();

    // ── SMS campaign worker ────────────────────────────────────────────────
    //
    // Primary worker only, like everything else in this block — but for a
    // different reason. The others would duplicate WORK; this one would
    // duplicate SENDS if it ran wrong. BullMQ's job lock already guarantees one
    // consumer per job, so N workers would be safe rather than harmful; the
    // real constraint is the SMS gateway. `runCampaign` paces its batches to
    // stay under MimSMS's rate limit, and four workers draining four campaigns
    // at once would defeat that pacing from outside the process that enforces
    // it. One consumer, one pace.
    //
    // Raise SMS_QUEUE_CONCURRENCY only after confirming the gateway tolerates it.
    smsWorker = createSmsWorker(async (job) => smsService.processCampaignJob(job.data));
  } else {
    logger.info(`Worker ${process.env.NODE_APP_INSTANCE}: background jobs run on the primary worker only`);
  }
}

start().catch((err) => {
  logger.error(`Startup failed: ${err.message}`);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  logger.error('UNHANDLED REJECTION! 💥 Shutting down...');
  logger.error(err.name, err.message);
  shutdown(1);
});

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  // Force-exit fallback. Must stay UNDER PM2's `kill_timeout` (12s in
  // ecosystem.config.js) or PM2 SIGKILLs us first and this never runs.
  //
  // The window matters more than it used to: draining the SMS worker waits for
  // the batch in flight, and a batch can sit on the gateway for up to
  // SMS_HTTP_TIMEOUT_MS (10s default). At the old 10s this process was
  // force-killed at almost exactly the moment a slow batch would have returned,
  // losing the progress write it was about to make. 11s leaves that write a
  // moment to land while still beating PM2's axe.
  const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 11000;
  const forceExit = setTimeout(() => {
    logger.error(`Forced shutdown after ${SHUTDOWN_GRACE_MS}ms timeout`);
    process.exit(code || 1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  try {
    stopSyncJob();
    stopDigestJob();
    stopStorageMaintenanceJob();
    telegramService.shutdown();

    // Close the worker BEFORE the HTTP server and before Mongo.
    //
    // `worker.close()` waits for the batch in flight to finish and then stops
    // taking new jobs, so a `pm2 reload` no longer destroys a running campaign:
    // whatever it was doing completes, the log records the progress, and the
    // job returns to the queue for the next worker to resume from
    // `progress.batchesDone`. This is the entire reason the campaign runner
    // moved off `setImmediate` — under PM2, a reload is a routine event, and it
    // used to lose the campaign silently.
    //
    // It has to happen before `mongoose.connection.close()` or the final
    // progress write has no connection to land on.
    if (smsWorker) {
      logger.info('Waiting for the in-flight SMS batch to finish…');
      await smsWorker.close();
      logger.info('SMS worker stopped');
    }
    await closeQueue();

    if (server) {
      await new Promise((resolve) => server.close(resolve));
      logger.info('HTTP server closed');
    }
    await closeRedis();
    const mongoose = require('mongoose');
    await mongoose.connection.close();
    logger.info('Connections closed. Bye 👋');
  } catch (err) {
    logger.error(`Error during shutdown: ${err.message}`);
  }
  process.exit(code);
}

process.on('SIGTERM', () => {
  logger.info('👋 SIGTERM RECEIVED. Shutting down gracefully');
  shutdown(0);
});
process.on('SIGINT', () => {
  logger.info('👋 SIGINT RECEIVED. Shutting down gracefully');
  shutdown(0);
});
