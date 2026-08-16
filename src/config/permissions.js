/**
 * Permission Definitions — Module × Action Matrix
 * Each module has a set of allowed actions (boolean flags)
 */

// All modules and their available actions
const MODULES = {
  products:      { key: 'products',      label: 'পণ্য',              labelEn: 'Products',        actions: ['view', 'create', 'update', 'delete', 'view_cost'] },
  categories:    { key: 'categories',    label: 'ক্যাটাগরি',          labelEn: 'Categories',      actions: ['view', 'create', 'update', 'delete'] },
  // `discount` is per-LINE negotiated pricing (`features.lineDiscount`), and it
  // is deliberately NOT implied by `create`. Ringing up a sale at the shelf
  // price and knocking ৳10 a kilo off it are different acts of authority — the
  // second is spending the shop's margin, and an owner wants to choose who may.
  //
  // It is also the one permission that cannot be enforced at the door: the
  // endpoint stays open to anyone with `sales.create`, and the check happens
  // per item inside `createSale` via `permission.middleware.hasPermission`.
  // Inert unless `features.lineDiscount` is on, the way `storefront`'s actions
  // are inert without that capability.
  //
  // `backdate` is dating an invoice to a day that has already been reported on.
  // Also NOT implied by `create`, and for a sharper reason than `discount`:
  // moving a sale between days moves it between report periods, between staff
  // members' figures and between cash drawers, so a staff member who can do it
  // can also paper over a discrepancy in yesterday's till. Enforced inside
  // `createSale` via `utils/saleDate.util.resolveSaleDate`, not at the door —
  // the endpoint stays open to anyone with `sales.create`, since a sale with no
  // date named is the ordinary case and must never be refused.
  sales:         { key: 'sales',         label: 'বিক্রয়',            labelEn: 'Sales',           actions: ['view', 'create', 'update', 'delete', 'view_profit', 'discount', 'backdate'] },
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
  discount:      { label: 'ছাড় দেওয়া',      labelEn: 'Give discount' },
  backdate:      { label: 'আগের তারিখে বিক্রি', labelEn: 'Backdate a sale' },
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
      sales:         ['view', 'create', 'update', 'view_profit', 'discount', 'backdate'],
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
      //
      // `discount` is haggling at the counter, which is what a cashier at these
      // shops is doing all day. It stays a SEPARATE action rather than being
      // folded into `create` so an owner who does not want it can still take it
      // away from one role without also taking away selling — and it is inert
      // in every shop without `features.lineDiscount`, which is almost all of
      // them. The shop's own ceiling is `settings.maxLineDiscountPercent`, and
      // selling below cost stays owner-only whatever this says.
      //
      // `backdate` is here because goods leave these shops before anyone gets
      // to the till — a delivery on Thursday entered on Saturday has to say
      // Thursday. The cashier who sold it is the one who knows which day it
      // was. Revocable per role, and every use is recorded in the audit log
      // with both the date claimed and the moment it was really typed.
      sales:         ['view', 'create', 'update', 'discount', 'backdate'],
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
const PRESET_VERSION = 5;

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
  {
    version: 4,
    /**
     * Per-item discount at the till.
     *
     * The original call was that no preset should grant this — that a shop
     * given the capability should have to choose who may spend its margin. In
     * practice that meant every shop switched on arrived at a POS with no rate
     * control for anyone but the owner, reported it as a bug, and had to be
     * walked through the roles matrix before the feature they had just been
     * sold did anything. The counter staff ARE the people who haggle; making
     * that the default and letting an owner revoke it is the right way round.
     *
     * Inert wherever `features.lineDiscount` is off, which is nearly every shop
     * — the same argument version 3 made for the online panel, and the reason
     * it is safe to grant platform-wide rather than shop by shop.
     *
     * Grants only, as ever: an owner who has already narrowed one of these
     * roles keeps their decision, because the role is stamped with the version
     * it reached and is never re-upgraded past it.
     *
     * Salesperson and inventory_manager are deliberately left out. A shop that
     * wants floor staff negotiating prices grants it explicitly — and
     * inventory_manager cannot sell at all.
     *
     * TWO LIMITS SURVIVE THIS, and support will be asked about both:
     *   - selling BELOW COST is still owner-only (lineDiscount.util.js rule 7),
     *     whatever this permission says;
     *   - the shop's ceiling is `settings.maxLineDiscountPercent`, which is
     *     `null` — no cap — until an owner sets one.
     */
    grants: {
      manager: { sales: ['discount'] },
      cashier: { sales: ['discount'] },
    },
  },
  {
    version: 5,
    /**
     * Backdating a sale to the day it actually happened.
     *
     * Shipped owner-only and widened on the same day, for the reason the shops
     * gave: goods go out before anyone reaches the till, and the person who
     * knows which day that was is the one who sold them. An owner who wants it
     * back revokes it per role — which is the entire reason it is a separate
     * action rather than part of `create`.
     *
     * Unlike `discount`, this is NOT inert in shops without a capability: there
     * is no feature flag behind it, so these 46 roles gain a real ability the
     * moment they next log in. That is deliberate and it is the trade — what
     * bounds it instead is that a backdated sale can never land in the future
     * or before the shop existed, and that EVERY use writes an audit entry
     * carrying both the date claimed and the wall-clock moment it was typed
     * (`sale.service` → `sale_create`, `backdatedTo` + `enteredAt`).
     *
     * Salesperson and inventory_manager are left out, as with `discount`.
     */
    grants: {
      manager: { sales: ['backdate'] },
      cashier: { sales: ['backdate'] },
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
