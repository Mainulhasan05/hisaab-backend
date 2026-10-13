/**
 * Permanent purchase deletion (owner-only) — the purchase-side twin of
 * `saleDeleteAndRename.test.js`.
 *
 * Models are mocked, so these pin the DECISIONS — who may, what is refused,
 * what is written and in which order. The arithmetic of the reversal itself is
 * `cancelPurchase`'s and is covered by its own suites; `deletePurchase` must
 * call it, not re-implement it.
 *
 * [R] = regression: fails without the feature/fix.  [G] = invariant guard.
 */
jest.mock('../utils/transaction.util', () => ({
  // Joins an ambient session exactly as the real one does, so a method that
  // forgets to forward it is visible here.
  // `global.__TX_SESSION__` stands in for the session a top-level call opens.
  runInTransaction: (cb, opts = {}) => cb(opts.session ?? global.__TX_SESSION__ ?? null),
}));

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Purchase = require('../models/Purchase.model');
const Payment = require('../models/Payment.model');
const PurchaseReturn = require('../models/PurchaseReturn.model');
const DeletedPurchase = require('../models/DeletedPurchase.model');
const InvoiceCounter = require('../models/InvoiceCounter.model');
const AuditLog = require('../models/AuditLog.model');
const User = require('../models/User.model');
const purchaseService = require('../services/purchase.service');
const { toBangladeshMonthStr } = require('../utils/bdTime.util');

const SHOP = new mongoose.Types.ObjectId();
const OWNER = new mongoose.Types.ObjectId();

const ownerReq = () => ({
  user: { _id: OWNER, isOwner: true, name: 'মালিক' },
  shop: { _id: SHOP, features: {} },
  branchId: null,
});
const staffReq = () => ({
  user: { _id: new mongoose.Types.ObjectId(), isOwner: false, name: 'ম্যানেজার' },
  shop: { _id: SHOP, features: {} },
  branchId: null,
});

const purchaseDoc = (over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  shop: SHOP,
  branch: null,
  invoiceNo: 'PUR2026100007',
  status: 'completed',
  returnedAmount: 0,
  totalAmount: 9000,
  paid: 9000,
  due: 0,
  supplier: new mongoose.Types.ObjectId(),
  supplierName: 'রহিম ট্রেডার্স',
  date: new Date(),
  createdAt: new Date(),
  items: [{ productName: 'চাল', quantity: 100, unitPrice: 90, total: 9000 }],
  ...over,
});

afterEach(() => jest.restoreAllMocks());

/* ═══════════════════════════════════════════════════════════════════════════
 * DELETE
 * ═════════════════════════════════════════════════════════════════════════ */
describe('deletePurchase', () => {
  /** Wire every collaborator for a delete that is allowed to succeed. */
  const arm = ({ purchase = purchaseDoc(), passwordOk = true, hasReturn = null, linkedPayment = null } = {}) => {
    const findOne = jest.spyOn(Purchase, 'findOne')
      .mockReturnValueOnce({ session: jest.fn().mockResolvedValue(purchase) })
      .mockReturnValueOnce({
        session: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ ...purchase, status: 'cancelled' }),
        }),
      });
    jest.spyOn(User, 'findById').mockReturnValue({
      select: jest.fn().mockResolvedValue({ comparePassword: jest.fn().mockResolvedValue(passwordOk) }),
    });
    jest.spyOn(PurchaseReturn, 'exists').mockResolvedValue(hasReturn);
    const payExists = jest.spyOn(Payment, 'exists').mockResolvedValue(linkedPayment);
    const cancel = jest.spyOn(purchaseService, 'cancelPurchase').mockResolvedValue({ success: true });
    const archive = jest.spyOn(DeletedPurchase, 'create')
      .mockResolvedValue([{ _id: new mongoose.Types.ObjectId(), deletedAt: new Date() }]);
    const remove = jest.spyOn(Purchase.collection, 'deleteOne').mockResolvedValue({ deletedCount: 1 });
    jest.spyOn(AuditLog, 'create').mockResolvedValue({});
    return { purchase, findOne, cancel, archive, remove, payExists };
  };

  const input = (over = {}) => ({ reason: 'ভুল সরবরাহকারী', confirmInvoiceNo: 'PUR2026100007', password: 'secret', ...over });

  it('[R] refuses a non-owner before touching anything — even with the password', async () => {
    const { remove, cancel } = arm();
    await expect(purchaseService.deletePurchase(SHOP, OWNER, 'id', input(), staffReq()))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(cancel).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('[R] requires a reason', async () => {
    arm();
    await expect(purchaseService.deletePurchase(SHOP, OWNER, 'id', input({ reason: ' ' }), ownerReq()))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('[R] checks the password on the server', async () => {
    const { remove } = arm({ passwordOk: false });
    await expect(purchaseService.deletePurchase(SHOP, OWNER, 'id', input(), ownerReq()))
      .rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    await expect(purchaseService.deletePurchase(SHOP, OWNER, 'id', input({ password: '' }), ownerReq()))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(remove).not.toHaveBeenCalled();
  });

  it('[R] the purchase number must be typed back exactly', async () => {
    const { remove } = arm();
    await expect(purchaseService.deletePurchase(SHOP, OWNER, 'id', input({ confirmInvoiceNo: 'PUR2026100008' }), ownerReq()))
      .rejects.toMatchObject({ code: 'CONFIRM_MISMATCH' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('[G] surrounding spaces in the typed number are forgiven', async () => {
    arm();
    await expect(purchaseService.deletePurchase(SHOP, OWNER, 'id', input({ confirmInvoiceNo: '  PUR2026100007 ' }), ownerReq()))
      .resolves.toMatchObject({ invoiceNo: 'PUR2026100007' });
  });

  it('[R] a LIVE purchase is reversed through cancelPurchase first, in the same transaction', async () => {
    const SESSION = { id: 'ambient' };
    const { purchase, cancel, archive, remove } = arm();
    // Run the whole delete inside a known session to prove it is forwarded.
    global.__TX_SESSION__ = SESSION;
    try {
      await purchaseService.deletePurchase(SHOP, OWNER, 'id', input(), ownerReq());
    } finally {
      delete global.__TX_SESSION__;
    }

    expect(cancel).toHaveBeenCalledTimes(1);
    const [, , id, , opts] = cancel.mock.calls[0];
    expect(id).toBe(purchase._id);
    expect(opts.session).toBe(SESSION);
    expect(opts.reason).toContain('ভুল সরবরাহকারী');

    // Reverse → archive → remove. An archive that fails must abort the delete.
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(archive.mock.invocationCallOrder[0]);
    expect(archive.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
    expect(archive.mock.calls[0][1]).toEqual({ session: SESSION });
    expect(remove.mock.calls[0][1]).toEqual({ session: SESSION });
    expect(archive.mock.calls[0][0][0]).toMatchObject({
      invoiceNo: 'PUR2026100007',
      statusBeforeDelete: 'completed',
      reversedOnDelete: true,
      supplierName: 'রহিম ট্রেডার্স',
      totalAmount: 9000,
      deletedBy: OWNER,
    });
  });

  it('[R] an already-cancelled purchase is NOT reversed again', async () => {
    const { cancel, archive, remove } = arm({ purchase: purchaseDoc({ status: 'cancelled' }) });
    const out = await purchaseService.deletePurchase(SHOP, OWNER, 'id', input(), ownerReq());
    expect(cancel).not.toHaveBeenCalled();
    expect(out.reversedOnDelete).toBe(false);
    expect(archive.mock.calls[0][0][0]).toMatchObject({ statusBeforeDelete: 'cancelled', reversedOnDelete: false });
    expect(remove).toHaveBeenCalled();
  });

  it('[R] removes the purchase scoped to the shop, and archives the full snapshot', async () => {
    const { purchase, archive, remove } = arm();
    await purchaseService.deletePurchase(SHOP, OWNER, 'id', input(), ownerReq());
    expect(remove.mock.calls[0][0]).toEqual({ _id: purchase._id, shop: SHOP });
    expect(archive.mock.calls[0][0][0].snapshot).toMatchObject({ _id: purchase._id, items: purchase.items });
  });

  it('[R] refuses a purchase with goods returned against it', async () => {
    const { remove, cancel } = arm({ hasReturn: { _id: 'r' } });
    await expect(purchaseService.deletePurchase(SHOP, OWNER, 'id', input(), ownerReq()))
      .rejects.toMatchObject({ code: 'HAS_RETURN', statusCode: 409 });
    expect(cancel).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('[R] refuses when any supplier payment names it — voided ones and multi-bill slices included', async () => {
    const { remove, payExists } = arm({ purchase: purchaseDoc({ status: 'cancelled' }), linkedPayment: { _id: 'p' } });
    await expect(purchaseService.deletePurchase(SHOP, OWNER, 'id', input(), ownerReq()))
      .rejects.toMatchObject({ code: 'LINKED_PAYMENT', statusCode: 409 });
    expect(remove).not.toHaveBeenCalled();

    const filter = payExists.mock.calls[0][0];
    expect(filter.shop).toBe(SHOP);
    expect(filter).not.toHaveProperty('status'); // cancelled-inclusive
    expect(JSON.stringify(filter.$or)).toContain('allocations.purchase');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * cancelPurchase joins the caller's transaction
 * ═════════════════════════════════════════════════════════════════════════ */
describe('cancelPurchase as a nested step', () => {
  it('[R] runs inside the session it is handed instead of opening its own', async () => {
    const SESSION = { id: 'outer' };
    const sessionFn = jest.fn().mockResolvedValue(null);
    jest.spyOn(Purchase, 'findOne').mockReturnValue({ session: sessionFn });
    await expect(purchaseService.cancelPurchase(SHOP, OWNER, 'id', ownerReq(), { session: SESSION }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(sessionFn).toHaveBeenCalledWith(SESSION);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * READ
 * ═════════════════════════════════════════════════════════════════════════ */
describe('getPurchaseById', () => {
  const chain = (result) => {
    const c = { populate: jest.fn(() => c), then: (res, rej) => Promise.resolve(result).then(res, rej) };
    return c;
  };

  it('[R] a deleted purchase answers 410 with who and when, not a bare 404', async () => {
    jest.spyOn(Purchase, 'findOne').mockReturnValue(chain(null));
    jest.spyOn(DeletedPurchase, 'findOne').mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ invoiceNo: 'PUR2026100007', deletedAt: new Date(), deletedByName: 'মালিক' }),
      }),
    });
    await expect(purchaseService.getPurchaseById(SHOP, 'id', ownerReq()))
      .rejects.toMatchObject({ statusCode: 410, code: 'PURCHASE_DELETED' });
  });

  it('[G] a purchase that never existed is still a 404', async () => {
    jest.spyOn(Purchase, 'findOne').mockReturnValue(chain(null));
    jest.spyOn(DeletedPurchase, 'findOne').mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
    });
    await expect(purchaseService.getPurchaseById(SHOP, 'id', ownerReq()))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('[R] an owner\'s response says whether — and why not — it can be deleted', async () => {
    const doc = new Purchase(purchaseDoc());
    jest.spyOn(Purchase, 'findOne').mockReturnValue(chain(doc));
    jest.spyOn(PurchaseReturn, 'exists').mockResolvedValue(null);
    jest.spyOn(Payment, 'exists').mockResolvedValue({ _id: 'p' });
    const out = await purchaseService.getPurchaseById(SHOP, 'id', ownerReq());
    const json = out.toJSON();
    expect(json.canDelete).toBe(false);
    expect(json.deleteBlockedReason).toMatchObject({ code: 'LINKED_PAYMENT' });
  });

  it('[G] a staff response keeps its shape and pays no extra lookups', async () => {
    const doc = new Purchase(purchaseDoc());
    jest.spyOn(Purchase, 'findOne').mockReturnValue(chain(doc));
    const exists = jest.spyOn(Payment, 'exists').mockResolvedValue(null);
    const out = await purchaseService.getPurchaseById(SHOP, 'id', staffReq());
    const json = out.toJSON();
    expect(json).not.toHaveProperty('canDelete');
    expect(json).not.toHaveProperty('deleteBlockedReason');
    expect(exists).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * NUMBERING — a deleted number is never handed out again
 * ═════════════════════════════════════════════════════════════════════════ */
describe('Purchase.generateInvoiceNo when the month counter has to re-seed', () => {
  const prefix = `PUR${toBangladeshMonthStr(new Date()).replace('-', '')}`;
  const rows = (...nos) => ({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(nos.map((invoiceNo) => ({ invoiceNo }))) }) });

  beforeEach(() => {
    // No counter row (first of month, or the 30-day TTL took it): seed + 1.
    jest.spyOn(InvoiceCounter, 'nextSeq').mockImplementation(async (s, b, k, countExisting) => (await countExisting()) + 1);
  });

  it('[R] seeds past a deleted number, even when the count is lower', async () => {
    jest.spyOn(Purchase, 'countDocuments').mockResolvedValue(6); // 0001–0007, one deleted
    jest.spyOn(Purchase, 'find').mockReturnValue(rows(`${prefix}0006`));
    jest.spyOn(DeletedPurchase, 'find').mockReturnValue(rows(`${prefix}0007`));
    await expect(Purchase.generateInvoiceNo(SHOP)).resolves.toBe(`${prefix}0008`);
  });

  it('[R] seeds past a gap in the live sequence (a burned number)', async () => {
    jest.spyOn(Purchase, 'countDocuments').mockResolvedValue(2);
    jest.spyOn(Purchase, 'find').mockReturnValue(rows(`${prefix}0001`, `${prefix}0003`));
    jest.spyOn(DeletedPurchase, 'find').mockReturnValue(rows());
    await expect(Purchase.generateInvoiceNo(SHOP)).resolves.toBe(`${prefix}0004`);
  });

  it('[G] an unbroken month continues exactly where the count says', async () => {
    jest.spyOn(Purchase, 'countDocuments').mockResolvedValue(3);
    jest.spyOn(Purchase, 'find').mockReturnValue(rows(`${prefix}0001`, `${prefix}0002`, `${prefix}0003`));
    jest.spyOn(DeletedPurchase, 'find').mockReturnValue(rows());
    await expect(Purchase.generateInvoiceNo(SHOP)).resolves.toBe(`${prefix}0004`);
  });

  it('[G] a first-ever purchase is 0001', async () => {
    jest.spyOn(Purchase, 'countDocuments').mockResolvedValue(0);
    jest.spyOn(Purchase, 'find').mockReturnValue(rows());
    jest.spyOn(DeletedPurchase, 'find').mockReturnValue(rows());
    await expect(Purchase.generateInvoiceNo(SHOP)).resolves.toBe(`${prefix}0001`);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The guard bypass stays where it was reviewed
 * ═════════════════════════════════════════════════════════════════════════ */
describe('the purchase guard bypass stays where it was reviewed', () => {
  const SRC = path.resolve(__dirname, '..');
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'node_modules') walk(full, out); }
      else if (e.name.endsWith('.js')) out.push(full);
    }
    return out;
  };

  it('[G] only purchase.service.deletePurchase carries the purchase-delete marker, once', () => {
    const hits = [];
    for (const f of walk(SRC)) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (line.includes('// purchase-delete:reviewed')) hits.push(`${path.relative(SRC, f)}:${i + 1}`);
      });
    }
    expect(hits).toHaveLength(1);
    expect(hits[0].startsWith(path.join('services', 'purchase.service.js'))).toBe(true);
  });

  it('[G] every driver-level Purchase delete carries a reviewed marker', () => {
    const offenders = [];
    for (const f of walk(SRC)) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*')) return;
        if (/\bPurchase\.collection\.(deleteOne|deleteMany)\(/.test(line)
          && !/purchase-delete:reviewed/.test(line)) {
          offenders.push(`${path.relative(SRC, f)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('[G] the deletion record is itself undeletable, has no TTL, and is registered', () => {
    const indexes = DeletedPurchase.schema.indexes();
    expect(indexes.some(([, opts]) => opts && opts.expireAfterSeconds !== undefined)).toBe(false);
    const src = fs.readFileSync(path.join(SRC, 'models', 'DeletedPurchase.model.js'), 'utf8');
    expect(src).toContain('plugin(immutableGuard');
    expect(require('../models')).toHaveProperty('DeletedPurchase');
    const admin = fs.readFileSync(path.join(SRC, 'services', 'admin.service.js'), 'utf8');
    expect(admin).toMatch(/branchScopedModels = \[[\s\S]*?DeletedPurchase[\s\S]*?\];/);
  });
});
