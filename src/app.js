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
// testing deployment comment

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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};
app.use(cors(corsOptions));

// Response Compression (gzip/deflate) — reduces transfer size by 60-80%
app.use(compression());
// Body Parsing
const bodyLimit = process.env.REQUEST_BODY_LIMIT || '10mb';
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

// Rate Limiting
app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);

// Health Check Endpoint
app.get('/health', (req, res) => {
  const cacheInfo = getCacheInfo();
  res.status(200).json({
    success: true,
    message: 'Server is healthy',
    messageBn: 'সার্ভার সচল আছে',
    timestamp: new Date().toISOString(),
    cache: cacheInfo
  });
});

// API Routes
app.use('/api', require('./routes'));

// Handle 404
app.use(notFoundHandler);

// Global Error Handler
app.use(errorHandler);

module.exports = app;
