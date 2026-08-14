/**
 * Cashier preset scope + the versioned upgrade that carries preset changes
 * to shops that already exist.
 */

const {
  ROLE_PRESETS,
  PRESET_VERSION,
  presetKeyForRoleName,
  buildPresetUpgradePatch,
} = require('../config/permissions');

describe('Cashier preset scope', () => {
  const cashier = ROLE_PRESETS.cashier.permissions;

  it('runs the customer desk end to end', () => {
    expect(cashier.customers.view).toBe(true);
    expect(cashier.customers.create).toBe(true);
    expect(cashier.customers.update).toBe(true);
  });

  it('can collect dues — at customer level and against a sale', () => {
    // POST /customers/:id/collect-due → customers.update
    expect(cashier.customers.update).toBe(true);
    // PATCH /sales/:id/payment → sales.update
    expect(cashier.sales.update).toBe(true);
  });

  it('can sell and put through a counter return', () => {
    expect(cashier.sales.create).toBe(true);
    // POST /sales-returns → sales.update
    expect(cashier.sales.update).toBe(true);
  });

  it('can text customers', () => {
    expect(cashier.sms.view).toBe(true);
    expect(cashier.sms.create).toBe(true);
  });

  it('can look up products and check stock', () => {
    expect(cashier.products.view).toBe(true);
    expect(cashier.stock.view).toBe(true);
  });

  it('can never see the buying price', () => {
    expect(cashier.products.view_cost).toBe(false);
    // The purchase ledger is raw cost data, so the module is off entirely.
    expect(cashier.purchases.view).toBe(false);
    expect(cashier.purchases.view_cost).toBe(false);
    expect(cashier.sales.view_profit).toBe(false);
    expect(cashier.reports.view_profit).toBe(false);
  });

  it('cannot void sales, erase customers, or hand-adjust stock', () => {
    expect(cashier.sales.delete).toBe(false);
    expect(cashier.customers.delete).toBe(false);
    expect(cashier.stock.manual_adjust).toBe(false);
  });

  it('cannot touch the catalogue, settings or staff', () => {
    expect(cashier.products.create).toBe(false);
    expect(cashier.products.update).toBe(false);
    expect(cashier.settings.view).toBe(false);
    expect(cashier.staff.view).toBe(false);
  });
});

describe('Preset upgrade', () => {
  it('maps Bengali, English and key role names to their preset', () => {
    expect(presetKeyForRoleName(ROLE_PRESETS.cashier.name)).toBe('cashier');
    expect(presetKeyForRoleName('Cashier')).toBe('cashier');
    expect(presetKeyForRoleName('cashier')).toBe('cashier');
    expect(presetKeyForRoleName(ROLE_PRESETS.manager.name)).toBe('manager');
  });

  it('leaves custom roles alone', () => {
    expect(presetKeyForRoleName('Weekend Helper')).toBeNull();
    expect(presetKeyForRoleName('')).toBeNull();
    expect(presetKeyForRoleName(null)).toBeNull();
  });

  it('grants every new permission to a role that predates versioning', () => {
    const patch = buildPresetUpgradePatch('cashier', 0);
    expect(patch).toMatchObject({
      'permissions.sms.view': true,
      'permissions.sms.create': true,
      'permissions.customers.update': true,
      'permissions.sales.update': true,
      'permissions.stock.view': true,
    });
  });

  it('skips revisions the role already has', () => {
    const patch = buildPresetUpgradePatch('cashier', 1);
    expect(patch['permissions.customers.update']).toBe(true);
    expect(patch['permissions.sms.view']).toBeUndefined();
  });

  it('is a no-op once the role is current', () => {
    expect(buildPresetUpgradePatch('cashier', PRESET_VERSION)).toBeNull();
  });

  it('only ever grants — no key is set to false', () => {
    const patch = buildPresetUpgradePatch('cashier', 0);
    Object.values(patch).forEach((v) => expect(v).toBe(true));
  });

  it('has nothing pending for presets with no upgrades', () => {
    // `salesperson` and `inventory_manager` are named in no PRESET_UPGRADES
    // entry, so an upgrade from version 0 has nothing to grant them.
    //
    // This used to assert the same of `manager`, which was true only until
    // manager gained the v3 online-panel grant. The fact under test is "a
    // preset nobody has upgraded stays untouched", not anything about manager
    // specifically — so the example moved rather than the assertion.
    expect(buildPresetUpgradePatch('salesperson', 0)).toBeNull();
    expect(buildPresetUpgradePatch('inventory_manager', 0)).toBeNull();
  });

  it('carries the online panel to managers and cashiers (v3)', () => {
    const manager = buildPresetUpgradePatch('manager', 2);
    expect(manager['permissions.online_orders.view']).toBe(true);
    expect(manager['permissions.online_orders.cancel']).toBe(true);
    expect(manager['permissions.storefront.update']).toBe(true);
    // Taking the shop's public face live stays the owner's call.
    expect(manager['permissions.storefront.publish']).toBeUndefined();

    const cashier = buildPresetUpgradePatch('cashier', 2);
    expect(cashier['permissions.online_orders.view']).toBe(true);
    expect(cashier['permissions.online_orders.update']).toBe(true);
    // Orders arrive from Facebook and the phone too, and taking one down is
    // counter work — see the note in config/permissions.js.
    expect(cashier['permissions.online_orders.create']).toBe(true);
    // Cancelling unwinds a Sale, stock and the customer's balance — withheld
    // for the same reason `sales.delete` is.
    expect(cashier['permissions.online_orders.cancel']).toBeUndefined();
    expect(cashier['permissions.storefront.view']).toBeUndefined();
  });

  it('ignores grants naming an action the module does not have', () => {
    // Guards against a typo in PRESET_UPGRADES silently writing a junk key.
    const patch = buildPresetUpgradePatch('cashier', 0) || {};
    for (const path of Object.keys(patch)) {
      const [, moduleKey, action] = path.split('.');
      const { MODULES } = require('../config/permissions');
      expect(MODULES[moduleKey]).toBeDefined();
      expect(MODULES[moduleKey].actions).toContain(action);
    }
  });
});
