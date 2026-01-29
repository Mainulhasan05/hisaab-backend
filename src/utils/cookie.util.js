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

  // For cross-origin requests (frontend on different domain than backend):
  // - sameSite: 'none' allows cookies to be sent cross-origin
  // - secure: true is REQUIRED when sameSite is 'none'
  // Both frontend and backend must use HTTPS in production
  return {
    httpOnly: true,
    secure: isProduction, // HTTPS required in production
    sameSite: isProduction ? 'none' : 'lax', // 'none' for cross-origin in production
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
  const isProduction = process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAMES.USER_TOKEN, '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    expires: new Date(0),
    path: '/'
  });
};

/**
 * Clear admin authentication token cookie
 * @param {Object} res - Express response object
 */
const clearAdminTokenCookie = (res) => {
  const isProduction = process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAMES.ADMIN_TOKEN, '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
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
