const express = require('express');
const router = express.Router();

const authController = require('../controllers/auth.controller');
const { protect, softProtect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const { validate } = require('../middleware/validate.middleware');
const authValidation = require('../validations/auth.validation');
const { COOKIE_NAMES } = require('../utils/cookie.util');
const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin.model');
const ApiResponse = require('../utils/response.util');

const { authLimiter, passwordResetLimiter } = require('../middleware/rateLimiter.middleware');

// Public routes
router.post('/register', authLimiter, validate(authValidation.register), authController.register);
router.post('/send-otp', authLimiter, validate(authValidation.sendOTP), authController.sendOTP);
router.post('/verify-otp', authLimiter, validate(authValidation.verifyOTP), authController.verifyOTP);
router.post('/login', authLimiter, validate(authValidation.login), authController.login);
router.post('/refresh', authController.refreshToken);

// ── Forgot password ────────────────────────────────────────────────────────
//
// Public by necessity: the entire point is that the caller cannot log in. All
// three steps sit behind `passwordResetLimiter` rather than `authLimiter` — a
// single honest reset costs three requests and `authLimiter` allows five a
// minute across login as well, so sharing it would 429 the recovery flow on the
// screen users reach precisely because they are already stuck. The controls
// that matter are keyed on the phone and live in the service.
router.post(
  '/forgot-password',
  passwordResetLimiter,
  validate(authValidation.forgotPassword),
  authController.forgotPassword
);
router.post(
  '/forgot-password/verify',
  passwordResetLimiter,
  validate(authValidation.verifyPasswordResetCode),
  authController.verifyPasswordResetCode
);
router.post(
  '/reset-password',
  passwordResetLimiter,
  validate(authValidation.resetPassword),
  authController.resetPassword
);
router.post('/admin/login', authLimiter, validate(authValidation.adminLogin), authController.adminLogin);
router.post('/admin/logout', authController.adminLogout);

// Dedicated admin auth check — explicitly reads admin cookie only
router.get('/admin/me', async (req, res) => {
  try {
    const token = req.cookies && req.cookies[COOKIE_NAMES.ADMIN_TOKEN];
    if (!token) {
      return ApiResponse.unauthorized(res, {
        message: 'No admin session',
        messageBn: 'অ্যাডমিন সেশন নেই'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.isAdmin) {
      return ApiResponse.unauthorized(res, {
        message: 'Not an admin token',
        messageBn: 'অ্যাডমিন টোকেন নয়'
      });
    }

    const admin = await Admin.findById(decoded.id);
    if (!admin || !admin.isActive) {
      return ApiResponse.unauthorized(res, {
        message: 'Admin not found or inactive',
        messageBn: 'অ্যাডমিন পাওয়া যায়নি'
      });
    }

    return ApiResponse.success(res, {
      data: {
        admin: {
          _id: admin._id,
          name: admin.name,
          phone: admin.phone,
          role: admin.role,
          isSuperAdmin: admin.isSuperAdmin
        }
      },
      message: 'Admin profile retrieved',
      messageBn: 'অ্যাডমিন প্রোফাইল পাওয়া গেছে'
    });
  } catch (error) {
    return ApiResponse.unauthorized(res, {
      message: 'Invalid or expired admin token',
      messageBn: 'অবৈধ বা মেয়াদোত্তীর্ণ অ্যাডমিন টোকেন'
    });
  }
});

router.get('/me', softProtect, authController.getMe);

// Protected routes
router.use(protect);

router.post('/logout', authController.logout);
router.post('/change-password', validate(authValidation.changePassword), authController.changePassword);
router.post('/verify-password', authController.verifyPassword);
router.patch('/profile', validate(authValidation.updateProfile), authController.updateProfile);

// Legacy /team routes removed — staff management lives at /api/staff + /api/roles.
// The old handlers wrote string roles into an ObjectId field and raw permission
// arrays into a field that no longer exists, and hard-deleted users without
// invalidating their auth cache.

// Shop settings — owner, or staff granted settings.update
router.patch('/shop/settings', rbac('settings', 'update'), authController.updateShopSettings);

module.exports = router;
