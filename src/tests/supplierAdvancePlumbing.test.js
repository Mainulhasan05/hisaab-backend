/**
 * Phase D — the surfaces a supplier advance passes through, wired before the
 * doors that will use them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY BEFORE THE DOORS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nothing can write a `supplier_advance` row yet, so every change this suite
 * pins is provably a no-op today. That is exactly the argument for shipping it
 * first: each of these surfaces is silently wrong the moment the first advance
 * exists, and none of them raises an error when it is — the till just reads
 * over, or a rebuild quietly destroys the movement it was meant to verify.
 *
 * The customer side learned this the expensive way (ADVANCE_PAYMENT_PLAN M2/M6,
 * shipped a phase before its doors for the same reason).
 *
 * Against the SOURCE where the surface needs a database to reach, and against
 * behaviour where it does not.
 */

const fs = require('fs');
const mongoose = require('mongoose');
const supplierService = require('../services/supplier.service');
const Supplier = require('../models/Supplier.model');
const AuditLog = require('../models/AuditLog.model');

const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8');

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const SUPPLIER = new mongoose.Types.ObjectId();

/* ── P2 · THE CASH DRAWER ─────────────────────────────────────────────────── */

describe('an advance is cash OUT of the drawer', () => {
  const source = read('../services/cashRegister.service');

  it('rides the supplier money-out bucket', () => {
    // Not a new bucket: economically it is a purchase paid before the goods
    // arrive, and `cashOut.purchases` is where that belongs. A seventh bucket
    // would mean a `CashRegister` schema change and a migration of every closed
    // day, for a figure the model already reaches (the same call the কেনা ফেরত
    // netting made).
    const bucket = source.slice(source.indexOf('cashSupplierPayments'));
    expect(bucket).toContain("$in: ['purchase_payment', 'supplier_advance']");
  });

  it('is money OUT, never money IN — the customer advance is the other one', () => {
    // `advance` (customer deposit) belongs in cash IN; `supplier_advance`
    // belongs in cash OUT. Swapping them would make every taka paid out read as
    // a taka taken in, which is why they are separate types at all.
    const cashIn = source.slice(source.indexOf('cashCollections'), source.indexOf('cashSupplierPayments'));
    expect(cashIn).not.toContain('supplier_advance');
  });
});

/* ── P3 · THE ACCOUNT REBUILD ─────────────────────────────────────────────── */

describe('an advance is replayed by the account reconciler', () => {
  it('counts it among the money leaving an account', () => {
    // A rebuild that omitted it would DESTROY the movement from the account it
    // left — and this script exists to be a second opinion, so one missing a
    // payment type is worse than none.
    const source = read('../../scripts/recalc-account-balances.js');
    const out = source.slice(source.indexOf('const supplierPayments'));
    expect(out.slice(0, 900)).toContain("$in: ['purchase_payment', 'supplier_advance']");
  });
});

/* ── P5 · THE PAYABLES AGEING ─────────────────────────────────────────────── */

describe('an advance never appears as aged debt', () => {
  it('stays structural: the report derives from documents, not from the rollup', () => {
    // Ageing is built from `Purchase.due` and the adjustment rows. A prepayment
    // lives on neither, so it cannot show as aged debt and cannot net against
    // another vendor's payable (R1). The safety holds only while this stays
    // true — reading `Supplier.totalDue` here would break both properties at
    // once.
    const aging = read('../services/supplier.service');
    const body = aging.slice(aging.indexOf('async getPayableAging'), aging.indexOf('async getPayableAging') + 4000);
    expect(body).toContain('Purchase.aggregate');
    expect(body).toContain('SupplierDueAdjustment.aggregate');
    expect(body).not.toContain('Supplier.find');
    expect(body).not.toContain('advanceBalance');
  });
});

/* ── P6 · THE DELETE GUARD ────────────────────────────────────────────────── */

describe('a supplier with an open position cannot be deleted away', () => {
  const stub = (over) => {
    const doc = {
      _id: SUPPLIER, name: 'করিম ট্রেডার্স', isActive: true,
      totalDue: 0, advanceBalance: 0, ...over,
      save: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(Supplier, 'findOne').mockResolvedValue(doc);
    return doc;
  };

  beforeEach(() => {
    jest.spyOn(AuditLog, 'create').mockResolvedValue([{}]);
  });
  afterEach(() => jest.restoreAllMocks());

  it('warns before deleting one the shop still owes, naming the figure', async () => {
    // `_applyOpeningDue` already refuses to ADD debt to a deleted supplier,
    // because every read filters `isActive` and the shop ends up owing money no
    // screen will show. Deleting a supplier already owed does the same damage
    // from the other side, and nothing stopped it until now.
    //
    // The refusal carries the AMOUNT, because that is the point: a warning that
    // does not say what is at stake is a speed bump.
    const doc = stub({ totalDue: 200000 });

    await expect(supplierService.deleteSupplier(SHOP, USER, SUPPLIER))
      .rejects.toMatchObject({ statusCode: 400, messageBn: expect.stringContaining('200000') });

    expect(doc.isActive).toBe(true);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('goes ahead once the owner has acknowledged that figure', async () => {
    // Warn, do not block — the posture the customer-side fat-finger threshold
    // settled on. A shop closing an account it settled off the books has a real
    // reason to remove a row that still shows a payable, and the software
    // cannot know it is wrong.
    const doc = stub({ totalDue: 200000 });

    await expect(
      supplierService.deleteSupplier(SHOP, USER, SUPPLIER, { acknowledgeDue: true })
    ).resolves.toEqual({ success: true });

    expect(doc.isActive).toBe(false);
  });

  it('records what was owed at the moment it was removed', async () => {
    // Otherwise the only trace of a deleted-with-debt supplier is a row nothing
    // will show.
    stub({ totalDue: 200000 });

    await supplierService.deleteSupplier(SHOP, USER, SUPPLIER, { acknowledgeDue: true });

    const entry = AuditLog.create.mock.calls[0][0];
    expect(entry.changes.before.totalDue).toBe(200000);
    expect(entry.description).toContain('200000');
  });

  it('BLOCKS one holding our money — acknowledging does not help', async () => {
    // Inert today. It blocks rather than warns because a payable deleted away
    // is money someone else will come and ask for, while a PREPAYMENT deleted
    // away is the shop's own claim on a vendor holding its cash — and with no
    // refund door (E's D4) and no supplier restore endpoint, acknowledging it
    // would not make it recoverable, only deliberate.
    const doc = stub({ advanceBalance: 50000 });

    await expect(
      supplierService.deleteSupplier(SHOP, USER, SUPPLIER, { acknowledgeDue: true })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(doc.isActive).toBe(true);
  });


  it('still deletes a supplier who is square', async () => {
    // The ordinary case must be untouched: this is a tidy-up action and most
    // suppliers owe nothing.
    const doc = stub({});

    await expect(supplierService.deleteSupplier(SHOP, USER, SUPPLIER))
      .resolves.toEqual({ success: true });

    expect(doc.isActive).toBe(false);
    expect(doc.save).toHaveBeenCalled();
  });

  it('reads a missing figure as zero rather than refusing', async () => {
    // `advanceBalance` is absent on every supplier written before Phase C, and
    // `undefined > 0` is false — but relying on that silently is how a guard
    // ends up depending on a schema default. Asserted.
    const doc = stub({ totalDue: undefined, advanceBalance: undefined });

    await expect(supplierService.deleteSupplier(SHOP, USER, SUPPLIER))
      .resolves.toEqual({ success: true });

    expect(doc.isActive).toBe(false);
  });
});
