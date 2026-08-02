const winston = require('winston');
const path = require('path');

// Log directory anchored to the app root, not process.cwd() — starting the
// server from another directory must not scatter log files
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    return stack
      ? `${timestamp} [${level.toUpperCase()}]: ${message}\n${stack}`
      : `${timestamp} [${level.toUpperCase()}]: ${message}`;
  })
);

// Define log format for console (with colors)
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `${timestamp} ${level}: ${message}`;
  })
);

const isProduction = process.env.NODE_ENV === 'production';

const transports = [
  // Error log file
  new winston.transports.File({
    filename: path.join(LOG_DIR, 'error.log'),
    level: 'error',
    maxsize: 5242880, // 5MB
    maxFiles: 5
  }),
  // Combined log file
  new winston.transports.File({
    filename: path.join(LOG_DIR, 'combined.log'),
    maxsize: 5242880, // 5MB
    maxFiles: 5
  })
];

// Console transport only outside production: stdout writes are blocking when
// redirected to a file/pipe (the usual PM2/shared-hosting setup), which stalls
// the event loop under load. Errors still go to error.log in production.
if (!isProduction) {
  transports.unshift(new winston.transports.Console({ format: consoleFormat }));
}

// Create logger instance
const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  format: logFormat,
  transports,
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'exceptions.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 3
    })
  ],
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'rejections.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 3
    })
  ]
});

// Create a stream object for Morgan
logger.stream = {
  write: (message) => {
    logger.info(message.trim());
  }
};

module.exports = logger;
