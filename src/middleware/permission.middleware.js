const ApiResponse = require('../utils/response.util');
const { MODULES } = require('../config/permissions');

/**
 * May this request perform `module.action`? The same question `rbac` asks, as a
 * plain boolean.
 *
 * Exists because not every permission can be enforced at the door. A per-LINE
 * capability — "may this cashier discount an individual item?" — is decided
 * inside `createSale`, per item, long after the route middleware has run, and
 * the endpoint itself must stay open to anyone with `sales.create`. Without
 * this helper that service would hand-roll the bypass rules, and a hand-rolled
 * copy that forgets `req.isAdmin` locks the platform admin out of a shop.
 *
 * Fails CLOSED on every uncertainty: no request, no user, no permissions
 * object, a non-boolean value. `rbac` below delegates to it, so there is one
 * definition of who may do what.
 *
 * @param {Object} req    the Express request
 * @param {string} module a MODULES key
 * @param {string} action an action on that module
 * @returns {boolean}
 */
const hasPermission = (req, module, action) => {
  if (!req) return false;
  // Platform admins bypass everything.
  if (req.isAdmin) return true;
  if (!req.user) return false;
  // The owner bypasses all RBAC checks.
  if (req.user.isOwner) return true;
  return req.user.permissions?.[module]?.[action] === true;
};

/**
 * RBAC Middleware Factory
 * Usage: rbac('products', 'view'), rbac('sales', 'create'), etc.
 *
 * - Admins bypass all checks
 * - Owners bypass all checks (isOwner === true)
 * - Employees are checked against their embedded JWT permissions
 */
const rbac = (module, action) => {
  return (req, res, next) => {
    // Platform admins bypass everything
    if (req.isAdmin) return next();

    // Must be authenticated
    if (!req.user) {
      return ApiResponse.unauthorized(res, {
        message: 'Authentication required',
        messageBn: 'লগইন করুন'
      });
    }

    if (hasPermission(req, module, action)) return next();

    // Get module label for user-friendly error
    const moduleLabel = MODULES[module]?.label || module;
    const actionLabels = {
      view: 'দেখার', create: 'তৈরি করার', update: 'সম্পাদনা করার', delete: 'মুছে ফেলার',
      cancel: 'বাতিল করার', publish: 'প্রকাশ করার',
    };
    const actionLabel = actionLabels[action] || action;

    return ApiResponse.forbidden(res, {
      message: `You do not have permission to ${action} ${module}`,
      messageBn: `আপনার ${moduleLabel} ${actionLabel} অনুমতি নেই`
    });
  };
};

/**
 * RBAC middleware allowing ANY of several module/action pairs.
 * Usage: rbacAny([['products', 'update'], ['stock', 'manual_adjust']])
 * Same bypass rules as rbac(); the error message names the first pair.
 */
const rbacAny = (pairs) => {
  return (req, res, next) => {
    if (req.isAdmin) return next();

    if (!req.user) {
      return ApiResponse.unauthorized(res, {
        message: 'Authentication required',
        messageBn: 'লগইন করুন'
      });
    }

    for (const [module, action] of pairs) {
      if (hasPermission(req, module, action)) return next();
    }

    const [module, action] = pairs[0];
    const moduleLabel = MODULES[module]?.label || module;
    const actionLabels = {
      view: 'দেখার', create: 'তৈরি করার', update: 'সম্পাদনা করার', delete: 'মুছে ফেলার',
      cancel: 'বাতিল করার', publish: 'প্রকাশ করার',
    };
    const actionLabel = actionLabels[action] || action;

    return ApiResponse.forbidden(res, {
      message: `You do not have permission to ${action} ${module}`,
      messageBn: `আপনার ${moduleLabel} ${actionLabel} অনুমতি নেই`
    });
  };
};

/**
 * Owner-only middleware
 * For routes that should ONLY be accessible by the tenant owner
 * (managing roles, managing staff, deleting sensitive data)
 */
const ownerOnly = (req, res, next) => {
  if (req.isAdmin) return next();

  if (!req.user) {
    return ApiResponse.unauthorized(res, {
      message: 'Authentication required',
      messageBn: 'লগইন করুন'
    });
  }

  if (!req.user.isOwner) {
    return ApiResponse.forbidden(res, {
      message: 'Only the shop owner can perform this action',
      messageBn: 'শুধুমাত্র দোকান মালিক এই কাজ করতে পারবেন'
    });
  }

  next();
};

module.exports = {
  hasPermission,
  rbac,
  rbacAny,
  ownerOnly,
};
