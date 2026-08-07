const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const morgan = require('morgan');

const { apiLimiter, authLimiter } = require('./middleware/rateLimiter.middleware');
const { errorHandler, notFoundHandler } = require('./middleware/error.middleware');
const { requestContext } = require('./middleware/requestContext.middleware');
const { getCacheInfo } = require('./config/redis.config');
const logger = require('./utils/logger.util');

// Create Express app
const app = express();

// Trust proxy (for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Health Check Endpoint — registered before the middleware stack so load-balancer
// probes stay cheap and don't pollute logs or rate-limit buckets
app.get('/health', (req, res) => {
  const mongoose = require('mongoose');
  const cacheInfo = getCacheInfo();
  const dbReady = mongoose.connection.readyState === 1;
  res.status(dbReady ? 200 : 503).json({
    success: dbReady,
    message: dbReady ? 'Server is healthy' : 'Database not connected',
    messageBn: dbReady ? 'সার্ভার সচল আছে' : 'ডাটাবেস সংযোগ নেই',
    timestamp: new Date().toISOString(),
    db: { readyState: mongoose.connection.readyState },
    cache: cacheInfo
  });
});

// Security Middleware
app.use(helmet());

// CORS Configuration
const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'])
      .map(o => o.trim()); // Trim whitespace/\r from each origin

    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      logger.warn(`CORS blocked origin: "${origin}" | Allowed: ${JSON.stringify(allowedOrigins)}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // x-shop-id lets a platform admin act inside a specific shop from the admin
  // panel; without it in this list the browser strips the header entirely.
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-active-branch', 'x-shop-id', 'x-idempotency-key']
};
app.use(cors(corsOptions));

// Rate Limiting — BEFORE body parsing so rejected/flooding requests never pay
// for a multi-MB JSON.parse + sanitize walk (previously the limiter ran last)
app.use('/api', apiLimiter);

// Response Compression (gzip/deflate) — reduces transfer size by 60-80%.
// Level 4 gives ~90% of the size reduction of the default (6) at a fraction of the CPU.
app.use(compression({ level: 4, threshold: 2048 }));

// Body Parsing. Bulk-import endpoints get a larger limit; everything else is
// capped at 1 MB — a 10 MB global limit meant ~50-100ms of blocked event loop
// per oversized payload, available to any client.
const bulkBodyLimit = process.env.REQUEST_BODY_LIMIT_BULK || process.env.REQUEST_BODY_LIMIT || '10mb';
app.use(
  ['/api/products/bulk-import', '/api/products/bulk-stock', '/api/customers/bulk-import'],
  express.json({ limit: bulkBodyLimit })
);
const bodyLimit = process.env.REQUEST_BODY_LIMIT_DEFAULT || '1mb';
app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

// Cookie Parser
app.use(cookieParser());

// Request Context (IP, User Agent, Device info)
app.use(requestContext);

// Data Sanitization against NoSQL Injection
app.use(mongoSanitize());

// Prevent HTTP Parameter Pollution
app.use(hpp());

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', { stream: logger.stream }));
}

// API Routes
app.use('/api', require('./routes'));

// Handle 404
app.use(notFoundHandler);

// Global Error Handler
app.use(errorHandler);

module.exports = app;
