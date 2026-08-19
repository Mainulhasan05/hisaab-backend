/**
 * Money that is not trade — and the reconciliation that finds what is missing.
 *
 * ── The rule these exist to protect ─────────────────────────────────────────
 *
 * An owner drawing ৳30,000 for household costs has NOT made the shop ৳30,000
 * less profitable. They have taken money out of it. Shops record it as an
 * expense because there is nowhere else to put it, and every margin figure the
 * owner then reads is understated by the amount of their own housekeeping.
 *
 * So: these entries move a balance and must never reach the P&L. The first test
 * group is what stops a future change quietly wiring them into it.
 *
 * INVARIANT GUARDS throughout — there is no prior behaviour to regress against,
 * because until now there was no way to record any of this at all.
 */
const mongoose = require('mongoose');
const fs = require('fs');
const AccountEntry = require('../models/AccountEntry.model');
const AccountReconciliation = require('../models/AccountReconciliation.model');
const PaymentAccount = require('../models/PaymentAccount.model');
const paymentAccountService = require('../services/paymentAccount.service');

jest.mock('../utils/transaction.util', () => ({
  runInTransaction: (fn) => fn(null),
}));

const SHOP = new mongoose.Types.ObjectId();
const ACCOUNT = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();

const reqFor = () => ({
  shop: { _id: SHOP, multiBranchEnabled: false, features: { fundAccounts: true } },
  branchId: null,
});

function stubEntry() {
  jest.spyOn(paymentAccountService, 'assertUsableAccount')
    .mockResolvedValue({ _id: ACCOUNT, name: 'ক্যাশ বাক্স', balance: 50000 });
  const delta = jest.fn().mockResolvedValue(true);
  jest.spyOn(paymentAccountService, 'applyAccountDelta').mockImplementation(delta);
  jest.spyOn(AccountEntry, 'create').mockImplementation(async (docs) => [
    { ...docs[0], _id: new mongoose.Types.ObjectId() },
  ]);
  jest.spyOn(require('../models/AuditLog.model'), 'create').mockResolvedValue({});
  return delta;
}

afterEach(() => jest.restoreAllMocks());

describe('these entries never reach profit', () => {
  it('is a collection of its own, not an expense category', () => {
    // A category would put the money in the P&L, which is the bug. The separate
    // collection IS the fix.
    expect(AccountEntry.modelName).toBe('AccountEntry');
    expect(AccountEntry.schema.path('amount')).toBeDefined();
  });

  it('is not read by the profit & loss report', () => {
    // The P&L reads sales, expenses, purchases, returns and — since Phase 3 —
    // transfer charges. It must never read this one: an owner's withdrawal is
    // not a cost of trading.
    const source = fs.readFileSync(
      require.resolve('../services/report.service.js'), 'utf8'
    );
    expect(source).not.toContain('AccountEntry');
    // The charge line IS read, and deliberately — a bKash fee is a real cost.
    expect(source).toContain('AccountTransfer');
  });
});

describe('direction is derived, not guessed', () => {
  it('knows which way each real-world type moves money', () => {
    expect(AccountEntry.directionFor('owner_deposit')).toBe('in');
    expect(AccountEntry.directionFor('loan_in')).toBe('in');
    expect(AccountEntry.directionFor('owner_withdrawal')).toBe('out');
    expect(AccountEntry.directionFor('loan_out')).toBe('out');
  });

  it('refuses to guess for an adjustment', () => {
    // A correction can go either way, and guessing would silently double the
    // error it was meant to fix.
    expect(AccountEntry.directionFor('adjustment')).toBeNull();
  });

  it('applies a NEGATIVE delta for a withdrawal', async () => {
    const delta = stubEntry();

    await paymentAccountService.createEntry(SHOP, USER, {
      account: ACCOUNT, type: 'owner_withdrawal', amount: 30000,
    }, reqFor(), true);

    expect(delta.mock.calls[0][0].amount).toBe(-30000);
  });

  it('applies a POSITIVE delta for a deposit', async () => {
    const delta = stubEntry();

    await paymentAccountService.createEntry(SHOP, USER, {
      account: ACCOUNT, type: 'owner_deposit', amount: 100000,
    }, reqFor(), true);

    expect(delta.mock.calls[0][0].amount).toBe(100000);
  });

  it('does not need the owner for an ordinary withdrawal', async () => {
    // Recording that the owner took money out is bookkeeping about something
    // that already happened. It is `adjustment` that is dangerous.
    stubEntry();
    await expect(
      paymentAccountService.createEntry(SHOP, USER, {
        account: ACCOUNT, type: 'owner_withdrawal', amount: 500,
      }, reqFor(), false)
    ).resolves.toBeDefined();
  });
});

describe('adjustment is the one that is gated', () => {
  it('is owner-only', async () => {
    stubEntry();
    // It is the only entry that can move a balance with no real-world event
    // behind it — so it is the only one a staff member could use to paper over
    // a till discrepancy.
    await expect(
      paymentAccountService.createEntry(SHOP, USER, {
        account: ACCOUNT, type: 'adjustment', direction: 'out', amount: 4200, notes: 'x',
      }, reqFor(), false)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('requires a reason', async () => {
    stubEntry();
    // A correction with no reason is a number nobody can account for six months
    // later, which is what this collection exists to prevent.
    await expect(
      paymentAccountService.createEntry(SHOP, USER, {
        account: ACCOUNT, type: 'adjustment', direction: 'out', amount: 4200,
      }, reqFor(), true)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('requires an explicit direction', async () => {
    stubEntry();
    await expect(
      paymentAccountService.createEntry(SHOP, USER, {
        account: ACCOUNT, type: 'adjustment', amount: 4200, notes: 'কারণ',
      }, reqFor(), true)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('goes through when the owner supplies both', async () => {
    const delta = stubEntry();
    await paymentAccountService.createEntry(SHOP, USER, {
      account: ACCOUNT, type: 'adjustment', direction: 'out', amount: 4200,
      notes: 'ব্যাংক স্টেটমেন্টের সাথে মিলিয়ে',
    }, reqFor(), true);

    expect(delta.mock.calls[0][0].amount).toBe(-4200);
  });
});

describe('reconciliation records the gap, it does not close it', () => {
  it('computes the difference from the two sides', () => {
    const r = new AccountReconciliation({
      shop: SHOP, account: ACCOUNT, createdBy: USER,
      systemBalance: 600000, statementBalance: 604200,
    });
    const hook = AccountReconciliation.schema.s.hooks;
    return new Promise((resolve) => {
      hook.execPre('save', r, () => {
        // Positive: the real world holds MORE than the app knows about.
        expect(r.difference).toBe(4200);
        resolve();
      });
    });
  });

  it('reads systemBalance from the account, never from the caller', async () => {
    // A figure the caller supplies is a figure the caller can make agree — which
    // would turn the one record that exists to catch a discrepancy into one that
    // never finds any.
    jest.spyOn(paymentAccountService, 'assertUsableAccount')
      .mockResolvedValue({ _id: ACCOUNT, name: 'ব্যাংক', balance: 600000 });
    const create = jest.spyOn(AccountReconciliation, 'create')
      .mockImplementation(async (docs) => [docs[0]]);

    await paymentAccountService.reconcileAccount(SHOP, USER, {
      account: ACCOUNT,
      statementBalance: 604200,
      // A malicious or mistaken client naming its own figure must be ignored.
      systemBalance: 604200,
    }, reqFor());

    expect(create.mock.calls[0][0][0].systemBalance).toBe(600000);
  });

  it('moves no balance', async () => {
    jest.spyOn(paymentAccountService, 'assertUsableAccount')
      .mockResolvedValue({ _id: ACCOUNT, name: 'ব্যাংক', balance: 600000 });
    jest.spyOn(AccountReconciliation, 'create').mockImplementation(async (docs) => [docs[0]]);
    const delta = jest.spyOn(paymentAccountService, 'applyAccountDelta');

    await paymentAccountService.reconcileAccount(SHOP, USER, {
      account: ACCOUNT, statementBalance: 604200,
    }, reqFor());

    // A gap is evidence. Overwriting one side with the other destroys the only
    // record of which side was wrong — the owner writes an `adjustment` instead.
    expect(delta).not.toHaveBeenCalled();
  });
});

describe('the money position — Q-1, what a branch view shows', () => {
  it('flags shared accounts rather than hiding or splitting them', async () => {
    jest.spyOn(PaymentAccount, 'find').mockReturnValue({
      sort: () => ({
        lean: () => Promise.resolve([
          { _id: ACCOUNT, name: 'ক্যাশ বাক্স', type: 'cash', balance: 20000 },
          { _id: new mongoose.Types.ObjectId(), name: 'ব্যাংক', type: 'bank', balance: 600000 },
        ]),
      }),
    });
    jest.spyOn(require('../models/AccountTransfer.model'), 'aggregate').mockResolvedValue([]);
    jest.spyOn(AccountEntry, 'aggregate').mockResolvedValue([]);

    const result = await paymentAccountService.getMoneyPosition(SHOP, reqFor());

    // Splitting a shared balance across branches by some ratio would invent a
    // number; hiding it would make the total read far too low. Naming it is the
    // only version that is true.
    expect(result.accounts.map((a) => a.isShared)).toEqual([false, true]);
    // Derived, never stored (D-1).
    expect(result.totalBalance).toBe(620000);
  });

  it('returns an empty position for a shop with no accounts', async () => {
    jest.spyOn(PaymentAccount, 'find').mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve([]) }),
    });

    const result = await paymentAccountService.getMoneyPosition(SHOP, reqFor());

    expect(result.accounts).toEqual([]);
    expect(result.totalBalance).toBe(0);
  });
});
