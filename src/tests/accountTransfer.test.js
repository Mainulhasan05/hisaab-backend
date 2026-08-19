/**
 * Transfers — money changing places, and the drawer that has to know about it.
 *
 * ── The bug these close ─────────────────────────────────────────────────────
 *
 * Banking the day's takings was unrecordable. A shopkeeper with ৳80,000 in the
 * box who deposited ৳60,000 had two options and both were wrong:
 *
 *   · record it as an EXPENSE — the P&L then says the shop spent ৳60,000 it did
 *     not spend, and the month's profit is wrong by that much;
 *   · record nothing — the cash register insists ৳80,000 should be in a box
 *     holding ৳20,000, every evening, and it reads as theft.
 *
 * A transfer is neither. Nothing was earned, nothing was spent, the same money
 * is somewhere else. Only the CHARGE touches profit.
 *
 * REGRESSIONS on the cash register (the shortfall was real and reproducible);
 * INVARIANT GUARDS on everything else.
 */
const mongoose = require('mongoose');
const fs = require('fs');
const AccountTransfer = require('../models/AccountTransfer.model');
const PaymentAccount = require('../models/PaymentAccount.model');
const CashRegister = require('../models/CashRegister.model');
const paymentAccountService = require('../services/paymentAccount.service');
const { MODULES, ROLE_PRESETS } = require('../config/permissions');

/**
 * Run the callback inline instead of opening a real session.
 *
 * `runInTransaction` degrades gracefully when Mongo is absent — it logs and
 * executes directly — but only after a 10s connection timeout, which is longer
 * than Jest's own. Mocking it keeps these tests about the transfer logic rather
 * than about the driver.
 */
jest.mock('../utils/transaction.util', () => ({
  runInTransaction: (fn) => fn(null),
}));

const SHOP = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();
const CASH = new mongoose.Types.ObjectId();
const BANK = new mongoose.Types.ObjectId();

const reqFor = ({ multiBranch = false, branchId = null } = {}) => ({
  shop: { _id: SHOP, multiBranchEnabled: multiBranch, features: { fundAccounts: true } },
  branchId,
});

/** Both ends resolve, and the transaction helper runs the callback inline. */
function stubTransfer() {
  jest.spyOn(paymentAccountService, 'assertUsableAccount').mockImplementation(
    async (shopId, id) => ({ _id: id, name: String(id) === String(CASH) ? 'ক্যাশ বাক্স' : 'ব্যাংক', branch: null })
  );
  const delta = jest.fn().mockResolvedValue(true);
  jest.spyOn(paymentAccountService, 'applyAccountDelta').mockImplementation(delta);
  jest.spyOn(AccountTransfer, 'create').mockImplementation(async (docs) => [
    { ...docs[0], _id: new mongoose.Types.ObjectId(), transferNo: 'TFR-000001' },
  ]);
  jest.spyOn(require('../models/AuditLog.model'), 'create').mockResolvedValue({});
  return delta;
}

afterEach(() => jest.restoreAllMocks());

describe('the charge is derived, never stored', () => {
  it('is the gap between what left and what arrived', () => {
    // bKash cash-out: ৳50,925 leaves the wallet, ৳50,000 reaches the drawer.
    const t = new AccountTransfer({
      shop: SHOP, transferNo: 'TFR-000001', fromAccount: CASH, toAccount: BANK,
      amountOut: 50925, amountIn: 50000, createdBy: SHOP,
    });
    expect(t.charge).toBe(925);
  });

  it('is zero when nothing was deducted', () => {
    // Banking cash costs nothing, and this is the common case.
    const t = new AccountTransfer({
      shop: SHOP, transferNo: 'TFR-000002', fromAccount: CASH, toAccount: BANK,
      amountOut: 60000, amountIn: 60000, createdBy: SHOP,
    });
    expect(t.charge).toBe(0);
  });

  it('is not a stored field', () => {
    // `amountOut - amountIn` is the only definition that cannot drift from the
    // figures it is computed from — the same rule the grand balance follows.
    expect(AccountTransfer.schema.path('charge')).toBeUndefined();
  });
});

describe('createTransfer', () => {
  it('debits what left and credits what arrived — not the same figure twice', async () => {
    const delta = stubTransfer();

    await paymentAccountService.createTransfer(SHOP, SHOP, {
      fromAccount: CASH, toAccount: BANK, amountOut: 50925, amountIn: 50000,
    }, reqFor());

    const amounts = delta.mock.calls.map((c) => c[0].amount);
    // Reading one figure for both legs would lose the ৳925 and leave every
    // cash-out permanently adrift by the fee.
    expect(amounts).toEqual([-50925, 50000]);
  });

  it('defaults amountIn to amountOut, so the no-charge case is one number', async () => {
    const delta = stubTransfer();

    await paymentAccountService.createTransfer(SHOP, SHOP, {
      fromAccount: CASH, toAccount: BANK, amountOut: 60000,
    }, reqFor());

    expect(delta.mock.calls.map((c) => c[0].amount)).toEqual([-60000, 60000]);
  });

  it('refuses more arriving than left', async () => {
    stubTransfer();
    // Not a charge — a typo. Accepting it would mint money into the balances.
    await expect(
      paymentAccountService.createTransfer(SHOP, SHOP, {
        fromAccount: CASH, toAccount: BANK, amountOut: 1000, amountIn: 1200,
      }, reqFor())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses a transfer to the same account', async () => {
    stubTransfer();
    await expect(
      paymentAccountService.createTransfer(SHOP, SHOP, {
        fromAccount: CASH, toAccount: CASH, amountOut: 1000,
      }, reqFor())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('validates BOTH ends against the caller, not just their visibility', async () => {
    const assertUsable = jest.spyOn(paymentAccountService, 'assertUsableAccount')
      .mockResolvedValue({ _id: CASH, name: 'x' });
    jest.spyOn(paymentAccountService, 'applyAccountDelta').mockResolvedValue(true);
    jest.spyOn(AccountTransfer, 'create').mockResolvedValue([{ _id: CASH, transferNo: 'T' }]);
    jest.spyOn(require('../models/AuditLog.model'), 'create').mockResolvedValue({});

    await paymentAccountService.createTransfer(SHOP, SHOP, {
      fromAccount: CASH, toAccount: BANK, amountOut: 100,
    }, reqFor({ multiBranch: true, branchId: BRANCH }));

    // An owner in All-Branches can SEE every branch's drawer and must still not
    // be able to move money out of one that is not theirs.
    expect(assertUsable).toHaveBeenCalledTimes(2);
  });

  it('moves both balances inside the transaction', () => {
    // A balance moved outside the transaction that created the transfer
    // survives a rollback the transfer did not — leaving the books permanently
    // richer or poorer with no document to explain it.
    const source = fs.readFileSync(
      require.resolve('../services/paymentAccount.service.js'), 'utf8'
    );
    const body = source.slice(source.indexOf('async createTransfer('));
    expect(body).toContain('runInTransaction');
    expect(body).toMatch(/applyAccountDelta\(\{[\s\S]{0,120}session,/);
  });
});

describe('the cash register learns about transfers (UC-1)', () => {
  it('carries both buckets on the schema', () => {
    expect(CashRegister.schema.path('cashIn.transfers')).toBeDefined();
    expect(CashRegister.schema.path('cashOut.transfers')).toBeDefined();
  });

  it('counts them in expectedClosing — the whole point', () => {
    // ৳80,000 taken, ৳60,000 banked. Before this the till expected ৳80,000 in a
    // box holding ৳20,000 and reported a theft-sized shortfall every evening.
    const register = new CashRegister({
      shop: SHOP, date: new Date(), createdBy: SHOP,
      openingBalance: 0,
      cashIn: { sales: 80000 },
      cashOut: { transfers: 60000 },
    });
    // The pre-save hook owns this arithmetic. `execPre` is how mongoose itself
    // runs it, so the test exercises the real code rather than a copy of it.
    return new Promise((resolve) => {
      CashRegister.schema.s.hooks.execPre('save', register, () => {
        expect(register.expectedClosing).toBe(20000);
        // The virtuals must agree with it, or the screen and the stored figure
        // would tell the shopkeeper two different things.
        expect(register.totalCashOut).toBe(60000);
        resolve();
      });
    });
  });

  it('counts money that came INTO the drawer from a bank', () => {
    // UC-10: the bank has money, the box is empty, wages are due tomorrow.
    const register = new CashRegister({
      shop: SHOP, date: new Date(), createdBy: SHOP,
      openingBalance: 5000,
      cashIn: { transfers: 40000 },
    });
    return new Promise((resolve) => {
      CashRegister.schema.s.hooks.execPre('save', register, () => {
        expect(register.expectedClosing).toBe(45000);
        expect(register.totalCashIn).toBe(40000);
        resolve();
      });
    });
  });

  it('is zero for a shop with no fund accounts (I-1)', () => {
    // The default. A register that has never seen a transfer reads exactly as
    // it always has.
    const register = new CashRegister({
      shop: SHOP, date: new Date(), createdBy: SHOP,
      openingBalance: 1000, cashIn: { sales: 500 },
    });
    expect(register.cashIn.transfers).toBe(0);
    expect(register.cashOut.transfers).toBe(0);
  });

  it('skips the transfer queries entirely when the shop holds no cash accounts', () => {
    // Not merely returning zero — not asking. A shop without the capability
    // must not pay for it on the till's hot path.
    const source = fs.readFileSync(
      require.resolve('../services/cashRegister.service.js'), 'utf8'
    );
    expect(source).toContain('cashAccountIds.length === 0 ? Promise.resolve([])');
  });
});

describe('permissions', () => {
  it('keeps transfer out of every role preset', () => {
    // Moving the day's takings is spending authority. It stays with the owner
    // until they hand it over deliberately.
    for (const [name, preset] of Object.entries(ROLE_PRESETS)) {
      expect([name, preset.permissions.accounts?.transfer === true]).toEqual([name, false]);
    }
    expect(MODULES.accounts.actions).toContain('transfer');
  });
});

describe('transferNo', () => {
  it('is unique per SHOP, never globally', () => {
    // A plain global unique made two different shops collide on their first
    // transfer — the exact bug `migrate-stockTransfer-index.js` exists to undo.
    const idx = AccountTransfer.schema.indexes()
      .find(([keys]) => keys.shop === 1 && keys.transferNo === 1);
    expect(idx).toBeDefined();
    expect(idx[1].unique).toBe(true);

    const global = AccountTransfer.schema.indexes()
      .find(([keys]) => Object.keys(keys).length === 1 && keys.transferNo);
    expect(global).toBeUndefined();
  });
});
