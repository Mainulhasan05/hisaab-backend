require('dotenv').config();
const { validateEnv } = require('./config/env');
validateEnv();

const app = require('./app');
const connectDB = require('./config/database');
const { initializeRedis, closeConnection: closeRedis } = require('./config/redis.config');
const logger = require('./utils/logger.util');

// Register all models early so Mongoose can resolve populate refs
require('./models/Role.model');

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT EXCEPTION! 💥 Shutting down...');
  logger.error(err.stack || err);
  process.exit(1);
});

const PORT = process.env.PORT || 5000;
let server = null;

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
  // and must not delay startup
  runSeeders().catch((err) => logger.warn('Seeding error:', err.message));
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

  // Force-exit fallback: never hang longer than 10s on shutdown
  const forceExit = setTimeout(() => {
    logger.error('Forced shutdown after 10s timeout');
    process.exit(code || 1);
  }, 10000);
  forceExit.unref();

  try {
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
