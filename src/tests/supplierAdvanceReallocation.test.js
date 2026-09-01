/**
 * অগ্রিম দেওয়া — keeping the BILLS and the VENDOR telling the same story.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CASE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Purchase.advanceApplied` is the fourth term in a bill's `due`. Phase G
 * shipped it written in exactly ONE place — at bill creation — and never
 * revisited. That is the mistake `reallocateCustomerInvoices` exists to avoid,
 * and its header names it in one line: AN ALLOCATION IS NOT AN EVENT.
 *
 * The failure it produced was not subtle. A vendor holding ৳1,00,000 of the
 * shop's money delivers ৳35,200 and then ৳20,000 of goods; both challans are
 * covered, so both read `due: 0, status: 'completed'`. The owner then finds the
 * advance was keyed against the wrong vendor and voids it.
 * `voidSupplierPayment` correctly re-raises `Supplier.totalDue` to ৳55,200 —
 * and touches no bill, because an advance row carries neither `allocations` nor
 * a `purchase`. The vendor position said ৳55,200 was owed, `Σ Purchase.due`
 * said ৳0, and the two challans holding that debt were marked COMPLETED, which
 * is the part that made it unrecoverable at the counter: nobody would ever open
 * them to pay.
 *
 * SUPPLIER_DUE_ADVANCE_PLAN.md P5 predicted it — "Phase G owes the other half".
 *
 * Groups (AGENT_WORKFLOW.md §7.1):
 *
 *   A. THE POOL — what counts as the vendor's unspent prepayment, and what
 *      must never be counted twice.
 *   B. THE SPREAD — oldest bill first, each up to what it can actually hold.
 *   C. THE RESET — the case the whole function exists for: money leaving the
 *      pool must come OFF the bills it was sitting on.
 *   D. THE CEILING IS SHARED — the allocator and the `due` hook must reach the
 *      same number, or money disappears between them in silence.
 *   E. THE DOORS — every path that moves the pool or a bill's capacity calls it.
 */

const mongoose = require('mongoose');
const fs = require('fs');
const Purchase = require('../models/Purchase.model');
const Supplier = require('../models/Supplier.model');
const Payment = require('../models/Payment.model');
const { reallocateSupplierAdvance } = require('../services/supplierSettlement.service');

const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8');

const SHOP = new mongoose.Types.ObjectId();
const SUPPLIER = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();

/**
 * A bill that runs the REAL pre-save hook on save.
 *
 * The whole point of this suite is that the allocator and the `due` derivation
 * agree, so stubbing the derivation would test nothing. `save()` here fires the
 * same hook the database path does and leaves the document holding what would
 * have been stored.
 */
const stubBill = ({ invoiceNo, totalAmount, paid = 0, returnedAmount = 0, advanceApplied = 0, date }) => {
  const doc = new Purchase({
    shop: SHOP, branch: BRANCH, supplier: SUPPLIER, supplierName: 'রহিম ট্রেডার্স',
    invoiceNo, items: [], totalAmount, paid, returnedAmount, advanceApplied,
    date: date || new Date('2026-01-01'),
  });
  const hooks = Purchase.schema.s.hooks._pres.get('save') || [];
  const fire = () => hooks.forEach((h) => h.fn.call(doc, () => {}));
  fire();
  doc.save = jest.fn(async () => { fire(); return doc; });
  return doc;
};

/** The vendor's live prepayment rows, as one summed pool. */
const stubPool = (total) => {
  jest.spyOn(Payment, 'aggregate').mockResolvedValue(total > 0 ? [{ _id: null, total }] : []);
};

/** The bill queue, already ordered as the real `.sort()` would leave it. */
const stubBills = (bills) => {
  jest.spyOn(Purchase, 'find').mockReturnValue({
    sort: () => ({ session: () => Promise.resolve(bills) }),
  });
};

const run = () => reallocateSupplierAdvance(
  { shopId: SHOP, supplierId: SUPPLIER, branchId: BRANCH }, null
);

afterEach(() => jest.restoreAllMocks());

/* ── A. THE POOL ──────────────────────────────────────────────────────────── */

describe('the pool is the gross অগ্রিম, and only the live rows', () => {
  it('reads supplier_advance rows, never Supplier.advanceBalance', () => {
    /**
     * `advanceBalance` is what is LEFT after the bills took their share.
     * Spreading that over the same bills again would credit them twice. The
     * pool is the gross, and what the bills cannot absorb is exactly what
     * `advanceBalance` then reports — the two agree by construction rather than
     * by maintenance.
     */
    const src = read('../services/supplierSettlement.service');
    expect(src).toContain('PAYMENT_TYPES.SUPPLIER_ADVANCE');
    expect(src).toContain('The pool is the GROSS advance, not `Supplier.advanceBalance`');
  });

  it('excludes a voided advance with $ne, not an equality test', async () => {
    // Rows written before `status` existed carry none at all. `status: 'active'`
    // would exclude every one of them, emptying the pool and un-allocating
    // every prepayment the shop ever made.
    stubPool(0);
    stubBills([]);
    await run();
    const [[pipeline]] = Payment.aggregate.mock.calls;
    expect(pipeline[0].$match.status).toEqual({ $ne: 'cancelled' });
    expect(pipeline[0].$match.type).toBe('supplier_advance');
  });

  it('scopes both halves to one branch', async () => {
    // Matching `settleSupplierDue`, which already refuses to let a payment at
    // one branch write down another branch's payable. An advance is a payment
    // made early; it does not get a wider reach for being early.
    stubPool(0);
    stubBills([]);
    await run();
    const [[pipeline]] = Payment.aggregate.mock.calls;
    expect(String(pipeline[0].$match.branch)).toBe(String(BRANCH));
    expect(String(Purchase.find.mock.calls[0][0].branch)).toBe(String(BRANCH));
  });

  it('costs one aggregate and no bill write for a vendor nobody prepaid', async () => {
    // The overwhelming majority of purchases on the platform. An empty pool and
    // no bill carrying a stale share must leave without touching anything.
    stubPool(0);
    const bill = stubBill({ invoiceNo: 'P-1', totalAmount: 5000 });
    stubBills([bill]);

    expect(await run()).toEqual([]);
    expect(bill.save).not.toHaveBeenCalled();
  });
});

/* ── B. THE SPREAD ────────────────────────────────────────────────────────── */

describe('oldest bill first, each up to what it can hold', () => {
  it('covers what it can and leaves the rest as the vendor position', async () => {
    // ৳1,00,000 prepaid, ৳55,200 of goods delivered across two challans.
    const b1 = stubBill({ invoiceNo: 'P-1', totalAmount: 35200, date: new Date('2026-01-01') });
    const b2 = stubBill({ invoiceNo: 'P-2', totalAmount: 20000, date: new Date('2026-02-01') });
    stubPool(100000);
    stubBills([b1, b2]);

    const changed = await run();

    expect(b1.advanceApplied).toBe(35200);
    expect(b1.due).toBe(0);
    expect(b2.advanceApplied).toBe(20000);
    expect(b2.due).toBe(0);
    expect(changed.map((c) => c.invoiceNo)).toEqual(['P-1', 'P-2']);

    // And the leftover is exactly what the vendor is still holding.
    const supplier = { totalAmount: 55200, openingDue: 0, totalPaid: 100000 };
    Supplier.applyBalances(supplier);
    expect(supplier.advanceBalance).toBe(100000 - 35200 - 20000);
    expect(supplier.totalDue).toBe(0);
  });

  it('stops at the pool and leaves the older bill the winner', async () => {
    // ৳25,000 of prepayment against ৳55,200 of goods. The OLDEST challan is
    // covered first — "পুরোনো বাকি আগে শোধ" — and the newer one keeps the debt.
    const b1 = stubBill({ invoiceNo: 'P-1', totalAmount: 35200 });
    const b2 = stubBill({ invoiceNo: 'P-2', totalAmount: 20000 });
    stubPool(25000);
    stubBills([b1, b2]);

    await run();

    expect(b1.advanceApplied).toBe(25000);
    expect(b1.due).toBe(10200);
    expect(b2.advanceApplied).toBe(0);
    expect(b2.due).toBe(20000);
  });

  it('never lets a bill take more than it still owes', async () => {
    // Half the bill was settled in cash at the counter; the prepayment may only
    // reach the other half, or `due` would go negative and the surplus would be
    // silently clamped away instead of moving to the next challan.
    const b1 = stubBill({ invoiceNo: 'P-1', totalAmount: 20000, paid: 15000 });
    const b2 = stubBill({ invoiceNo: 'P-2', totalAmount: 20000 });
    stubPool(100000);
    stubBills([b1, b2]);

    await run();

    expect(b1.advanceApplied).toBe(5000);
    expect(b1.due).toBe(0);
    expect(b2.advanceApplied).toBe(20000);
  });

  it('is idempotent — running it twice writes nothing the second time', async () => {
    // It is called from four services and reached on ordinary purchases. A
    // second pass that re-wrote every bill would make the common path expensive
    // and every audit trail noisy.
    const b1 = stubBill({ invoiceNo: 'P-1', totalAmount: 35200 });
    stubPool(100000);
    stubBills([b1]);

    expect(await run()).toHaveLength(1);
    b1.save.mockClear();
    expect(await run()).toEqual([]);
    expect(b1.save).not.toHaveBeenCalled();
  });
});

/* ── C. THE RESET ─────────────────────────────────────────────────────────── */

describe('money leaving the pool comes off the bills it was sitting on', () => {
  it('THE REGRESSION — voiding the advance re-opens the challans it covered', async () => {
    /**
     * Proved numerically before the fix: Supplier said ৳55,200 owed while
     * `Σ Purchase.due` said ৳0 and both challans read `completed`. The vendor
     * book was right and the bill book was stranded, with no screen able to
     * show the debt and no way to pay it.
     */
    const b1 = stubBill({ invoiceNo: 'P-1', totalAmount: 35200, advanceApplied: 35200 });
    const b2 = stubBill({ invoiceNo: 'P-2', totalAmount: 20000, advanceApplied: 20000 });
    expect(b1.due + b2.due).toBe(0);

    // The advance row is voided, so the pool is empty.
    stubPool(0);
    stubBills([b1, b2]);

    await run();

    expect(b1.advanceApplied).toBe(0);
    expect(b2.advanceApplied).toBe(0);
    expect(b1.due + b2.due).toBe(55200);
    expect(b1.status).not.toBe('completed');

    // And the two books now agree, which is the whole point.
    const supplier = { totalAmount: 55200, openingDue: 0, totalPaid: 0 };
    Supplier.applyBalances(supplier);
    expect(supplier.totalDue).toBe(b1.due + b2.due);
  });

  it('finds a bill the pool no longer reaches, not just the open ones', async () => {
    // The trap: `settleSupplierDue` walks `due: { $gt: 0 }`, and reusing that
    // filter here would skip the one document this function exists to correct —
    // a bill a now-voided advance had driven to `due: 0`.
    stubPool(0);
    stubBills([]);
    await run();
    expect(Purchase.find.mock.calls[0][0].due).toBeUndefined();
    expect(Purchase.find.mock.calls[0][0].status).toEqual({ $ne: 'cancelled' });
  });

  it('moves the freed money onto the next challan when a bill is cancelled', async () => {
    // Cancelling a covered challan hands its share back. Without a re-spread
    // the shop read as holding ৳25,000 of credit while a live challan from the
    // same vendor sat at ৳10,200 due — and the payables ageing, which sums
    // `Purchase.due`, aged debt the prepayment had already covered.
    const b2 = stubBill({ invoiceNo: 'P-2', totalAmount: 20000, advanceApplied: 9800 });
    expect(b2.due).toBe(10200);

    // P-1 is gone from the queue; the whole ৳1,00,000 is available again.
    stubPool(100000);
    stubBills([b2]);

    await run();

    expect(b2.advanceApplied).toBe(20000);
    expect(b2.due).toBe(0);
  });

  it('re-spreads when a ফেরত shrinks what a bill can absorb', async () => {
    // `advanceApplied` is clamped by the `due` hook to what is outstanding
    // AFTER returns, so a কেনা ফেরত silently releases part of the prepayment.
    // The released amount has to land on the next challan rather than being
    // clamped out of existence.
    const b1 = stubBill({ invoiceNo: 'P-1', totalAmount: 35200, returnedAmount: 10000, advanceApplied: 35200 });
    const b2 = stubBill({ invoiceNo: 'P-2', totalAmount: 20000 });
    stubPool(100000);
    stubBills([b1, b2]);

    await run();

    expect(b1.advanceApplied).toBe(25200);
    expect(b1.due).toBe(0);
    expect(b2.advanceApplied).toBe(20000);
  });
});

/* ── D. THE SHARED CEILING ────────────────────────────────────────────────── */

describe('the allocator and the `due` hook use one formula', () => {
  it('`outstandingBeforeAdvance` nets cash and returns', () => {
    expect(Purchase.outstandingBeforeAdvance({ totalAmount: 35200, paid: 0 })).toBe(35200);
    expect(Purchase.outstandingBeforeAdvance({ totalAmount: 35200, paid: 5000, returnedAmount: 10000 })).toBe(20200);
    // A return larger than what is outstanding cannot mint room.
    expect(Purchase.outstandingBeforeAdvance({ totalAmount: 1000, paid: 900, returnedAmount: 5000 })).toBe(0);
    expect(Purchase.outstandingBeforeAdvance(null)).toBe(0);
  });

  it('the hook clamps through the same static rather than its own arithmetic', () => {
    // Written out twice they drift, and the drift is silent: the allocator
    // hands the bill ৳9,000, the hook clamps it to ৳7,000, and ৳2,000 of the
    // vendor's money stops existing with no book reporting an error.
    const model = read('../models/Purchase.model');
    expect(model).toContain('this.constructor.outstandingBeforeAdvance(this)');
    const service = read('../services/supplierSettlement.service');
    expect(service).toContain('Purchase.outstandingBeforeAdvance(bill)');
  });

  it('what the allocator assigns is what the bill actually credits', async () => {
    // The property the shared formula buys: no amount is assigned that the hook
    // will then clamp away.
    const b1 = stubBill({ invoiceNo: 'P-1', totalAmount: 20000, paid: 3000, returnedAmount: 2000 });
    stubPool(100000);
    stubBills([b1]);

    const [change] = await run();

    expect(change.applied).toBe(15000);
    expect(b1.advanceApplied).toBe(15000);
    expect(b1.due).toBe(0);
  });
});

/* ── E. THE DOORS ─────────────────────────────────────────────────────────── */

describe('every path that moves the pool or a bill calls it', () => {
  const purchase = read('../services/purchase.service');
  const settlement = read('../services/supplierSettlement.service');
  const returns = read('../services/purchaseReturn.service');

  it('a new bill consumes the vendor অগ্রিম', () => {
    expect(purchase).toContain('advanceAllocations = await supplierSettlement.reallocateSupplierAdvance');
    // The one-shot it replaces read the SHOP-WIDE balance to decide what a
    // BRANCH's bill could take.
    expect(purchase).not.toContain('const advanceHeld =');
  });

  it('cancelling a bill runs it AFTER the bill is marked cancelled', () => {
    // Order is load-bearing: the allocator reads `status: { $ne: 'cancelled' }`
    // from the database, so any earlier it would find this bill still live and
    // put the freed money straight back onto the document being voided.
    const marked = purchase.indexOf("purchase.status = 'cancelled';");
    const call = purchase.indexOf('reallocateSupplierAdvance', marked);
    expect(marked).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(marked);
  });

  it('voiding a supplier payment or advance runs it', () => {
    expect(settlement).toContain('reallocated = await reallocateSupplierAdvance');
  });

  it('a কেনা ফেরত runs it', () => {
    expect(returns).toContain('await supplierSettlement.reallocateSupplierAdvance');
  });

  it('settling a bill by hand runs it', () => {
    // Paying a bill shrinks what it can absorb, so অগ্রিম already on it may now
    // overflow onto the next challan.
    expect(purchase.match(/reallocateSupplierAdvance/g).length).toBeGreaterThanOrEqual(4);
  });

  it('the ordinary পরিশোধ counter deliberately does NOT, and says why', () => {
    // It pays each bill exactly `bill.due`, which is already net of that bill's
    // অগ্রিম — so capacity falls by precisely what was paid and the allocation
    // is unchanged. A call there would put a pool aggregate and a full bill
    // scan on the busiest supplier path to find nothing to do.
    expect(settlement).toContain('No `reallocateSupplierAdvance` here, deliberately');
  });
});
