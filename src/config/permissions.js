/**
 * Permission Definitions
 * Granular permissions for role-based access control
 */

// All available permissions
const PERMISSIONS = {
  // Products
  PRODUCTS_VIEW: 'products_view',
  PRODUCTS_CREATE: 'products_create',
  PRODUCTS_EDIT: 'products_edit',
  PRODUCTS_DELETE: 'products_delete',

  // Sales
  SALES_VIEW: 'sales_view',
  SALES_CREATE: 'sales_create',
  SALES_EDIT: 'sales_edit',
  SALES_DELETE: 'sales_delete',

  // Customers
  CUSTOMERS_VIEW: 'customers_view',
  CUSTOMERS_CREATE: 'customers_create',
  CUSTOMERS_EDIT: 'customers_edit',
  CUSTOMERS_DELETE: 'customers_delete',

  // Reports
  REPORTS_VIEW: 'reports_view',

  // Settings
  SETTINGS_EDIT: 'settings_edit',

  // Team Management
  TEAM_MANAGE: 'team_manage',

  // SMS
  SMS_SEND: 'sms_send',

  // Categories
  CATEGORIES_VIEW: 'categories_view',
  CATEGORIES_MANAGE: 'categories_manage',

  // Stock
  STOCK_VIEW: 'stock_view',
  STOCK_MANAGE: 'stock_manage'
};

// Permission list as array
const PERMISSION_LIST = Object.values(PERMISSIONS);

// Default permissions by role
const ROLE_PERMISSIONS = {
  owner: [...PERMISSION_LIST], // Owner has all permissions

  manager: [
    PERMISSIONS.PRODUCTS_VIEW,
    PERMISSIONS.PRODUCTS_CREATE,
    PERMISSIONS.PRODUCTS_EDIT,
    PERMISSIONS.SALES_VIEW,
    PERMISSIONS.SALES_CREATE,
    PERMISSIONS.SALES_EDIT,
    PERMISSIONS.CUSTOMERS_VIEW,
    PERMISSIONS.CUSTOMERS_CREATE,
    PERMISSIONS.CUSTOMERS_EDIT,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.SMS_SEND,
    PERMISSIONS.CATEGORIES_VIEW,
    PERMISSIONS.CATEGORIES_MANAGE,
    PERMISSIONS.STOCK_VIEW,
    PERMISSIONS.STOCK_MANAGE
  ],

  staff: [
    PERMISSIONS.PRODUCTS_VIEW,
    PERMISSIONS.SALES_VIEW,
    PERMISSIONS.SALES_CREATE,
    PERMISSIONS.CUSTOMERS_VIEW,
    PERMISSIONS.CUSTOMERS_CREATE,
    PERMISSIONS.CATEGORIES_VIEW,
    PERMISSIONS.STOCK_VIEW
  ]
};

// Permission descriptions (Bengali)
const PERMISSION_LABELS = {
  products_view: { en: 'View Products', bn: 'পণ্য দেখুন' },
  products_create: { en: 'Create Products', bn: 'পণ্য যোগ করুন' },
  products_edit: { en: 'Edit Products', bn: 'পণ্য সম্পাদনা' },
  products_delete: { en: 'Delete Products', bn: 'পণ্য মুছুন' },
  sales_view: { en: 'View Sales', bn: 'বিক্রয় দেখুন' },
  sales_create: { en: 'Create Sales', bn: 'বিক্রয় করুন' },
  sales_edit: { en: 'Edit Sales', bn: 'বিক্রয় সম্পাদনা' },
  sales_delete: { en: 'Delete Sales', bn: 'বিক্রয় মুছুন' },
  customers_view: { en: 'View Customers', bn: 'কাস্টমার দেখুন' },
  customers_create: { en: 'Create Customers', bn: 'কাস্টমার যোগ করুন' },
  customers_edit: { en: 'Edit Customers', bn: 'কাস্টমার সম্পাদনা' },
  customers_delete: { en: 'Delete Customers', bn: 'কাস্টমার মুছুন' },
  reports_view: { en: 'View Reports', bn: 'রিপোর্ট দেখুন' },
  settings_edit: { en: 'Edit Settings', bn: 'সেটিংস সম্পাদনা' },
  team_manage: { en: 'Manage Team', bn: 'টিম ম্যানেজ করুন' },
  sms_send: { en: 'Send SMS', bn: 'এসএমএস পাঠান' },
  categories_view: { en: 'View Categories', bn: 'ক্যাটাগরি দেখুন' },
  categories_manage: { en: 'Manage Categories', bn: 'ক্যাটাগরি ম্যানেজ করুন' },
  stock_view: { en: 'View Stock', bn: 'স্টক দেখুন' },
  stock_manage: { en: 'Manage Stock', bn: 'স্টক ম্যানেজ করুন' }
};

/**
 * Check if a user has a specific permission
 */
const hasPermission = (userPermissions, requiredPermission) => {
  if (!userPermissions || !Array.isArray(userPermissions)) {
    return false;
  }
  return userPermissions.includes(requiredPermission);
};

/**
 * Check if a user has any of the required permissions
 */
const hasAnyPermission = (userPermissions, requiredPermissions) => {
  if (!userPermissions || !Array.isArray(userPermissions)) {
    return false;
  }
  return requiredPermissions.some(perm => userPermissions.includes(perm));
};

/**
 * Check if a user has all of the required permissions
 */
const hasAllPermissions = (userPermissions, requiredPermissions) => {
  if (!userPermissions || !Array.isArray(userPermissions)) {
    return false;
  }
  return requiredPermissions.every(perm => userPermissions.includes(perm));
};

/**
 * Get default permissions for a role
 */
const getDefaultPermissions = (role) => {
  return ROLE_PERMISSIONS[role] || [];
};

module.exports = {
  PERMISSIONS,
  PERMISSION_LIST,
  ROLE_PERMISSIONS,
  PERMISSION_LABELS,
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  getDefaultPermissions
};
