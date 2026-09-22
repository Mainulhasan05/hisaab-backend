/**
 * Voiding a fund transfer — the owner's way to correct a typo.
 *
 * A transfer moved two balances, so a void has to move both back, exactly, in
 * the same transaction — and every reader that sums transfers has to stop
 * counting the voided row, or the reversal is counted twice.
 *
 * REGRESSIONS: the reversal arithmetic, the refusals, the reader guard.
 * INVARIANT GUARD: a transfer that never touched a drawer is never blocked by one.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const AccountTransfer = require('../models/AccountTransfer.model');
const CashRegister = require('../models/CashRegister.model');
const AuditLog = require('../models/AuditLog.model');
const paymentAccountService = require('../services/paymentAccount.service');

jest.mock('../utils/transaction.util', () => ({
  runInTransaction: (fn) => fn(null),
}));

const SHOP = new mongoose.Types.ObjectId();
const OWNER = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();
const CASH = { _id: new mongoose.Types.ObjectId(), name: 'ক্যাশ বাক্স', type: 'cash', branch: null };
const BANK = { _id: new mongoose.Types.ObjectId(), name: 'ব্যাংক', type: 'bank', branch: null };
const BKASH = { _id: new mongoose.Types.ObjectId(), name: 'বিকাশ', type: 'mfs', branch: null };

const reqFor = ({ multiBranch = false, branchId = null } = {}) => ({
  shop: { _id: SHOP, multiBranchEnabled: multiBranch, features: { fundAccounts: true } },
  branchId,
});

function stubFind(doc) {
  const findOne = jest.fn(() => {
    const chain = { populate: () => chain, then: (res, rej) => Promise.resolve(doc).then(res, rej) };
    return chain;
  });
  jest.spyOn(AccountTransfer, 'findOne').mockImplementation(findOne);
  return findOne;
}

function transferDoc(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    transferNo: 'TFR-000007',
    branch: null,
    fromAccount: CASH,
    toAccount: BANK,
    amountOut: 60000,
    amountIn: 60000,
    date: new Date('2026-09-20T06:00:00Z'),
    status: 'active',
    save: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function stubRegister(status) {
  return jest.spyOn(CashRegister, 'findOne').mockReturnValue({
    lean: () => Promise.resolve(status ? { status } : null),
  });
}

let delta;
beforeEach(() => {
  delta = jest.spyOn(paymentAccountService, 'applyAccountDelta').mockResolvedValue(true);
  jest.spyOn(AuditLog, 'create').mockResolvedValue([{}]);
});
afterEach(() => jest.restoreAllMocks());

describe('cancelTransfer — the reversal', () => {
  it('moves both legs back with the opposite sign, charge included', async () => {
    // bKash cash-out ৳50,925 → ৳50,000 in the drawer, typed against the wrong day.
    const doc = transferDoc({ fromAccount: BKASH, toAccount: CASH, amountOut: 50925, amountIn: 50000 });
    stubFind(doc);
    stubRegister('open');

    await paymentAccountService.cancelTransfer(SHOP, OWNER, doc._id, 'ভুল তারিখ', reqFor());

    expect(delta).toHaveBeenCalledWith(expect.objectContaining({ account: BKASH._id, amount: 50925 }));
    expect(delta).toHaveBeenCalledWith(expect.objectContaining({ account: CASH._id, amount: -50000 }));
    expect(delta).toHaveBeenCalledTimes(2);
  });

  it('marks the row cancelled with who, when and why — it is never deleted', async () => {
    const doc = transferDoc();
    stubFind(doc);
    stubRegister(null);
    const del = jest.spyOn(AccountTransfer, 'deleteOne');

    await paymentAccountService.cancelTransfer(SHOP, OWNER, doc._id, '  টাইপো  ', reqFor());

    expect(doc.status).toBe('cancelled');
    expect(doc.cancelledBy).toBe(OWNER);
    expect(doc.cancelReason).toBe('টাইপো');
    expect(doc.cancelledAt).toBeInstanceOf(Date);
    expect(doc.save).toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(AuditLog.create.mock.calls[0][0][0]).toMatchObject({
      action: 'account_transfer_cancel',
      entity: { type: 'account_transfer', id: doc._id },
    });
  });

  it('scopes the lookup by shop and by the active branch', async () => {
    const find = stubFind(transferDoc({ branch: BRANCH }));
    stubRegister(null);

    await paymentAccountService.cancelTransfer(
      SHOP, OWNER, 'x', 'টাইপো', reqFor({ multiBranch: true, branchId: BRANCH })
    );

    expect(find.mock.calls[0][0]).toMatchObject({ shop: SHOP, branch: BRANCH });
  });
});

describe('cancelTransfer — refusals', () => {
  it('requires a reason', async () => {
    stubFind(transferDoc());
    await expect(
      paymentAccountService.cancelTransfer(SHOP, OWNER, 'x', '   ', reqFor())
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(delta).not.toHaveBeenCalled();
  });

  it('404s on a transfer outside the caller’s shop or branch', async () => {
    stubFind(null);
    await expect(
      paymentAccountService.cancelTransfer(SHOP, OWNER, 'x', 'টাইপো', reqFor())
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses a second cancel instead of reversing the money twice', async () => {
    stubFind(transferDoc({ status: 'cancelled' }));
    await expect(
      paymentAccountService.cancelTransfer(SHOP, OWNER, 'x', 'টাইপো', reqFor())
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(delta).not.toHaveBeenCalled();
  });

  it('refuses when a cash end sits in a CLOSED register — the drawer was counted', async () => {
    const doc = transferDoc();
    stubFind(doc);
    stubRegister('closed');
    await expect(
      paymentAccountService.cancelTransfer(SHOP, OWNER, doc._id, 'টাইপো', reqFor())
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(doc.save).not.toHaveBeenCalled();
    expect(delta).not.toHaveBeenCalled();
  });

  it('INVARIANT: bank ↔ bKash never consults a register, closed or not', async () => {
    const doc = transferDoc({ fromAccount: BANK, toAccount: BKASH });
    stubFind(doc);
    const reg = stubRegister('closed');

    await paymentAccountService.cancelTransfer(SHOP, OWNER, doc._id, 'টাইপো', reqFor());

    expect(reg).not.toHaveBeenCalled();
    expect(delta).toHaveBeenCalledTimes(2);
  });
});

describe('every reader that sums transfers skips cancelled rows', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it.each([
    ['services/cashRegister.service.js', 2],
    ['services/paymentAccount.service.js', 2],
    ['services/report.service.js', 1],
  ])('%s', (file, n) => {
    const src = read(file);
    const aggregates = (src.match(/AccountTransfer\.aggregate\(/g) || []).length;
    const guarded = (src.match(/\.\.\.LIVE_TRANSFER/g) || []).length;
    expect(aggregates).toBe(n);
    expect(guarded).toBeGreaterThanOrEqual(aggregates);
  });

  it('the balance checker replays only live transfers', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../scripts/recalc-account-balances.js'), 'utf8');
    const lines = src.split('\n').filter((l) => /(fromAccount|toAccount): accountId/.test(l));
    expect(lines).toHaveLength(2);
    lines.forEach((l) => expect(l).toMatch(/\.\.\.LIVE\b/));
  });

  it('LIVE_TRANSFER keeps pre-void rows, which carry no status at all', () => {
    expect(AccountTransfer.LIVE_TRANSFER).toEqual({ status: { $ne: 'cancelled' } });
  });

  it('the void route is owner-only', () => {
    const src = read('routes/paymentAccount.routes.js');
    expect(src).toMatch(/'\/transfers\/:id\/cancel',\s*\n\s*ownerOnly,/);
  });
});
