const express = require('express');
const router = express.Router();

const authController = require('../controllers/auth.controller');
const { protect, softProtect, ownerOnly } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const authValidation = require('../validations/auth.validation');
const { COOKIE_NAMES } = require('../utils/cookie.util');
const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin.model');
const ApiResponse = require('../utils/response.util');

// Public routes
router.post('/register', validate(authValidation.register), authController.register);
router.post('/send-otp', validate(authValidation.sendOTP), authController.sendOTP);
router.post('/verify-otp', validate(authValidation.verifyOTP), authController.verifyOTP);
router.post('/login', validate(authValidation.login), authController.login);
router.post('/admin/login', validate(authValidation.adminLogin), authController.adminLogin);
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
router.patch('/profile', validate(authValidation.updateProfile), authController.updateProfile);

// Team management (Owner only)
router.route('/team')
  .get(authController.getTeamMembers)
  .post(ownerOnly, validate(authValidation.createTeamMember), authController.createTeamMember);

router.route('/team/:id')
  .put(ownerOnly, validate(authValidation.updateTeamMember), authController.updateTeamMember)
  .delete(ownerOnly, authController.deleteTeamMember);

// Shop settings (Owner only)
router.patch('/shop/settings', ownerOnly, authController.updateShopSettings);

module.exports = router;
