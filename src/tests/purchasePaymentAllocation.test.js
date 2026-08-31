/**
 * F-4 / F-5 — a supplier payment settles older bills, atomically.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THESE PIN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * In real life the shop hands the supplier ৳50,000 covering this challan AND
 * last month's. `recordPayment` used to refuse anything past the named bill's
 * due, so the shop either split it into fake payments or did not record it.
 * Now the primary bill absorbs up to its own due and the excess walks the same
 * shop+supplier+branch's other open bills oldest first — ONE Payment row, its
 * split on `allocations`, the supplier rollup and the branch ledger each moved
 * ONCE by the total, all inside one transaction (F-5).
 *
 * REGRESSION TESTS unless marked otherwise: against the pre-F-4 service the
 * allocation cases throw "exceeds due" and the transactional case finds no
 * `runInTransaction` call to observe.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue([{}]),
}));
// The holder lets individual tests hand the callback a session sentinel, so
// the F-5 case can assert every write actually carries it.
jest.mock('../utils/transaction.util', () => {
  const state = { session: null };
  return {
    __state: state,
    runInTransaction: jest.fn((cb) => cb(state.session)),
  };
});

const mongoose = require('mongoose');
const purchaseService = require('../services/purchase.service');
const paymentAccountService = require('../services/paymentAccount.service');
const transactionUtil = require('../utils/transaction.util');
const Purchase = require('../models/Purchase.model');
const Supplier = require('../models/Supplier.model');
const SupplierBalance = require('../models/SupplierBalance.model');
const Payment = require('../models/Payment.model');
const AuditLog = require('../models/AuditLog.model');

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const SUPPLIER = new mongoose.Types.ObjectId();
const ACCOUNT = new mongoose.Types.ObjectId();

/**
 * A purchase doc whose `save` mirrors `Purchase.pre('save')` exactly — clamp
 * `paid` to `totalAmount`, derive `due` and the payment status, never touch a
 * cancelled doc's status. The service leans on that hook, so the stub has to
 * behave like it or the assertions on status prove nothing.
 */
function bill({ invoiceNo, totalAmount, paid, supplier = SUPPLIER, date, createdAt }) {
  return {
    _id: new mongoose.Types.ObjectId(),
    shop: SHOP,
    branch: null,
    supplier,
    invoiceNo,
    totalAmount,
    paid,
    due: Math.max(0, totalAmount - paid),
    status: totalAmount - paid <= 0 ? 'completed' : paid > 0 ? 'partial' : 'unpaid',
    date: date || new Date('2026-08-01'),
    createdAt: createdAt || new Date('2026-08-01'),
    save: jest.fn().mockImplementation(function () {
      this.paid = Math.min(Math.max(0, this.paid || 0), this.totalAmount);
      this.due = Math.max(0, this.totalAmount - this.paid);
      if (this.status !== 'cancelled') {
        this.status = this.due === 0 ? 'completed' : this.paid > 0 ? 'partial' : 'unpaid';
      }
      return Promise.resolve(this);
    }),
  };
}

let accountDeltas;
let sortArgs;
let supplierDoc;

function stubPrimary(doc) {
  jest.spyOn(Purchase, 'findOne').mockReturnValue({ session: () => Promise.resolve(doc) });
  return doc;
}

function stubEligible(bills) {
  jest.spyOn(Purchase, 'find').mockImplementation(() => ({
    sort: (args) => {
      sortArgs = args;
      return { session: () => Promise.resolve(bills) };
    },
  }));
}

beforeEach(() => {
  accountDeltas = [];
  sortArgs = null;
  transactionUtil.__state.session = null;
  jest.spyOn(Payment, 'create').mockImplementation(async (rows) => rows.map((r) => ({ ...r, _id: new mongoose.Types.ObjectId() })));
  // The rollup is now READ, moved on its components and re-derived, so the stub
  // is a document rather than an `$inc` sink. Started at ৳2,000 owed on ৳2,000
  // billed so the arithmetic below has something to move.
  supplierDoc = {
    _id: SUPPLIER, totalAmount: 2000, totalPaid: 0, openingDue: 0,
    totalDue: 2000, advanceBalance: 0,
    save: jest.fn().mockResolvedValue(undefined),
  };
  jest.spyOn(Supplier, 'findById').mockReturnValue({
    session: () => Promise.resolve(supplierDoc),
  });
  jest.spyOn(SupplierBalance, 'applyDelta').mockResolvedValue({});
  jest.spyOn(SupplierBalance, 'recomputeBalances').mockResolvedValue({});
  jest.spyOn(paymentAccountService, 'applyAccountDelta').mockImplementation(async (d) => {
    accountDeltas.push(d);
  });
  jest.spyOn(paymentAccountService, 'resolveAccountForMethod').mockResolvedValue(ACCOUNT);
});

afterEach(() => {
  jest.restoreAllMocks();
  AuditLog.create.mockClear();
  transactionUtil.runInTransaction.mockClear();
});

const pay = (purchaseId, body) =>
  purchaseService.recordPayment(SHOP, USER, purchaseId, body, null);

/* ════════════════════════════════════════════════════════════════════════════
 * F-4 — the over-payment allocation
 * ════════════════════════════════════════════════════════════════════════════ */

describe('an over-payment settles the supplier\'s older bills, oldest first', () => {
  it('splits exactly: primary up to its due, then each older bill up to its', async () => {
    const primary = stubPrimary(bill({ invoiceNo: 'PUR-NEW', totalAmount: 1000, paid: 800 })); // due 200
    const older = bill({ invoiceNo: 'PUR-OLD1', totalAmount: 300, paid: 0 }); // due 300
    const oldest = bill({ invoiceNo: 'PUR-OLD2', totalAmount: 900, paid: 400 }); // due 500
    stubEligible([older, oldest]); // already in the service's requested order

    const result = await pay(primary._id, { amount: 700, method: 'cash' });

    // Primary absorbed 200 and closed.
    expect(primary.paid).toBe(1000);
    expect(primary.due).toBe(0);
    expect(primary.status).toBe('completed');

    // Older bills each took up to their due, in order.
    expect(older.paid).toBe(300);
    expect(older.status).toBe('completed');
    expect(oldest.paid).toBe(600); // 400 + the remaining 200
    expect(oldest.status).toBe('partial');

    // ONE Payment row, for the full amount, split recorded on allocations.
    expect(Payment.create).toHaveBeenCalledTimes(1);
    const [row] = Payment.create.mock.calls[0][0];
    expect(row.amount).toBe(700);
    expect(row.type).toBe('purchase_payment');
    expect(row.purchase).toBe(primary._id);
    expect(row.allocations).toEqual([
      { purchase: primary._id, amount: 200 },
      { purchase: older._id, amount: 300 },
      { purchase: oldest._id, amount: 200 },
    ]);

    // The supplier books move ONCE, by the total, mirrored on both sides —
    // Σ SupplierBalance.totalDue === Supplier.totalDue survives because the
    // two deltas are the same arithmetic.
    //
    // Shop-wide that is now `totalPaid += 700` and BOTH halves re-derived, not
    // `$inc: { totalDue: -700 }`. The figures agree — ৳2,000 billed less ৳700
    // paid is ৳1,300 owed — but only the component form can land the money in
    // `advanceBalance` when a vendor ends up holding it.
    expect(supplierDoc.save).toHaveBeenCalledTimes(1);
    expect(supplierDoc.totalPaid).toBe(700);
    expect(supplierDoc.totalDue).toBe(1300);
    expect(supplierDoc.advanceBalance).toBe(0);
    expect(SupplierBalance.applyDelta).toHaveBeenCalledTimes(1);
    expect(SupplierBalance.applyDelta.mock.calls[0][0]).toMatchObject({ paid: 700, due: -700 });
    // The branch row cannot derive its own halves from an `$inc`, so it is
    // re-derived right after — or a branch holding credit keeps both figures.
    expect(SupplierBalance.recomputeBalances).toHaveBeenCalledTimes(1);

    // Money left the drawer once.
    expect(accountDeltas).toEqual([
      expect.objectContaining({ shop: SHOP, account: ACCOUNT, amount: -700 }),
    ]);

    // The response contract the frontend is built against.
    expect(result.totalApplied).toBe(700);
    expect(result.purchase).toBe(primary);
    expect(result.allocations).toEqual([
      { purchase: primary._id, invoiceNo: 'PUR-NEW', amount: 200 },
      { purchase: older._id, invoiceNo: 'PUR-OLD1', amount: 300 },
      { purchase: oldest._id, invoiceNo: 'PUR-OLD2', amount: 200 },
    ]);
  });

  it('asks for the older bills oldest first, same shop+supplier+branch, live, with due', async () => {
    const primary = stubPrimary(bill({ invoiceNo: 'P', totalAmount: 100, paid: 50 }));
    const other = bill({ invoiceNo: 'O', totalAmount: 100, paid: 0 });
    stubEligible([other]);

    await pay(primary._id, { amount: 150 });

    const filter = Purchase.find.mock.calls[0][0];
    expect(filter).toMatchObject({
      shop: SHOP,
      supplier: SUPPLIER,
      branch: null,
      status: { $ne: 'cancelled' },
      due: { $gt: 0 },
    });
    expect(filter._id).toEqual({ $ne: primary._id });
    // Oldest first by the backdatable `date`, tie-broken by `createdAt`.
    expect(sortArgs).toEqual({ date: 1, createdAt: 1 });
  });

  it('refuses an amount past the supplier\'s total open due, naming the maximum', async () => {
    const primary = stubPrimary(bill({ invoiceNo: 'P', totalAmount: 1000, paid: 800 })); // due 200
    stubEligible([
      bill({ invoiceNo: 'O1', totalAmount: 300, paid: 0 }), // due 300
      bill({ invoiceNo: 'O2', totalAmount: 900, paid: 400 }), // due 500
    ]);

    // Max payable is 200 + 300 + 500 = 1000. A supplier advance is
    // deliberately not tracked (supplier.service.js says so).
    await expect(pay(primary._id, { amount: 1100 })).rejects.toMatchObject({
      statusCode: 400,
      messageBn: 'সরবরাহকারীর মোট বাকি ৳1000 — এর বেশি নেওয়া যাবে না',
    });

    // Nothing moved.
    expect(Payment.create).not.toHaveBeenCalled();
    expect(primary.save).not.toHaveBeenCalled();
    expect(accountDeltas).toEqual([]);
  });

  it('keeps the old hard cap and message for a purchase with no supplier', async () => {
    // INVARIANT GUARD — passes before and after F-4.
    const primary = stubPrimary(bill({ invoiceNo: 'P', totalAmount: 500, paid: 300, supplier: null }));
    stubEligible([]);

    await expect(pay(primary._id, { amount: 300 })).rejects.toMatchObject({
      statusCode: 400,
      messageBn: 'পেমেন্টের পরিমাণ বাকির চেয়ে বেশি',
    });
    expect(Purchase.find).not.toHaveBeenCalled();
  });

  it('a plain within-due payment stores no allocations and never queries other bills', async () => {
    // INVARIANT GUARD — the stored row must stay byte-identical to every row
    // written before `allocations` existed.
    const primary = stubPrimary(bill({ invoiceNo: 'P', totalAmount: 500, paid: 100 }));
    stubEligible([]);

    const result = await pay(primary._id, { amount: 150 });

    expect(Purchase.find).not.toHaveBeenCalled();
    const [row] = Payment.create.mock.calls[0][0];
    expect(row.allocations).toEqual([]);
    expect(primary.paid).toBe(250);
    expect(primary.status).toBe('partial');
    expect(result.allocations).toEqual([
      { purchase: primary._id, invoiceNo: 'P', amount: 150 },
    ]);
    expect(result.totalApplied).toBe(150);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * F-5 — one transaction, or it does not happen
 * ════════════════════════════════════════════════════════════════════════════ */

describe('recordPayment is transactional', () => {
  it('runs inside runInTransaction and threads the session through every write', async () => {
    const FAKE_SESSION = { id: 'txn' };
    transactionUtil.__state.session = FAKE_SESSION;

    const primary = stubPrimary(bill({ invoiceNo: 'P', totalAmount: 1000, paid: 800 }));
    const other = bill({ invoiceNo: 'O', totalAmount: 300, paid: 0 });
    stubEligible([other]);

    await pay(primary._id, { amount: 400 });

    expect(transactionUtil.runInTransaction).toHaveBeenCalledTimes(1);

    // Every write carries the session: a failure between any two of the five
    // used to split the books with nothing to signal it.
    expect(primary.save).toHaveBeenCalledWith({ session: FAKE_SESSION });
    expect(other.save).toHaveBeenCalledWith({ session: FAKE_SESSION });
    expect(Payment.create.mock.calls[0][1]).toEqual({ session: FAKE_SESSION });
    expect(accountDeltas[0].session).toBe(FAKE_SESSION);
    expect(supplierDoc.save).toHaveBeenCalledWith({ session: FAKE_SESSION });
    expect(SupplierBalance.applyDelta.mock.calls[0][1]).toBe(FAKE_SESSION);
    expect(AuditLog.create.mock.calls[0][1]).toEqual({ session: FAKE_SESSION });
  });

  it('still refuses zero, negative and malformed amounts', async () => {
    // INVARIANT GUARD — the `<= 0` boundary predates this work.
    stubPrimary(bill({ invoiceNo: 'P', totalAmount: 500, paid: 100 }));
    stubEligible([]);

    for (const amount of [0, -5, null, undefined, '', 'abc', NaN]) {
      await expect(pay('pid', { amount })).rejects.toThrow(/greater than 0/i);
    }
    expect(Payment.create).not.toHaveBeenCalled();
  });

  it('takes no payment on a cancelled purchase', async () => {
    // INVARIANT GUARD.
    const doc = bill({ invoiceNo: 'P', totalAmount: 500, paid: 100 });
    doc.status = 'cancelled';
    stubPrimary(doc);

    await expect(pay('pid', { amount: 100 })).rejects.toThrow(/cancelled/i);
  });
});
