const ApiResponse = require('../utils/response.util');
const logger = require('../utils/logger.util');

/**
 * Custom Error Class
 */
class AppError extends Error {
  constructor(message, messageBn, statusCode) {
    super(message);
    this.messageBn = messageBn;
    this.statusCode = statusCode;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Handle Cast Error (Invalid MongoDB ObjectId)
 */
const handleCastErrorDB = (err) => {
  const message = `Invalid ${err.path}: ${err.value}`;
  const messageBn = `অবৈধ ${err.path}: ${err.value}`;
  return new AppError(message, messageBn, 400);
};

/**
 * Handle Duplicate Field Error
 */
const handleDuplicateFieldsDB = (err) => {
  const value = err.errmsg.match(/(["'])(\\?.)*?\1/)?.[0] || 'value';
  const message = `Duplicate field value: ${value}. Please use another value.`;
  const messageBn = `এই তথ্য আগে থেকেই আছে: ${value}। অন্য তথ্য ব্যবহার করুন।`;
  return new AppError(message, messageBn, 409);
};

/**
 * Handle Validation Error
 */
const handleValidationErrorDB = (err) => {
  const errors = Object.values(err.errors).map(el => el.message);
  const message = `Validation failed: ${errors.join('. ')}`;
  const messageBn = `তথ্য যাচাই ব্যর্থ: ${errors.join('. ')}`;
  return new AppError(message, messageBn, 422);
};

/**
 * Handle JWT Error
 */
const handleJWTError = () => {
  return new AppError(
    'Invalid token. Please log in again.',
    'অবৈধ টোকেন। অনুগ্রহ করে পুনরায় লগইন করুন।',
    401
  );
};

/**
 * Handle JWT Expired Error
 */
const handleJWTExpiredError = () => {
  return new AppError(
    'Your session has expired. Please log in again.',
    'আপনার সেশন শেষ হয়ে গেছে। অনুগ্রহ করে পুনরায় লগইন করুন।',
    401
  );
};

/**
 * Send Error Response in Development
 */
const sendErrorDev = (err, res) => {
  return res.status(err.statusCode || 500).json({
    success: false,
    statusCode: err.statusCode || 500,
    message: err.message,
    messageBn: err.messageBn || 'কিছু সমস্যা হয়েছে',
    error: err,
    stack: err.stack,
    timestamp: new Date().toISOString()
  });
};

/**
 * Send Error Response in Production
 */
const sendErrorProd = (err, res) => {
  // Operational, trusted error: send message to client
  if (err.isOperational) {
    return ApiResponse.error(res, {
      message: err.message,
      messageBn: err.messageBn || 'কিছু সমস্যা হয়েছে',
      statusCode: err.statusCode
    });
  }

  // Programming or other unknown error: don't leak error details
  logger.error('ERROR 💥:', err);

  return ApiResponse.serverError(res, {
    message: 'Something went wrong!',
    messageBn: 'কিছু সমস্যা হয়েছে!'
  });
};

/**
 * Global Error Handler Middleware
 */
const errorHandler = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.message = err.message || 'Something went wrong';

  // Log error
  logger.error(`${err.statusCode} - ${err.message} - ${req.originalUrl} - ${req.method} - ${req.ip}`);

  if (process.env.NODE_ENV === 'development') {
    return sendErrorDev(err, res);
  }

  // Production error handling
  let error = { ...err };
  error.message = err.message;
  error.messageBn = err.messageBn;

  // Handle specific error types
  if (err.name === 'CastError') error = handleCastErrorDB(err);
  if (err.code === 11000) error = handleDuplicateFieldsDB(err);
  if (err.name === 'ValidationError') error = handleValidationErrorDB(err);
  if (err.name === 'JsonWebTokenError') error = handleJWTError();
  if (err.name === 'TokenExpiredError') error = handleJWTExpiredError();

  return sendErrorProd(error, res);
};

/**
 * Handle 404 Not Found
 */
const notFoundHandler = (req, res, next) => {
  const err = new AppError(
    `Route ${req.originalUrl} not found`,
    `${req.originalUrl} রাউট পাওয়া যায়নি`,
    404
  );
  next(err);
};

module.exports = {
  AppError,
  errorHandler,
  notFoundHandler
};
