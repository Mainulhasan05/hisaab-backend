/**
 * Permanent invoice deletion (owner-only) and invoice-number correction
 * (features.customInvoiceNo).
 *
 * Models are mocked, so these pin the DECISIONS — who may, what is refused,
 * what is written and in which order. The arithmetic of the reversal itself is
 * `cancelSale`'s and is covered by its own suites; `deleteSale` must call it,
 * not re-implement it.
 */
jest.mock('../utils/transaction.util', () => ({
  runInTransaction: (cb) => cb(null),
}));

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Sale = require('../models/Sale.model');
const Payment = require('../models/Payment.model');
const SalesReturn = require('../models/SalesReturn.model');
const SMSLog = require('../models/SMSLog.model');
const StockTransaction = require('../models/StockTransaction.model');
const CashRegister = require('../models/CashRegister.model');
const DeletedSale = require('../models/DeletedSale.model');
const AuditLog = require('../models/AuditLog.model');
const User = require('../models/User.model');
const saleService = require('../services/sale.service');

const SHOP = new mongoose.Types.ObjectId();
const OWNER = new mongoose.Types.ObjectId();

const ownerReq = (features = {}) => ({
  user: { _id: OWNER, isOwner: true, name: 'মালিক' },
  shop: { _id: SHOP, features },
  branchId: null,
});
const staffReq = (features = {}) => ({
  user: { _id: new mongoose.Types.ObjectId(), isOwner: false, name: 'ক্যাশিয়ার' },
  shop: { _id: SHOP, features },
  branchId: null,
});

const saleDoc = (over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  shop: SHOP,
  branch: null,
  invoiceNo: 'A-1034',
  status: 'completed',
  returnedAmount: 0,
  total: 500,
  paid: 500,
  due: 0,
  dueSettled: 0,
  createdAt: new Date(),
  items: [{ productName: 'চাল', quantity: 2, unitPrice: 250, total: 500 }],
  ...over,
});

afterEach(() => jest.restoreAllMocks());

/* ═══════════════════════════════════════════════════════════════════════════
 * DELETE
 * ═════════════════════════════════════════════════════════════════════════ */
describe('deleteSale', () => {
  /** Wire every collaborator for a delete that is allowed to succeed. */
  const arm = ({ sale = saleDoc(), passwordOk = true, register = null, hasReturn = null, laterPayment = null } = {}) => {
    const findOne = jest.spyOn(Sale, 'findOne')
      .mockReturnValueOnce(Promise.resolve(sale))
      .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue({ ...sale, status: 'cancelled' }) });
    jest.spyOn(User, 'findById').mockReturnValue({
      select: jest.fn().mockResolvedValue({ comparePassword: jest.fn().mockResolvedValue(passwordOk) }),
    });
    jest.spyOn(SalesReturn, 'exists').mockResolvedValue(hasReturn);
    jest.spyOn(Payment, 'exists').mockResolvedValue(laterPayment);
    jest.spyOn(CashRegister, 'findOne').mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(register ? { status: register } : null) }),
    });
    const cancel = jest.spyOn(saleService, 'cancelSale').mockResolvedValue({});
    const checkoutRow = { _id: new mongoose.Types.ObjectId(), sale: sale._id, atCheckout: true, amount: 500 };
    jest.spyOn(Payment, 'find').mockReturnValue({ lean: jest.fn().mockResolvedValue([checkoutRow]) });
    const archive = jest.spyOn(DeletedSale, 'create').mockResolvedValue([{ _id: new mongoose.Types.ObjectId(), deletedAt: new Date() }]);
    const delSale = jest.spyOn(Sale.collection, 'deleteOne').mockResolvedValue({ deletedCount: 1 });
    const delPay = jest.spyOn(Payment.collection, 'deleteMany').mockResolvedValue({ deletedCount: 1 });
    const sms = jest.spyOn(SMSLog, 'updateMany').mockResolvedValue({});
    jest.spyOn(AuditLog, 'create').mockResolvedValue({});
    jest.spyOn(saleService, 'invalidateCache').mockResolvedValue();
    return { sale, findOne, cancel, archive, delSale, delPay, sms, checkoutRow };
  };

  const input = (over = {}) => ({ reason: 'ভুল কাস্টমার', confirmInvoiceNo: 'A-1034', password: 'secret', ...over });

  it('[R] refuses a non-owner before touching anything — even with the password', async () => {
    const findOne = jest.spyOn(Sale, 'findOne');
    await expect(saleService.deleteSale(SHOP, OWNER, 'id', input(), staffReq()))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('[R] requires a reason', async () => {
    await expect(saleService.deleteSale(SHOP, OWNER, 'id', input({ reason: '  ' }), ownerReq()))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('[R] checks the password on the server, not a browser timestamp', async () => {
    const { delSale } = arm({ passwordOk: false });
    await expect(saleService.deleteSale(SHOP, OWNER, 'id', input(), ownerReq()))
      .rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    expect(delSale).not.toHaveBeenCalled();

    await expect(saleService.deleteSale(SHOP, OWNER, 'id', input({ password: '' }), ownerReq()))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('[R] the invoice number must be typed back exactly', async () => {
    const { delSale, cancel } = arm();
    await expect(saleService.deleteSale(SHOP, OWNER, 'id', input({ confirmInvoiceNo: 'A-1043' }), ownerReq()))
      .rejects.toMatchObject({ code: 'CONFIRM_MISMATCH' });
    expect(cancel).not.toHaveBeenCalled();
    expect(delSale).not.toHaveBeenCalled();
  });

  it.each([
    ['HAS_RETURN', { hasReturn: { _id: 1 } }],
    ['LATER_PAYMENT', { laterPayment: { _id: 1 } }],
    ['REGISTER_CLOSED', { register: 'closed' }],
    ['ONLINE_ORDER', { sale: saleDoc({ order: new mongoose.Types.ObjectId() }) }],
    ['REVISION_CHAIN', { sale: saleDoc({ revisedFrom: new mongoose.Types.ObjectId() }) }],
    ['WITH_COURIER', { sale: saleDoc({ courier: new mongoose.Types.ObjectId() }) }],
  ])('[R] refuses %s and writes nothing', async (code, opts) => {
    const { delSale, cancel, archive } = arm(opts);
    await expect(saleService.deleteSale(SHOP, OWNER, 'id', input(), ownerReq()))
      .rejects.toMatchObject({ code });
    expect(cancel).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect(delSale).not.toHaveBeenCalled();
  });

  it('[R] a LIVE sale is reversed through cancelSale first, in the same transaction', async () => {
    const { sale, cancel, archive, delSale } = arm({ sale: saleDoc({ dueSettled: 200 }) });
    await saleService.deleteSale(SHOP, OWNER, 'id', input({ voidSettlement: true }), ownerReq());

    expect(cancel).toHaveBeenCalledTimes(1);
    const args = cancel.mock.calls[0];
    expect(args[2]).toBe(sale._id);
    expect(args[3]).toContain('ভুল কাস্টমার');
    expect(args[5]).toHaveProperty('session');
    expect(args[6]).toBe(true); // the খাতা tri-state is forwarded, never defaulted

    // Reverse → archive → remove. An archive that fails must abort the delete.
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(archive.mock.invocationCallOrder[0]);
    expect(archive.mock.invocationCallOrder[0]).toBeLessThan(delSale.mock.invocationCallOrder[0]);
    expect(archive.mock.calls[0][0][0]).toMatchObject({
      invoiceNo: 'A-1034',
      statusBeforeDelete: 'completed',
      reversedOnDelete: true,
      settlementVoided: true,
      deletedBy: OWNER,
    });
  });

  it('[G] an undecided খাতা settlement still reaches cancelSale as undefined', async () => {
    const { cancel } = arm({ sale: saleDoc({ dueSettled: 200 }) });
    await saleService.deleteSale(SHOP, OWNER, 'id', input(), ownerReq());
    expect(cancel.mock.calls[0][6]).toBeUndefined();
  });

  it('[R] an already-cancelled sale is NOT reversed again — and a closed drawer does not stop it', async () => {
    const { cancel, archive, delSale } = arm({ sale: saleDoc({ status: 'cancelled' }), register: 'closed' });
    const out = await saleService.deleteSale(SHOP, OWNER, 'id', input(), ownerReq());
    expect(cancel).not.toHaveBeenCalled();
    expect(out.reversedOnDelete).toBe(false);
    expect(archive.mock.calls[0][0][0]).toMatchObject({ statusBeforeDelete: 'cancelled', reversedOnDelete: false });
    expect(delSale).toHaveBeenCalled();
  });

  it('[R] removes the sale and its checkout payment row, scoped to the shop, and archives both', async () => {
    const { sale, archive, delSale, delPay, checkoutRow } = arm();
    await saleService.deleteSale(SHOP, OWNER, 'id', input(), ownerReq());

    expect(delSale.mock.calls[0][0]).toEqual({ _id: sale._id, shop: SHOP });
    expect(delPay.mock.calls[0][0]).toEqual({ _id: { $in: [checkoutRow._id] }, shop: SHOP });
    expect(archive.mock.calls[0][0][0].removedPayments).toEqual([checkoutRow]);
    expect(archive.mock.calls[0][0][0].snapshot).toMatchObject({ _id: sale._id, items: sale.items });
  });

  it('[R] frees the number for the receipt-SMS duplicate guard', async () => {
    const { sms } = arm();
    await saleService.deleteSale(SHOP, OWNER, 'id', input(), ownerReq());
    expect(sms).toHaveBeenCalledWith(
      { shop: SHOP, invoiceNumber: 'A-1034' },
      { $set: { invoiceNumber: 'A-1034~deleted' } },
      {}
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * RENAME
 * ═════════════════════════════════════════════════════════════════════════ */
describe('renameInvoiceNo', () => {
  const ON = { customInvoiceNo: true };

  const arm = ({ sale = saleDoc(), versions = [], updateErr = null } = {}) => {
    jest.spyOn(Sale, 'findOne')
      .mockReturnValueOnce(Promise.resolve(sale))
      .mockReturnValueOnce(Promise.resolve({ ...sale, invoiceNo: 'A-1043' }));
    const update = jest.spyOn(Sale, 'updateOne').mockImplementation(async () => {
      if (updateErr) throw updateErr;
      return { matchedCount: 1 };
    });
    const find = jest.spyOn(Sale, 'find').mockReturnValue({ lean: jest.fn().mockResolvedValue(versions) });
    const stx = jest.spyOn(StockTransaction, 'updateMany').mockResolvedValue({});
    const ret = jest.spyOn(SalesReturn, 'updateMany').mockResolvedValue({});
    const sms = jest.spyOn(SMSLog, 'updateMany').mockResolvedValue({});
    const audit = jest.spyOn(AuditLog, 'create').mockResolvedValue({});
    jest.spyOn(saleService, 'invalidateCache').mockResolvedValue();
    return { sale, update, find, stx, ret, sms, audit };
  };

  it('[R] refuses a shop without the capability', async () => {
    arm();
    await expect(saleService.renameInvoiceNo(SHOP, OWNER, 'id', 'A-1043', '', ownerReq()))
      .rejects.toMatchObject({ code: 'FEATURE_OFF', statusCode: 403 });
  });

  it('[R] refuses a cancelled invoice and a superseded version', async () => {
    arm({ sale: saleDoc({ status: 'cancelled' }) });
    await expect(saleService.renameInvoiceNo(SHOP, OWNER, 'id', 'A-1043', '', ownerReq(ON)))
      .rejects.toMatchObject({ code: 'SALE_CANCELLED' });
    jest.restoreAllMocks();

    arm({ sale: saleDoc({ invoiceNo: 'A-1034~r1', revisedTo: new mongoose.Types.ObjectId() }) });
    await expect(saleService.renameInvoiceNo(SHOP, OWNER, 'id', 'A-1043', '', ownerReq(ON)))
      .rejects.toMatchObject({ code: 'ALREADY_REVISED' });
  });

  it('[G] the new number obeys the same rules as typing it at the till', async () => {
    arm();
    await expect(saleService.renameInvoiceNo(SHOP, OWNER, 'id', 'A~1043', '', ownerReq(ON)))
      .rejects.toMatchObject({ statusCode: 400 });
    jest.restoreAllMocks();
    arm();
    await expect(saleService.renameInvoiceNo(SHOP, OWNER, 'id', '-1043', '', ownerReq(ON)))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('[R] refuses the number it already has', async () => {
    arm();
    await expect(saleService.renameInvoiceNo(SHOP, OWNER, 'id', ' A-1034 ', '', ownerReq(ON)))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('[R] a number in use is a 409 INVOICE_NO_TAKEN from the unique index', async () => {
    arm({ updateErr: Object.assign(new Error('dup'), { code: 11000 }) });
    await expect(saleService.renameInvoiceNo(SHOP, OWNER, 'id', 'A-1043', '', ownerReq(ON)))
      .rejects.toMatchObject({ code: 'INVOICE_NO_TAKEN', statusCode: 409 });
  });

  it('[R] a staff member of a capability shop may fix it, and the old number is recorded', async () => {
    const { sale, update, audit } = arm();
    await saleService.renameInvoiceNo(SHOP, OWNER, 'id', 'A-1043', 'হাতের লেখা ভুল', staffReq(ON));

    const [filter, change] = update.mock.calls[0];
    expect(filter).toEqual({ _id: sale._id, shop: SHOP, invoiceNo: 'A-1034' });
    expect(change.$set).toEqual({ invoiceNo: 'A-1043' });
    expect(change.$push.invoiceNoHistory).toMatchObject({ from: 'A-1034', to: 'A-1043', reason: 'হাতের লেখা ভুল' });
    expect(audit.mock.calls[0][0]).toMatchObject({
      action: 'sale_invoice_rename',
      changes: { before: { invoiceNo: 'A-1034' }, after: { invoiceNo: 'A-1043' } },
    });
  });

  it('[R] carries the id-linked labels along — and re-keys the SMS guard', async () => {
    const { sale, stx, ret, sms } = arm();
    await saleService.renameInvoiceNo(SHOP, OWNER, 'id', 'A-1043', '', ownerReq(ON));

    expect(stx).toHaveBeenCalledWith(
      { shop: SHOP, 'reference.id': sale._id, 'reference.invoiceNo': 'A-1034' },
      { $set: { 'reference.invoiceNo': 'A-1043' } }, {}
    );
    expect(ret).toHaveBeenCalledWith({ shop: SHOP, sale: sale._id }, { $set: { invoiceNo: 'A-1043' } }, {});
    expect(sms).toHaveBeenCalledWith(
      { shop: SHOP, invoiceNumber: 'A-1034' },
      { $set: { invoiceNumber: 'A-1043' } }, {}
    );
  });

  it('[R] renames superseded revisions too, so the prefix search still finds them', async () => {
    const v1 = { _id: new mongoose.Types.ObjectId(), invoiceNo: 'A-1034~r1' };
    const { update } = arm({
      sale: saleDoc({ revisedFrom: v1._id, revision: 1 }),
      versions: [v1],
    });
    await saleService.renameInvoiceNo(SHOP, OWNER, 'id', 'A-1043', '', ownerReq(ON));
    expect(update.mock.calls[1][1]).toEqual({ $set: { invoiceNo: 'A-1043~r1' } });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * INVARIANT GUARDS — the response every existing shop gets must not change
 * ═════════════════════════════════════════════════════════════════════════ */
describe('nothing changes for shops that use neither', () => {
  it('[G] a new Sale carries no invoiceNoHistory key', () => {
    const doc = new Sale({ shop: SHOP, invoiceNo: 'X' }).toObject();
    expect(doc).not.toHaveProperty('invoiceNoHistory');
  });

  it('[G] getSaleById adds no delete/rename keys for staff in a shop without the capability', async () => {
    const sale = saleDoc();
    const chain = { populate: jest.fn() };
    chain.populate.mockReturnValue(chain);
    chain.then = (res) => res({ ...sale, toObject: () => ({ ...sale }) });
    jest.spyOn(Sale, 'findOne').mockReturnValue(chain);
    jest.spyOn(saleService, 'reviseBlockedReason').mockResolvedValue(null);
    const deleteCheck = jest.spyOn(saleService, 'deleteBlockedReason');

    const out = await saleService.getSaleById(SHOP, sale._id, null, staffReq());
    expect(out).not.toHaveProperty('canDelete');
    expect(out).not.toHaveProperty('deleteBlockedReason');
    expect(out).not.toHaveProperty('canRenameInvoiceNo');
    expect(deleteCheck).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE HOLE IN immutableGuard IS EXACTLY ONE CALL SITE WIDE
 * ═════════════════════════════════════════════════════════════════════════ */
describe('the guard bypass stays where it was reviewed', () => {
  const SRC = path.resolve(__dirname, '..');
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'node_modules') walk(full, out); }
      else if (e.name.endsWith('.js')) out.push(full);
    }
    return out;
  };

  it('[G] only sale.service.deleteSale carries the sale-delete marker, twice', () => {
    const hits = [];
    for (const f of walk(SRC)) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (line.includes('// sale-delete:reviewed')) hits.push(`${path.relative(SRC, f)}:${i + 1}`);
      });
    }
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.startsWith(path.join('services', 'sale.service.js')))).toBe(true);
  });

  it('[G] every driver-level Sale/Payment delete carries a reviewed marker', () => {
    const offenders = [];
    for (const f of walk(SRC)) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*')) return;
        if (/\b(Sale|Payment)\.collection\.(deleteOne|deleteMany)\(/.test(line)
          && !/(sale-delete|admin-purge):reviewed/.test(line)) {
          offenders.push(`${path.relative(SRC, f)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('[G] the deletion record is itself undeletable and has no TTL', () => {
    const indexes = DeletedSale.schema.indexes();
    expect(indexes.some(([, opts]) => opts && opts.expireAfterSeconds !== undefined)).toBe(false);
    const src = fs.readFileSync(path.join(SRC, 'models', 'DeletedSale.model.js'), 'utf8');
    expect(src).toContain("plugin(immutableGuard");
  });
});
