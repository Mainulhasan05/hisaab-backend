/**
 * Permission Definitions — Module × Action Matrix
 * Each module has a set of allowed actions (boolean flags)
 */

// All modules and their available actions
const MODULES = {
  products:      { key: 'products',      label: 'পণ্য',              labelEn: 'Products',        actions: ['view', 'create', 'update', 'delete', 'view_cost'] },
  categories:    { key: 'categories',    label: 'ক্যাটাগরি',          labelEn: 'Categories',      actions: ['view', 'create', 'update', 'delete'] },
  sales:         { key: 'sales',         label: 'বিক্রয়',            labelEn: 'Sales',           actions: ['view', 'create', 'update', 'delete', 'view_profit'] },
  customers:     { key: 'customers',     label: 'কাস্টমার',          labelEn: 'Customers',       actions: ['view', 'create', 'update', 'delete'] },
  // A purchase record IS cost data (unit prices, invoice totals, dues), so
  // `view` alone only reveals *that* a purchase happened — supplier, date,
  // invoice no, quantities. The money is behind `view_cost`.
  purchases:     { key: 'purchases',     label: 'ক্রয়',              labelEn: 'Purchases',       actions: ['view', 'create', 'update', 'delete', 'view_cost'] },
  suppliers:     { key: 'suppliers',     label: 'সরবরাহকারী',        labelEn: 'Suppliers',       actions: ['view', 'create', 'update', 'delete'] },
  expenses:      { key: 'expenses',      label: 'খরচ',               labelEn: 'Expenses',        actions: ['view', 'create', 'update', 'delete'] },
  cash_register: { key: 'cash_register', label: 'ক্যাশ রেজিস্টার',    labelEn: 'Cash Register',   actions: ['view', 'create', 'update'] },
  reports:       { key: 'reports',       label: 'রিপোর্ট',            labelEn: 'Reports',         actions: ['view', 'view_profit'] },
  settings:      { key: 'settings',      label: 'সেটিংস',            labelEn: 'Settings',        actions: ['view', 'update'] },
  sms:           { key: 'sms',           label: 'এসএমএস',            labelEn: 'SMS',             actions: ['view', 'create'] },
  // Staff mutations are deliberately owner-only (a staff member who can edit
  // other staff could escalate their own privileges) — so only `view` is offered
  staff:         { key: 'staff',         label: 'স্টাফ ম্যানেজমেন্ট', labelEn: 'Staff Management', actions: ['view'] },
  stock:         { key: 'stock',         label: 'স্টক সমন্বয়',       labelEn: 'Stock Adjustment', actions: ['view', 'manual_adjust'] },
  stock_transfers: { key: 'stock_transfers', label: 'শাখা ট্রান্সফার', labelEn: 'Stock Transfers', actions: ['view', 'create', 'update'] },
  // ── The online panel ───────────────────────────────────────────────────────
  //
  // Both modules are inert unless `features.storefront` is on, which is off for
  // every shop by default. They appear in the roles matrix regardless, the same
  // way `stock_transfers` does for a single-branch shop — the matrix describes
  // what a role MAY do, and the capability decides whether the screen exists.
  //
  // `create` IS needed, and the first draft of this file got that wrong. The
  // reasoning was "nobody on the shop side creates an online order — a
  // customer does". That describes a storefront-only shop and almost none of
  // them are. Orders arrive from Facebook, WhatsApp, Messenger, Instagram and
  // the phone, and every one of those needs the SAME parcel lifecycle as a
  // website order: pack, hand to a courier, track, collect COD, settle.
  //
  // Recording those through the POS instead — which already accepts
  // `Sale.channel: 'facebook'` — writes the money correctly and gives the shop
  // no fulfilment workflow at all: no packing slip, no courier field, no
  // delivered/returned states, nothing to work through tomorrow morning. So a
  // manual order is a real `Order`, created here.
  //
  // `update` covers every forward transition INCLUDING confirm — the one that
  // runs `createSale`, deducts stock and moves the customer's balance. It is
  // materially equivalent to `sales.create` and should be granted with the same
  // care. `cancel` is separate because cancelling a confirmed order cancels a
  // Sale, which unwinds stock and the customer ledger.
  online_orders: { key: 'online_orders', label: 'অনলাইন অর্ডার', labelEn: 'Online Orders', actions: ['view', 'create', 'update', 'cancel'] },
  // `publish` is separate from `update` because publishing is outward-facing:
  // a junior staffer may draft the site, but making it public — under the
  // shop's name, to the shop's customers — is the owner's call.
  storefront:    { key: 'storefront',    label: 'অনলাইন দোকান',  labelEn: 'Online Storefront', actions: ['view', 'update', 'publish'] },
};

// List of all module keys
const MODULE_KEYS = Object.keys(MODULES);

// Bengali labels for actions (used in error messages and the roles UI matrix)
const ACTION_LABELS = {
  view:          { label: 'দেখা',           labelEn: 'View' },
  create:        { label: 'তৈরি',           labelEn: 'Create' },
  update:        { label: 'সম্পাদনা',       labelEn: 'Update' },
  delete:        { label: 'মুছে ফেলা',      labelEn: 'Delete' },
  view_cost:     { label: 'ক্রয়মূল্য দেখা', labelEn: 'View cost' },
  view_profit:   { label: 'লাভ দেখা',       labelEn: 'View profit' },
  manual_adjust: { label: 'স্টক সমন্বয়',    labelEn: 'Adjust stock' },
  cancel:        { label: 'বাতিল',           labelEn: 'Cancel' },
  publish:       { label: 'প্রকাশ',          labelEn: 'Publish' },
};

/**
 * Serializable matrix for clients — the roles UI must render from this,
 * never from a hardcoded copy.
 */
const getPermissionMatrix = () => {
  return MODULE_KEYS.map((key) => ({
    key,
    label: MODULES[key].label,
    labelEn: MODULES[key].labelEn,
    actions: MODULES[key].actions.map((action) => ({
      key: action,
      label: ACTION_LABELS[action]?.label || action,
      labelEn: ACTION_LABELS[action]?.labelEn || action,
    })),
  }));
};

/**
 * Deep-merge a client-supplied permissions object onto a base matrix.
 * Only known module/action keys are applied; values are coerced to booleans.
 * Modules absent from `input` keep their `base` values — so a client that
 * renders a subset of the matrix can never silently wipe the rest.
 */
const mergePermissions = (base, input) => {
  const perms = {};
  for (const [modKey, mod] of Object.entries(MODULES)) {
    perms[modKey] = {};
    for (const action of mod.actions) {
      const baseVal = base?.[modKey]?.[action] === true;
      const inputVal = input?.[modKey]?.[action];
      perms[modKey][action] = inputVal === undefined ? baseVal : inputVal === true;
    }
  }
  return perms;
};

/**
 * Collect module/action keys in `input` that don't exist in the matrix,
 * so the API can reject typos instead of silently dropping them.
 */
const findUnknownPermissionKeys = (input) => {
  const unknown = [];
  if (!input || typeof input !== 'object') return unknown;
  for (const [modKey, actions] of Object.entries(input)) {
    if (!MODULES[modKey]) {
      unknown.push(modKey);
      continue;
    }
    if (actions && typeof actions === 'object') {
      for (const action of Object.keys(actions)) {
        if (!MODULES[modKey].actions.includes(action)) {
          unknown.push(`${modKey}.${action}`);
        }
      }
    }
  }
  return unknown;
};

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
      products:      ['view', 'create', 'update', 'view_cost'],
      categories:    ['view', 'create', 'update'],
      sales:         ['view', 'create', 'update', 'view_profit'],
      customers:     ['view', 'create', 'update'],
      purchases:     ['view', 'create', 'update', 'view_cost'],
      suppliers:     ['view', 'create', 'update'],
      expenses:      ['view', 'create', 'update'],
      cash_register: ['view', 'create', 'update'],
      reports:       ['view', 'view_profit'],
      settings:      ['view'],
      sms:           ['view', 'create'],
      staff:         ['view'],
      stock:         ['view', 'manual_adjust'],
      stock_transfers: ['view', 'create', 'update'],
      // A manager runs the parcel desk end to end and may draft the site.
      // `storefront.publish` is withheld: taking the shop's public face live is
      // the owner's decision, the same way `isWholesale` is.
      online_orders: ['view', 'create', 'update', 'cancel'],
      storefront:    ['view', 'update'],
    }),
  },
  // Runs the counter: sells, takes payment against dues, handles walk-in
  // returns, owns the customer desk end to end, and texts customers. Can read
  // stock but never what the shop paid for it.
  //
  // Withheld on purpose: products.view_cost (buying price), sales.delete
  // (voiding a completed sale), customers.delete (erasing a customer's
  // history), stock.manual_adjust (rewriting stock counts by hand).
  cashier: {
    name: 'ক্যাশিয়ার',
    nameEn: 'Cashier',
    permissions: buildPermissionsFromConfig({
      products:      ['view'],
      categories:    ['view'],
      // `update` is what lets a cashier record a payment against a due sale
      // and put through a counter return — both routine till work.
      sales:         ['view', 'create', 'update'],
      customers:     ['view', 'create', 'update'],
      // `purchases` and `suppliers` were deliberately dropped: the purchase
      // ledger is raw buying-price data, so granting it here handed a cashier
      // every cost figure despite products.view_cost being off.
      expenses:      ['view'],
      cash_register: ['view', 'create'],
      reports:       ['view'],
      settings:      [],
      sms:           ['view', 'create'],
      staff:         [],
      stock:         ['view'],
      stock_transfers: ['view'],
      // Processing an order is counter work by another name — same person,
      // same judgement. `cancel` is withheld for the same reason `sales.delete`
      // is: it unwinds a completed sale, stock and the customer's balance.
      // A cashier taking a Facebook order over the phone is doing counter work
      // by another name — same person, same judgement as ringing up a sale.
      online_orders: ['view', 'create', 'update'],
    }),
  },
  // Sell and check stock, nothing else. No reports, no purchase ledger, no
  // expenses — for owners who don't want floor staff seeing any money figure
  // beyond the selling price they're quoting.
  salesperson: {
    name: 'বিক্রয়কর্মী',
    nameEn: 'Salesperson',
    permissions: buildPermissionsFromConfig({
      products:      ['view'],
      categories:    ['view'],
      sales:         ['view', 'create'],
      customers:     ['view', 'create'],
      cash_register: ['view', 'create'],
      sms:           ['view', 'create'],
      stock:         ['view'],
      stock_transfers: ['view'],
    }),
  },
  // Builds the catalogue and receives stock, so it needs buying prices — but
  // never sees sale profit or any report.
  inventory_manager: {
    name: 'স্টক ম্যানেজার',
    nameEn: 'Inventory Manager',
    permissions: buildPermissionsFromConfig({
      products:      ['view', 'create', 'update', 'view_cost'],
      categories:    ['view', 'create', 'update'],
      purchases:     ['view', 'create', 'update', 'view_cost'],
      suppliers:     ['view', 'create', 'update'],
      stock:         ['view', 'manual_adjust'],
      stock_transfers: ['view', 'create', 'update'],
    }),
  },
};

/**
 * Preset schema version.
 *
 * Presets seed a shop's roles at registration, so editing ROLE_PRESETS above
 * only reaches *new* shops — every existing shop keeps the Role document it was
 * created with. To roll a change out to shops that already exist, bump this and
 * add a PRESET_UPGRADES entry.
 */
const PRESET_VERSION = 3;

/**
 * Additive grants applied once per role, in version order.
 * See Role.presetVersion and roleService.getRoles().
 *
 * Grants only — an upgrade never revokes. Because each role is stamped with the
 * version it reached, an owner who later narrows a default role does not get
 * the upgrade re-applied on top of their decision.
 */
const PRESET_UPGRADES = [
  {
    version: 1,
    // Cashiers need SMS to send due reminders from the till. (Previously an
    // ad-hoc self-heal in roleService.getRoles.)
    grants: {
      cashier: { sms: ['view', 'create'] },
    },
  },
  {
    version: 2,
    // Cashiers own the customer desk: edit customer records, collect dues at
    // both customer and sale level, and put through counter returns.
    grants: {
      cashier: {
        customers: ['update'],
        sales: ['update'],
        stock: ['view'],
      },
    },
  },
  {
    version: 3,
    // The online panel. Granting these to shops that already exist costs them
    // nothing and shows them nothing: both modules are inert until an admin
    // turns on `features.storefront`, which is off everywhere by default. Doing
    // it now rather than at the moment a shop is switched on means nobody has
    // to remember to re-run a role migration on the day it matters.
    //
    // Salesperson and inventory_manager are deliberately left out — a shop that
    // wants floor staff on parcels grants it explicitly.
    grants: {
      manager: {
        online_orders: ['view', 'create', 'update', 'cancel'],
        storefront: ['view', 'update'],
      },
      cashier: {
        online_orders: ['view', 'create', 'update'],
      },
    },
  },
];

/**
 * Map a role name back to the preset it tracks, so an upgrade can be aimed at
 * "the cashier role" without depending on document order. Matches the Bengali
 * preset name or its English equivalent, since older shops were seeded with
 * either.
 */
const presetKeyForRoleName = (roleName) => {
  if (!roleName) return null;
  const needle = String(roleName).trim().toLowerCase();
  for (const [key, preset] of Object.entries(ROLE_PRESETS)) {
    if (
      needle === preset.name.toLowerCase() ||
      needle === preset.nameEn.toLowerCase() ||
      needle === key
    ) {
      return key;
    }
  }
  return null;
};

/**
 * Build the $set patch bringing one role from `fromVersion` up to
 * PRESET_VERSION. Returns null when there is nothing to grant.
 *
 * @param {string} presetKey - preset this role tracks ('cashier', 'manager', …)
 * @param {number} fromVersion - the role's current presetVersion
 */
const buildPresetUpgradePatch = (presetKey, fromVersion = 0) => {
  const patch = {};
  for (const upgrade of PRESET_UPGRADES) {
    if (upgrade.version <= fromVersion) continue;
    const grants = upgrade.grants[presetKey];
    if (!grants) continue;
    for (const [modKey, actions] of Object.entries(grants)) {
      const mod = MODULES[modKey];
      if (!mod) continue;
      for (const action of actions) {
        if (mod.actions.includes(action)) {
          patch[`permissions.${modKey}.${action}`] = true;
        }
      }
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
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
  ACTION_LABELS,
  ROLE_PRESETS,
  PRESET_VERSION,
  PRESET_UPGRADES,
  presetKeyForRoleName,
  buildPresetUpgradePatch,
  buildPermissions,
  buildPermissionsFromConfig,
  getPermissionMatrix,
  mergePermissions,
  findUnknownPermissionKeys,
  checkPerm,
  LEGACY_PERMISSION_MAP,
};
