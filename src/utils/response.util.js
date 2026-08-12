/**
 * Standardized API Response Utility
 * Provides consistent response format across all endpoints
 */

class ApiResponse {
  /**
   * Send success response
   */
  static success(res, {
    data = null,
    message = 'Success',
    statusCode = 200
  }) {
    return res.status(statusCode).json({
      success: true,
      statusCode,
      message,
      data,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send error response
   *
   * `messageBn` is the whole point of this app's error copy and it used to be
   * silently dropped here: callers all over the codebase — `validate.middleware`
   * included — passed a carefully written Bengali sentence into `badRequest`,
   * `notFound`, `conflict` and friends, and this method destructured only
   * `message`, `statusCode` and `errors`. The Bengali never reached the wire,
   * so `lib/axios.js` read `data.messageBn` as undefined and every Redux thunk's
   * `error.messageBn || error.message` fell through to English. For a
   * Bengali-first audience that happened at exactly the moments users panic.
   *
   * It is omitted from the body rather than sent as `null` when absent, so a
   * client can distinguish "no Bengali copy for this error" from "the key is
   * always there and always empty".
   */
  static error(res, {
    message = 'Something went wrong',
    messageBn = null,
    statusCode = 500,
    errors = null
  }) {
    const body = {
      success: false,
      statusCode,
      message,
      errors,
      timestamp: new Date().toISOString()
    };
    if (messageBn) body.messageBn = messageBn;
    return res.status(statusCode).json(body);
  }

  /**
   * Send paginated response
   * Supports both: { page, limit, total } OR { pagination: { page, limit, total } }
   */
  static paginated(res, {
    data,
    page,
    limit,
    total,
    pagination,
    message = 'Success',
    ...extra
  }) {
    // Support both direct params and nested pagination object
    const pPage = page ?? pagination?.page ?? 1;
    const pLimit = limit ?? pagination?.limit ?? 20;
    const pTotal = total ?? pagination?.total ?? 0;

    const currentPage = parseInt(pPage) || 1;
    const currentLimit = parseInt(pLimit) || 20;
    const pages = Math.ceil(pTotal / currentLimit) || 0;

    return res.status(200).json({
      success: true,
      statusCode: 200,
      message,
      data,
      pagination: {
        page: currentPage,
        limit: currentLimit,
        total: pTotal,
        pages,
        hasNext: currentPage < pages,
        hasPrev: currentPage > 1
      },
      ...extra,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send created response (201)
   */
  static created(res, {
    data = null,
    message = 'Created successfully'
  }) {
    return this.success(res, { data, message, statusCode: 201 });
  }

  /**
   * Send no content response (204)
   */
  static noContent(res) {
    return res.status(204).send();
  }

  /**
   * Send bad request response (400)
   */
  static badRequest(res, {
    message = 'Bad request',
    messageBn = null,
    errors = null
  }) {
    return this.error(res, { message, messageBn, statusCode: 400, errors });
  }

  /**
   * Send unauthorized response (401)
   */
  static unauthorized(res, {
    message = 'Unauthorized',
    messageBn = null
  }) {
    return this.error(res, { message, messageBn, statusCode: 401 });
  }

  /**
   * Send forbidden response (403)
   */
  static forbidden(res, {
    message = 'Access forbidden',
    messageBn = null,
    code = null
  }) {
    const body = { success: false, statusCode: 403, message, timestamp: new Date().toISOString() };
    if (messageBn) body.messageBn = messageBn;
    if (code) body.code = code;
    return res.status(403).json(body);
  }

  /**
   * Send payment required response (402) — used for expired subscriptions
   */
  static paymentRequired(res, {
    message = 'Subscription required',
    messageBn = null,
    code = 'SUBSCRIPTION_EXPIRED'
  }) {
    const body = {
      success: false,
      statusCode: 402,
      message,
      code,
      timestamp: new Date().toISOString()
    };
    if (messageBn) body.messageBn = messageBn;
    return res.status(402).json(body);
  }

  /**
   * Send not found response (404)
   */
  static notFound(res, {
    message = 'Resource not found',
    messageBn = null
  }) {
    return this.error(res, { message, messageBn, statusCode: 404 });
  }

  /**
   * Send conflict response (409)
   */
  static conflict(res, {
    message = 'Resource already exists',
    messageBn = null
  }) {
    return this.error(res, { message, messageBn, statusCode: 409 });
  }

  /**
   * Send validation error response (422)
   */
  static validationError(res, {
    message = 'Validation failed',
    messageBn = null,
    errors = null
  }) {
    return this.error(res, { message, messageBn, statusCode: 422, errors });
  }

  /**
   * Send too many requests response (429)
   */
  static tooManyRequests(res, {
    message = 'Too many requests',
    messageBn = null
  }) {
    return this.error(res, { message, messageBn, statusCode: 429 });
  }

  /**
   * Send server error response (500)
   */
  static serverError(res, {
    message = 'Internal server error',
    messageBn = null
  }) {
    return this.error(res, { message, messageBn, statusCode: 500 });
  }
}

module.exports = ApiResponse;
