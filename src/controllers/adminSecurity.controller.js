const adminSecurityService = require('../services/adminSecurity.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { clearAdminTokenCookie } = require('../utils/cookie.util');

/**
 * Admin password change and lockout recovery, gated behind an SMS code to the
 * founder's number. See `adminSecurity.service.js` for the policy.
 *
 * Two flows share one service:
 *
 *   · CHANGE — authenticated. Mounted under the admin router, so `req.admin`
 *     is present and the target account is never taken from the body. A body
 *     that names its own admin id is how one admin resets another's password.
 *   · RESET  — public, for an admin who cannot sign in. The target IS taken
 *     from the body because there is no session to read it from; that is safe
 *     only because the code goes to the founder regardless of what is typed.
 */

/**
 * Minimum admin password length.
 *
 * Higher than the shop-user floor of 6 on purpose: this credential opens every
 * shop's books and can suspend any of them. Matches the `minlength` on
 * `Admin.model`, checked here as well so the caller gets a Bengali message
 * instead of a Mongoose validation error.
 */
const MIN_PASSWORD_LENGTH = 8;

const rejectWeakPassword = (res, password) => {
  if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
    ApiResponse.badRequest(res, {
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      messageBn: 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে',
    });
    return true;
  }
  return false;
};

// ── Authenticated change ────────────────────────────────────────────────────

/** Where codes will land. Shown on the console so nobody waits on the wrong phone. */
exports.getDestination = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, {
    data: adminSecurityService.getCodeDestination(),
    message: 'Code destination retrieved',
    messageBn: 'কোড কোথায় যাবে তা লোড হয়েছে',
  });
});

exports.requestPasswordChange = asyncHandler(async (req, res) => {
  const result = await adminSecurityService.requestPasswordChange({
    adminId: req.admin._id,
    currentPassword: req.body.currentPassword,
    req,
  });

  return ApiResponse.success(res, {
    data: result,
    message: 'Security code sent',
    messageBn: `ফাউন্ডারের নম্বরে (${result.sentTo}) কোড পাঠানো হয়েছে`,
  });
});

exports.verifyPasswordChange = asyncHandler(async (req, res) => {
  const result = await adminSecurityService.verifyCode({
    adminId: req.admin._id,
    purpose: 'password_change',
    otp: req.body.otp,
    req,
  });

  return ApiResponse.success(res, {
    data: result,
    message: 'Code verified',
    messageBn: 'কোড যাচাই হয়েছে। এখন নতুন পাসওয়ার্ড দিন।',
  });
});

exports.completePasswordChange = asyncHandler(async (req, res) => {
  if (rejectWeakPassword(res, req.body.newPassword)) return;

  const result = await adminSecurityService.changePassword({
    adminId: req.admin._id,
    purpose: 'password_change',
    challengeToken: req.body.challengeToken,
    newPassword: req.body.newPassword,
    req,
  });

  // The session that made this request is now invalid too — `passwordChangedAt`
  // is stamped past the token's `iat`, so the very next call would 401 anyway.
  // Clearing the cookie makes that a clean sign-out rather than a console that
  // appears logged in and fails on every click.
  clearAdminTokenCookie(res);

  return ApiResponse.success(res, {
    data: { ...result, signedOut: true },
    message: 'Password changed. Please sign in again.',
    messageBn: 'পাসওয়ার্ড পরিবর্তন হয়েছে। নতুন পাসওয়ার্ড দিয়ে আবার লগইন করুন।',
  });
});

// ── Public lockout recovery ─────────────────────────────────────────────────

exports.requestPasswordReset = asyncHandler(async (req, res) => {
  const result = await adminSecurityService.requestPasswordReset({
    phone: req.body.phone,
    req,
  });

  return ApiResponse.success(res, {
    data: result,
    message: 'Security code sent',
    messageBn: `ফাউন্ডারের নম্বরে (${result.sentTo}) কোড পাঠানো হয়েছে`,
  });
});

exports.verifyPasswordReset = asyncHandler(async (req, res) => {
  const result = await adminSecurityService.verifyCode({
    phone: req.body.phone,
    purpose: 'password_reset',
    otp: req.body.otp,
    req,
  });

  return ApiResponse.success(res, {
    data: result,
    message: 'Code verified',
    messageBn: 'কোড যাচাই হয়েছে। এখন নতুন পাসওয়ার্ড দিন।',
  });
});

exports.completePasswordReset = asyncHandler(async (req, res) => {
  if (rejectWeakPassword(res, req.body.newPassword)) return;

  const result = await adminSecurityService.changePassword({
    phone: req.body.phone,
    purpose: 'password_reset',
    challengeToken: req.body.challengeToken,
    newPassword: req.body.newPassword,
    req,
  });

  return ApiResponse.success(res, {
    data: result,
    message: 'Password reset. Please sign in.',
    messageBn: 'পাসওয়ার্ড রিসেট হয়েছে। নতুন পাসওয়ার্ড দিয়ে লগইন করুন।',
  });
});
