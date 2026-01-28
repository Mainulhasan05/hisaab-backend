/**
 * Cookie Utility
 * Handles secure cookie operations for authentication
 */

// Cookie names
const COOKIE_NAMES = {
  USER_TOKEN: 'hisaab_token',
  ADMIN_TOKEN: 'hisaab_admin_token'
};

// Cookie options
const getCookieOptions = (maxAge) => {
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    httpOnly: true,
    secure: isProduction, // Only HTTPS in production
    sameSite: isProduction ? 'strict' : 'lax',
    maxAge: maxAge, // in milliseconds
    path: '/'
  };
};

/**
 * Set user authentication token cookie
 * @param {Object} res - Express response object
 * @param {string} token - JWT token
 * @param {number} maxAgeDays - Cookie expiry in days (default: 30)
 */
const setUserTokenCookie = (res, token, maxAgeDays = 30) => {
  const maxAge = maxAgeDays * 24 * 60 * 60 * 1000; // Convert days to ms
  res.cookie(COOKIE_NAMES.USER_TOKEN, token, getCookieOptions(maxAge));
};

/**
 * Set admin authentication token cookie
 * @param {Object} res - Express response object
 * @param {string} token - JWT token
 * @param {number} maxAgeDays - Cookie expiry in days (default: 7)
 */
const setAdminTokenCookie = (res, token, maxAgeDays = 7) => {
  const maxAge = maxAgeDays * 24 * 60 * 60 * 1000; // Convert days to ms
  res.cookie(COOKIE_NAMES.ADMIN_TOKEN, token, getCookieOptions(maxAge));
};

/**
 * Clear user authentication token cookie
 * @param {Object} res - Express response object
 */
const clearUserTokenCookie = (res) => {
  res.cookie(COOKIE_NAMES.USER_TOKEN, '', {
    httpOnly: true,
    expires: new Date(0),
    path: '/'
  });
};

/**
 * Clear admin authentication token cookie
 * @param {Object} res - Express response object
 */
const clearAdminTokenCookie = (res) => {
  res.cookie(COOKIE_NAMES.ADMIN_TOKEN, '', {
    httpOnly: true,
    expires: new Date(0),
    path: '/'
  });
};

/**
 * Get token from request (cookie or header)
 * @param {Object} req - Express request object
 * @param {string} type - 'user' or 'admin'
 * @returns {string|null} Token or null
 */
const getTokenFromRequest = (req, type = 'user') => {
  const cookieName = type === 'admin' ? COOKIE_NAMES.ADMIN_TOKEN : COOKIE_NAMES.USER_TOKEN;

  // First check cookies
  if (req.cookies && req.cookies[cookieName]) {
    return req.cookies[cookieName];
  }

  // Fallback to Authorization header (for API clients, mobile apps, etc.)
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    return req.headers.authorization.split(' ')[1];
  }

  return null;
};

module.exports = {
  COOKIE_NAMES,
  setUserTokenCookie,
  setAdminTokenCookie,
  clearUserTokenCookie,
  clearAdminTokenCookie,
  getTokenFromRequest
};
