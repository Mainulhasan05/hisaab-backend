const ApiResponse = require('../utils/response.util');
const { MODULES } = require('../config/permissions');

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

    // Owner bypasses all RBAC checks
    if (req.user.isOwner) return next();

    // Employee — check permissions from JWT
    const perms = req.user.permissions;

    if (perms && perms[module] && perms[module][action] === true) {
      return next();
    }

    // Get module label for user-friendly error
    const moduleLabel = MODULES[module]?.label || module;
    const actionLabels = { view: 'দেখার', create: 'তৈরি করার', update: 'সম্পাদনা করার', delete: 'মুছে ফেলার' };
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
  rbac,
  ownerOnly,
};
