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
    messageBn = 'সফল',
    statusCode = 200
  }) {
    return res.status(statusCode).json({
      success: true,
      statusCode,
      message,
      messageBn,
      data,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send error response
   */
  static error(res, {
    message = 'Something went wrong',
    messageBn = 'কিছু সমস্যা হয়েছে',
    statusCode = 500,
    errors = null
  }) {
    return res.status(statusCode).json({
      success: false,
      statusCode,
      message,
      messageBn,
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
    messageBn = 'সফল'
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
      messageBn,
      data,
      pagination: {
        page: currentPage,
        limit: currentLimit,
        total: pTotal,
        pages,
        hasNext: currentPage < pages,
        hasPrev: currentPage > 1
      },
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send created response (201)
   */
  static created(res, {
    data = null,
    message = 'Created successfully',
    messageBn = 'সফলভাবে তৈরি হয়েছে'
  }) {
    return this.success(res, { data, message, messageBn, statusCode: 201 });
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
    messageBn = 'অবৈধ অনুরোধ',
    errors = null
  }) {
    return this.error(res, { message, messageBn, statusCode: 400, errors });
  }

  /**
   * Send unauthorized response (401)
   */
  static unauthorized(res, {
    message = 'Unauthorized',
    messageBn = 'অননুমোদিত প্রবেশ'
  }) {
    return this.error(res, { message, messageBn, statusCode: 401 });
  }

  /**
   * Send forbidden response (403)
   */
  static forbidden(res, {
    message = 'Access forbidden',
    messageBn = 'প্রবেশ নিষিদ্ধ',
    code = null
  }) {
    const body = { success: false, statusCode: 403, message, messageBn, timestamp: new Date().toISOString() };
    if (code) body.code = code;
    return res.status(403).json(body);
  }

  /**
   * Send payment required response (402) — used for expired subscriptions
   */
  static paymentRequired(res, {
    message = 'Subscription required',
    messageBn = 'সাবস্ক্রিপশন নবায়ন প্রয়োজন',
    code = 'SUBSCRIPTION_EXPIRED'
  }) {
    return res.status(402).json({
      success: false,
      statusCode: 402,
      message,
      messageBn,
      code,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send not found response (404)
   */
  static notFound(res, {
    message = 'Resource not found',
    messageBn = 'তথ্য পাওয়া যায়নি'
  }) {
    return this.error(res, { message, messageBn, statusCode: 404 });
  }

  /**
   * Send conflict response (409)
   */
  static conflict(res, {
    message = 'Resource already exists',
    messageBn = 'এই তথ্য আগে থেকেই আছে'
  }) {
    return this.error(res, { message, messageBn, statusCode: 409 });
  }

  /**
   * Send validation error response (422)
   */
  static validationError(res, {
    message = 'Validation failed',
    messageBn = 'তথ্য যাচাই ব্যর্থ',
    errors = null
  }) {
    return this.error(res, { message, messageBn, statusCode: 422, errors });
  }

  /**
   * Send too many requests response (429)
   */
  static tooManyRequests(res, {
    message = 'Too many requests',
    messageBn = 'অনেক বেশি অনুরোধ, কিছুক্ষণ পর চেষ্টা করুন'
  }) {
    return this.error(res, { message, messageBn, statusCode: 429 });
  }

  /**
   * Send server error response (500)
   */
  static serverError(res, {
    message = 'Internal server error',
    messageBn = 'সার্ভারে সমস্যা হয়েছে'
  }) {
    return this.error(res, { message, messageBn, statusCode: 500 });
  }
}

module.exports = ApiResponse;
