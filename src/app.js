const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const morgan = require('morgan');

const {
  apiLimiter,
  authLimiter,
  isPublicStorefrontPath,
  isPaymentReturnPath,
} = require('./middleware/rateLimiter.middleware');
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
/* One CORS mount, with one exception.
 *
 * The payment gateway returns a paying customer's BROWSER to us. If it does so
 * with a form POST, that navigation carries `Origin: https://api.paystation.com.bd`
 * — an origin that is not in ALLOWED_ORIGINS and must never be added to it,
 * because that list governs who may make credentialed XHR calls against this
 * API. The callback above answers a disallowed origin with an Error, which the
 * error handler turns into a 500, so the customer would be shown a server error
 * instead of the subscription they had just paid for.
 *
 * `cors` accepts a per-request delegate for exactly this. See
 * `isPaymentReturnPath` for why waving this one path through costs nothing:
 * CORS governs whether a browser may READ a cross-origin response, and has
 * never applied to top-level navigations, which is what this request is. */
app.use(cors((req, callback) => {
  if (isPaymentReturnPath(req)) {
    return callback(null, { ...corsOptions, origin: true });
  }
  return callback(null, corsOptions);
}));

// Rate Limiting — BEFORE body parsing so rejected/flooding requests never pay
// for a multi-MB JSON.parse + sanitize walk (previously the limiter ran last)
//
// `/api/public/*` is skipped here and carries `storefrontLimiter` instead, from
// its own router. The two are alternatives rather than layers: a request that
// counted against both buckets would make a 429 impossible to attribute, and
// the tighter ceiling would silently become the only one that mattered. The
// point of a separate tier is that a storefront being hammered cannot spend the
// allowance the till is relying on (ECOMMERCE_PLAN.md §13).
app.use('/api', (req, res, next) => {
  if (isPublicStorefrontPath(req)) return next();
  return apiLimiter(req, res, next);
});

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
