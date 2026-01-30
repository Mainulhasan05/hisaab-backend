require('dotenv').config();

const app = require('./app');
const connectDB = require('./config/database');
const { initializeRedis, closeConnection: closeRedis } = require('./config/redis.config');
const logger = require('./utils/logger.util');

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT EXCEPTION! 💥 Shutting down...');
  logger.error(err.name, err.message);
  process.exit(1);
});

// Connect to Database and initialize services
connectDB().then(async () => {
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
});

// Initialize Redis (with in-memory fallback)
initializeRedis().then((connected) => {
  if (connected) {
    logger.info('Redis cache initialized');
  } else {
    logger.info('Using in-memory cache (Redis not available)');
  }
}).catch((err) => {
  logger.warn('Redis initialization error, using in-memory cache:', err.message);
});

// Start Server
const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
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

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  logger.error('UNHANDLED REJECTION! 💥 Shutting down...');
  logger.error(err.name, err.message);
  server.close(() => {
    process.exit(1);
  });
});

// Handle SIGTERM
process.on('SIGTERM', async () => {
  logger.info('👋 SIGTERM RECEIVED. Shutting down gracefully');
  await closeRedis();
  server.close(() => {
    logger.info('💥 Process terminated!');
  });
});
