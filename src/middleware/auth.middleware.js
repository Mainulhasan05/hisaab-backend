const jwt = require('jsonwebtoken');
const User = require('../models/User.model');
const Admin = require('../models/Admin.model');
const Shop = require('../models/Shop.model');
const Branch = require('../models/Branch.model');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { COOKIE_NAMES } = require('../utils/cookie.util');
const cacheService = require('../services/cache.service');

// Auth cache TTL: 30 seconds — short enough to reflect password changes quickly
const AUTH_CACHE_TTL = 30;

/**
 * Extract token from cookies/headers based on route type
 */
function extractToken(req) {
  let token = null;
  const isAdminRoute = req.originalUrl.startsWith('/api/admin') ||
    req.originalUrl.startsWith('/api/pages') ||
    req.originalUrl.startsWith('/api/contact');

  if (isAdminRoute) {
    if (req.cookies && req.cookies[COOKIE_NAMES.ADMIN_TOKEN]) {
      token = req.cookies[COOKIE_NAMES.ADMIN_TOKEN];
    } else if (req.cookies && req.cookies[COOKIE_NAMES.USER_TOKEN]) {
      token = req.cookies[COOKIE_NAMES.USER_TOKEN];
    }
  } else {
    if (req.cookies && req.cookies[COOKIE_NAMES.USER_TOKEN]) {
      token = req.cookies[COOKIE_NAMES.USER_TOKEN];
    } else if (req.cookies && req.cookies[COOKIE_NAMES.ADMIN_TOKEN]) {
      token = req.cookies[COOKIE_NAMES.ADMIN_TOKEN];
    }
  }
  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }
  return token;
}

/**
 * Fetch user with shop, using a short-lived cache to avoid DB hit on every request.
 * Cache key is based on user ID; invalidated naturally by 30s TTL.
 */
async function getCachedUser(userId) {
  const cacheKey = `auth:user:${userId}`;
  const cached = await cacheService.get(cacheKey);
  if (cached) {
    // Reconstruct Mongoose-like object with method support
    const user = await User.hydrate(cached.user);
    user.shop = cached.shop ? Shop.hydrate(cached.shop) : null;
    return user;
  }
  const user = await User.findById(userId).populate('shop');
  if (user) {
    await cacheService.set(cacheKey, {
      user: user.toObject(),
      shop: user.shop ? user.shop.toObject() : null,
    }, AUTH_CACHE_TTL);
  }
  return user;
}

/**
 * Fetch admin, using a short-lived cache.
 */
async function getCachedAdmin(adminId) {
  const cacheKey = `auth:admin:${adminId}`;
  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return Admin.hydrate(cached);
  }
  const admin = await Admin.findById(adminId);
  if (admin) {
    await cacheService.set(cacheKey, admin.toObject(), AUTH_CACHE_TTL);
  }
  return admin;
}

/**
 * Protect routes - Verify JWT token
 */
const protect = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);

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
      const admin = await getCachedAdmin(decoded.id);

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
    const user = await getCachedUser(decoded.id);

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

    // ── Branch Context Resolution ──
    // For single-branch shops: skip entirely (branch = null)
    // For multi-branch shops:
    //   Owner: read X-Active-Branch header (switchable)
    //   Staff: use branch from JWT (fixed)
    req.branch = null;
    req.branchId = null;

    if (user.shop && user.shop.multiBranchEnabled) {
      if (decoded.isOwner) {
        const activeBranchId = req.headers['x-active-branch'] || req.cookies?.activeBranch;
        if (activeBranchId && activeBranchId !== 'all') {
          const branch = await Branch.validateBranchOwnership(activeBranchId, user.shop._id);
          if (!branch) {
            // For write requests, block access. For GET, fall back to null/all branches view.
            if (req.method !== 'GET') {
              return ApiResponse.forbidden(res, {
                message: 'Invalid branch for this shop',
                messageBn: '?? ??????? ???? ???? ????',
              });
            }
          } else {
            req.branch = branch;
            req.branchId = branch._id;
          }
        }

      } else if (decoded.branch) {
        const branch = await Branch.validateBranchOwnership(decoded.branch, user.shop._id);
        if (!branch) {
          return ApiResponse.forbidden(res, {
            message: 'Your assigned branch is inactive or invalid',
            messageBn: '????? ????????? ???? ?????????? ?? ????',
          });
        }
        req.branch = branch;
        req.branchId = branch._id;
      } else {
        return ApiResponse.forbidden(res, {
          message: 'No branch is assigned to this staff account',
          messageBn: '?? ????? ??????????? ???? ???? ????????? ???',
        });
      }
    }

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

/**
 * Soft protect middleware - Optional token validation
 * Decodes user or admin credentials if present, but does NOT block unauthenticated requests.
 */
const softProtect = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);

  if (!token) {
    req.user = null;
    req.shop = null;
    req.isAdmin = false;
    req.branch = null;
    req.branchId = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.isAdmin) {
      const admin = await getCachedAdmin(decoded.id);
      if (admin && admin.isActive && !admin.changedPasswordAfter(decoded.iat)) {
        req.admin = admin;
        req.isAdmin = true;
      }
      return next();
    }

    const user = await getCachedUser(decoded.id);
    if (user && user.isActive && !user.changedPasswordAfter(decoded.iat)) {
      if (user.shop && user.shop.isActive) {
        req.user = user;
        req.shop = user.shop;
        req.user.isOwner = decoded.isOwner === true;
        req.user.permissions = decoded.permissions || null;

        // ── Branch Context Resolution (same as protect) ──
        req.branch = null;
        req.branchId = null;

        if (user.shop.multiBranchEnabled) {
          if (decoded.isOwner) {
            const activeBranchId = req.headers['x-active-branch'] || req.cookies?.activeBranch;
            if (activeBranchId && activeBranchId !== 'all') {
              const branch = await Branch.validateBranchOwnership(activeBranchId, user.shop._id);
              if (branch) {
                req.branch = branch;
                req.branchId = branch._id;
              }
              // If branch is invalid, we do NOT clear req.user for owners.
              // They just fall back to all branches view (branch = null).
            }
          } else if (decoded.branch) {
            const branch = await Branch.validateBranchOwnership(decoded.branch, user.shop._id);
            if (branch) {
              req.branch = branch;
              req.branchId = branch._id;
            } else {
              req.user = null;
              req.shop = null;
              req.isAdmin = false;
            }
          } else {
            req.user = null;
            req.shop = null;
            req.isAdmin = false;
          }
        }
      }
    }
    next();
  } catch (error) {
    // Silently ignore jwt errors in softProtect
    req.user = null;
    req.shop = null;
    req.isAdmin = false;
    req.branch = null;
    req.branchId = null;
    next();
  }
});

module.exports = {
  protect,
  softProtect,
  adminOnly,
  superAdminOnly,
  ownerOnly,
  restrictTo
};
