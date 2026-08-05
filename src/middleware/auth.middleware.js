const jwt = require('jsonwebtoken');
const User = require('../models/User.model');
const Admin = require('../models/Admin.model');
const Shop = require('../models/Shop.model');
const Branch = require('../models/Branch.model');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { COOKIE_NAMES } = require('../utils/cookie.util');
const cacheService = require('../services/cache.service');
const userActivityService = require('../services/userActivity.service');
const logger = require('../utils/logger.util');

// Auth cache TTL: 5 minutes. Mutations that must take effect immediately
// (shop status/subscription/settings changes, staff deactivation) explicitly
// invalidate the affected keys via utils/authCache.util.js.
const AUTH_CACHE_TTL = 300;
// Branch documents change very rarely; branch.service invalidates these keys on change.
const BRANCH_CACHE_TTL = 600;

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
    }
  }
  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }
  return token;
}

/**
 * Fetch a branch after validating it belongs to the shop, with caching —
 * previously an uncached Mongo query on every request for multi-branch shops.
 * Only positive results are cached; invalidated by branch.service on change.
 */
async function getCachedBranchOwnership(branchId, shopId) {
  const cacheKey = `shop:${shopId}:branch:${branchId}:own`;
  const cached = await cacheService.get(cacheKey);
  if (cached) return Branch.hydrate(cached);

  const branch = await Branch.validateBranchOwnership(branchId, shopId);
  if (branch) {
    await cacheService.set(cacheKey, branch.toObject(), BRANCH_CACHE_TTL);
  }
  return branch;
}

/**
 * First active branch of a shop (used as the default write target for owners
 * in "All Branches" view), cached. branch.service invalidates this key.
 */
async function getCachedDefaultBranch(shopId) {
  const cacheKey = `shop:${shopId}:default_branch`;
  const cached = await cacheService.get(cacheKey);
  if (cached) return Branch.hydrate(cached);

  const branch = await Branch.findOne({ shop: shopId, isActive: true }).sort({ createdAt: 1 });
  if (branch) {
    await cacheService.set(cacheKey, branch.toObject(), BRANCH_CACHE_TTL);
  }
  return branch;
}

/**
 * Fetch user with shop, using a cache to avoid DB hits on every request.
 * Cache key is based on user ID; explicitly invalidated on relevant mutations,
 * with the TTL as a backstop.
 */
async function getCachedUser(userId) {
  const cacheKey = `auth:user:${userId}`;
  const cached = await cacheService.get(cacheKey);
  if (cached) {
    // Reconstruct Mongoose-like object with method support
    const user = await User.hydrate(cached.user);
    user.shop = cached.shop ? Shop.hydrate(cached.shop) : null;
    // Non-schema property: `role` is an ObjectId path, so the populated doc
    // is carried separately as a plain object (only permissions/isActive are read)
    user.roleDoc = cached.role || null;
    return user;
  }
  const user = await User.findById(userId).populate('shop').populate('role');
  if (user) {
    const roleDoc = user.role ? user.role.toObject() : null;
    user.depopulate('role'); // keep user.role an ObjectId, matching the cache-hit shape
    user.roleDoc = roleDoc;
    await cacheService.set(cacheKey, {
      user: user.toObject(),
      shop: user.shop ? user.shop.toObject() : null,
      role: roleDoc,
    }, AUTH_CACHE_TTL);
  }
  return user;
}

/**
 * Resolve RBAC context from the DB-backed user document (NOT the JWT).
 * Permissions used to be embedded in the access token, which made every role
 * edit invisible until re-login. The user+role doc is cached (TTL 300s) and
 * explicitly invalidated by staff/role mutations, so changes apply live.
 */
function resolveRbacContext(user) {
  const isOwner = user.isOwner === true;
  let permissions = null;
  if (!isOwner && user.roleDoc && user.roleDoc.isActive !== false && user.roleDoc.permissions) {
    permissions = user.roleDoc.permissions;
  }
  return { isOwner, permissions };
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

    // Check token revocation blacklist
    if (decoded.jti) {
      const isBlacklisted = await cacheService.get(`blacklist:token:${decoded.jti}`);
      if (isBlacklisted) {
        return ApiResponse.unauthorized(res, {
          message: 'Session has been revoked or expired. Please log in again',
          messageBn: 'সেশনটি বাতিল করা হয়েছে। পুনরায় লগইন করুন'
        });
      }
    }

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

      // If accessing a shop route (not /api/admin), resolve shop context or deny
      const isAdminRoute = req.originalUrl.startsWith('/api/admin') ||
        req.originalUrl.startsWith('/api/pages') ||
        req.originalUrl.startsWith('/api/contact');

      if (!isAdminRoute) {
        const shopId = req.headers['x-shop-id'] || req.cookies?.activeShopId || req.query?.shopId;
        if (shopId) {
          const shop = await Shop.findById(shopId);
          if (shop) {
            req.shop = shop;
            req.user = {
              _id: admin._id,
              name: admin.name,
              email: admin.email,
              role: 'admin',
              isOwner: true,
              shop: shop._id,
            };
            return next();
          }
        }
        return ApiResponse.unauthorized(res, {
          message: 'Shop session required. Please log in with a shop account.',
          messageBn: 'দোকান অ্যাকাউন্ট দিয়ে লগইন করুন।'
        });
      }

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
        // SET NX marker so this write fires once per 5 min, not on every
        // request from every terminal of the expired shop
        cacheService.setNX(`shop:${user.shop._id}:expmarked`, 1, 300)
          .then((acquired) => {
            if (acquired) {
              return Shop.findByIdAndUpdate(user.shop._id, {
                'subscription.status': 'expired',
              });
            }
          })
          .catch(() => {}); // fire-and-forget, don't block the response
      }

      // Read-only grace mode: GET requests are allowed so users can still view their data.
      // RBAC context must still be set here — without it rbac() denies every GET
      // for owners and staff alike, inverting the intended access.
      if (req.method === 'GET') {
        req.user = user;
        req.shop = user.shop;
        const rbacCtx = resolveRbacContext(user);
        req.user.isOwner = rbacCtx.isOwner;
        req.user.permissions = rbacCtx.permissions;
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

    // Inject RBAC data from the DB-backed user (cached + invalidated on change),
    // so role edits and reassignments take effect without re-login
    const rbacCtx = resolveRbacContext(user);
    req.user.isOwner = rbacCtx.isOwner;
    req.user.permissions = rbacCtx.permissions;

    // ── Branch Context Resolution ──
    // For single-branch shops: skip entirely (branch = null)
    // For multi-branch shops:
    //   Owner: read X-Active-Branch header (switchable)
    //   Staff: use assigned branch from the user document
    req.branch = null;
    req.branchId = null;

    if (user.shop && user.shop.multiBranchEnabled) {
      if (rbacCtx.isOwner) {
        const activeBranchId = req.headers['x-active-branch'] || req.cookies?.activeBranch;
        if (activeBranchId && activeBranchId !== 'all') {
          const branch = await getCachedBranchOwnership(activeBranchId, user.shop._id);
          if (branch) {
            req.branch = branch;
            req.branchId = branch._id;
          }
        }

        // If owner is in "All Branches" view (or activeBranchId is not set)
        // AND it is a write request, automatically default req.branchId to the first active branch.
        if (!req.branchId && req.method !== 'GET') {
          const defaultBranch = await getCachedDefaultBranch(user.shop._id);
          if (defaultBranch) {
            req.branch = defaultBranch;
            req.branchId = defaultBranch._id;
          }
        }
      } else if (user.branch) {
        const branch = await getCachedBranchOwnership(user.branch, user.shop._id);
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
    // Non-blocking activity tracking (0ms added request latency)
    userActivityService.recordActivity(user._id, decoded.jti).catch(err => {
      logger.error('Background user activity tracking error:', err.message);
    });

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
        const rbacCtx = resolveRbacContext(user);
        req.user.isOwner = rbacCtx.isOwner;
        req.user.permissions = rbacCtx.permissions;

        // ── Branch Context Resolution (same as protect) ──
        req.branch = null;
        req.branchId = null;

        if (user.shop.multiBranchEnabled) {
          if (rbacCtx.isOwner) {
            const activeBranchId = req.headers['x-active-branch'] || req.cookies?.activeBranch;
            if (activeBranchId && activeBranchId !== 'all') {
              const branch = await getCachedBranchOwnership(activeBranchId, user.shop._id);
              if (branch) {
                req.branch = branch;
                req.branchId = branch._id;
              }
              // If branch is invalid, we do NOT clear req.user for owners.
              // They just fall back to all branches view (branch = null).
            }
          } else if (user.branch) {
            const branch = await getCachedBranchOwnership(user.branch, user.shop._id);
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
