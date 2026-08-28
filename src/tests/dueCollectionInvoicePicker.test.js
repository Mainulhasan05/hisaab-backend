/**
 * "Which invoice did that ৳5,000 settle?" — and letting the owner answer it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TENSION THIS RESOLVES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * খাতা money arrives untied to any invoice — that is what makes it খাতা money.
 * `reallocateCustomerInvoices` therefore decides where it lands, and it does so
 * by re-deriving the WHOLE allocation from scratch on every touch: every
 * collection, cancellation, return and counter payment. That recompute is what
 * makes the allocation idempotent and self-healing, and it is why historical
 * drift repairs itself instead of needing a script per bug.
 *
 * A shopkeeper picking an invoice by hand is in direct tension with that. Write
 * their choice straight onto the invoice and the next recompute spreads it
 * oldest-first and silently undoes them — the invoice they closed is open again
 * the next time anything touches that customer, with nothing on screen to
 * explain it. That failure would look exactly like the drift bug this file's
 * subject was written to fix.
 *
 * So the choice is stored on the PAYMENT (`Payment.appliedTo`) as an INPUT to
 * the recompute, never as its output. The engine honours targets first and
 * spreads only what is left. It stays a pure function of stored data — and now
 * it remembers what the owner asked for.
 *
 * The tests below are about that boundary: targets are honoured, targets that
 * can no longer be honoured degrade to the old behaviour rather than losing
 * money, and nothing invalid is ever stored in the first place.
 */
const mongoose = require('mongoose');
const Payment = require('../models/Payment.model');
const Sale = require('../models/Sale.model');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const dueSettlement = require('../services/dueSettlement.service');

const SHOP = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();

// Three credit invoices, oldest first. Nothing paid at the counter on any of
// them, so each can absorb its full total.
const OLD = { _id: new mongoose.Types.ObjectId(), invoiceNo: 'INV-1', total: 3000 };
const MID = { _id: new mongoose.Types.ObjectId(), invoiceNo: 'INV-2', total: 4000 };
const NEW = { _id: new mongoose.Types.ObjectId(), invoiceNo: 'INV-3', total: 5000 };

function saleDoc(fixture, over = {}) {
  return {
    _id: fixture._id,
    invoiceNo: fixture.invoiceNo,
    branch: null,
    total: fixture.total,
    paid: 0,
    returnedAdjustment: 0,
    ledgerSettled: 0,
    due: fixture.total,
    status: 'unpaid',
    createdAt: new Date(`2026-08-0${['INV-1', 'INV-2', 'INV-3'].indexOf(fixture.invoiceNo) + 1}`),
    ...over,
  };
}

/**
 * @param pool     collections taken, in taka
 * @param targets  `appliedTo` rows across those collections
 * @param sales    the invoice queue
 */
function stub({ pool, targets = [], sales, openingDue = 0 }) {
  jest.spyOn(Payment, 'aggregate').mockResolvedValue(
    pool > 0 ? [{ _id: null, total: pool, targets: targets.length ? [targets] : [[]] }] : []
  );
  jest.spyOn(Sale, 'find').mockReturnValue({
    sort: () => Promise.resolve(sales),
  });
  jest.spyOn(Customer, 'findById').mockReturnValue({
    session: () => ({ lean: () => Promise.resolve({ openingDue }) }),
  });
  jest.spyOn(CustomerBalance, 'find').mockResolvedValue([]);
  return jest.spyOn(Sale, 'updateOne').mockResolvedValue({ acknowledged: true });
}

/** What each invoice ended up holding, keyed by invoice number. */
function settledByInvoice(updateOne, sales) {
  const byId = new Map(sales.map((s) => [String(s._id), s.invoiceNo]));
  const out = {};
  for (const call of updateOne.mock.calls) {
    out[byId.get(String(call[0]._id))] = call[1].$set.ledgerSettled;
  }
  return out;
}

const realloc = () =>
  dueSettlement.reallocateCustomerInvoices(
    { shopId: SHOP, customerId: CUSTOMER, branchScoped: false },
    null
  );

afterEach(() => jest.restoreAllMocks());

describe('with no picks, nothing changes — oldest invoice first', () => {
  it('fills the oldest bill before it touches the next', async () => {
    const sales = [saleDoc(OLD), saleDoc(MID), saleDoc(NEW)];
    const updateOne = stub({ pool: 5000, sales });

    await realloc();

    // 3,000 clears INV-1; the remaining 2,000 goes onto INV-2. INV-3 untouched.
    expect(settledByInvoice(updateOne, sales)).toEqual({ 'INV-1': 3000, 'INV-2': 2000 });
  });
});

describe('a picked invoice gets the money, whatever its age', () => {
  it('settles the NEWEST invoice when that is what the owner chose', async () => {
    const sales = [saleDoc(OLD), saleDoc(MID), saleDoc(NEW)];
    const updateOne = stub({
      pool: 5000,
      targets: [{ sale: NEW._id, amount: 5000 }],
      sales,
    });

    await realloc();

    // The whole point. Oldest-first would have put this on INV-1 and INV-2.
    expect(settledByInvoice(updateOne, sales)).toEqual({ 'INV-3': 5000 });
  });

  it('splits across exactly the invoices named', async () => {
    const sales = [saleDoc(OLD), saleDoc(MID), saleDoc(NEW)];
    const updateOne = stub({
      pool: 5000,
      targets: [
        { sale: NEW._id, amount: 4000 },
        { sale: MID._id, amount: 1000 },
      ],
      sales,
    });

    await realloc();

    expect(settledByInvoice(updateOne, sales)).toEqual({ 'INV-2': 1000, 'INV-3': 4000 });
  });

  it('sums two collections that named the same invoice', async () => {
    // ৳2,000 last week and ৳3,000 today is ৳5,000 against that bill — the later
    // pick must not replace the earlier one.
    const sales = [saleDoc(OLD), saleDoc(MID), saleDoc(NEW)];
    const updateOne = stub({
      pool: 5000,
      targets: [
        { sale: NEW._id, amount: 2000 },
        { sale: NEW._id, amount: 3000 },
      ],
      sales,
    });

    await realloc();

    expect(settledByInvoice(updateOne, sales)).toEqual({ 'INV-3': 5000 });
  });

  it('spreads only the UNtargeted remainder oldest-first', async () => {
    // ৳6,000 collected, ৳5,000 of it aimed at INV-3. The loose ৳1,000 behaves
    // exactly as it always did.
    const sales = [saleDoc(OLD), saleDoc(MID), saleDoc(NEW)];
    const updateOne = stub({
      pool: 6000,
      targets: [{ sale: NEW._id, amount: 5000 }],
      sales,
    });

    await realloc();

    expect(settledByInvoice(updateOne, sales)).toEqual({ 'INV-1': 1000, 'INV-3': 5000 });
  });

  it('keeps targeted money away from the পুরোনো খাতা', async () => {
    // Opening debt is consumed before any invoice — but only out of the loose
    // pool. Money the owner aimed at a bill must not be eaten by it.
    const sales = [saleDoc(OLD), saleDoc(NEW)];
    const updateOne = stub({
      pool: 5000,
      targets: [{ sale: NEW._id, amount: 5000 }],
      sales,
      openingDue: 4000,
    });

    await realloc();

    expect(settledByInvoice(updateOne, sales)).toEqual({ 'INV-3': 5000 });
  });
});

describe('a pick that can no longer be honoured loses no money', () => {
  it('spills the excess onto the queue when the invoice shrank', async () => {
    // ৳5,000 was aimed at INV-3, but a return since has left it able to absorb
    // only ৳1,500. The other ৳3,500 is real money the customer handed over: it
    // falls back to oldest-first rather than vanishing.
    const sales = [saleDoc(OLD), saleDoc(NEW, { total: 1500, due: 1500 })];
    const updateOne = stub({
      pool: 5000,
      targets: [{ sale: NEW._id, amount: 5000 }],
      sales,
    });

    await realloc();

    expect(settledByInvoice(updateOne, sales)).toEqual({ 'INV-1': 3000, 'INV-3': 1500 });
  });

  it('falls back entirely when the picked invoice was cancelled away', async () => {
    // A cancelled sale never enters the queue, so the target names nothing.
    // The money still has to land somewhere or `Sale.due` and
    // `Customer.totalDue` go back out of step — the exact drift this engine
    // exists to close.
    const sales = [saleDoc(OLD), saleDoc(MID)];
    const updateOne = stub({
      pool: 3000,
      targets: [{ sale: NEW._id, amount: 3000 }],
      sales,
    });

    await realloc();

    expect(settledByInvoice(updateOne, sales)).toEqual({ 'INV-1': 3000 });
  });
});

describe('the recompute is still idempotent', () => {
  it('writes nothing on a second pass over an already-correct allocation', async () => {
    // Same inputs, but the invoices already carry the allocation. Nothing
    // changed, so nothing is written — which is what makes this safe to call
    // from four services and from the repair script.
    const sales = [
      saleDoc(OLD, { ledgerSettled: 0, due: 3000 }),
      saleDoc(NEW, { ledgerSettled: 5000, due: 0, status: 'completed' }),
    ];
    const updateOne = stub({
      pool: 5000,
      targets: [{ sale: NEW._id, amount: 5000 }],
      sales,
    });

    await realloc();

    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe('the model records the choice where the recompute can read it', () => {
  it('keeps appliedTo on Payment, not on Sale', () => {
    // On Sale it would be output, and the next recompute would overwrite it.
    // On Payment it is input, and survives every recompute by construction.
    expect(Payment.schema.path('appliedTo')).toBeDefined();
    expect(Sale.schema.path('appliedTo')).toBeUndefined();
  });

  it('defaults to empty, so an ordinary collection is unchanged', () => {
    const row = new Payment({
      shop: SHOP, customer: CUSTOMER, amount: 100, type: 'due_collection',
      receivedBy: new mongoose.Types.ObjectId(),
    });
    expect(row.appliedTo).toHaveLength(0);
  });
});
