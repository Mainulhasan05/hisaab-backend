const ApiResponse = require('../utils/response.util');
const { PERMISSIONS } = require('../config/permissions');

/**
 * Check if user has specific permission
 */
const checkPermission = (permission) => {
  return (req, res, next) => {
    // Admins have all permissions
    if (req.isAdmin) {
      return next();
    }

    // Check user permission
    if (!req.user) {
      return ApiResponse.unauthorized(res, {
        message: 'Authentication required',
        messageBn: 'লগইন করুন'
      });
    }

    if (!req.user.hasPermission(permission)) {
      return ApiResponse.forbidden(res, {
        message: 'You do not have permission to perform this action',
        messageBn: 'এই কাজ করার অনুমতি নেই'
      });
    }

    next();
  };
};

/**
 * Check if user has any of the permissions
 */
const checkAnyPermission = (...permissions) => {
  return (req, res, next) => {
    if (req.isAdmin) {
      return next();
    }

    if (!req.user) {
      return ApiResponse.unauthorized(res, {
        message: 'Authentication required',
        messageBn: 'লগইন করুন'
      });
    }

    if (!req.user.hasAnyPermission(permissions)) {
      return ApiResponse.forbidden(res, {
        message: 'You do not have permission to perform this action',
        messageBn: 'এই কাজ করার অনুমতি নেই'
      });
    }

    next();
  };
};

/**
 * Check if user has all permissions
 */
const checkAllPermissions = (...permissions) => {
  return (req, res, next) => {
    if (req.isAdmin) {
      return next();
    }

    if (!req.user) {
      return ApiResponse.unauthorized(res, {
        message: 'Authentication required',
        messageBn: 'লগইন করুন'
      });
    }

    const hasAll = permissions.every(p => req.user.hasPermission(p));
    if (!hasAll) {
      return ApiResponse.forbidden(res, {
        message: 'You do not have all required permissions',
        messageBn: 'সব প্রয়োজনীয় অনুমতি নেই'
      });
    }

    next();
  };
};

// Pre-built permission middlewares
const canViewProducts = checkPermission(PERMISSIONS.PRODUCTS_VIEW);
const canCreateProducts = checkPermission(PERMISSIONS.PRODUCTS_CREATE);
const canEditProducts = checkPermission(PERMISSIONS.PRODUCTS_EDIT);
const canDeleteProducts = checkPermission(PERMISSIONS.PRODUCTS_DELETE);

const canViewSales = checkPermission(PERMISSIONS.SALES_VIEW);
const canCreateSales = checkPermission(PERMISSIONS.SALES_CREATE);
const canEditSales = checkPermission(PERMISSIONS.SALES_EDIT);
const canDeleteSales = checkPermission(PERMISSIONS.SALES_DELETE);

const canViewCustomers = checkPermission(PERMISSIONS.CUSTOMERS_VIEW);
const canCreateCustomers = checkPermission(PERMISSIONS.CUSTOMERS_CREATE);
const canEditCustomers = checkPermission(PERMISSIONS.CUSTOMERS_EDIT);
const canDeleteCustomers = checkPermission(PERMISSIONS.CUSTOMERS_DELETE);

const canViewReports = checkPermission(PERMISSIONS.REPORTS_VIEW);
const canEditSettings = checkPermission(PERMISSIONS.SETTINGS_EDIT);
const canManageTeam = checkPermission(PERMISSIONS.TEAM_MANAGE);
const canSendSMS = checkPermission(PERMISSIONS.SMS_SEND);

const canViewCategories = checkPermission(PERMISSIONS.CATEGORIES_VIEW);
const canManageCategories = checkPermission(PERMISSIONS.CATEGORIES_MANAGE);

const canViewStock = checkPermission(PERMISSIONS.STOCK_VIEW);
const canManageStock = checkPermission(PERMISSIONS.STOCK_MANAGE);

module.exports = {
  checkPermission,
  checkAnyPermission,
  checkAllPermissions,
  canViewProducts,
  canCreateProducts,
  canEditProducts,
  canDeleteProducts,
  canViewSales,
  canCreateSales,
  canEditSales,
  canDeleteSales,
  canViewCustomers,
  canCreateCustomers,
  canEditCustomers,
  canDeleteCustomers,
  canViewReports,
  canEditSettings,
  canManageTeam,
  canSendSMS,
  canViewCategories,
  canManageCategories,
  canViewStock,
  canManageStock
};
