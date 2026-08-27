/**
 * Cancelling a purchase unwinds the money that was paid against it later.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `cancelPurchase` reversed stock, batches, prices, the checkout legs and the
 * supplier rollups — and left every `recordPayment` row standing: the Payment
 * rows survived, their account debits were never credited back, and the cash
 * register kept counting money the drawer had (notionally) got back. The
 * supplier arithmetic already assumed those payments unwound (it subtracts the
 * CURRENT due and the FULL paid), so the missing half was exactly two writes:
 * void the rows, refund the accounts.
 *
 * Post-cancel the books must read "this bill never happened, the money went
 * back to the drawer" — supplier at zero on BOTH books, accounts restored.
 *
 * ── The multi-bill decision (F-4) ────────────────────────────────────────────
 *
 * A payment that settled SEVERAL bills is not unwound piecemeal: voiding the
 * whole row claws back money that legitimately settled other live bills, and
 * shrinking the row makes `amount` misstate what was handed over. So a
 * purchase entangled in a multi-bill payment — as its named bill or as an
 * allocation target — refuses to cancel, in Bangla, until that payment is
 * voided first.
 *
 * REGRESSION TESTS unless marked otherwise: against the old service the void
 * cases find the Payment rows still active and the accounts still short.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue([{}]),
}));
jest.mock('../utils/transaction.util', () => ({
  runInTransaction: (cb) => cb(null),
}));

const mongoose = require('mongoose');
const purchaseService = require('../services/purchase.service');
const paymentAccountService = require('../services/paymentAccount.service');
const Purchase = require('../models/Purchase.model');
const Product = require('../models/Product.model');
const StockTransaction = require('../models/StockTransaction.model');
const Supplier = require('../models/Supplier.model');
const SupplierBalance = require('../models/SupplierBalance.model');
const Payment = require('../models/Payment.model');

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const SUPPLIER = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();
const PURCHASE_ID = new mongoose.Types.ObjectId();
const OTHER_PURCHASE = new mongoose.Types.ObjectId();
const LEG_ACCOUNT = new mongoose.Types.ObjectId();
const PAY_ACCOUNT = new mongoose.Types.ObjectId();

/**
 * The bill being cancelled: ৳100 total, ৳30 cash at the counter (one leg),
 * ৳50 paid later through `recordPayment`, ৳20 still due. Items empty — the
 * stock reversal has its own suites; this one is about the money.
 */
function stubPurchase(overrides = {}) {
  const doc = {
    _id: PURCHASE_ID,
    shop: SHOP,
    branch: BRANCH,
    supplier: SUPPLIER,
    invoiceNo: 'PUR-X',
    items: [],
    totalAmount: 100,
    paid: 80,
    due: 20,
    status: 'partial',
    payments: [{ method: 'cash', amount: 30, account: LEG_ACCOUNT }],
    save: jest.fn().mockImplementation(function () {
      // Mirror Purchase.pre('save'): a cancelled doc keeps its status.
      this.due = Math.max(0, this.totalAmount - this.paid);
      if (this.status !== 'cancelled') {
        this.status = this.due === 0 ? 'completed' : this.paid > 0 ? 'partial' : 'unpaid';
      }
      return Promise.resolve(this);
    }),
    ...overrides,
  };
  jest.spyOn(Purchase, 'findOne').mockReturnValue({ session: () => Promise.resolve(doc) });
  return doc;
}

/** A live purchase_payment row written by `recordPayment`. */
function paymentRow(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    shop: SHOP,
    purchase: PURCHASE_ID,
    type: 'purchase_payment',
    amount: 50,
    account: PAY_ACCOUNT,
    status: 'active',
    allocations: [],
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** First find → this bill's own rows; second find → inbound allocations. */
function stubPaymentFinds({ later = [], inbound = [] } = {}) {
  jest.spyOn(Payment, 'find').mockImplementation((filter) => ({
    session: () => Promise.resolve(filter['allocations.purchase'] ? inbound : later),
  }));
}

/**
 * The two supplier books, kept as real arithmetic rather than bare spies, so
 * the Σ SupplierBalance.totalDue === Supplier.totalDue invariant (PURCHASE_PLAN
 * §9) is asserted on actual numbers, not on calls having happened.
 */
let supplierDoc;
let balanceRow;
let accountDeltas;

beforeEach(() => {
  accountDeltas = [];

  supplierDoc = {
    _id: SUPPLIER,
    totalPurchases: 1,
    totalAmount: 100,
    totalDue: 20, // after the ৳50 later payment
    save: jest.fn().mockResolvedValue(undefined),
  };
  jest.spyOn(Supplier, 'findById').mockReturnValue({ session: () => Promise.resolve(supplierDoc) });

  balanceRow = { totalAmount: 100, totalPaid: 80, totalDue: 20, openingDue: 0, purchaseCount: 1 };
  jest.spyOn(SupplierBalance, 'applyDelta').mockImplementation(async (d) => {
    balanceRow.totalAmount += d.amount || 0;
    balanceRow.totalPaid += d.paid || 0;
    balanceRow.totalDue += d.due || 0;
    balanceRow.purchaseCount += d.count || 0;
  });
  jest.spyOn(SupplierBalance, 'recomputeDue').mockImplementation(async () => {
    balanceRow.totalDue = Math.max(
      0,
      balanceRow.totalAmount + balanceRow.openingDue - balanceRow.totalPaid
    );
    return balanceRow;
  });

  jest.spyOn(Product, 'find').mockReturnValue({ session: () => Promise.resolve([]) });
  jest.spyOn(Product, 'bulkWrite').mockResolvedValue({});
  jest.spyOn(StockTransaction, 'insertMany').mockResolvedValue([]);
  jest.spyOn(paymentAccountService, 'applyAccountDelta').mockImplementation(async (d) => {
    accountDeltas.push(d);
  });
});

afterEach(() => jest.restoreAllMocks());

const cancel = (options) =>
  purchaseService.cancelPurchase(SHOP, USER, PURCHASE_ID, null, options);

/* ════════════════════════════════════════════════════════════════════════════
 * The unwind
 * ════════════════════════════════════════════════════════════════════════════ */

describe('cancelPurchase voids the later payments and refunds their accounts', () => {
  it('marks each live purchase_payment row cancelled, never deleted', async () => {
    stubPurchase();
    const row = paymentRow();
    stubPaymentFinds({ later: [row] });

    await cancel();

    expect(row.status).toBe('cancelled');
    expect(row.cancelledBy).toBe(USER);
    expect(row.cancelledAt).toBeInstanceOf(Date);
    expect(row.cancelReason).toContain('ক্রয় বাতিল');
    expect(row.save).toHaveBeenCalled();
  });

  it('credits back the checkout legs AND each voided payment\'s account', async () => {
    stubPurchase();
    stubPaymentFinds({ later: [paymentRow()] });

    await cancel();

    // ৳30 back into the leg's account, ৳50 back into the payment's — the
    // drawer ends exactly where it was before this bill existed.
    expect(accountDeltas).toEqual([
      expect.objectContaining({ account: LEG_ACCOUNT, amount: 30 }),
      expect.objectContaining({ account: PAY_ACCOUNT, amount: 50 }),
    ]);
  });

  it('leaves the supplier books at "this bill never happened" on BOTH sides', async () => {
    stubPurchase();
    stubPaymentFinds({ later: [paymentRow()] });

    await cancel();

    // Shop-wide rollup back to zero.
    expect(supplierDoc.totalAmount).toBe(0);
    expect(supplierDoc.totalDue).toBe(0);
    expect(supplierDoc.totalPurchases).toBe(0);

    // Branch ledger back to zero — and the §9 invariant holds:
    // Σ SupplierBalance.totalDue === Supplier.totalDue.
    expect(balanceRow.totalAmount).toBe(0);
    expect(balanceRow.totalPaid).toBe(0);
    expect(balanceRow.totalDue).toBe(supplierDoc.totalDue);
  });

  it('records who cancelled, when, and the stated reason (F-6)', async () => {
    const purchase = stubPurchase();
    stubPaymentFinds();

    await cancel({ reason: 'ভুল সরবরাহকারীর নামে এন্ট্রি' });

    expect(purchase.status).toBe('cancelled');
    expect(purchase.cancelledAt).toBeInstanceOf(Date);
    expect(purchase.cancelledBy).toBe(USER);
    expect(purchase.cancelReason).toBe('ভুল সরবরাহকারীর নামে এন্ট্রি');
  });

  it('changes nothing else for a bill with no later payments', async () => {
    // INVARIANT GUARD — the pre-existing unwind must be byte-identical when
    // there is nothing new to unwind.
    stubPurchase();
    stubPaymentFinds();

    await cancel();

    expect(accountDeltas).toEqual([
      expect.objectContaining({ account: LEG_ACCOUNT, amount: 30 }),
    ]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * The multi-bill refusal
 * ════════════════════════════════════════════════════════════════════════════ */

describe('a purchase entangled in a multi-bill payment refuses to cancel', () => {
  it('refuses when its own payment also settled other bills', async () => {
    stubPurchase();
    const row = paymentRow({
      amount: 500,
      allocations: [
        { purchase: PURCHASE_ID, amount: 200 },
        { purchase: OTHER_PURCHASE, amount: 300 },
      ],
    });
    stubPaymentFinds({ later: [row] });

    await expect(cancel()).rejects.toMatchObject({
      statusCode: 400,
      messageBn: 'এই ক্রয়ের পেমেন্ট অন্য বিলের সাথে ভাগ হয়ে আছে — আগে পেমেন্টটি বাতিল করুন',
    });

    // Refused BEFORE anything moved.
    expect(row.status).toBe('active');
    expect(accountDeltas).toEqual([]);
    expect(Product.find).not.toHaveBeenCalled();
  });

  it('refuses when another bill\'s payment allocated money onto this one', async () => {
    stubPurchase();
    const inboundRow = paymentRow({
      purchase: OTHER_PURCHASE,
      allocations: [
        { purchase: OTHER_PURCHASE, amount: 100 },
        { purchase: PURCHASE_ID, amount: 400 },
      ],
    });
    stubPaymentFinds({ inbound: [inboundRow] });

    await expect(cancel()).rejects.toMatchObject({ statusCode: 400 });
    expect(accountDeltas).toEqual([]);
  });

  it('does NOT refuse a payment whose allocations only name this bill', async () => {
    // A single-bill payment that happens to carry its own allocation row is
    // this bill's money and unwinds normally.
    stubPurchase();
    const row = paymentRow({ allocations: [{ purchase: PURCHASE_ID, amount: 50 }] });
    stubPaymentFinds({ later: [row] });

    await cancel();

    expect(row.status).toBe('cancelled');
  });
});
