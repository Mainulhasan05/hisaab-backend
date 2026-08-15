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
  // Use keyValue for better error messages (shows actual field names)
  const keyValue = err.keyValue || {};
  const fields = Object.keys(keyValue).filter(k => k !== 'shop');
  const fieldName = fields[0] || 'value';
  const fieldValue = keyValue[fieldName] || '';

  const fieldLabels = {
    invoiceNo: 'ইনভয়েস নম্বর',
    code: 'পণ্য কোড',
    phone: 'ফোন নম্বর',
    email: 'ইমেইল',
    barcode: 'বারকোড',
    slug: 'স্লাগ',
    name: 'নাম',
  };
  const label = fieldLabels[fieldName] || fieldName;

  const message = `Duplicate ${fieldName}: ${fieldValue}. Please use another value.`;
  const messageBn = `এই ${label} আগে থেকেই আছে: ${fieldValue}। অন্য ${label} ব্যবহার করুন।`;
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
    // Top-level, not just nested inside `error` below. `lib/axios.js` reads
    // `data.messageBn`, so burying it in the debug blob meant the Bengali was
    // missing in development too — the same bug the production path had.
    messageBn: err.messageBn || null,
    // The same passthrough fields production sends, for the same reason the
    // Bengali one is here: a client branches on `code` (MEDIA_IN_USE,
    // PLATFORM_MEDIA_QUOTA_EXCEEDED, WRONG_BRANCH, BRANCH_REQUIRED …), and
    // sending them in production but not development meant every one of those
    // branches was dead on a developer's machine and only came alive after
    // deploy. `error: err` below does not cover it: `lib/axios.js` reads
    // `data.code`, not `data.error.code`.
    ...passthroughFields(err),
    error: err,
    stack: err.stack,
    timestamp: new Date().toISOString()
  });
};

/**
 * The structured extras an `AppError` may carry beyond its two messages.
 *
 * These are the contract between a service that refuses something and the
 * screen that has to explain the refusal — "used by WHAT", "which branch",
 * "how full". Every one of them is opt-in: a plain `AppError` adds nothing.
 */
const passthroughFields = (err) => {
  const out = {};

  if (err.code) out.code = err.code;
  if (err.phone) out.phone = err.phone;
  // WRONG_BRANCH carries the branch a record actually belongs to, so the
  // client can name it and offer a one-click switch instead of a bare 404.
  if (err.branch) out.branch = err.branch;

  // MEDIA_IN_USE and FOLDER_NOT_EMPTY exist to answer "used by WHAT" — the
  // whole reason `PlatformMedia.refs` stores owners rather than a counter.
  // Both services build that list and hang it on the error; dropping it here
  // left the client able to render only the generic refusal, and the admin
  // hunting through every page they had ever built.
  if (err.usedBy) out.usedBy = err.usedBy;
  if (err.files) out.files = err.files;

  // The quota errors carry the numbers their message interpolates, so a client
  // can render a meter rather than re-parsing the sentence.
  if (err.quotaMb !== undefined) out.quotaMb = err.quotaMb;
  if (err.usedBytes !== undefined) out.usedBytes = err.usedBytes;

  // CONTRACT_INVALID carries every reason a landing page was refused. Dropping
  // it here meant a publish that failed on four things said only "this page
  // cannot take an order yet", and the author had to guess which four.
  if (err.issues) out.issues = err.issues;

  return out;
};

/**
 * Send Error Response in Production
 */
const sendErrorProd = (err, res) => {
  // Operational, trusted error: send message to client
  if (err.isOperational) {
    const response = {
      success: false,
      statusCode: err.statusCode,
      message: err.message,
      // Every `AppError` in this codebase is constructed with a Bengali
      // sentence beside the English one, and this response object used to
      // serialise only the English. The result was that the whole Bengali
      // error vocabulary — hundreds of hand-written messages — existed, was
      // maintained, and never once reached a shopkeeper's screen in
      // production. Omitted rather than sent as null when there is no Bengali
      // copy, matching `ApiResponse.error`.
      timestamp: new Date().toISOString()
    };

    if (err.messageBn) response.messageBn = err.messageBn;

    // Shared with `sendErrorDev` so the two responses cannot drift — a client
    // branch that works in development must work in production and vice versa.
    Object.assign(response, passthroughFields(err));

    return res.status(err.statusCode).json(response);
  }

  // Programming or other unknown error: log it and return actual message for debugging
  logger.error('ERROR 💥:', err);

  return res.status(err.statusCode || 500).json({
    success: false,
    statusCode: err.statusCode || 500,
    message: err.message || 'Something went wrong!',
    // A non-operational error has no authored Bengali copy — it is a crash, not
    // a message we wrote. A generic sentence still beats showing a shopkeeper
    // an English stack fragment with no idea what to do next.
    messageBn: 'কিছু একটা সমস্যা হয়েছে। আবার চেষ্টা করুন।',
    errors: null,
    timestamp: new Date().toISOString()
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

  // Handle specific error types (both dev and prod need proper messageBn)
  let error = { ...err };
  error.message = err.message;
  error.messageBn = err.messageBn;
  error.statusCode = err.statusCode;
  error.isOperational = err.isOperational;
  if (err.code) error.code = err.code;
  if (err.phone) error.phone = err.phone;
  if (err.branch) error.branch = err.branch;

  if (err.name === 'CastError') error = handleCastErrorDB(err);
  if (err.code === 11000) error = handleDuplicateFieldsDB(err);
  if (err.name === 'ValidationError') error = handleValidationErrorDB(err);
  if (err.name === 'JsonWebTokenError') error = handleJWTError();
  if (err.name === 'TokenExpiredError') error = handleJWTExpiredError();

  if (process.env.NODE_ENV === 'development') {
    return sendErrorDev(error, res);
  }

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

const asyncHandler = require('../utils/asyncHandler.util');

module.exports = {
  AppError,
  errorHandler,
  notFoundHandler,
  asyncHandler,
};

