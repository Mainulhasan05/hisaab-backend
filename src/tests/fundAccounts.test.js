/**
 * Fund accounts — the capability, the branch rule, and the one balance writer.
 *
 * Mostly INVARIANT GUARDS (I-1 / I-6 / I-7 class): a shop without
 * `features.fundAccounts` must behave exactly as it did before this collection
 * existed, and a single-branch shop must not learn that branches exist.
 *
 * The `applyAccountDelta` group is different — those pin the rule that makes a
 * stored rollup survivable. `variants[].stock` drifted from `product.stock` on
 * live data for months because a second write path did not know about the
 * rollup; the answer here is that there is exactly one writer, and these fail
 * the moment someone adds a second.
 */
const mongoose = require('mongoose');
const PaymentAccount = require('../models/PaymentAccount.model');
const paymentAccountService = require('../services/paymentAccount.service');
const { accountFilter, accountMatch, canUseAccount } = require('../utils/accountScope.util');
const { FEATURES, shopHasFeature } = require('../utils/features.util');
const { MODULES, ROLE_PRESETS, PRESET_VERSION } = require('../config/permissions');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH_A = new mongoose.Types.ObjectId();
const BRANCH_B = new mongoose.Types.ObjectId();

/** A request as the middleware would have built it. */
const reqFor = ({ multiBranch = false, branchId = null } = {}) => ({
  shop: { _id: SHOP, multiBranchEnabled: multiBranch },
  branchId,
});

afterEach(() => jest.restoreAllMocks());

describe('the capability is registered, and off', () => {
  it('is a known feature with a Bengali label', () => {
    expect(FEATURES.fundAccounts).toBeDefined();
    expect(FEATURES.fundAccounts.bn).toBeTruthy();
    // No prerequisites: sales, purchases and expenses exist for every shop from
    // the day it registers, so there is nothing to switch on first.
    expect(FEATURES.fundAccounts.requires).toEqual([]);
  });

  it('fails CLOSED for a shop that has never heard of it', () => {
    // The `undefined.x` and `!== false` traps features.util exists to prevent.
    expect(shopHasFeature({}, 'fundAccounts')).toBe(false);
    expect(shopHasFeature({ features: {} }, 'fundAccounts')).toBe(false);
    expect(shopHasFeature({ features: { fundAccounts: false } }, 'fundAccounts')).toBe(false);
    expect(shopHasFeature({ features: { fundAccounts: true } }, 'fundAccounts')).toBe(true);
  });

  it('resolves no account at all for a shop without the capability', async () => {
    // I-1 by construction: every write path calls this and gets `null`, so none
    // of them needs its own `if (hasFeature)` — and none of them can forget one.
    const find = jest.spyOn(PaymentAccount, 'find');

    const resolved = await paymentAccountService.resolveAccountForMethod(
      { _id: SHOP, features: {} },
      'bkash',
      reqFor()
    );

    expect(resolved).toBeNull();
    // Not merely null — it must not have gone looking. A shop without the
    // capability should cost nothing on the checkout path.
    expect(find).not.toHaveBeenCalled();
  });
});

describe('permissions', () => {
  it('exposes accounts with transfer split out from create', () => {
    expect(MODULES.accounts.actions).toEqual(['view', 'create', 'update', 'transfer']);
  });

  it('has no delete action — an account is closed, never removed', () => {
    // Sales, purchases, expenses and payments point at it; a dangling reference
    // turns settled history unreadable.
    expect(MODULES.accounts.actions).not.toContain('delete');
  });

  it('gives no preset the transfer action', () => {
    // Moving the day's takings out of the drawer is spending authority and
    // stays with the owner until they hand it over deliberately.
    for (const [name, preset] of Object.entries(ROLE_PRESETS)) {
      expect([name, preset.permissions.accounts?.transfer === true]).toEqual([name, false]);
    }
  });

  it('keeps the balances screen off the selling roles', () => {
    // Taking payment into a named account rides on `sales.create` through the
    // names-only /accounts/options surface. This module is the admin screen.
    expect(ROLE_PRESETS.cashier.permissions.accounts?.view === true).toBe(false);
    expect(ROLE_PRESETS.salesperson.permissions.accounts?.view === true).toBe(false);
    expect(ROLE_PRESETS.manager.permissions.accounts.view).toBe(true);
  });

  it('bumped the preset version so existing shops get the manager grant', () => {
    // Presets only reach NEW shops. Without the bump every live manager keeps
    // the Role document they were seeded with and the module does nothing —
    // which is exactly how `sales.discount` reached production doing nothing.
    expect(PRESET_VERSION).toBeGreaterThanOrEqual(8);
  });
});

describe('the branch rule — cash is a counter, a bank is the business', () => {
  it('puts a cash box in the active branch and everything else nowhere', () => {
    expect(String(PaymentAccount.branchFor('cash', BRANCH_A))).toBe(String(BRANCH_A));
    expect(PaymentAccount.branchFor('bank', BRANCH_A)).toBeNull();
    expect(PaymentAccount.branchFor('mfs', BRANCH_A)).toBeNull();
    expect(PaymentAccount.branchFor('card', BRANCH_A)).toBeNull();
  });

  it('collapses to nothing for a single-branch shop (I-1)', () => {
    // `requireBranch` returns null there, so even the cash box is unscoped and
    // the collection behaves as if branches did not exist.
    expect(PaymentAccount.branchFor('cash', null)).toBeNull();
  });
});

describe('accountScope — the $or that branchFilter cannot express', () => {
  it('adds no predicate at all for a single-branch shop (I-1)', () => {
    const filter = accountFilter(reqFor(), { shop: SHOP });
    expect(filter).toEqual({ shop: SHOP });
    expect(filter.$or).toBeUndefined();
  });

  it('adds no predicate for an owner viewing All Branches', () => {
    // No active branch means every account in the shop, which is correct — and
    // it must never throw, exactly like `branchFilter`.
    expect(accountFilter(reqFor({ multiBranch: true }), { shop: SHOP }).$or).toBeUndefined();
  });

  it('keeps SHARED accounts visible from inside a branch', () => {
    // The whole reason this helper exists. A plain `{branch: X}` predicate
    // would hide every bank account and MFS number, silently, with no error —
    // the failure mode I-2 exists to prevent.
    const filter = accountFilter(reqFor({ multiBranch: true, branchId: BRANCH_A }), { shop: SHOP });
    expect(filter.$or).toEqual([{ branch: null }, { branch: BRANCH_A }]);
  });

  it('casts the branch id for aggregations (I-3)', () => {
    // `$match` does not cast. A string id matches zero documents and reports ৳0
    // with no error anywhere.
    const match = accountMatch(reqFor({ multiBranch: true, branchId: String(BRANCH_A) }), { shop: SHOP });
    expect(match.$or[1].branch).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(match.$or[1].branch)).toBe(String(BRANCH_A));
  });

  it('refuses another branch\'s drawer on a WRITE even when it is visible', () => {
    // Visibility is not authority: an owner in All-Branches can SEE every cash
    // box and must still not book a Dhaka sale into the Chittagong drawer.
    const req = reqFor({ multiBranch: true, branchId: BRANCH_A });
    expect(canUseAccount(req, { branch: BRANCH_A })).toBe(true);
    expect(canUseAccount(req, { branch: BRANCH_B })).toBe(false);
    expect(canUseAccount(req, { branch: null })).toBe(true);
  });
});

describe('applyAccountDelta — the only writer of balance', () => {
  it('is a no-op when no account was named', async () => {
    // A shop without the capability names no account on anything. Making this
    // an error would push the same `if` into every caller — and one of them
    // would eventually forget it.
    const updateOne = jest.spyOn(PaymentAccount, 'updateOne');

    expect(await paymentAccountService.applyAccountDelta({ shop: SHOP, account: null, amount: 500 }))
      .toBe(false);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('is a no-op for a zero delta', async () => {
    const updateOne = jest.spyOn(PaymentAccount, 'updateOne');
    await paymentAccountService.applyAccountDelta({ shop: SHOP, account: BRANCH_A, amount: 0 });
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('refuses to write without a shop predicate (I-5)', async () => {
    // Mongoose strips `undefined` from filters rather than refusing them, so a
    // missing shop would make this writable across the entire platform.
    await expect(
      paymentAccountService.applyAccountDelta({ shop: null, account: BRANCH_A, amount: 100 })
    ).rejects.toThrow();
  });

  it('increments by a SIGNED amount and carries the session', async () => {
    const updateOne = jest.spyOn(PaymentAccount, 'updateOne')
      .mockResolvedValue({ modifiedCount: 1 });
    const session = { id: 'txn' };

    await paymentAccountService.applyAccountDelta({
      shop: SHOP, account: BRANCH_A, amount: -750, session,
    });

    const [filter, update, options] = updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: BRANCH_A, shop: SHOP });
    expect(update).toEqual({ $inc: { balance: -750 } });
    // A balance moved outside the transaction that moved the money it describes
    // survives a rollback the money did not.
    expect(options).toEqual({ session });
  });
});

describe('opening balance is owner-only (I-7 field gate)', () => {
  it('refuses a non-owner naming one at creation', async () => {
    await expect(
      paymentAccountService.createAccount(SHOP, BRANCH_A, {
        name: 'ব্যাংক', type: 'bank', method: 'bank', openingBalance: 50000,
      }, reqFor(), false)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('lets a non-owner create an account that names no opening balance', async () => {
    // The gate is on the FIELD, not the route — `accounts.create` is enough to
    // add an account, exactly as `openingDue` works on customers.
    jest.spyOn(PaymentAccount, 'create').mockResolvedValue({ _id: BRANCH_A, name: 'ব্যাংক', save: jest.fn() });
    jest.spyOn(paymentAccountService, '_ensureSingleDefault').mockResolvedValue(undefined);
    const AuditLog = require('../models/AuditLog.model');
    jest.spyOn(AuditLog, 'create').mockResolvedValue({});

    await expect(
      paymentAccountService.createAccount(SHOP, BRANCH_A, {
        name: 'ব্যাংক', type: 'bank', method: 'bank',
      }, reqFor(), false)
    ).resolves.toBeDefined();
  });

  it('treats 0 as a real answer, not as absent', async () => {
    // Same rule as `packSellingPrice` and `wholesalePrice`: a cleared money box
    // posts 0, and 0 must not silently fall back to something else.
    expect(paymentAccountService._resolveOpeningBalance(0, true)).toBe(0);
    expect(paymentAccountService._resolveOpeningBalance(null, false)).toBe(0);
    expect(paymentAccountService._resolveOpeningBalance('', false)).toBe(0);
  });

  it('allows a NEGATIVE opening balance', async () => {
    // An overdrawn current account is real. Clamping at zero would misstate the
    // shop's position in the one direction that matters.
    expect(paymentAccountService._resolveOpeningBalance(-12000, true)).toBe(-12000);
  });
});
