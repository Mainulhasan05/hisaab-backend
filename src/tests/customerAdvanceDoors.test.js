/**
 * Phase J — অগ্রিম জমা: money a customer leaves with the shop.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CASE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A customer buys ৳300, hands over ৳1,000, and does not take the ৳700 back.
 * That ৳700 is a LIABILITY — money the shop holds and has not earned — and it
 * must be adjusted against their next purchase. Separately, a customer may
 * simply hand over a deposit with no sale involved.
 *
 * The model layer for this shipped inert on 2026-08-21. Every advance computed
 * to ৳0 because nothing could write the row. These are the doors.
 *
 * Groups (AGENT_WORKFLOW.md §7.1):
 *
 *   A. THE CEILING — INVARIANT GUARD. `collectDuePayment` must go on refusing
 *      an over-payment, or a fat-fingered ৳20,000 for ৳2,000 becomes an
 *      ৳18,000 liability nobody decided to take on.
 *
 *   B. THE TWO ROWS — a collection that straddles is debt AND deposit, and one
 *      mixed row would make the daily summary report a deposit as বাকি আদায়.
 *
 *   C. NEVER BOTH — a customer cannot owe the shop and be in credit with it.
 *
 *   D. THE TILL — the cashier must CLICK. Inferring a deposit from the tendered
 *      amount would manufacture phantom credit at every counter in the country.
 */

jest.mock('../models/AuditLog.model', () => ({
  create: jest.fn().mockResolvedValue([{}]),
  log: jest.fn().mockResolvedValue({}),
}));

const fs = require('fs');
const mongoose = require('mongoose');
const dueSettlement = require('../services/dueSettlement.service');
const paymentAccountService = require('../services/paymentAccount.service');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Payment = require('../models/Payment.model');

const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8');

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const ACCOUNT = new mongoose.Types.ObjectId();

let created;
let accountDeltas;

/** A customer whose stored halves are consistent with their components. */
const stubCustomer = ({ purchases = 0, paid = 0, opening = 0 } = {}) => {
  const net = purchases + opening - paid;
  return {
    _id: new mongoose.Types.ObjectId(),
    shop: SHOP, name: 'করিম মিয়া',
    totalPurchases: purchases, openingDue: opening, totalPaid: paid,
    totalDue: Math.max(0, net),
    advanceBalance: Math.max(0, -net),
    save: jest.fn().mockResolvedValue(undefined),
  };
};

beforeEach(() => {
  created = [];
  accountDeltas = [];
  jest.spyOn(Payment, 'create').mockImplementation(async (rows) => {
    created.push(...rows);
    return rows;
  });
  jest.spyOn(CustomerBalance, 'settleDue').mockResolvedValue([]);
  jest.spyOn(CustomerBalance, 'applyDelta').mockResolvedValue({});
  jest.spyOn(CustomerBalance, 'recomputeBalances').mockResolvedValue({});
  jest.spyOn(paymentAccountService, 'applyAccountDelta')
    .mockImplementation(async (d) => { accountDeltas.push(d); });
  jest.spyOn(paymentAccountService, 'resolveAccountForMethod').mockResolvedValue(ACCOUNT);
  // The allocation pool. Empty, so `reallocateCustomerInvoices` short-circuits
  // before it reads a shop or an invoice — this suite pins the ROLLUP writes,
  // and the allocation onto invoices has its own suite
  // (`dueCollectionHitsInvoices.test.js`). Unstubbed it reaches for a real
  // database and hangs the file on a 5s timeout.
  jest.spyOn(Payment, 'aggregate').mockResolvedValue([]);
});

afterEach(() => jest.restoreAllMocks());

const settle = (customer, amount, over = {}) => dueSettlement.settleCustomerDue({
  shopId: SHOP, userId: USER, customer, amount, method: 'cash', paidAt: new Date(), ...over,
});

/* ── A. THE CEILING ───────────────────────────────────────────────────────── */

describe('an over-payment is still refused without the flag', () => {
  it('refuses, exactly as it always did', async () => {
    // I-1 for the money paths. Every caller written before advances existed
    // passes no flag and must behave identically — preserved BY CONSTRUCTION,
    // not by everyone remembering.
    const customer = stubCustomer({ purchases: 2000 });

    await expect(settle(customer, 3000)).rejects.toMatchObject({ statusCode: 400 });
    expect(created).toHaveLength(0);
    expect(accountDeltas).toHaveLength(0);
  });

  it('is opened only by the doors built for it', () => {
    // `collectDuePayment` must never pass it, or the ordinary বাকি আদায় screen
    // becomes a deposit door by accident and the fat-finger refusal is lost.
    const src = read('../services/customer.service');
    const collect = src.slice(src.indexOf('async collectDuePayment('));
    expect(collect.slice(0, 3000)).not.toContain('allowAdvance');

    const advance = src.slice(src.indexOf('async takeAdvance('), src.indexOf('async collectDuePayment('));
    expect(advance).toContain('allowAdvance: true');
  });
});

/* ── B. THE TWO ROWS ──────────────────────────────────────────────────────── */

describe('a straddling collection is written as two rows', () => {
  it('splits ৳3,000 against a ৳2,000 debt into debt and deposit', async () => {
    // One row carrying ৳3,000 would make the daily summary report ৳3,000 of
    // "বাকি আদায়", and an owner judging whether customers are paying up would
    // be reading a number that answers a different question.
    const customer = stubCustomer({ purchases: 2000 });

    const res = await settle(customer, 3000, { allowAdvance: true });

    expect(res.appliedToDue).toBe(2000);
    expect(res.advancePart).toBe(1000);

    const collection = created.find((r) => r.type === 'due_collection');
    const deposit = created.find((r) => r.type === 'advance');
    expect(collection.amount).toBe(2000);
    expect(deposit.amount).toBe(1000);
    expect(String(collection.receiptGroup)).toBe(String(deposit.receiptGroup));
    expect(collection.paidAt).toEqual(deposit.paidAt);
  });

  it('writes ONE row when nothing straddles', async () => {
    const customer = stubCustomer({ purchases: 2000 });
    await settle(customer, 2000);
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe('due_collection');
    expect(created[0].receiptGroup).toBeUndefined();
  });

  it('writes ONE deposit row for a customer who owes nothing', async () => {
    const customer = stubCustomer({});
    const res = await settle(customer, 5000, { allowAdvance: true });

    expect(created).toHaveLength(1);
    expect(created[0].type).toBe('advance');
    expect(res.appliedToDue).toBe(0);
    expect(customer.advanceBalance).toBe(5000);
  });

  it('reports the receipt balance on the DEBT half only', async () => {
    // `dueAfter` is what the slip and the SMS quote. A deposit reduces no
    // receivable, and a receipt claiming otherwise tells the customer their
    // খাতা is smaller than it is.
    const customer = stubCustomer({ purchases: 2000 });
    const res = await settle(customer, 3000, { allowAdvance: true });

    expect(res.dueBefore).toBe(2000);
    expect(res.dueAfter).toBe(0);
  });

  it('moves the cash once, for the whole amount', async () => {
    const customer = stubCustomer({ purchases: 2000 });
    await settle(customer, 3000, { allowAdvance: true });
    expect(accountDeltas).toEqual([
      expect.objectContaining({ account: ACCOUNT, amount: 3000 }),
    ]);
  });
});

/* ── C. NEVER BOTH ────────────────────────────────────────────────────────── */

describe('a customer never owes and holds credit at once', () => {
  it('derives both halves from the components', async () => {
    const customer = stubCustomer({ purchases: 2000 });
    await settle(customer, 3000, { allowAdvance: true });

    expect(customer.totalPaid).toBe(3000);
    expect(customer.totalDue).toBe(0);
    expect(customer.advanceBalance).toBe(1000);
  });

  it('spends the deposit on the next credit purchase', async () => {
    // The reallocation pool already counts `advance` — that shipped inert in
    // Phase 2 — so the money applies itself oldest-first with no new mechanism.
    expect(read('../services/dueSettlement.service'))
      .toContain("type: { $in: ['due_collection', 'advance'] }");
  });

  it('allocates only the debt half across branches', async () => {
    // `settleDue` decides whose RECEIVABLE this money reduces. A deposit
    // reduces none, and spreading it would credit branches that never saw it.
    const customer = stubCustomer({ purchases: 2000 });
    const branchId = new mongoose.Types.ObjectId();

    await settle(customer, 3000, { allowAdvance: true, branchId });

    expect(CustomerBalance.settleDue).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2000 }), null
    );
    expect(CustomerBalance.applyDelta).toHaveBeenCalledWith(
      expect.objectContaining({ branch: branchId, paid: 1000 }), null
    );
    expect(CustomerBalance.recomputeBalances).toHaveBeenCalled();
  });

  it('cannot be deleted away while the shop holds their money', () => {
    // A deposit removed from every `isActive`-filtered screen is money the shop
    // is quietly keeping. Blocks rather than warns, unlike the supplier
    // payable: they will come back for it.
    const src = read('../services/customer.service');
    expect(src).toContain('Cannot delete a customer holding an advance');
  });
});

/* ── D. THE TILL ──────────────────────────────────────────────────────────── */

describe('the cashier must click', () => {
  const sale = read('../services/sale.service');

  it('never infers a deposit from the tendered amount', () => {
    // A cashier keying ৳1,000 on a ৳300 bill is recording what crossed the
    // counter — the normal case, and the reason `paid` is clamped at all.
    // Auto-crediting it would manufacture phantom credit at every till.
    expect(sale).toContain('advanceDeposit');
    expect(sale).toContain('The cashier must click');
  });

  it('refuses to hold an advance with no customer on the sale', () => {
    // A walk-in has no account to hold credit in. Refusing beats ignoring:
    // handing the money back while the till says it was kept is the worst of
    // both.
    expect(sale).toContain('Cannot hold an advance without a customer');
  });

  it('takes a deposit when NOTHING was posted to settle', async () => {
    /**
     * THE REGRESSION — a 500 at the till, on the exact shape this feature was
     * built for.
     *
     * `dueSettlement` defaults to `null`, and the settlement block is entered
     * on `settleAmount > 0 || advanceDeposit > 0`. Only the FIRST of those
     * implies a `dueSettlement` was posted. A customer who owes nothing, buys
     * ৳2,600, hands over ৳3,000 and has the cashier tap অগ্রিম জমা রাখুন sends
     * `advanceDeposit` alone — so reading `.method` off the null threw
     * `Cannot read properties of null (reading 'method')` and the whole
     * checkout came back as a 500. Nothing was written; the sale simply could
     * not be rung up.
     *
     * The client is not at fault and must not be changed to compensate: the
     * POS deliberately sends `dueSettlement` only when the cashier left an
     * amount in the box (see the note beside the payload in the sale page), so
     * an ordinary deposit legitimately carries no settlement at all.
     */
    const src = read('../services/sale.service');

    // No un-guarded read of the two fields the deposit path needs. `.amount`
    // is deliberately not in this list: it is read inside
    // `else if (rawDueSettlement && ...)`, which is a branch a deposit-only
    // payload never enters. These two are read on the way OUT of that branch,
    // where the null is still live.
    expect(src).not.toContain('rawDueSettlement.method');
    expect(src).not.toContain('rawDueSettlement.account');

    // And the fallback resolves without one.
    expect(src).toContain('rawDueSettlement?.method || paymentMethod');
  });

  it('books the deposit into the drawer the bill was paid into', () => {
    /**
     * One customer, one counter, one handover — the deposit is the same notes
     * as the bill. Falling through to the method's DEFAULT account books the
     * ৳2,600 where the cashier chose and the ৳400 somewhere else: two accounts
     * for one movement, and a cash count over in one and short in the other
     * with no row to explain either.
     *
     * Guarded on the methods matching, because they need not — a cashier can
     * pay the bill by bKash and settle the খাতা in cash, and then there is no
     * leg to borrow from.
     */
    const src = read('../services/sale.service');
    expect(src).toContain('settlementMethod === paymentMethod');
    expect(src).toContain("payments.find((leg) => leg.method === paymentMethod)?.account");
  });

  it('records only the debt portion as `Sale.dueSettled`', () => {
    // That field is summed by the daily collections figure and printed on the
    // receipt. Writing the combined movement would report a deposit as debt
    // collection on both.
    expect(sale).toContain('settled.appliedToDue !== dueSettled');
  });
});

/* ── The customer-facing surfaces ─────────────────────────────────────────── */

describe('the customer is told what the shop is holding', () => {
  it('names it on the receipt SMS', () => {
    const { buildSaleReceipt } = require('../utils/smsTemplates.util');
    const body = buildSaleReceipt({
      invoiceNo: 'INV-1', total: 300, paid: 300, due: 0,
      advanceHeld: 700, totalDue: 0, shopName: 'হিসাব',
    });
    // Without this line the receipt reads `বিল ৳300` and nothing else, and the
    // only reasonable conclusion is that the ৳700 was pocketed.
    expect(body).toContain('অগ্রিম জমা ৳700');
  });

  it('names it on the খতিয়ান, and not as বাকি আদায়', () => {
    // The shop earned nothing and reduced no receivable. A customer reading
    // their own ledger needs to see money they can still spend.
    expect(read('../services/customer.service')).toContain("'অগ্রিম জমা'");
  });

  it('can be given back', () => {
    // The delete guard refuses to remove a customer holding one, so a deposit
    // with no reversal would leave an account that can never be closed.
    expect(read('../services/dueSettlement.service'))
      .toContain("['due_collection', 'advance'].includes(payment.type)");
  });
});
