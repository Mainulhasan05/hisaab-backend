/**
 * Permission Definitions — Module × Action Matrix
 * Each module has a set of allowed actions (boolean flags)
 */

// All modules and their available actions
const MODULES = {
  products:      { key: 'products',      label: 'পণ্য',              labelEn: 'Products',        actions: ['view', 'create', 'update', 'delete'] },
  categories:    { key: 'categories',    label: 'ক্যাটাগরি',          labelEn: 'Categories',      actions: ['view', 'create', 'update', 'delete'] },
  sales:         { key: 'sales',         label: 'বিক্রয়',            labelEn: 'Sales',           actions: ['view', 'create', 'update', 'delete'] },
  customers:     { key: 'customers',     label: 'কাস্টমার',          labelEn: 'Customers',       actions: ['view', 'create', 'update', 'delete'] },
  purchases:     { key: 'purchases',     label: 'ক্রয়',              labelEn: 'Purchases',       actions: ['view', 'create', 'update', 'delete'] },
  suppliers:     { key: 'suppliers',     label: 'সরবরাহকারী',        labelEn: 'Suppliers',       actions: ['view', 'create', 'update', 'delete'] },
  expenses:      { key: 'expenses',      label: 'খরচ',               labelEn: 'Expenses',        actions: ['view', 'create', 'update', 'delete'] },
  cash_register: { key: 'cash_register', label: 'ক্যাশ রেজিস্টার',    labelEn: 'Cash Register',   actions: ['view', 'create', 'update', 'delete'] },
  reports:       { key: 'reports',       label: 'রিপোর্ট',            labelEn: 'Reports',         actions: ['view'] },
  settings:      { key: 'settings',      label: 'সেটিংস',            labelEn: 'Settings',        actions: ['view', 'update'] },
  sms:           { key: 'sms',           label: 'এসএমএস',            labelEn: 'SMS',             actions: ['view', 'create'] },
  staff:         { key: 'staff',         label: 'স্টাফ ম্যানেজমেন্ট', labelEn: 'Staff Management', actions: ['view', 'create', 'update', 'delete'] },
};

// List of all module keys
const MODULE_KEYS = Object.keys(MODULES);

/**
 * Build a full permissions object with all flags set to a given value
 */
const buildPermissions = (defaultValue = false) => {
  const perms = {};
  for (const [key, mod] of Object.entries(MODULES)) {
    perms[key] = {};
    for (const action of mod.actions) {
      perms[key][action] = defaultValue;
    }
  }
  return perms;
};

/**
 * Build a permissions object from a specific config
 * @param {Object} config - { module: [action, ...], ... }
 */
const buildPermissionsFromConfig = (config) => {
  const perms = buildPermissions(false);
  for (const [mod, actions] of Object.entries(config)) {
    if (perms[mod]) {
      for (const action of actions) {
        if (perms[mod][action] !== undefined) {
          perms[mod][action] = true;
        }
      }
    }
  }
  return perms;
};

// ── Preset role definitions ──
const ROLE_PRESETS = {
  manager: {
    name: 'ম্যানেজার',
    nameEn: 'Manager',
    permissions: buildPermissionsFromConfig({
      products:      ['view', 'create', 'update'],
      categories:    ['view', 'create', 'update'],
      sales:         ['view', 'create', 'update'],
      customers:     ['view', 'create', 'update'],
      purchases:     ['view', 'create', 'update'],
      suppliers:     ['view', 'create', 'update'],
      expenses:      ['view', 'create', 'update'],
      cash_register: ['view', 'create', 'update'],
      reports:       ['view'],
      settings:      ['view'],
      sms:           ['view', 'create'],
      staff:         ['view'],
    }),
  },
  cashier: {
    name: 'ক্যাশিয়ার',
    nameEn: 'Cashier',
    permissions: buildPermissionsFromConfig({
      products:      ['view'],
      categories:    ['view'],
      sales:         ['view', 'create'],
      customers:     ['view', 'create'],
      purchases:     ['view'],
      suppliers:     ['view'],
      expenses:      ['view'],
      cash_register: ['view', 'create'],
      reports:       ['view'],
      settings:      [],
      sms:           [],
      staff:         [],
    }),
  },
};

/**
 * Check a permission: perms[module][action]
 */
const checkPerm = (permissions, module, action) => {
  if (!permissions || !permissions[module]) return false;
  return permissions[module][action] === true;
};

// ── Legacy compatibility exports ──
// These map old flat permission strings to new module×action pairs
// Used during migration only
const LEGACY_PERMISSION_MAP = {
  'products_view':     { module: 'products', action: 'view' },
  'products_create':   { module: 'products', action: 'create' },
  'products_edit':     { module: 'products', action: 'update' },
  'products_delete':   { module: 'products', action: 'delete' },
  'sales_view':        { module: 'sales', action: 'view' },
  'sales_create':      { module: 'sales', action: 'create' },
  'sales_edit':        { module: 'sales', action: 'update' },
  'sales_delete':      { module: 'sales', action: 'delete' },
  'customers_view':    { module: 'customers', action: 'view' },
  'customers_create':  { module: 'customers', action: 'create' },
  'customers_edit':    { module: 'customers', action: 'update' },
  'customers_delete':  { module: 'customers', action: 'delete' },
  'reports_view':      { module: 'reports', action: 'view' },
  'settings_edit':     { module: 'settings', action: 'update' },
  'team_manage':       { module: 'staff', action: 'view' },
  'sms_send':          { module: 'sms', action: 'create' },
  'categories_view':   { module: 'categories', action: 'view' },
  'categories_manage': { module: 'categories', action: 'update' },
  'stock_view':        { module: 'products', action: 'view' },
  'stock_manage':      { module: 'products', action: 'update' },
  'expenses_view':     { module: 'expenses', action: 'view' },
  'expenses_create':   { module: 'expenses', action: 'create' },
  'expenses_edit':     { module: 'expenses', action: 'update' },
  'expenses_delete':   { module: 'expenses', action: 'delete' },
  'purchases_view':    { module: 'purchases', action: 'view' },
  'purchases_create':  { module: 'purchases', action: 'create' },
  'purchases_edit':    { module: 'purchases', action: 'update' },
  'purchases_delete':  { module: 'purchases', action: 'delete' },
};

module.exports = {
  MODULES,
  MODULE_KEYS,
  ROLE_PRESETS,
  buildPermissions,
  buildPermissionsFromConfig,
  checkPerm,
  LEGACY_PERMISSION_MAP,
};
