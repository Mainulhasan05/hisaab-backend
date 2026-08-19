/**
 * Khata money must come off the invoices that hold the debt.
 *
 * ── The bug ──────────────────────────────────────────────────────────────────
 *
 * A customer bought ৳7,000 of goods and paid ৳2,800, leaving invoice
 * HFG202600403 at `due: 4200, status: 'partial'`. They then paid the ৳4,200 off
 * in two instalments — ৳2,000 as বাকি আদায় on the customer page, ৳2,200 as
 * surplus tendered at a later checkout. Their customer page read ৳0 owed.
 *
 * HFG202600403 still read `due: 4200, status: 'partial'`, and did so for as long
 * as the shop kept the record.
 *
 * `settleCustomerDue` moved `Customer.totalDue`, the `CustomerBalance` rows, the
 * fund account and wrote the `Payment` row — five correct writes — and never
 * touched a `Sale`. So the shop's TWO answers to "how much is owed" diverged by
 * exactly the sum of every khata collection ever taken, and the invoice-side
 * answer is the one that ten aggregations report as "মোট বাকি".
 *
 * ── Groups ───────────────────────────────────────────────────────────────────
 *
 *   A. THE ALLOCATION ITSELF — REGRESSION. The customer above, end to end.
 *      Oldest invoice first, nothing over-allocated, idempotent on re-run.
 *
 *   B. `paid` IS NOT WHERE THIS GOES — REGRESSION, and the subtle one.
 *      `cancelSale` unwinds exactly `-sale.paid` from the customer's ledger. If
 *      khata money were folded into `paid`, cancelling whichever invoice it
 *      happened to land on would claw back money the customer really handed
 *      over, while its immutable `due_collection` row sat there proving they
 *      had. Three terms, three meanings.
 *
 *   C. SEPARATE BOOKS — GUARD. Under `customerScope: 'branch'` a collection
 *      must not close another branch's invoice. `settleCustomerDue` already
 *      refuses to let a cashier do that by hand; the allocator must not do it
 *      behind their back, and it takes no `req` to read the flag off.
 *
 *   D. CHEAP WHEN THERE IS NOTHING TO DO — INVARIANT. This runs on every
 *      `recordPayment`, cancellation and return. For a customer who has never
 *      had a khata collection it must cost one indexed aggregate and stop.
 */

jest.mock('../services/paymentAccount.service', () => ({
  applyAccountDelta: jest.fn().mockResolvedValue(undefined),
  resolveAccountForMethod: jest.fn().mockResolvedValue(null),
  assertUsableAccount: jest.fn().mockResolvedValue({ _id: 'ACCOUNT_ID' }),
}));

const mongoose = require('mongoose');

const dueSettlement = require('../services/dueSettlement.service');
const Payment = require('../models/Payment.model');
const Sale = require('../models/Sale.model');
const Shop = require('../models/Shop.model');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const { computeInvoiceTotals } = require('../utils/invoiceMath.util');

const SHOP = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();
const BRANCH_A = new mongoose.Types.ObjectId();
const BRANCH_B = new mongoose.Types.ObjectId();

/**
 * A stand-in Sale, opened at whatever figures the case needs.
 *
 * Its `due` is derived through the REAL `computeInvoiceTotals` rather than by
 * reimplementing the arithmetic: the whole point of those helpers
 * is that there is one definition, and a test that carried its own copy would
 * keep passing after the real one drifted. See invoiceMath.util.js's header.
 */
const stubSale = ({ invoiceNo, total, paid = 0, returnedAdjustment = 0, ledgerSettled = 0, branch = null, createdAt }) => {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    invoiceNo,
    branch,
    total,
    paid,
    returnedAdjustment,
    ledgerSettled,
    createdAt: createdAt || new Date(),
    saleDate: null,
    status: 'partial',
  };
  doc.due = computeInvoiceTotals({ subtotal: total, paid, returnedAdjustment, ledgerSettled }).due;
  return doc;
};

/**
 * `Sale.updateOne` applied to whichever stub doc it names.
 *
 * The allocator writes by update rather than `save()`: `Sale.pre('save')`
 * re-derives every figure from `this.items`, so saving would mean loading the
 * full line items of every one of a customer's invoices to move a single number
 * on some of them — on a path that runs at every checkout payment, cancellation
 * and return. Applying the `$set` here is what lets these tests assert the
 * RESULTING invoice rather than the shape of the call.
 */
const stubUpdate = (docs) =>
  jest.spyOn(Sale, 'updateOne').mockImplementation(async (filter, update) => {
    const doc = docs.find((d) => String(d._id) === String(filter._id));
    if (doc) Object.assign(doc, update.$set);
    return { modifiedCount: 1 };
  });

/** `Sale.find(...).sort(...)` returning the given docs. */
const stubFind = (sales) =>
  jest.spyOn(Sale, 'find').mockReturnValue({ sort: () => sales });

/** `Σ due_collection`, grouped by branch, as the aggregate returns it. */
const stubPool = (rows) => jest.spyOn(Payment, 'aggregate').mockResolvedValue(rows);

const stubShop = ({ multiBranch = false, scope = 'shop' } = {}) =>
  jest.spyOn(Shop, 'findById').mockReturnValue({
    session: () => ({ lean: async () => ({ multiBranchEnabled: multiBranch, customerScope: scope }) }),
  });

/** The pre-software খাতা balance, shop-wide or per branch. */
const stubOpening = (opening) => {
  if (typeof opening === 'number') {
    return jest.spyOn(Customer, 'findById').mockReturnValue({
      session: () => ({ lean: async () => ({ openingDue: opening }) }),
    });
  }
  // Per branch: { [branchId]: amount }
  return jest.spyOn(CustomerBalance, 'find').mockResolvedValue(
    Object.entries(opening).map(([branch, openingDue]) => ({ branch, openingDue }))
  );
};

beforeEach(() => {
  // No pre-software debt unless a case says otherwise, which is the state every
  // customer created inside the app is in.
  stubOpening(0);
  jest.spyOn(CustomerBalance, 'find').mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());

/* ════════════════════════════════════════════════════════════════════════
 * A. THE ALLOCATION
 * ════════════════════════════════════════════════════════════════════════ */
describe('A. khata money lands on the invoices that hold the debt', () => {
  it('closes the invoice the customer actually owed on', async () => {
    // The reported case, exactly: ৳7,000 invoice, ৳2,800 paid at the till,
    // ৳4,200 collected afterwards across two khata payments.
    const inv = stubSale({ invoiceNo: 'HFG202600403', total: 7000, paid: 2800 });
    expect(inv.due).toBe(4200);

    stubPool([{ _id: null, total: 4200 }]);
    stubFind([inv]);
    stubUpdate([inv]);
    stubShop();

    const applied = await dueSettlement.reallocateCustomerInvoices({
      shopId: SHOP, customerId: CUSTOMER,
    });

    expect(inv.ledgerSettled).toBe(4200);
    expect(inv.due).toBe(0);
    expect(inv.status).toBe('completed');
    expect(applied).toEqual([
      expect.objectContaining({ invoiceNo: 'HFG202600403', applied: 4200, dueBefore: 4200, dueAfter: 0, cleared: true }),
    ]);
  });

  it('fills the oldest invoice first and stops when the money runs out', async () => {
    // "পুরোনো বাকি আগে শোধ" — the same order `CustomerBalance.settleDue`
    // allocates on the rollup side, so the two books agree about which debt is
    // gone rather than only about the total.
    const older = stubSale({ invoiceNo: 'A-1', total: 3000, createdAt: new Date('2026-01-01') });
    const newer = stubSale({ invoiceNo: 'A-2', total: 3000, createdAt: new Date('2026-06-01') });

    stubPool([{ _id: null, total: 4000 }]);
    stubFind([older, newer]);
    stubUpdate([older, newer]);
    stubShop();

    await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: CUSTOMER });

    expect(older.due).toBe(0);
    expect(newer.ledgerSettled).toBe(1000);
    expect(newer.due).toBe(2000);
  });

  it('leaves the surplus unallocated rather than inventing an invoice for it', async () => {
    // Collections beyond what the open invoices can absorb are settling
    // `openingDue` — the pre-software খাতা figure, which has no invoice behind
    // it. `Customer.deriveDue` already carries that term.
    const inv = stubSale({ invoiceNo: 'A-3', total: 1000 });

    stubPool([{ _id: null, total: 5000 }]);
    stubFind([inv]);
    stubUpdate([inv]);
    stubShop();

    await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: CUSTOMER });

    expect(inv.ledgerSettled).toBe(1000);   // not 5000
    expect(inv.due).toBe(0);
  });

  it('is idempotent — a second pass writes nothing', async () => {
    // THE PROPERTY THE WHOLE DESIGN RESTS ON. This is a recompute called from
    // four services on every collection, cancellation, return and payment. If
    // re-running it moved anything, those call sites would need reversal
    // arithmetic of their own and would drift — which is the bug being fixed.
    const inv = stubSale({ invoiceNo: 'A-4', total: 5000, paid: 1000 });

    stubPool([{ _id: null, total: 4000 }]);
    stubFind([inv]);
    const write = stubUpdate([inv]);
    stubShop();

    const first = await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: CUSTOMER });
    expect(first).toHaveLength(1);
    expect(write).toHaveBeenCalledTimes(1);

    const second = await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: CUSTOMER });
    expect(second).toEqual([]);
    expect(write).toHaveBeenCalledTimes(1);   // not written a second time
  });

  it('gives money back when an invoice can no longer hold it', async () => {
    // A return, or a direct `recordPayment`, shrinks what an invoice can
    // absorb. The freed amount has to move to the next open invoice — left
    // where it was, the pre-save clamp would silently discard it and the drift
    // would come straight back.
    const first = stubSale({ invoiceNo: 'A-5', total: 4000, ledgerSettled: 4000, createdAt: new Date('2026-01-01') });
    const second = stubSale({ invoiceNo: 'A-6', total: 4000, createdAt: new Date('2026-02-01') });
    first.paid = 3000;   // settled directly after the allocation was made

    stubPool([{ _id: null, total: 4000 }]);
    stubFind([first, second]);
    stubUpdate([first, second]);
    stubShop();

    await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: CUSTOMER });

    expect(first.ledgerSettled).toBe(1000);   // all it can still hold
    expect(second.ledgerSettled).toBe(3000);  // the rest moved on
  });

  it('settles the পুরোনো খাতা before any invoice', async () => {
    // REGRESSION, and the one that is wrong in two directions at once.
    //
    // ৳11,000 of pre-software debt, one ৳260 invoice, ৳5,000 collected. Opening
    // debt predates every invoice by construction, so oldest-first spends the
    // whole ৳5,000 on it — the customer has paid down the খাতা, not last week's
    // bill, and the aging report is the screen that reads the difference.
    const inv = stubSale({ invoiceNo: 'A-7', total: 260 });

    stubPool([{ _id: null, total: 5000 }]);
    stubFind([inv]);
    stubUpdate([inv]);
    stubShop();
    stubOpening(11000);

    const applied = await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: CUSTOMER });

    expect(inv.ledgerSettled).toBe(0);
    expect(inv.due).toBe(260);
    expect(applied).toEqual([]);
  });

  it('spends what is left over after the খাতা on the invoices', async () => {
    // The other half of the rule: opening debt takes its share and no more.
    const inv = stubSale({ invoiceNo: 'A-8', total: 4000 });

    stubPool([{ _id: null, total: 5000 }]);
    stubFind([inv]);
    stubUpdate([inv]);
    stubShop();
    stubOpening(1000);

    await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: CUSTOMER });

    expect(inv.ledgerSettled).toBe(4000);
    expect(inv.due).toBe(0);
  });

  it('does not let leftover khata money settle a future sale', async () => {
    // THE FAILURE THE RULE ABOVE PREVENTS. A customer with ৳11,000 of opening
    // debt pays ৳5,000, clearing part of the খাতা and leaving nothing for any
    // invoice. They then buy ৳3,000 on বাকি.
    //
    // Without opening-first, that ৳5,000 sits unallocated in the pool and the
    // NEXT recompute — triggered by anything, days later — hands ৳3,000 of it to
    // the new invoice. The shopkeeper sells on credit and the bill reads
    // "পুরো পেয়েছি" with no payment behind it and nothing to connect it to.
    const future = stubSale({ invoiceNo: 'A-9', total: 3000, createdAt: new Date('2026-08-19') });

    stubPool([{ _id: null, total: 5000 }]);
    stubFind([future]);
    stubUpdate([future]);
    stubShop();
    stubOpening(11000);

    await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: CUSTOMER });

    expect(future.ledgerSettled).toBe(0);
    expect(future.due).toBe(3000);
    expect(future.status).toBe('partial');   // untouched by the allocator
  });

  it('never allocates onto a cancelled invoice', async () => {
    // Asserted at the query, because a cancelled sale is not a receivable and
    // hiding money on one is indistinguishable from losing it.
    const find = stubFind([]);
    stubUpdate([]);
    stubPool([{ _id: null, total: 1000 }]);
    stubShop();

    await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: CUSTOMER });

    expect(find.mock.calls[0][0]).toMatchObject({ status: { $ne: 'cancelled' } });
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * B. IT IS NOT `paid`
 * ════════════════════════════════════════════════════════════════════════ */
describe('B. khata money never becomes sale.paid', () => {
  it('leaves `paid` exactly where it was', async () => {
    // REGRESSION. `cancelSale` unwinds `-sale.paid` from the customer's ledger.
    // Folding a ৳4,200 khata collection into this invoice's `paid` would make
    // cancelling it subtract ৳4,200 the customer genuinely paid — and the
    // `Payment{due_collection}` row is immutable, so the money would exist in
    // one book and not the other, permanently.
    const inv = stubSale({ invoiceNo: 'B-1', total: 7000, paid: 2800 });

    stubPool([{ _id: null, total: 4200 }]);
    stubFind([inv]);
    stubUpdate([inv]);
    stubShop();

    await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: CUSTOMER });

    expect(inv.paid).toBe(2800);          // untouched
    expect(inv.ledgerSettled).toBe(4200); // it went here instead
  });

  it('reads `partial`, not `unpaid`, on an invoice cleared only by khata money', async () => {
    // A shopkeeper looking at 'unpaid' calls the customer. This one has paid.
    const inv = stubSale({ invoiceNo: 'B-2', total: 5000, paid: 0 });

    stubPool([{ _id: null, total: 2000 }]);
    stubFind([inv]);
    stubUpdate([inv]);
    stubShop();

    await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: CUSTOMER });

    expect(inv.due).toBe(3000);
    expect(inv.status).toBe('partial');
  });

  it('respects a return that has already come off the due', async () => {
    // `returnedAdjustment` is the other non-tendered reducer. Both come off, and
    // neither may push the due below zero.
    const inv = stubSale({ invoiceNo: 'B-3', total: 5000, paid: 1000, returnedAdjustment: 1500 });
    expect(inv.due).toBe(2500);

    stubPool([{ _id: null, total: 9999 }]);
    stubFind([inv]);
    stubUpdate([inv]);
    stubShop();

    await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: CUSTOMER });

    expect(inv.ledgerSettled).toBe(2500);
    expect(inv.due).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C. SEPARATE BOOKS
 * ════════════════════════════════════════════════════════════════════════ */
describe('C. a branch cannot write down another branch\'s invoice', () => {
  it('keeps each branch\'s pool on its own invoices under separate books', async () => {
    const atA = stubSale({ invoiceNo: 'C-A', total: 5000, branch: BRANCH_A });
    const atB = stubSale({ invoiceNo: 'C-B', total: 5000, branch: BRANCH_B });

    // ৳3,000 collected at A only. B collected nothing.
    stubPool([{ _id: BRANCH_A, total: 3000 }]);
    stubFind([atA, atB]);
    stubUpdate([atA, atB]);
    stubShop({ multiBranch: true, scope: 'branch' });

    await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: CUSTOMER });

    expect(atA.due).toBe(2000);
    expect(atB.due).toBe(5000);   // untouched — B is owed what B is owed
  });

  it('pools every branch together under shared books', async () => {
    // One book is precisely what shared means, and `CustomerBalance.settleDue`
    // already spreads the rollup side across branches for the same reason.
    const atA = stubSale({ invoiceNo: 'C-A2', total: 5000, branch: BRANCH_A, createdAt: new Date('2026-01-01') });
    const atB = stubSale({ invoiceNo: 'C-B2', total: 5000, branch: BRANCH_B, createdAt: new Date('2026-02-01') });

    stubPool([{ _id: BRANCH_A, total: 3000 }, { _id: BRANCH_B, total: 4000 }]);
    stubFind([atA, atB]);
    stubUpdate([atA, atB]);
    stubShop({ multiBranch: true, scope: 'shop' });

    await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: CUSTOMER });

    expect(atA.due).toBe(0);      // ৳5,000 of the ৳7,000 pool, oldest first
    expect(atB.due).toBe(3000);   // the remaining ৳2,000
  });

  it('resolves the book mode itself when the caller cannot say', async () => {
    // GUARD. `cancelSale`, `recordPayment` and the returns path take a bare
    // `shopId` and have no `req` to read the flag off. A parameter defaulting
    // to `false` would have made shared-book allocation the silent default for
    // exactly those callers — re-spreading one branch's money across another's
    // invoices, which is what group C exists to prevent.
    const shop = stubShop({ multiBranch: true, scope: 'branch' });
    stubPool([{ _id: BRANCH_A, total: 1000 }]);
    stubFind([]);
    stubUpdate([]);

    await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: CUSTOMER });

    expect(shop).toHaveBeenCalled();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * D. COST WHEN IDLE
 * ════════════════════════════════════════════════════════════════════════ */
describe('D. costs nothing for a customer with no khata collections', () => {
  it('stops at the pool query', async () => {
    // INVARIANT. This runs on every `recordPayment`, cancellation and return.
    // The overwhelming majority of customers have never had a khata collection
    // taken, and for them the answer is "nothing to allocate" — one indexed
    // aggregate on {shop, customer}, no shop lookup, no invoice scan, no write.
    const pool = stubPool([]);
    const find = stubFind([]);
    stubUpdate([]);
    const shop = stubShop();

    const applied = await dueSettlement.reallocateCustomerInvoices({
      shopId: SHOP, customerId: CUSTOMER,
    });

    expect(applied).toEqual([]);
    expect(pool).toHaveBeenCalledTimes(1);
    expect(find).not.toHaveBeenCalled();
    expect(shop).not.toHaveBeenCalled();
  });

  it('does nothing at all for a walk-in', async () => {
    const pool = stubPool([]);
    const applied = await dueSettlement.reallocateCustomerInvoices({ shopId: SHOP, customerId: null });
    expect(applied).toEqual([]);
    expect(pool).not.toHaveBeenCalled();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * E. THE WIRING
 * ════════════════════════════════════════════════════════════════════════ */
describe('E. every collection runs the allocation', () => {
  it('settleCustomerDue allocates and reports where the money went', async () => {
    // The join between the rollup writes (already tested in
    // dueSettlementAtCheckout) and the invoice writes (group A). Without it,
    // the five correct writes stay correct and the invoices stay frozen —
    // which is the entire bug.
    const inv = stubSale({ invoiceNo: 'E-1', total: 7000, paid: 2800 });

    jest.spyOn(Payment, 'create').mockResolvedValue([{ _id: new mongoose.Types.ObjectId() }]);
    jest.spyOn(CustomerBalance, 'settleDue').mockResolvedValue([]);
    stubPool([{ _id: null, total: 4200 }]);
    stubFind([inv]);
    stubUpdate([inv]);
    stubShop();

    const customer = {
      _id: CUSTOMER, totalDue: 4200, totalPaid: 2800,
      save: jest.fn().mockResolvedValue(undefined),
    };

    const result = await dueSettlement.settleCustomerDue({
      shopId: SHOP,
      userId: new mongoose.Types.ObjectId(),
      customer,
      amount: 4200,
      branchId: null,
    });

    expect(customer.totalDue).toBe(0);
    expect(inv.due).toBe(0);
    expect(result.allocations).toEqual([
      expect.objectContaining({ invoiceNo: 'E-1', cleared: true }),
    ]);
  });
});
