const AuthService = require('../services/auth.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const User = require('../models/User.model');
const cacheService = require('../services/cache.service');
const { invalidateShopAuthCache } = require('../utils/authCache.util');
const { featureMap } = require('../utils/features.util');
const { buildSubscriptionNotice } = require('../utils/subscriptionState.util');
const {
  setUserTokenCookie,
  setAdminTokenCookie,
  clearUserTokenCookie,
  clearAdminTokenCookie,
  COOKIE_NAMES
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
  const result = await AuthService.verifyOTP(req.body.phone, req.body.otp, {
    tracking: req.body.tracking,
    req
  });

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

  // Same phone with valid credentials in multiple shops: no session yet —
  // the client shows a shop picker and re-submits with shopSlug
  if (result.requiresShopSelection) {
    return ApiResponse.success(res, {
      data: result,
      message: 'Select a shop to continue',
      messageBn: 'কোন দোকানে ঢুকবেন তা নির্বাচন করুন'
    });
  }

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
 * @desc    Logout user and revoke tokens
 * @route   POST /api/auth/logout
 * @access  Private
 */
const logout = asyncHandler(async (req, res) => {
  const accessToken = req.cookies?.[COOKIE_NAMES.USER_TOKEN] || (req.headers.authorization?.startsWith('Bearer') ? req.headers.authorization.split(' ')[1] : null);
  const refreshTokenStr = req.cookies?.refreshToken || req.body?.refreshToken;

  await AuthService.logout(accessToken, refreshTokenStr);

  // Clear the httpOnly cookie
  clearUserTokenCookie(res);
  if (res.clearCookie) {
    res.clearCookie('refreshToken');
  }

  return ApiResponse.success(res, {
    message: 'Logout successful',
    messageBn: 'লগআউট সফল'
  });
});

/**
 * @desc    Refresh access token using refresh token
 * @route   POST /api/auth/refresh
 * @access  Public
 */
const refreshToken = asyncHandler(async (req, res) => {
  const tokenFromCookie = req.cookies?.refreshToken || req.cookies?.[COOKIE_NAMES.USER_TOKEN];
  const refreshTokenStr = req.body?.refreshToken || tokenFromCookie;

  const result = await AuthService.refreshToken(refreshTokenStr);

  setUserTokenCookie(res, result.accessToken);
  if (res.cookie) {
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
  }

  return ApiResponse.success(res, {
    data: result,
    message: 'Token refreshed successfully',
    messageBn: 'টোকেন সফলভাবে রিফ্রেশ করা হয়েছে'
  });
});

/**
 * @desc    Get current user profile
 * @route   GET /api/auth/me
 * @access  Private
 */
const getMe = asyncHandler(async (req, res) => {
  // Handle regular user token
  if (req.user) {
    const result = await AuthService.getMe(req.user._id);

    // Branch context, already resolved by `protect` for this request — no extra
    // query. Returning it here is what lets the client hydrate its branch state
    // on the very first paint: previously the switcher rendered "All Branches"
    // while axios was already sending a branch header from localStorage, so the
    // label and the data disagreed (FEATURE_AUDIT.md H-15).
    //
    // `branches` is the owner's switcher list; staff get only their own, so the
    // response never reveals branches they cannot use.
    const isMultiBranch = Boolean(req.shop?.multiBranchEnabled);
    const allBranches = req.user.branchList || [];
    const branches = !isMultiBranch
      ? []
      : (result.user.isOwner
        ? allBranches
        : allBranches.filter((b) => String(b._id) === String(req.branchId || '')));

    return ApiResponse.success(res, {
      data: {
        user: result.user,
        shop: req.shop,
        permissions: result.permissions,
        multiBranchEnabled: isMultiBranch,
        activeBranchId: req.branchId ? String(req.branchId) : null,
        activeBranch: req.branch
          ? { _id: String(req.branch._id), name: req.branch.name, code: req.branch.code }
          : null,
        branches,
        // Whether customers and dues are per-branch (Phase 7). The UI needs it
        // only to label the customer pages: an owner who switches branch and
        // sees the customer count change reads that as a bug unless the page
        // says which book it is showing. Always 'shop' for single-branch shops,
        // so nothing about their UI changes.
        customerScope: isMultiBranch ? (req.shop?.customerScope || 'branch') : 'shop',
        // Opt-in capabilities (Shop.features). Sent as a COMPLETE map — every
        // known key present as a real boolean, never only the enabled ones —
        // because the client renders "off" differently from "not loaded yet",
        // and a sparse object makes those two indistinguishable on first paint.
        //
        // The client does not receive the unit catalogue here; it builds that
        // locally from `lib/units.js` (mirrored from `config/units.js`, kept
        // honest by `scripts/check-unit-parity.mjs`). Sending ~50 units on the
        // hottest endpoint to save a file that has to exist anyway is a bad
        // trade.
        features: featureMap(req.shop),
        // The subscription banner, decided server-side by the same resolver
        // that decides whether this request may write. null = nothing to say.
        // Every user gets it, staff included: a cashier who sees "৩ দিন পর
        // মেয়াদ শেষ" tells the owner, and when writes do stop they already
        // know why instead of thinking the app broke.
        subscriptionNotice: buildSubscriptionNotice(req.shop),
      },
      message: 'Profile retrieved',
      messageBn: 'প্রোফাইল পাওয়া গেছে'
    });
  }

  // Handle guest (not authenticated)
  return ApiResponse.success(res, {
    data: { user: null, shop: null, permissions: null },
    message: 'Not authenticated',
    messageBn: 'লগইন করা নেই'
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

// Legacy /api/auth/team handlers removed — superseded by /api/staff + /api/roles.

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
    'showUnitOnInvoice',
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

  // ── The per-line discount cap ──────────────────────────────────────────────
  //
  // NOT in `allowedSettings` above, because it needs three things that list
  // cannot express.
  //
  // 1. IT IS OWNER-ONLY. `rbac('settings', 'update')` can be granted to a
  //    manager, and a manager who can raise the discount ceiling can raise
  //    their own — which is the same escalation `resolveWholesaleFlag` exists
  //    to prevent for `isWholesale`.
  //
  // 2. IT IS CAPABILITY-GATED. Storing a cap for a shop that cannot give line
  //    discounts is a setting that does nothing, which is a support ticket
  //    waiting to happen.
  //
  // 3. `null` IS A REAL VALUE. Every other key here is "absent means leave it
  //    alone"; this one additionally needs "explicitly cleared means no cap".
  //    An empty box on the form must therefore reach the database as `null`,
  //    not be skipped — while an ABSENT key still means untouched, which is
  //    what keeps the form reversible when the capability is switched off
  //    (AGENT_WORKFLOW.md I-7).
  if ('maxLineDiscountPercent' in req.body) {
    const { hasFeature } = require('../utils/features.util');
    const raw = req.body.maxLineDiscountPercent;

    if (!hasFeature(req, 'lineDiscount')) {
      return ApiResponse.forbidden(res, {
        message: 'Per-item discount is not enabled for this shop',
        messageBn: 'এই দোকানে পণ্যভিত্তিক ছাড় সুবিধা চালু নেই',
      });
    }
    if (!req.user?.isOwner && !req.isAdmin) {
      return ApiResponse.forbidden(res, {
        message: 'Only the shop owner can set the discount limit',
        messageBn: 'শুধুমাত্র দোকান মালিক ছাড়ের সীমা ঠিক করতে পারবেন',
      });
    }

    if (raw === null || raw === '') {
      updates['settings.maxLineDiscountPercent'] = null;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return ApiResponse.badRequest(res, {
          message: 'Discount limit must be between 0 and 100',
          messageBn: 'ছাড়ের সীমা ০ থেকে ১০০ এর মধ্যে দিন',
        });
      }
      updates['settings.maxLineDiscountPercent'] = n;
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

  await invalidateShopAuthCache(req.shop._id);

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

/**
 * @desc    Verify current user's password for delete actions
 * @route   POST /api/auth/verify-password
 * @access  Private
 */
const verifyPassword = asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return ApiResponse.badRequest(res, {
      message: 'Password is required',
      messageBn: 'পাসওয়ার্ড দেওয়া আবশ্যক'
    });
  }

  const user = await User.findById(req.user._id).select('+password');
  if (!user) {
    return ApiResponse.unauthorized(res, {
      message: 'User not found',
      messageBn: 'ব্যবহারকারী পাওয়া যায়নি'
    });
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    return ApiResponse.badRequest(res, {
      message: 'Incorrect password',
      messageBn: 'পাসওয়ার্ড সঠিক নয়'
    });
  }

  return ApiResponse.success(res, {
    message: 'Password verified successfully',
    messageBn: 'পাসওয়ার্ড সফলভাবে যাচাই করা হয়েছে'
  });
});

module.exports = {
  register,
  sendOTP,
  verifyOTP,
  login,
  logout,
  refreshToken,
  getMe,
  changePassword,
  adminLogin,
  adminLogout,
  updateShopSettings,
  updateProfile,
  verifyPassword
};
