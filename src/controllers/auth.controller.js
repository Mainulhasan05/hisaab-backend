const AuthService = require('../services/auth.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const {
  setUserTokenCookie,
  setAdminTokenCookie,
  clearUserTokenCookie,
  clearAdminTokenCookie
} = require('../utils/cookie.util');

/**
 * @desc    Register new shop with owner
 * @route   POST /api/auth/register
 * @access  Public
 */
const register = asyncHandler(async (req, res) => {
  const result = await AuthService.register(req.body, req);

  // Set httpOnly cookie
  setUserTokenCookie(res, result.token);

  // Remove token from response data (it's in the cookie now)
  const { token, ...responseData } = result;

  return ApiResponse.created(res, {
    data: responseData,
    message: 'Registration successful. Please verify your phone number.',
    messageBn: 'নিবন্ধন সফল। অনুগ্রহ করে ফোন নম্বর যাচাই করুন।'
  });
});

/**
 * @desc    Send OTP for verification
 * @route   POST /api/auth/send-otp
 * @access  Public
 */
const sendOTP = asyncHandler(async (req, res) => {
  const result = await AuthService.sendOTP(req.body.phone);

  return ApiResponse.success(res, {
    data: result,
    message: 'OTP sent successfully',
    messageBn: 'ওটিপি পাঠানো হয়েছে'
  });
});

/**
 * @desc    Verify OTP
 * @route   POST /api/auth/verify-otp
 * @access  Public
 */
const verifyOTP = asyncHandler(async (req, res) => {
  const result = await AuthService.verifyOTP(req.body.phone, req.body.otp);

  return ApiResponse.success(res, {
    data: result,
    message: 'Phone verified successfully',
    messageBn: 'ফোন নম্বর যাচাই সফল'
  });
});

/**
 * @desc    Login user
 * @route   POST /api/auth/login
 * @access  Public
 */
const login = asyncHandler(async (req, res) => {
  const result = await AuthService.login(req.body, req);

  // Set httpOnly cookie for user (admin cookie stays intact for coexistence)
  setUserTokenCookie(res, result.token);

  // Remove token from response data (it's in the cookie now)
  const { token, ...responseData } = result;

  return ApiResponse.success(res, {
    data: responseData,
    message: 'Login successful',
    messageBn: 'লগইন সফল'
  });
});

/**
 * @desc    Logout user
 * @route   POST /api/auth/logout
 * @access  Private
 */
const logout = asyncHandler(async (req, res) => {
  // Clear the httpOnly cookie
  clearUserTokenCookie(res);

  return ApiResponse.success(res, {
    message: 'Logout successful',
    messageBn: 'লগআউট সফল'
  });
});

/**
 * @desc    Get current user profile
 * @route   GET /api/auth/me
 * @access  Private
 */
const getMe = asyncHandler(async (req, res) => {
  // Handle admin token
  if (req.isAdmin && req.admin) {
    return ApiResponse.success(res, {
      data: {
        admin: {
          _id: req.admin._id,
          name: req.admin.name,
          phone: req.admin.phone,
          role: req.admin.role,
          isSuperAdmin: req.admin.isSuperAdmin
        }
      },
      message: 'Admin profile retrieved',
      messageBn: 'অ্যাডমিন প্রোফাইল পাওয়া গেছে'
    });
  }

  // Handle regular user token
  const result = await AuthService.getMe(req.user._id);

  return ApiResponse.success(res, {
    data: { user: result.user, shop: req.shop, permissions: result.permissions },
    message: 'Profile retrieved',
    messageBn: 'প্রোফাইল পাওয়া গেছে'
  });
});

/**
 * @desc    Change password
 * @route   POST /api/auth/change-password
 * @access  Private
 */
const changePassword = asyncHandler(async (req, res) => {
  const result = await AuthService.changePassword(req.user._id, req.body, req);

  return ApiResponse.success(res, {
    data: result,
    message: 'Password changed successfully',
    messageBn: 'পাসওয়ার্ড পরিবর্তন সফল'
  });
});

/**
 * @desc    Admin login
 * @route   POST /api/auth/admin/login
 * @access  Public
 */
const adminLogin = asyncHandler(async (req, res) => {
  const result = await AuthService.adminLogin(req.body, req);

  // Set httpOnly cookie for admin (user cookie stays intact for coexistence)
  setAdminTokenCookie(res, result.token);

  // Remove token from response data (it's in the cookie now)
  const { token, ...responseData } = result;

  return ApiResponse.success(res, {
    data: responseData,
    message: 'Admin login successful',
    messageBn: 'অ্যাডমিন লগইন সফল'
  });
});

/**
 * @desc    Create team member
 * @route   POST /api/auth/team
 * @access  Private (Owner only)
 */
const createTeamMember = asyncHandler(async (req, res) => {
  const user = await AuthService.createTeamMember(
    req.shop._id,
    req.user._id,
    req.body,
    req
  );

  return ApiResponse.created(res, {
    data: { user },
    message: 'Team member created successfully',
    messageBn: 'টিম মেম্বার যোগ করা হয়েছে'
  });
});

/**
 * @desc    Get team members
 * @route   GET /api/auth/team
 * @access  Private (Owner/Manager)
 */
const getTeamMembers = asyncHandler(async (req, res) => {
  const User = require('../models/User.model');

  const members = await User.find({
    shop: req.shop._id,
    _id: { $ne: req.user._id }
  }).select('-password').sort({ createdAt: -1 });

  return ApiResponse.success(res, {
    data: { members },
    message: 'Team members retrieved',
    messageBn: 'টিম মেম্বার লিস্ট'
  });
});

/**
 * @desc    Update team member
 * @route   PUT /api/auth/team/:id
 * @access  Private (Owner only)
 */
const updateTeamMember = asyncHandler(async (req, res) => {
  const User = require('../models/User.model');

  const member = await User.findOne({
    _id: req.params.id,
    shop: req.shop._id,
    isOwner: false
  });

  if (!member) {
    return ApiResponse.notFound(res, {
      message: 'Team member not found',
      messageBn: 'টিম মেম্বার পাওয়া যায়নি'
    });
  }

  const { name, role, permissions, isActive } = req.body;

  if (name) member.name = name;
  if (role) member.role = role;
  if (permissions) member.permissions = permissions;
  if (typeof isActive === 'boolean') member.isActive = isActive;

  await member.save();

  return ApiResponse.success(res, {
    data: { member },
    message: 'Team member updated',
    messageBn: 'টিম মেম্বার আপডেট হয়েছে'
  });
});

/**
 * @desc    Delete team member
 * @route   DELETE /api/auth/team/:id
 * @access  Private (Owner only)
 */
const deleteTeamMember = asyncHandler(async (req, res) => {
  const User = require('../models/User.model');

  const member = await User.findOneAndDelete({
    _id: req.params.id,
    shop: req.shop._id,
    isOwner: false
  });

  if (!member) {
    return ApiResponse.notFound(res, {
      message: 'Team member not found',
      messageBn: 'টিম মেম্বার পাওয়া যায়নি'
    });
  }

  return ApiResponse.success(res, {
    message: 'Team member deleted',
    messageBn: 'টিম মেম্বার মুছে ফেলা হয়েছে'
  });
});

/**
 * @desc    Update shop settings
 * @route   PATCH /api/auth/shop/settings
 * @access  Private (Owner only)
 */
const updateShopSettings = asyncHandler(async (req, res) => {
  const Shop = require('../models/Shop.model');

  // Basic shop info fields that can be updated directly
  const allowedBasicFields = ['name', 'phone', 'address'];

  // Settings fields that go under settings object
  const allowedSettings = [
    'lowStockThreshold',
    'invoicePrefix',
    'taxEnabled',
    'taxRate',
    'enabledVariantTypes'
  ];

  const updates = {};

  // Handle basic fields
  for (const key of allowedBasicFields) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }

  // Handle settings fields
  for (const key of allowedSettings) {
    if (req.body[key] !== undefined) {
      updates[`settings.${key}`] = req.body[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    return ApiResponse.badRequest(res, {
      message: 'No valid settings provided',
      messageBn: 'কোন বৈধ সেটিংস প্রদান করা হয়নি'
    });
  }

  const shop = await Shop.findByIdAndUpdate(
    req.shop._id,
    { $set: updates },
    { new: true }
  );

  return ApiResponse.success(res, {
    data: { shop },
    message: 'Settings updated successfully',
    messageBn: 'সেটিংস আপডেট হয়েছে'
  });
});

/**
 * @desc    Admin logout
 * @route   POST /api/auth/admin/logout
 * @access  Private (Admin)
 */
const adminLogout = asyncHandler(async (req, res) => {
  // Clear the httpOnly admin cookie
  clearAdminTokenCookie(res);

  return ApiResponse.success(res, {
    message: 'Admin logout successful',
    messageBn: 'অ্যাডমিন লগআউট সফল'
  });
});

/**
 * @desc    Update user profile
 * @route   PATCH /api/auth/profile
 * @access  Private
 */
const updateProfile = asyncHandler(async (req, res) => {
  const result = await AuthService.updateProfile(req.user._id, req.body, req);

  return ApiResponse.success(res, {
    data: result,
    message: 'Profile updated successfully',
    messageBn: 'প্রোফাইল আপডেট সফল হয়েছে'
  });
});

module.exports = {
  register,
  sendOTP,
  verifyOTP,
  login,
  logout,
  getMe,
  changePassword,
  adminLogin,
  adminLogout,
  createTeamMember,
  getTeamMembers,
  updateTeamMember,
  deleteTeamMember,
  updateShopSettings,
  updateProfile
};
