/**
 * সরবরাহকারী পরিশোধ — the voucher, and which account the money left.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PINS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   A. Both supplier money doors leave a printable trail: a রসিদ নং on every
 *      row, and the খাতা either side of the event. `recordPayment` (pay from
 *      the bill's own screen) used to mint no number at all.
 *
 *   B. The register says WHERE money left, not only HOW — per leg, so a bill
 *      paid ক্যাশ + ব্যাংক is not booked to its largest leg; the account filter
 *      is cast (I-3); the number is cut to its tail before it leaves.
 *
 *   C. The voucher endpoint reads the whole receipt group, branch-scoped.
 *
 * REGRESSIONS unless marked INVARIANT GUARD. Guards pass before and after:
 * they pin that a register with no filter runs the query it always ran.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue([{}]),
}));
jest.mock('../utils/transaction.util', () => ({
  runInTransaction: jest.fn((cb) => cb(null)),
}));

const mongoose = require('mongoose');
const purchaseService = require('../services/purchase.service');
const supplierService = require('../services/supplier.service');
const settlement = require('../services/supplierSettlement.service');
const paymentAccountService = require('../services/paymentAccount.service');
const supplierController = require('../controllers/supplier.controller');
const Purchase = require('../models/Purchase.model');
const Supplier = require('../models/Supplier.model');
const SupplierBalance = require('../models/SupplierBalance.model');
const Payment = require('../models/Payment.model');
const { accountDisplay } = require('../utils/accountDisplay.util');

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const SUPPLIER = new mongoose.Types.ObjectId();
const ACCOUNT = new mongoose.Types.ObjectId();
const RECEIPT_NO = /^RCP-\d{6}-[0-9A-F]{6}$/;

const req = { shop: { _id: SHOP, multiBranchEnabled: false }, branchId: null };

let created;
let supplierDoc;

beforeEach(() => {
  created = [];
  jest.spyOn(Payment, 'create').mockImplementation(async (rows) => {
    created.push(...rows);
    return rows.map((r) => ({ _id: new mongoose.Types.ObjectId(), ...r }));
  });
  jest.spyOn(Payment, 'aggregate').mockResolvedValue([]);
  jest.spyOn(paymentAccountService, 'applyAccountDelta').mockResolvedValue(undefined);
  jest.spyOn(paymentAccountService, 'resolveAccountForMethod').mockResolvedValue(ACCOUNT);
  jest.spyOn(SupplierBalance, 'applyDelta').mockResolvedValue({});
  jest.spyOn(SupplierBalance, 'recomputeBalances').mockResolvedValue({});
  jest.spyOn(settlement, 'reallocateSupplierAdvance').mockResolvedValue([]);
});

afterEach(() => jest.restoreAllMocks());

/* ── A. Both doors leave a printable trail ─────────────────────────────────── */

describe('recordPayment — paying from the bill\'s own screen', () => {
  function bill({ totalAmount, paid }) {
    return {
      _id: new mongoose.Types.ObjectId(),
      shop: SHOP, branch: null, supplier: SUPPLIER, invoiceNo: 'PUR-1',
      totalAmount, paid, due: totalAmount - paid, status: paid ? 'partial' : 'unpaid',
      save: jest.fn().mockImplementation(function () {
        this.due = Math.max(0, this.totalAmount - this.paid);
        return Promise.resolve(this);
      }),
    };
  }

  beforeEach(() => {
    supplierDoc = {
      _id: SUPPLIER, totalAmount: 5000, totalPaid: 0, openingDue: 0,
      totalDue: 5000, advanceBalance: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(Supplier, 'findById').mockReturnValue({ session: () => Promise.resolve(supplierDoc) });
  });

  it('mints a রসিদ নং from the row\'s own id, dated by paidAt', async () => {
    const doc = bill({ totalAmount: 5000, paid: 0 });
    jest.spyOn(Purchase, 'findOne').mockReturnValue({ session: () => Promise.resolve(doc) });

    await purchaseService.recordPayment(SHOP, USER, doc._id, { amount: 2000, method: 'bank' }, null);

    expect(created).toHaveLength(1);
    const [row] = created;
    expect(row.receiptNo).toMatch(RECEIPT_NO);
    // The number is a rendering of the row's identity, not a second id.
    expect(row.receiptNo.endsWith(String(row._id).slice(-6).toUpperCase())).toBe(true);
    expect(row.paidAt).toBeInstanceOf(Date);
    expect(row.account).toBe(ACCOUNT);
  });

  it('snapshots the vendor\'s খাতা before and after, read before any bill moved', async () => {
    const doc = bill({ totalAmount: 5000, paid: 0 });
    jest.spyOn(Purchase, 'findOne').mockReturnValue({ session: () => Promise.resolve(doc) });

    await purchaseService.recordPayment(SHOP, USER, doc._id, { amount: 2000, method: 'cash' }, null);

    expect(created[0].dueBefore).toBe(5000);
    expect(created[0].dueAfter).toBe(3000);
    // The rollup still moves the same document, once.
    expect(supplierDoc.save).toHaveBeenCalledTimes(1);
  });

  it('writes no খাতা figures for a supplier-less bill — there is no খাতা to state', async () => {
    const doc = { ...bill({ totalAmount: 1000, paid: 0 }), supplier: null };
    doc.save = jest.fn().mockResolvedValue(doc);
    jest.spyOn(Purchase, 'findOne').mockReturnValue({ session: () => Promise.resolve(doc) });

    await purchaseService.recordPayment(SHOP, USER, doc._id, { amount: 400, method: 'cash' }, null);

    expect(created[0].receiptNo).toMatch(RECEIPT_NO);
    expect(created[0]).not.toHaveProperty('dueBefore');
    expect(created[0]).not.toHaveProperty('dueAfter');
  });
});

describe('settleSupplierDue — the পরিশোধ door', () => {
  const stub = ({ openingDue = 0, totalAmount = 0, bills = [] }) => {
    supplierDoc = {
      _id: SUPPLIER, shop: SHOP, name: 'করিম ট্রেডার্স', isActive: true,
      totalAmount, totalPaid: 0, openingDue,
      totalDue: totalAmount + openingDue, advanceBalance: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(Supplier, 'findOne').mockReturnValue({ session: () => Promise.resolve(supplierDoc) });
    jest.spyOn(Purchase, 'find').mockReturnValue({ sort: () => ({ session: () => Promise.resolve(bills) }) });
  };

  it('stamps the EVENT\'s খাতা on every row of a straddling payment', async () => {
    const b = {
      _id: new mongoose.Types.ObjectId(), paid: 0, due: 3000,
      save: jest.fn().mockResolvedValue(undefined),
    };
    stub({ openingDue: 2000, totalAmount: 3000, bills: [b] });

    await settlement.settleSupplierDue({
      shopId: SHOP, userId: USER, supplierId: SUPPLIER, amount: 4000, method: 'cash',
    });

    // খাতা half + bills half: two rows, one event, one voucher.
    expect(created).toHaveLength(2);
    for (const row of created) {
      expect(row.receiptNo).toMatch(RECEIPT_NO);
      expect(row.dueBefore).toBe(5000);
      expect(row.dueAfter).toBe(1000);
    }
    expect(String(created[0].receiptGroup)).toBe(String(created[1].receiptGroup));
  });

  it('an অগ্রিম surplus never drives the payable below zero', async () => {
    stub({ openingDue: 1000 });

    await settlement.settleSupplierDue({
      shopId: SHOP, userId: USER, supplierId: SUPPLIER, amount: 6000, method: 'cash', allowAdvance: true,
    });

    expect(created.every((r) => r.dueBefore === 1000 && r.dueAfter === 0)).toBe(true);
  });
});

/* ── B. The register says where the money left ─────────────────────────────── */

describe('the register\'s account trail', () => {
  const capture = (result = [{ rows: [], total: [], live: [], byAccount: [] }]) => {
    Payment.aggregate.mockResolvedValue(result);
    return () => Payment.aggregate.mock.calls[0][0];
  };
  const billArm = (pipeline) => pipeline.find((s) => s.$unionWith)?.$unionWith;

  it('gives every row legs — a Payment row one, a bill row its own split', async () => {
    const pipeline = capture();
    await supplierService.getSupplierPaymentRegister(SHOP, {}, req);
    const stages = pipeline();
    expect(stages[1]).toEqual({
      $addFields: {
        legs: [{ method: '$method', account: { $ifNull: ['$account', null] }, amount: '$amount' }],
      },
    });
    const project = billArm(stages).pipeline.find((s) => s.$project).$project;
    expect(project.legs.$cond[1].$map.input).toBe('$payments');
    // Legacy bills carry `paid` alone: one leg on the recorded method.
    expect(project.legs.$cond[2]).toEqual([{ method: '$paymentMethod', account: null, amount: '$atPurchaseAmount' }]);
  });

  it('casts the account filter to an ObjectId in BOTH arms (I-3)', async () => {
    const pipeline = capture();
    await supplierService.getSupplierPaymentRegister(SHOP, { account: String(ACCOUNT) }, req);
    const stages = pipeline();

    expect(stages[0].$match.account).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(stages[0].$match.account)).toBe(String(ACCOUNT));

    const billMatch = billArm(stages).pipeline[0].$match;
    expect(billMatch.$and[0]['payments.account']).toBeInstanceOf(mongoose.Types.ObjectId);

    const legCut = stages.find((s) => s.$addFields?.legs?.$filter);
    const cond = legCut.$addFields.legs.$filter.cond.$and[0].$eq;
    expect(cond[1]).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it('reports only the matching part of a split bill under a filter', async () => {
    const pipeline = capture();
    await supplierService.getSupplierPaymentRegister(SHOP, { method: 'bank' }, req);
    const stages = pipeline();
    expect(stages).toContainEqual({
      $addFields: { rowAmount: '$amount', amount: { $round: [{ $sum: '$legs.amount' }, 2] } },
    });
    expect(stages).toContainEqual({ $match: { amount: { $gt: 0 } } });
    expect(stages[0].$match.method).toBe('bank');
  });

  it('refuses an account id that is not one, rather than matching nothing', async () => {
    capture();
    await expect(
      supplierService.getSupplierPaymentRegister(SHOP, { account: 'abc' }, req)
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      supplierService.getSupplierPaymentRegister(SHOP, { method: 'gold' }, req)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('searches by the number printed on the voucher', async () => {
    jest.spyOn(Supplier, 'find').mockReturnValue({ limit: () => ({ lean: async () => [] }) });
    jest.spyOn(Purchase, 'find').mockReturnValue({ limit: () => ({ lean: async () => [] }) });
    const pipeline = capture();
    await supplierService.getSupplierPaymentRegister(SHOP, { search: 'RCP-261027' }, req);
    const or = pipeline()[0].$match.$and.find((c) => c.$or).$or;
    expect(or.some((c) => c.receiptNo instanceof RegExp)).toBe(true);
  });

  it('cuts the account number to its tail and totals per account', async () => {
    const accountDoc = { _id: ACCOUNT, name: 'DBBL চলতি', type: 'bank', method: 'bank', bankName: 'DBBL', accountNumber: '1051 1100 2345 6789' };
    capture([{
      rows: [{ _id: new mongoose.Types.ObjectId(), amount: 500, legs: [{ method: 'bank', account: ACCOUNT, amount: 500, accountDoc }] }],
      total: [{ n: 1 }],
      live: [{ _id: 'purchase_payment', amount: 500, count: 1 }],
      byAccount: [{ method: 'bank', amount: 500, accountDoc }],
    }]);

    const out = await supplierService.getSupplierPaymentRegister(SHOP, {}, req);

    const leg = out.payments[0].legs[0];
    expect(leg.account).toMatchObject({ name: 'DBBL চলতি', bankName: 'DBBL', accountTail: '6789' });
    expect(JSON.stringify(out)).not.toContain('1051');
    expect(out.summary.byAccount).toEqual([
      { method: 'bank', amount: 500, account: expect.objectContaining({ accountTail: '6789' }) },
    ]);
  });

  it('INVARIANT GUARD: no filter → the payment arm\'s $match is what it always was', async () => {
    const pipeline = capture();
    await supplierService.getSupplierPaymentRegister(SHOP, {}, req);
    const stages = pipeline();
    expect(stages[0].$match).not.toHaveProperty('account');
    expect(stages[0].$match).not.toHaveProperty('method');
    expect(stages.some((s) => s.$addFields?.rowAmount)).toBe(false);
    expect(billArm(stages).pipeline[0].$match).not.toHaveProperty('$and');
  });
});

describe('accountDisplay', () => {
  it('never carries a balance or the full number', () => {
    const out = accountDisplay({ _id: ACCOUNT, name: 'ক্যাশ বাক্স', type: 'cash', method: 'cash', balance: 99999, accountNumber: '' });
    expect(out).toEqual({ _id: ACCOUNT, name: 'ক্যাশ বাক্স', type: 'cash', method: 'cash', bankName: '', accountTail: '' });
  });

  it('INVARIANT GUARD: an unpopulated id or no account reads as null — the method is the record', () => {
    expect(accountDisplay(null)).toBeNull();
    expect(accountDisplay(ACCOUNT)).toBeNull();
  });
});

/* ── C. The voucher endpoint ───────────────────────────────────────────────── */

describe('getSupplierPaymentReceipt', () => {
  const GROUP = new mongoose.Types.ObjectId();
  const BILL = new mongoose.Types.ObjectId();
  const rowsQuery = (rows) => {
    const q = {
      sort: jest.fn(() => q),
      populate: jest.fn(() => q),
      lean: jest.fn(async () => rows),
    };
    return q;
  };

  it('returns the whole group as one voucher, parts in allocation order', async () => {
    const opening = {
      _id: new mongoose.Types.ObjectId(), receiptNo: 'RCP-261027-000001', type: 'purchase_payment',
      amount: 2000, supplier: SUPPLIER, method: 'bank', paidAt: new Date(), receiptGroup: GROUP,
      account: { _id: ACCOUNT, name: 'DBBL', type: 'bank', accountNumber: '99887766' },
      dueBefore: 5000, dueAfter: 1000,
    };
    const bills = {
      ...opening, _id: new mongoose.Types.ObjectId(), receiptNo: 'RCP-261027-000002', amount: 2000,
      purchase: BILL, allocations: [], status: 'cancelled', cancelReason: 'ভুল এন্ট্রি',
    };
    const findOne = jest.spyOn(Payment, 'findOne').mockReturnValue({ lean: async () => ({ _id: opening._id, receiptGroup: GROUP }) });
    const find = jest.spyOn(Payment, 'find').mockReturnValue(rowsQuery([opening, bills]));
    jest.spyOn(Purchase, 'find').mockReturnValue({ lean: async () => [{ _id: BILL, invoiceNo: 'PUR-7', supplier: SUPPLIER }] });
    jest.spyOn(Supplier, 'findOne').mockReturnValue({ lean: async () => ({ _id: SUPPLIER, name: 'করিম ট্রেডার্স', phone: '017' }) });

    const v = await supplierService.getSupplierPaymentReceipt(SHOP, opening._id, req);

    // Scoped by shop and type; grouped by receiptGroup.
    expect(findOne.mock.calls[0][0]).toMatchObject({ shop: SHOP, type: { $in: ['purchase_payment', 'supplier_advance'] } });
    expect(find.mock.calls[0][0]).toMatchObject({ shop: SHOP, receiptGroup: GROUP });

    expect(v.receiptNo).toBe('RCP-261027-000001');
    expect(v.parts.map((p) => p.kind)).toEqual(['opening', 'bills']);
    expect(v.parts[1].bills).toEqual([{ purchase: BILL, invoiceNo: 'PUR-7', amount: 2000 }]);
    // One part voided: the slip is NOT void, it says which part is.
    expect(v.voided).toBe(false);
    expect(v.partiallyVoided).toBe(true);
    expect(v.amount).toBe(2000);
    expect(v.totalAmount).toBe(4000);
    expect(v.account).toMatchObject({ name: 'DBBL', accountTail: '7766' });
    expect(v.supplier.name).toBe('করিম ট্রেডার্স');
  });

  it('is branch-scoped (I-2) — a branch cannot reprint another branch\'s voucher', async () => {
    const BRANCH = new mongoose.Types.ObjectId();
    const findOne = jest.spyOn(Payment, 'findOne').mockReturnValue({ lean: async () => null });

    await expect(
      supplierService.getSupplierPaymentReceipt(SHOP, new mongoose.Types.ObjectId(), { ...req, branchId: BRANCH })
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(String(findOne.mock.calls[0][0].branch)).toBe(String(BRANCH));
  });

  it('404s on an id that is not one, without querying', async () => {
    const findOne = jest.spyOn(Payment, 'findOne');
    await expect(supplierService.getSupplierPaymentReceipt(SHOP, 'nope', req)).rejects.toMatchObject({ statusCode: 404 });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('withholds the খাতা figures without purchases.view_cost — nulled, never zeroed', async () => {
    jest.spyOn(supplierService, 'getSupplierPaymentReceipt').mockResolvedValue({ amount: 500, dueBefore: 900, dueAfter: 400 });
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    const cashier = {
      shop: { _id: SHOP }, params: { paymentId: 'x' },
      user: { isOwner: false, permissions: { purchases: { view: true } } },
    };

    await supplierController.getSupplierPaymentReceipt(cashier, res, jest.fn());

    const body = res.json.mock.calls[0][0];
    expect(body.data).toMatchObject({ amount: 500, dueBefore: null, dueAfter: null });
  });

  it('INVARIANT GUARD: the owner keeps them', async () => {
    jest.spyOn(supplierService, 'getSupplierPaymentReceipt').mockResolvedValue({ amount: 500, dueBefore: 900, dueAfter: 400 });
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    const owner = { shop: { _id: SHOP }, params: { paymentId: 'x' }, user: { isOwner: true } };

    await supplierController.getSupplierPaymentReceipt(owner, res, jest.fn());

    expect(res.json.mock.calls[0][0].data).toMatchObject({ dueBefore: 900, dueAfter: 400 });
  });
});
