/**
 * Phase E — paying a supplier without opening a bill.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THESE PIN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two things were impossible before this service, and both are ordinary shop
 * events (SUPPLIER_DUE_ADVANCE_PLAN.md S-2, S-5):
 *
 *   · paying down a paper-খাতা `openingDue`, which has no bill to open — the
 *     only lever was an owner-only CORRECTION that moved the debt and left the
 *     cash unaccounted for;
 *   · handing a vendor one lump sum covering six challans.
 *
 * Groups (AGENT_WORKFLOW.md §7.1):
 *
 *   A. ALLOCATION — oldest debt first, খাতা before bills.
 *
 *   B. THE TWO ROWS — the single most consequential detail. The reconciler
 *      tells bill money from খাতা money by ONE field (`purchase`), because bill
 *      money is already inside `purchase.paid`. Writing one row for a
 *      straddling payment revives the double count fixed on 2026-08-31.
 *
 *   C. THE CEILING — INVARIANT GUARD. Paying past the payable would mint a
 *      prepayment with no screen to see it on and no door to refund it.
 *
 *   D. THE VOID — every book back exactly as it was, and refusing to do it
 *      twice.
 */

jest.mock('../models/AuditLog.model', () => ({
  create: jest.fn().mockResolvedValue([{}]),
  log: jest.fn().mockResolvedValue({}),
}));

const mongoose = require('mongoose');
const settlement = require('../services/supplierSettlement.service');
const paymentAccountService = require('../services/paymentAccount.service');
const Supplier = require('../models/Supplier.model');
const SupplierBalance = require('../models/SupplierBalance.model');
const Purchase = require('../models/Purchase.model');
const Payment = require('../models/Payment.model');

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const SUPPLIER = new mongoose.Types.ObjectId();
const ACCOUNT = new mongoose.Types.ObjectId();

let supplierDoc;
let created;
let accountDeltas;

/** A bill whose `save` mirrors `Purchase.pre('save')` — clamp, derive, status. */
const bill = ({ invoiceNo, totalAmount, paid, date }) => {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    shop: SHOP, supplier: SUPPLIER, branch: null,
    invoiceNo, totalAmount, paid, date,
    due: Math.max(0, totalAmount - paid),
    status: 'partial',
    save: jest.fn(async function save() {
      this.paid = Math.min(Math.max(0, this.paid || 0), this.totalAmount);
      this.due = Math.max(0, this.totalAmount - this.paid);
      this.status = this.due === 0 ? 'completed' : this.paid > 0 ? 'partial' : 'unpaid';
    }),
  };
  return doc;
};

const stub = ({ openingDue = 0, totalAmount = 0, totalPaid = 0, bills = [] } = {}) => {
  supplierDoc = {
    _id: SUPPLIER, shop: SHOP, name: 'করিম ট্রেডার্স', isActive: true,
    totalAmount, totalPaid, openingDue,
    totalDue: Math.max(0, totalAmount + openingDue - totalPaid),
    advanceBalance: 0,
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
  return bills;
};

beforeEach(() => {
  created = [];
  accountDeltas = [];
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

/* ── A. ALLOCATION ────────────────────────────────────────────────────────── */

describe('the oldest debt is paid first, and the oldest debt is the খাতা', () => {
  it('settles the carried-in payable before touching any bill', async () => {
    // Carried-in debt predates every bill in the system by definition. The
    // customer pool consumes `openingDue` before it walks invoices for the same
    // reason.
    const bills = stub({
      openingDue: 20000, totalAmount: 10000, totalPaid: 0,
      bills: [bill({ invoiceNo: 'PUR-1', totalAmount: 10000, paid: 0, date: new Date('2026-08-01') })],
    });

    const res = await pay(25000);

    expect(res.openingApplied).toBe(20000);
    expect(res.billsApplied).toBe(5000);
    expect(bills[0].paid).toBe(5000);
    expect(bills[0].due).toBe(5000);
  });

  it('walks the bills oldest first, each up to its own due', async () => {
    const bills = stub({
      totalAmount: 2200, totalPaid: 0,
      bills: [
        bill({ invoiceNo: 'OLD', totalAmount: 300, paid: 0, date: new Date('2026-07-01') }),
        bill({ invoiceNo: 'MID', totalAmount: 900, paid: 400, date: new Date('2026-07-15') }),
        bill({ invoiceNo: 'NEW', totalAmount: 1000, paid: 0, date: new Date('2026-08-01') }),
      ],
    });

    const res = await pay(1000);

    expect(bills[0].paid).toBe(300);   // closed
    expect(bills[1].paid).toBe(900);   // 400 + 500, closed
    expect(bills[2].paid).toBe(200);   // the remainder
    expect(res.allocations.map((a) => a.invoiceNo)).toEqual(['OLD', 'MID', 'NEW']);
  });

  it('moves the money out of the account exactly once', async () => {
    stub({
      openingDue: 20000, totalAmount: 10000,
      bills: [bill({ invoiceNo: 'PUR-1', totalAmount: 10000, paid: 0, date: new Date() })],
    });

    await pay(25000);

    // One event, one drawer movement — even though it wrote two rows.
    expect(accountDeltas).toEqual([
      expect.objectContaining({ shop: SHOP, account: ACCOUNT, amount: -25000 }),
    ]);
  });

  it('derives both halves of the supplier book rather than $inc-ing the due', async () => {
    stub({ openingDue: 20000, totalPaid: 0 });

    await pay(5000);

    expect(supplierDoc.totalPaid).toBe(5000);
    expect(supplierDoc.totalDue).toBe(15000);
    expect(supplierDoc.advanceBalance).toBe(0);
    // The branch row cannot derive its own halves from an `$inc`.
    expect(SupplierBalance.recomputeBalances).toHaveBeenCalled();
  });
});

/* ── B. THE TWO ROWS ──────────────────────────────────────────────────────── */

describe('a straddling payment is written as two rows, never one', () => {
  it('splits খাতা money from bill money by the `purchase` field', async () => {
    // THE detail everything downstream depends on. `recalc-supplier-balances`
    // counts a Payment row toward `totalPaid` only when it carries NO
    // `purchase`, because bill money is already inside `purchase.paid`. One
    // mixed row would be counted twice or not at all.
    stub({
      openingDue: 20000, totalAmount: 10000,
      bills: [bill({ invoiceNo: 'PUR-1', totalAmount: 10000, paid: 0, date: new Date() })],
    });

    await pay(25000);

    expect(created).toHaveLength(2);

    const billLess = created.find((r) => !r.purchase);
    const onBills = created.find((r) => r.purchase);

    expect(billLess.amount).toBe(20000);
    expect(billLess.supplier).toBe(SUPPLIER);

    expect(onBills.amount).toBe(5000);
    expect(onBills.allocations).toHaveLength(1);

    // The two halves sum to what was handed over, once.
    expect(billLess.amount + onBills.amount).toBe(25000);
  });

  it('writes ONE row when nothing straddles', async () => {
    stub({
      totalAmount: 10000,
      bills: [bill({ invoiceNo: 'PUR-1', totalAmount: 10000, paid: 0, date: new Date() })],
    });

    await pay(4000);

    expect(created).toHaveLength(1);
    expect(created[0].purchase).toBeDefined();
  });

  it('writes ONE bill-less row for a pure খাতা settlement', async () => {
    // The case that was impossible before: a vendor with carried-in debt and no
    // bills in the system at all.
    stub({ openingDue: 50000 });

    await pay(50000);

    expect(created).toHaveLength(1);
    expect(created[0].purchase).toBeUndefined();
    expect(created[0].supplier).toBe(SUPPLIER);
  });

  it('ties the pair together so the UI can show one event', async () => {
    stub({
      openingDue: 20000, totalAmount: 10000,
      bills: [bill({ invoiceNo: 'PUR-1', totalAmount: 10000, paid: 0, date: new Date() })],
    });

    await pay(25000);

    expect(created[0].receiptGroup).toBeDefined();
    expect(String(created[0].receiptGroup)).toBe(String(created[1].receiptGroup));
    expect(created[0].paidAt).toEqual(created[1].paidAt);
    // Each still gets its own receipt number — they are two rows on the books.
    expect(created[0].receiptNo).not.toBe(created[1].receiptNo);
    expect(created[0].receiptNo).toMatch(/^RCP-/);
  });
});

/* ── C. THE CEILING ───────────────────────────────────────────────────────── */

describe('the payable is a ceiling until the advance door opens', () => {
  it('refuses more than is owed, naming the maximum', async () => {
    stub({ openingDue: 5000 });

    await expect(pay(9000)).rejects.toMatchObject({
      statusCode: 400,
      messageBn: expect.stringContaining('5000'),
    });

    expect(created).toHaveLength(0);
    expect(accountDeltas).toHaveLength(0);
  });

  it('refuses a payment to a vendor who is square', async () => {
    stub({});
    await expect(pay(100)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses zero, negative and malformed amounts', async () => {
    stub({ openingDue: 5000 });
    for (const bad of [0, -100, 'abc', null, undefined, Infinity, NaN]) {
      await expect(pay(bad)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(accountDeltas).toHaveLength(0);
  });

  it('refuses to pay a deleted supplier', async () => {
    // The mirror of the guard `_applyOpeningDue` already carries: money must
    // not be recorded against a vendor no screen will show.
    stub({ openingDue: 5000 });
    supplierDoc.isActive = false;

    await expect(pay(1000)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses rather than part-paying when the books disagree with the bills', async () => {
    // `totalDue` says ৳9,000 is owed; the documents can only absorb ৳1,000.
    // Keeping the difference is how money goes missing, so it refuses and says
    // so — the reconciler is the tool for finding out why.
    stub({
      totalAmount: 9000, totalPaid: 0,
      bills: [bill({ invoiceNo: 'PUR-1', totalAmount: 1000, paid: 0, date: new Date() })],
    });

    await expect(pay(9000)).rejects.toMatchObject({ statusCode: 409 });
    expect(accountDeltas).toHaveLength(0);
  });
});

/* ── D. THE VOID ──────────────────────────────────────────────────────────── */

describe('voiding a supplier payment', () => {
  const voidStub = ({ status = 'active', allocations = [], purchase = null, amount = 5000 }) => {
    const doc = {
      _id: new mongoose.Types.ObjectId(),
      shop: SHOP, supplier: SUPPLIER, branch: null,
      type: 'purchase_payment', status, amount, account: ACCOUNT,
      allocations, purchase,
      save: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(Payment, 'findOne').mockResolvedValue(doc);
    jest.spyOn(Supplier, 'findOne').mockReturnValue({
      session: () => Promise.resolve(supplierDoc),
    });
    jest.spyOn(SupplierBalance, 'applyDelta').mockResolvedValue({});
    jest.spyOn(SupplierBalance, 'recomputeBalances').mockResolvedValue({});
    return doc;
  };

  const doVoid = (reason = 'ভুল এন্ট্রি') => settlement.voidSupplierPayment({
    shopId: SHOP, userId: USER, paymentId: new mongoose.Types.ObjectId(), reason,
  });

  beforeEach(() => {
    supplierDoc = {
      _id: SUPPLIER, name: 'করিম', totalAmount: 0, totalPaid: 5000, openingDue: 20000,
      totalDue: 15000, advanceBalance: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('puts the cash back and raises the payable again', async () => {
    voidStub({});

    const res = await doVoid();

    expect(res.reversed).toBe(5000);
    expect(accountDeltas).toEqual([
      expect.objectContaining({ account: ACCOUNT, amount: 5000 }),
    ]);
    expect(supplierDoc.totalPaid).toBe(0);
    expect(supplierDoc.totalDue).toBe(20000);
  });

  it('takes the money back off each bill it landed on', async () => {
    const target = bill({ invoiceNo: 'PUR-1', totalAmount: 1000, paid: 700, date: new Date() });
    jest.spyOn(Purchase, 'findOne').mockResolvedValue(target);
    voidStub({ purchase: target._id, amount: 700 });

    await doVoid();

    expect(target.paid).toBe(0);
    expect(target.due).toBe(1000);
    expect(target.status).toBe('unpaid');
  });

  it('refuses a second void rather than reversing twice', async () => {
    // Idempotent by refusal, not by silence: a double-tapped button on a slow
    // connection must not credit the account twice, and a caller told "already
    // voided" learns something true.
    voidStub({ status: 'cancelled' });

    await expect(doVoid()).rejects.toMatchObject({ statusCode: 400 });
    expect(accountDeltas).toHaveLength(0);
  });

  it('refuses when the bill was cancelled — that already reversed it', async () => {
    const target = bill({ invoiceNo: 'PUR-1', totalAmount: 1000, paid: 700, date: new Date() });
    target.status = 'cancelled';
    jest.spyOn(Purchase, 'findOne').mockResolvedValue(target);
    voidStub({ purchase: target._id, amount: 700 });

    await expect(doVoid()).rejects.toMatchObject({ statusCode: 400 });
  });

  it('demands a reason', async () => {
    // A reversal nobody can explain next month is indistinguishable from a
    // mistake.
    voidStub({});
    await expect(doVoid('   ')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('will not void a customer collection through this door', async () => {
    const doc = voidStub({});
    doc.type = 'due_collection';
    await expect(doVoid()).rejects.toMatchObject({ statusCode: 400 });
  });
});
