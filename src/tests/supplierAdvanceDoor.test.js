/**
 * Phase G — অগ্রিম: money handed to a vendor before the goods.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PINS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The event with nowhere to live until now (SUPPLIER_DUE_ADVANCE_PLAN.md S-4):
 * the shop pays ৳50,000 to secure stock and the goods arrive over five weeks.
 * Recorded as an `Expense` — the only door that was open — it overstates cost
 * of goods in the month the money left and double-counts when the bills land.
 *
 * It is an ASSET: a claim on a vendor holding the shop's cash. The mirror of
 * the customer deposit's liability, and neither may be netted against the due
 * it sits beside.
 *
 * Groups (AGENT_WORKFLOW.md §7.1):
 *
 *   A. THE CEILING STILL HOLDS — INVARIANT GUARD. Every caller that existed
 *      before advances did must still be refused, by construction rather than
 *      by everyone remembering.
 *
 *   B. DEBT FIRST — a vendor is never owed and in credit at once.
 *
 *   C. CONSUMPTION — the bill has to learn about it, or the payables ageing
 *      ages debt the vendor position says does not exist.
 *
 *   D. REVERSIBILITY — `deleteSupplier` refuses to remove a vendor holding our
 *      money, so an advance with no void door could never be closed out.
 */

jest.mock('../models/AuditLog.model', () => ({
  create: jest.fn().mockResolvedValue([{}]),
  log: jest.fn().mockResolvedValue({}),
}));

const fs = require('fs');
const mongoose = require('mongoose');
const settlement = require('../services/supplierSettlement.service');
const paymentAccountService = require('../services/paymentAccount.service');
const Supplier = require('../models/Supplier.model');
const SupplierBalance = require('../models/SupplierBalance.model');
const Purchase = require('../models/Purchase.model');
const Payment = require('../models/Payment.model');
const { PAYMENT_TYPES } = require('../config/constants');

const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8');

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const SUPPLIER = new mongoose.Types.ObjectId();
const ACCOUNT = new mongoose.Types.ObjectId();

let supplierDoc;
let created;
let accountDeltas;

const stub = ({ openingDue = 0, totalAmount = 0, totalPaid = 0, bills = [] } = {}) => {
  supplierDoc = {
    _id: SUPPLIER, shop: SHOP, name: 'করিম ট্রেডার্স', isActive: true,
    totalAmount, totalPaid, openingDue,
    totalDue: Math.max(0, totalAmount + openingDue - totalPaid),
    advanceBalance: Math.max(0, totalPaid - totalAmount - openingDue),
    save: jest.fn().mockResolvedValue(undefined),
  };
  jest.spyOn(Supplier, 'findOne').mockReturnValue({
    session: () => Promise.resolve(supplierDoc),
  });
  jest.spyOn(Purchase, 'find').mockReturnValue({
    sort: () => ({ session: () => Promise.resolve(bills) }),
  });
  jest.spyOn(SupplierBalance, 'applyDelta').mockResolvedValue({});
  jest.spyOn(SupplierBalance, 'recomputeBalances').mockResolvedValue({});
};

beforeEach(() => {
  created = [];
  accountDeltas = [];
  // The advance pool `reallocateSupplierAdvance` reads. Empty by default, so a
  // test that does not care about the re-spread does not have to say so; the
  // one that does overrides it.
  jest.spyOn(Payment, 'aggregate').mockResolvedValue([]);
  jest.spyOn(Payment, 'create').mockImplementation(async (rows) => {
    created.push(...rows);
    return rows;
  });
  jest.spyOn(paymentAccountService, 'applyAccountDelta')
    .mockImplementation(async (d) => { accountDeltas.push(d); });
  jest.spyOn(paymentAccountService, 'resolveAccountForMethod').mockResolvedValue(ACCOUNT);
});

afterEach(() => jest.restoreAllMocks());

const pay = (amount, over = {}) => settlement.settleSupplierDue({
  shopId: SHOP, userId: USER, supplierId: SUPPLIER, amount, method: 'cash', ...over,
});

/* ── A. THE CEILING STILL HOLDS ───────────────────────────────────────────── */

describe('the ordinary counter still refuses an over-payment', () => {
  it('refuses without the flag, exactly as before', async () => {
    // I-1 for the money paths: every caller written before advances existed
    // passes no flag and must behave identically. Preserved BY CONSTRUCTION,
    // which is the only way a guard like this survives contact with new code.
    stub({ openingDue: 5000 });

    await expect(pay(9000)).rejects.toMatchObject({ statusCode: 400 });
    expect(created).toHaveLength(0);
    expect(accountDeltas).toHaveLength(0);
  });

  it('is opened only by the door built for it', () => {
    // `paySupplier` must never pass it, or the ordinary পরিশোধ screen becomes
    // an advance door by accident and the fat-finger refusal is lost.
    const src = read('../services/supplier.service');
    const ordinary = src.slice(src.indexOf('async paySupplier('), src.indexOf('async paySupplierAdvance('));
    expect(ordinary).not.toContain('allowAdvance');

    const advance = src.slice(src.indexOf('async paySupplierAdvance('));
    expect(advance.slice(0, 1200)).toContain('allowAdvance: true');
  });

  it('is owner-only at the route', () => {
    // Settling a bill discharges an obligation the shop already had. Paying
    // ahead parts with cash for nothing yet received — a decision ABOUT the
    // shop's money rather than a record of one already made.
    const routes = read('../routes/supplier.routes');
    const block = routes.slice(routes.indexOf("'/:id/advance'"), routes.indexOf("'/:id/advance'") + 300);
    expect(block).toContain('ownerOnly');
  });
});

/* ── B. DEBT FIRST ────────────────────────────────────────────────────────── */

describe('debt is settled before anything becomes a prepayment', () => {
  it('clears what is owed, then holds the surplus', async () => {
    // ৳5,000 owed, ৳50,000 handed over: the debt goes, ৳45,000 is held on
    // account. The shop does not end up owing AND in credit with one vendor.
    stub({ openingDue: 5000 });

    const res = await pay(50000, { allowAdvance: true });

    expect(res.openingApplied).toBe(5000);
    expect(res.advanceApplied).toBe(45000);
    expect(supplierDoc.totalDue).toBe(0);
    expect(supplierDoc.advanceBalance).toBe(45000);
  });

  it('writes the two halves as two rows with different types', async () => {
    // One mixed row would force every report to choose between mislabelling
    // debt settlement or prepayment, forever.
    stub({ openingDue: 5000 });

    await pay(50000, { allowAdvance: true });

    const settled = created.find((r) => r.type === PAYMENT_TYPES.PURCHASE_PAYMENT);
    const advance = created.find((r) => r.type === PAYMENT_TYPES.SUPPLIER_ADVANCE);

    expect(settled.amount).toBe(5000);
    expect(advance.amount).toBe(45000);
    expect(advance.purchase).toBeUndefined();
    expect(advance.supplier).toBe(SUPPLIER);
    expect(String(settled.receiptGroup)).toBe(String(advance.receiptGroup));
  });

  it('books a pure prepayment to a vendor who is square', async () => {
    stub({});

    const res = await pay(50000, { allowAdvance: true });

    expect(res.advanceApplied).toBe(50000);
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe(PAYMENT_TYPES.SUPPLIER_ADVANCE);
    expect(supplierDoc.advanceBalance).toBe(50000);
    expect(supplierDoc.totalDue).toBe(0);
  });

  it('moves the cash out once, for the whole event', async () => {
    stub({ openingDue: 5000 });
    await pay(50000, { allowAdvance: true });
    expect(accountDeltas).toEqual([
      expect.objectContaining({ account: ACCOUNT, amount: -50000 }),
    ]);
  });
});

/* ── C. CONSUMPTION ───────────────────────────────────────────────────────── */

describe('a bill spends the advance it was paid for', () => {
  it('nets it off the bill without touching `paid`', () => {
    // `paid` is money that left the drawer FOR THIS BILL. The advance left the
    // drawer weeks ago, and is already counted by the reconciler as a bill-less
    // row — adding it to `paid` would count it twice, rebuilding S-11.
    const doc = new Purchase({
      shop: SHOP, invoiceNo: 'PUR-X', createdBy: USER,
      items: [{ product: new mongoose.Types.ObjectId(), productName: 'চাল', quantity: 1, unitPrice: 9000, total: 9000 }],
      totalAmount: 9000, paid: 0, advanceApplied: 9000,
    });

    return new Promise((resolve, reject) => {
      doc.schema.s.hooks.execPre('save', doc, (err) => (err ? reject(err) : resolve()));
    }).then(() => {
      expect(doc.paid).toBe(0);
      expect(doc.due).toBe(0);
      expect(doc.status).toBe('completed');
    });
  });

  it('can never drive the bill below zero', async () => {
    const doc = new Purchase({
      shop: SHOP, invoiceNo: 'PUR-Y', createdBy: USER,
      items: [{ product: new mongoose.Types.ObjectId(), productName: 'চাল', quantity: 1, unitPrice: 1000, total: 1000 }],
      totalAmount: 1000, paid: 400, advanceApplied: 99999,
    });

    await new Promise((resolve, reject) => {
      doc.schema.s.hooks.execPre('save', doc, (err) => (err ? reject(err) : resolve()));
    });

    expect(doc.due).toBe(0);
  });

  it('is absent by default, so nothing about an ordinary bill changes', () => {
    expect(Purchase.schema.path('advanceApplied').defaultValue).toBeUndefined();
  });

  it('is consumed when a bill arrives, by a recompute and not a one-shot', () => {
    /**
     * Without consumption the SUPPLIER reads as owing nothing — `advanceBalance`
     * is derived and falls the moment `totalAmount` rises — while the BILL still
     * reads as fully due, and the ageing report ages debt already covered.
     *
     * This used to assert a one-shot: `min(advanceHeld, purchase.due)` written
     * onto the arriving bill from the SHOP-WIDE `supplier.advanceBalance`, and
     * never revisited. Two faults in one line — it let a shop-wide pool decide
     * what a BRANCH's bill could take, and it made an allocation that no later
     * event could correct. Voiding the advance afterwards left ৳55,200 owed on
     * the vendor and ৳0 across the challans, all of them marked completed.
     *
     * The recompute replaces it and is pinned in full by
     * `supplierAdvanceReallocation.test.js`.
     */
    const body = read('../services/purchase.service');
    expect(body).toContain('reallocateSupplierAdvance');
    expect(body).not.toContain('const advanceHeld = supplierDoc.advanceBalance || 0;');
  });
});

/* ── D. REVERSIBILITY ─────────────────────────────────────────────────────── */

describe('an advance can be taken back off the books', () => {
  it('is voidable through the same door as a payment', async () => {
    // `deleteSupplier` refuses to remove a vendor holding our money, so an
    // advance with no reversal path would leave an account that can never be
    // closed — the exact argument the customer-side plan makes for its refund.
    const doc = {
      _id: new mongoose.Types.ObjectId(),
      shop: SHOP, supplier: SUPPLIER, branch: null,
      type: PAYMENT_TYPES.SUPPLIER_ADVANCE, status: 'active',
      amount: 45000, account: ACCOUNT, allocations: [], purchase: null,
      save: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(Payment, 'findOne').mockResolvedValue(doc);
    stub({ totalPaid: 45000 });
    jest.spyOn(Supplier, 'findOne').mockReturnValue({
      session: () => Promise.resolve(supplierDoc),
    });

    const res = await settlement.voidSupplierPayment({
      shopId: SHOP, userId: USER, paymentId: doc._id, reason: 'ভুল এন্ট্রি',
    });

    expect(res.reversed).toBe(45000);
    expect(accountDeltas).toEqual([expect.objectContaining({ amount: 45000 })]);
    expect(supplierDoc.advanceBalance).toBe(0);
  });

  it('re-opens the challans the voided advance was covering', async () => {
    /**
     * THE REGRESSION, at the door rather than in the allocator.
     *
     * An advance row carries neither `allocations` nor a `purchase`, so the
     * slices loop above walks ZERO bills. The vendor position was put back
     * correctly and the challans it had settled were not: ৳55,200 owed on the
     * supplier, ৳0 across the bills, and both of them marked `completed` — a
     * debt no screen could show and no counter could take money for.
     */
    const bill = new Purchase({
      shop: SHOP, supplier: SUPPLIER, supplierName: 'করিম ট্রেডার্স',
      invoiceNo: 'P-1', items: [], totalAmount: 35200, paid: 0,
      advanceApplied: 35200,
    });
    const fire = () => (Purchase.schema.s.hooks._pres.get('save') || [])
      .forEach((h) => h.fn.call(bill, () => {}));
    fire();
    bill.save = jest.fn(async () => { fire(); return bill; });
    expect(bill.due).toBe(0);

    const doc = {
      _id: new mongoose.Types.ObjectId(),
      shop: SHOP, supplier: SUPPLIER, branch: null,
      type: PAYMENT_TYPES.SUPPLIER_ADVANCE, status: 'active',
      amount: 45000, account: ACCOUNT, allocations: [], purchase: null,
      save: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(Payment, 'findOne').mockResolvedValue(doc);
    // The bill is still live; the pool is empty because the row just voided was
    // the only one.
    stub({ totalAmount: 35200, totalPaid: 45000, bills: [bill] });
    jest.spyOn(Supplier, 'findOne').mockReturnValue({
      session: () => Promise.resolve(supplierDoc),
    });

    const res = await settlement.voidSupplierPayment({
      shopId: SHOP, userId: USER, paymentId: doc._id, reason: 'ভুল সরবরাহকারী',
    });

    expect(bill.advanceApplied).toBe(0);
    expect(bill.due).toBe(35200);
    expect(bill.status).not.toBe('completed');
    // The two books say the same number again.
    expect(supplierDoc.totalDue).toBe(bill.due);
    expect(res.reallocated).toHaveLength(1);
  });
});

/* ── The reporting surfaces ───────────────────────────────────────────────── */

describe('an advance is visible where it must be and absent where it must not', () => {
  it('appears on the খতিয়ান, labelled as itself', () => {
    // The statement is the running account of everything that passed between
    // shop and vendor. Leaving advances out shows a balance the vendor's own
    // paper disagrees with by exactly the money already handed over.
    const src = read('../services/detailedReport.service');
    expect(src).toContain('PAYMENT_TYPES.SUPPLIER_ADVANCE');
    expect(src).toContain("'অগ্রিম প্রদান'");
  });

  it('never appears in the payables ageing', () => {
    // Ageing derives from `Purchase.due` and the adjustment rows. A prepayment
    // lives on neither, so it cannot age as debt or net against another
    // vendor's payable (R1).
    const src = read('../services/supplier.service');
    const body = src.slice(src.indexOf('async getPayableAging'), src.indexOf('async getPayableAging') + 4000);
    expect(body).not.toContain('advanceBalance');
  });

  it('is cash OUT of the drawer, never cash in', () => {
    const src = read('../services/cashRegister.service');
    const bucket = src.slice(src.indexOf('cashSupplierPayments'));
    expect(bucket).toContain("$in: ['purchase_payment', 'supplier_advance']");
  });
});
