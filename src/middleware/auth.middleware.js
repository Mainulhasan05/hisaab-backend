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
// (shop status/subscription/settings changes, staff deactivation, branch
// create/edit/deactivate) explicitly invalidate the affected keys via
// utils/authCache.util.js.
const AUTH_CACHE_TTL = 300;

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
 * Fetch user with shop, using a cache to avoid DB hits on every request.
 * Cache key is based on user ID; explicitly invalidated on relevant mutations,
 * with the TTL as a backstop.
 *
 * The shop's branch list rides in the same payload. Branch validation used to
 * cost up to two extra Redis GETs (plus a Mongo query on a miss) on every
 * request of every multi-branch shop; carrying the list here makes it an
 * in-memory lookup and removes those round trips entirely.
 * Only branches are cached, not per-branch data — the list is tiny and changes
 * very rarely, and authCache.util invalidates the shop's users on any change.
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
    user.branchList = cached.branches || [];
    return user;
  }
  const user = await User.findById(userId).populate('shop').populate('role');
  if (user) {
    const roleDoc = user.role ? user.role.toObject() : null;
    user.depopulate('role'); // keep user.role an ObjectId, matching the cache-hit shape
    user.roleDoc = roleDoc;

    // Only multi-branch shops have branches; single-branch shops skip the query.
    const branches = user.shop?.multiBranchEnabled
      ? await Branch.find({ shop: user.shop._id, isActive: true })
        .select('name code isActive isDefault')
        .sort({ createdAt: 1 })
        .lean()
      : [];
    user.branchList = branches;

    await cacheService.set(cacheKey, {
      user: user.toObject(),
      shop: user.shop ? user.shop.toObject() : null,
      role: roleDoc,
      branches,
    }, AUTH_CACHE_TTL);
  }
  return user;
}

/**
 * Resolve the request's branch from the cached branch list — no I/O.
 * Returns null when the id is absent, malformed, or not a branch of this shop,
 * which is what makes a guessed/stale X-Active-Branch header harmless.
 */
function findBranch(user, branchId) {
  if (!branchId || branchId === 'all') return null;
  const wanted = String(branchId);
  return (user.branchList || []).find((b) => String(b._id) === wanted) || null;
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

            // Branch context for admins too. This block used to `return next()`
            // before branch resolution ran, so req.branchId was always null and
            // every admin write into a multi-branch shop failed the
            // branch-required check (FEATURE_AUDIT.md M-7).
            req.branch = null;
            req.branchId = null;

            if (shop.multiBranchEnabled) {
              const requested = req.headers['x-active-branch'] || req.cookies?.activeBranch;
              if (requested !== 'all') {
                const branches = await Branch.find({ shop: shop._id, isActive: true })
                  .select('name code isActive isDefault')
                  .sort({ createdAt: 1 })
                  .lean();
                req.branch =
                  branches.find((b) => String(b._id) === String(requested)) ||
                  branches[0] ||
                  null;
                if (req.branch) req.branchId = req.branch._id;
              }
            }

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
    // Single-branch shops skip this entirely (branch stays null), which is what
    // keeps every downstream `if (branchId)` a no-op for them.
    //
    // Owner: X-Active-Branch header → activeBranch cookie → last-used branch →
    //        first active branch. The literal 'all' opts into the read-only
    //        cross-branch view. Resolution is deterministic at every step.
    // Staff: always their assigned branch. Headers are ignored for them.
    //
    // Resolved from the cached branch list — no query, no Redis round trip.
    req.branch = null;
    req.branchId = null;

    if (user.shop && user.shop.multiBranchEnabled) {
      if (rbacCtx.isOwner) {
        const requested = req.headers['x-active-branch'] || req.cookies?.activeBranch;

        // 'all' is an explicit opt-in to the aggregate view, so it must not fall
        // through to the last-used/first-branch defaults below.
        if (requested === 'all') {
          req.branch = null;
        } else {
          req.branch =
            findBranch(user, requested) ||
            findBranch(user, user.lastActiveBranch) ||
            user.branchList[0] ||
            null;
        }

        if (req.branch) {
          req.branchId = req.branch._id;

          // Remember the owner's branch so the next login lands where they left
          // off. SET NX caps this to one write per 5 min per (user, branch)
          // instead of one per request — same guard as the expiry marker above.
          if (String(user.lastActiveBranch || '') !== String(req.branch._id)) {
            cacheService.setNX(`user:${user._id}:lastbranch:${req.branch._id}`, 1, 300)
              .then((acquired) => {
                if (acquired) {
                  return User.findByIdAndUpdate(user._id, { lastActiveBranch: req.branch._id });
                }
              })
              .catch(() => {}); // fire-and-forget; never blocks the response
          }
        }
        // No branch resolved (shop has none yet) → behaves as single-branch.
      } else if (user.branch) {
        const branch = findBranch(user, user.branch);
        if (!branch) {
          return ApiResponse.forbidden(res, {
            message: 'Your assigned branch is inactive or invalid',
            messageBn: 'আপনার নির্ধারিত শাখাটি নিষ্ক্রিয় বা অবৈধ। দোকান মালিকের সাথে যোগাযোগ করুন।',
          });
        }
        req.branch = branch;
        req.branchId = branch._id;
      } else {
        return ApiResponse.forbidden(res, {
          message: 'No branch is assigned to this staff account',
          messageBn: 'এই অ্যাকাউন্টে কোনো শাখা নির্ধারণ করা হয়নি। দোকান মালিকের সাথে যোগাযোগ করুন।',
        });
      }
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

        // ── Branch Context Resolution ──
        // Same rules as `protect`, minus the persistence side effect (softProtect
        // serves optional-auth routes and must stay side-effect free). Previously
        // these two diverged: protect returned 403 on an invalid staff branch
        // while softProtect silently downgraded the request to anonymous.
        req.branch = null;
        req.branchId = null;

        if (user.shop.multiBranchEnabled) {
          if (rbacCtx.isOwner) {
            const requested = req.headers['x-active-branch'] || req.cookies?.activeBranch;
            if (requested !== 'all') {
              req.branch =
                findBranch(user, requested) ||
                findBranch(user, user.lastActiveBranch) ||
                user.branchList[0] ||
                null;
              if (req.branch) req.branchId = req.branch._id;
            }
            // An unresolvable branch never invalidates an owner — they fall back
            // to the aggregate view.
          } else {
            const branch = user.branch ? findBranch(user, user.branch) : null;
            if (branch) {
              req.branch = branch;
              req.branchId = branch._id;
            } else {
              // Staff with no valid branch have no scope to read within, so this
              // request carries no identity rather than an unscoped one.
              req.user = null;
              req.shop = null;
              req.isAdmin = false;
            }
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
