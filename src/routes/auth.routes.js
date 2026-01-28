const express = require('express');
const router = express.Router();

const authController = require('../controllers/auth.controller');
const { protect, ownerOnly } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const authValidation = require('../validations/auth.validation');

// Public routes
router.post('/register', validate(authValidation.register), authController.register);
router.post('/send-otp', validate(authValidation.sendOTP), authController.sendOTP);
router.post('/verify-otp', validate(authValidation.verifyOTP), authController.verifyOTP);
router.post('/login', validate(authValidation.login), authController.login);
router.post('/admin/login', validate(authValidation.adminLogin), authController.adminLogin);
router.post('/admin/logout', authController.adminLogout);

// Protected routes
router.use(protect);

router.post('/logout', authController.logout);
router.get('/me', authController.getMe);
router.post('/change-password', validate(authValidation.changePassword), authController.changePassword);

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
