const jwt = require('jsonwebtoken');
const User = require('../models/User.model');
const Admin = require('../models/Admin.model');
const Shop = require('../models/Shop.model');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { COOKIE_NAMES } = require('../utils/cookie.util');

/**
 * Protect routes - Verify JWT token
 */
const protect = asyncHandler(async (req, res, next) => {
  let token = null;

  // Determine if this is an admin route (prefer admin cookie for these)
  const isAdminRoute = req.originalUrl.startsWith('/api/admin') ||
    req.originalUrl.startsWith('/api/pages') ||
    req.originalUrl.startsWith('/api/contact');

  if (isAdminRoute) {
    // For admin routes: prefer admin token, fall back to user token
    if (req.cookies && req.cookies[COOKIE_NAMES.ADMIN_TOKEN]) {
      token = req.cookies[COOKIE_NAMES.ADMIN_TOKEN];
    } else if (req.cookies && req.cookies[COOKIE_NAMES.USER_TOKEN]) {
      token = req.cookies[COOKIE_NAMES.USER_TOKEN];
    }
  } else {
    // For user routes: prefer user token, fall back to admin token
    if (req.cookies && req.cookies[COOKIE_NAMES.USER_TOKEN]) {
      token = req.cookies[COOKIE_NAMES.USER_TOKEN];
    } else if (req.cookies && req.cookies[COOKIE_NAMES.ADMIN_TOKEN]) {
      token = req.cookies[COOKIE_NAMES.ADMIN_TOKEN];
    }
  }
  // Fallback to Authorization header (for mobile apps, API clients)
  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return ApiResponse.unauthorized(res, {
      message: 'Please log in to access this resource',
      messageBn: 'এই রিসোর্স অ্যাক্সেস করতে লগইন করুন'
    });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if it's an admin token
    if (decoded.isAdmin) {
      const admin = await Admin.findById(decoded.id);

      if (!admin) {
        return ApiResponse.unauthorized(res, {
          message: 'Admin not found',
          messageBn: 'অ্যাডমিন পাওয়া যায়নি'
        });
      }

      if (!admin.isActive) {
        return ApiResponse.unauthorized(res, {
          message: 'Admin account is deactivated',
          messageBn: 'অ্যাডমিন অ্যাকাউন্ট নিষ্ক্রিয়'
        });
      }

      // Check if password changed after token was issued
      if (admin.changedPasswordAfter(decoded.iat)) {
        return ApiResponse.unauthorized(res, {
          message: 'Password changed. Please log in again',
          messageBn: 'পাসওয়ার্ড পরিবর্তন হয়েছে। পুনরায় লগইন করুন'
        });
      }

      req.admin = admin;
      req.isAdmin = true;
      return next();
    }

    // Regular user token
    const user = await User.findById(decoded.id).populate('shop');

    if (!user) {
      return ApiResponse.unauthorized(res, {
        message: 'User not found',
        messageBn: 'ইউজার পাওয়া যায়নি'
      });
    }

    if (!user.isActive) {
      return ApiResponse.unauthorized(res, {
        message: 'Your account is deactivated',
        messageBn: 'আপনার অ্যাকাউন্ট নিষ্ক্রিয়'
      });
    }

    // Check if password changed after token was issued
    if (user.changedPasswordAfter(decoded.iat)) {
      return ApiResponse.unauthorized(res, {
        message: 'Password changed. Please log in again',
        messageBn: 'পাসওয়ার্ড পরিবর্তন হয়েছে। পুনরায় লগইন করুন'
      });
    }

    // Check shop status
    if (user.shop && !user.shop.isActive) {
      return ApiResponse.forbidden(res, {
        message: 'Your shop is deactivated',
        messageBn: 'আপনার দোকান নিষ্ক্রিয়'
      });
    }

    // Check subscription
    if (user.shop && !user.shop.isSubscriptionValid) {
      // Auto-update DB status to 'expired' if it's still showing 'active' but the date has passed
      if (
        user.shop.subscription &&
        user.shop.subscription.status === 'active' &&
        user.shop.subscription.expiresAt &&
        user.shop.subscription.expiresAt < new Date()
      ) {
        Shop.findByIdAndUpdate(user.shop._id, {
          'subscription.status': 'expired',
        }).catch(() => {}); // fire-and-forget, don't block the response
      }

      // Read-only grace mode: GET requests are allowed so users can still view their data
      if (req.method === 'GET') {
        req.user = user;
        req.shop = user.shop;
        req.subscriptionExpired = true; // Route handlers can check this if needed
        return next();
      }

      // All write operations are blocked with 402 Payment Required
      return ApiResponse.paymentRequired(res, {
        message: 'Your subscription has expired. You can still view your data, but cannot make changes. Please contact support to renew.',
        messageBn: 'আপনার সাবস্ক্রিপশনের মেয়াদ শেষ হয়েছে। আপনি ডেটা দেখতে পারবেন, কিন্তু পরিবর্তন করতে পারবেন না। পুনরায় সক্রিয় করতে সাপোর্টে যোগাযোগ করুন।',
      });
    }

    req.user = user;
    req.shop = user.shop;

    // Inject RBAC data from JWT payload (no additional DB lookup needed)
    req.user.isOwner = decoded.isOwner === true;
    req.user.permissions = decoded.permissions || null;

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return ApiResponse.unauthorized(res, {
        message: 'Invalid token',
        messageBn: 'অবৈধ টোকেন'
      });
    }

    if (error.name === 'TokenExpiredError') {
      return ApiResponse.unauthorized(res, {
        message: 'Token expired. Please log in again',
        messageBn: 'টোকেন মেয়াদ শেষ। পুনরায় লগইন করুন'
      });
    }

    throw error;
  }
});

/**
 * Admin only middleware
 */
const adminOnly = asyncHandler(async (req, res, next) => {
  if (!req.isAdmin) {
    return ApiResponse.forbidden(res, {
      message: 'Admin access required',
      messageBn: 'অ্যাডমিন অ্যাক্সেস প্রয়োজন'
    });
  }
  next();
});

/**
 * Super admin only middleware
 */
const superAdminOnly = asyncHandler(async (req, res, next) => {
  if (!req.isAdmin || !req.admin.isSuperAdmin) {
    return ApiResponse.forbidden(res, {
      message: 'Super admin access required',
      messageBn: 'সুপার অ্যাডমিন অ্যাক্সেস প্রয়োজন'
    });
  }
  next();
});

/**
 * Shop owner only middleware
 */
const ownerOnly = asyncHandler(async (req, res, next) => {
  if (!req.user || !req.user.isOwner) {
    return ApiResponse.forbidden(res, {
      message: 'Shop owner access required',
      messageBn: 'দোকান মালিকের অ্যাক্সেস প্রয়োজন'
    });
  }
  next();
});

/**
 * Restrict to specific roles
 */
const restrictTo = (...roles) => {
  return asyncHandler(async (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return ApiResponse.forbidden(res, {
        message: 'You do not have permission to perform this action',
        messageBn: 'এই কাজ করার অনুমতি নেই'
      });
    }
    next();
  });
};

module.exports = {
  protect,
  adminOnly,
  superAdminOnly,
  ownerOnly,
  restrictTo
};
