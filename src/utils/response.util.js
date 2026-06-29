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
   */
  static error(res, {
    message = 'Something went wrong',
    statusCode = 500,
    errors = null
  }) {
    return res.status(statusCode).json({
      success: false,
      statusCode,
      message,
      errors,
      timestamp: new Date().toISOString()
    });
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
    errors = null
  }) {
    return this.error(res, { message, statusCode: 400, errors });
  }

  /**
   * Send unauthorized response (401)
   */
  static unauthorized(res, {
    message = 'Unauthorized'
  }) {
    return this.error(res, { message, statusCode: 401 });
  }

  /**
   * Send forbidden response (403)
   */
  static forbidden(res, {
    message = 'Access forbidden',
    code = null
  }) {
    const body = { success: false, statusCode: 403, message, timestamp: new Date().toISOString() };
    if (code) body.code = code;
    return res.status(403).json(body);
  }

  /**
   * Send payment required response (402) — used for expired subscriptions
   */
  static paymentRequired(res, {
    message = 'Subscription required',
    code = 'SUBSCRIPTION_EXPIRED'
  }) {
    return res.status(402).json({
      success: false,
      statusCode: 402,
      message,
      code,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send not found response (404)
   */
  static notFound(res, {
    message = 'Resource not found'
  }) {
    return this.error(res, { message, statusCode: 404 });
  }

  /**
   * Send conflict response (409)
   */
  static conflict(res, {
    message = 'Resource already exists'
  }) {
    return this.error(res, { message, statusCode: 409 });
  }

  /**
   * Send validation error response (422)
   */
  static validationError(res, {
    message = 'Validation failed',
    errors = null
  }) {
    return this.error(res, { message, statusCode: 422, errors });
  }

  /**
   * Send too many requests response (429)
   */
  static tooManyRequests(res, {
    message = 'Too many requests'
  }) {
    return this.error(res, { message, statusCode: 429 });
  }

  /**
   * Send server error response (500)
   */
  static serverError(res, {
    message = 'Internal server error'
  }) {
    return this.error(res, { message, statusCode: 500 });
  }
}

module.exports = ApiResponse;
