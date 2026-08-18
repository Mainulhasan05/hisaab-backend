/**
 * Cookie Utility
 * Handles secure cookie operations for authentication
 *
 * Cookie lifetimes come from `config/constants` (ADMIN_SESSION_DAYS /
 * USER_SESSION_DAYS), the SAME numbers the JWTs are signed with. A cookie that
 * outlives its token means a browser that keeps sending a credential the server
 * already rejects; a cookie that dies first means a token still valid that the
 * browser has stopped sending. Both present as "it logged me out" and neither
 * is visible from the code that changed. One source, two derived clocks.
 */

const { ADMIN_SESSION_DAYS, USER_SESSION_DAYS } = require('../config/constants');

// Cookie names
const COOKIE_NAMES = {
  USER_TOKEN: 'hisaab_token',
  ADMIN_TOKEN: 'hisaab_admin_token',
  REFRESH_TOKEN: 'refreshToken'
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
 * @param {number} maxAgeDays - Cookie expiry in days (default: USER_SESSION_DAYS)
 */
const setUserTokenCookie = (res, token, maxAgeDays = USER_SESSION_DAYS) => {
  const maxAge = maxAgeDays * 24 * 60 * 60 * 1000; // Convert days to ms
  res.cookie(COOKIE_NAMES.USER_TOKEN, token, getCookieOptions(maxAge));
};

/**
 * Set admin authentication token cookie
 * @param {Object} res - Express response object
 * @param {string} token - JWT token
 * @param {number} maxAgeDays - Cookie expiry in days (default: ADMIN_SESSION_DAYS)
 */
const setAdminTokenCookie = (res, token, maxAgeDays = ADMIN_SESSION_DAYS) => {
  const maxAge = maxAgeDays * 24 * 60 * 60 * 1000; // Convert days to ms
  res.cookie(COOKIE_NAMES.ADMIN_TOKEN, token, getCookieOptions(maxAge));
};

/**
 * Set the refresh token cookie.
 *
 * Uses the SAME `getCookieOptions` as every other cookie here. The refresh
 * cookie used to be set inline in `auth.controller.refreshToken` with
 * hand-written options, and its `sameSite: 'lax'` meant it was never sent in
 * production — where the frontend and the API are on different origins and
 * every other cookie is `sameSite: 'none'`.
 *
 * @param {Object} res
 * @param {string} token
 * @param {number} maxAgeDays
 */
const setRefreshTokenCookie = (res, token, maxAgeDays = USER_SESSION_DAYS) => {
  const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
  res.cookie(COOKIE_NAMES.REFRESH_TOKEN, token, getCookieOptions(maxAge));
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
  setRefreshTokenCookie,
  clearUserTokenCookie,
  clearAdminTokenCookie,
  getTokenFromRequest
};
