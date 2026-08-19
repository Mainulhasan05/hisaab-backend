/**
 * Settling an old খাতা out of money tendered at the till.
 *
 * A customer owing ৳2,200 buys ৳500 of goods and hands over ৳2,700. Before this
 * feature the surplus was change: the POS showed "ফেরত দিন ৳2,200" and the
 * shopkeeper had to walk to the customer page and run বাকি আদায় separately, or
 * forget to. Now the till can apply it, and the money becomes a real
 * `due_collection` — never a larger `sale.paid`.
 *
 * Groups, and it matters which is which (AGENT_WORKFLOW.md §7.1):
 *
 *   A. THE CEILING — REGRESSION in the strong sense. The whole feature is one
 *      unchecked number away from letting a POS write down debt that does not
 *      exist, and under separate books, debt that belongs to another branch.
 *      `collectDuePayment` already refuses both; the point of sharing one
 *      module is that the till inherits those refusals rather than reimplementing
 *      them. These fail loudly if it ever stops.
 *
 *   B. IT IS A COLLECTION, NOT A SALE PAYMENT. The four things that break when
 *      ৳2,200 is folded into `sale.paid` are all silent (revenue overstated,
 *      `deriveDue` unreconcilable, returns refunding against the wrong base,
 *      the overpayment clamp defeated). Nothing at runtime notices, so the
 *      shape of the written row is pinned here instead.
 *
 *   C. BOUNDS — INVARIANT GUARDS. The customer routes carry no Joi schema at
 *      all, so for বাকি আদায় this module IS the boundary. Pass by construction
 *      today.
 *
 *   D. WIRING — GUARDS. Two halves, and the second is the one that bites.
 *      Against the SOURCE, because `createSale` opens a transaction and touches
 *      a dozen collections, so reaching it needs a database — the same reason
 *      `cashDrawerNoDoubleCount` and `fundAccountWiring` read services off
 *      disk. What matters there is ORDER: the book is read before the sale
 *      moves it, and the snapshots are actually persisted.
 *
 *      Against the SCHEMA, because the sale routes DO carry one and
 *      `validate.middleware` runs it with `stripUnknown: true`. A field the
 *      schema does not name is deleted before the service sees it, silently:
 *      the cashier ticks জমা, the money goes back as change, and nothing
 *      anywhere reports an error. See sale.validation.js's own header.
 *
 *   E. THE SNAPSHOTS. Absent and zero are different answers, and every reader
 *      of a pre-feature invoice depends on being able to tell them apart.
 *
 * Deliberately NOT here: that `CustomerBalance.settleDue` allocates oldest-debt
 * first. That is its own tested behaviour and asserting it through this module
 * would be testing the mock (§7.2). What IS pinned is that this module calls it
 * rather than doing its own allocation.
 */

jest.mock('../services/paymentAccount.service', () => ({
  applyAccountDelta: jest.fn().mockResolvedValue(undefined),
  resolveAccountForMethod: jest.fn().mockResolvedValue(null),
  assertUsableAccount: jest.fn().mockResolvedValue({ _id: 'ACCOUNT_ID' }),
}));

const fs = require('fs');
const mongoose = require('mongoose');

const dueSettlement = require('../services/dueSettlement.service');
const paymentAccountService = require('../services/paymentAccount.service');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Payment = require('../models/Payment.model');
const Sale = require('../models/Sale.model');

const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8');

/** The body of the named async method, up to the next method at the same depth. */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return '';
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n {2}(?:async )?[a-zA-Z_][\w]*\s*\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const SALE = new mongoose.Types.ObjectId();
const BRANCH_A = new mongoose.Types.ObjectId(); // raised the invoices
const BRANCH_B = new mongoose.Types.ObjectId(); // where the customer walked in

/** ৳2,200 on the খাতা, ৳500 of goods on the counter, ৳2,700 in hand. */
const stubCustomer = (totalDue = 2200) => ({
  _id: new mongoose.Types.ObjectId(),
  shop: SHOP,
  name: 'করিম মিয়া',
  phone: '01712345002',
  totalPaid: 0,
  totalDue,
  save: jest.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  jest.spyOn(Payment, 'create').mockResolvedValue([{ _id: new mongoose.Types.ObjectId() }]);
  jest.spyOn(CustomerBalance, 'settleDue').mockResolvedValue([]);
  // The allocation pool. Empty, so `reallocateCustomerInvoices` short-circuits
  // before it reads a shop or an invoice — these suites pin the ROLLUP writes,
  // and the allocation onto invoices has its own suite
  // (`dueCollectionHitsInvoices.test.js`). Unstubbed it would reach for a real
  // database and hang the whole file on a 5s timeout.
  jest.spyOn(Payment, 'aggregate').mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());

/* ── A. THE CEILING ───────────────────────────────────────────────────────── */

describe('a checkout cannot settle more debt than exists', () => {
  it('refuses more than the shop-wide due under shared books', async () => {
    const customer = stubCustomer(2200);

    await expect(
      dueSettlement.settleCustomerDue(
        { shopId: SHOP, userId: USER, customer, amount: 2201, branchId: BRANCH_B },
        null
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(Payment.create).not.toHaveBeenCalled();
    expect(customer.save).not.toHaveBeenCalled();
    expect(paymentAccountService.applyAccountDelta).not.toHaveBeenCalled();
  });

  it("refuses another branch's due under separate books", async () => {
    // ৳2,200 shop-wide, all of it raised at BRANCH_A. The customer is standing
    // at BRANCH_B, which is owed nothing. Validating against the shop-wide
    // figure would leave BRANCH_B negative and BRANCH_A overstated, forever,
    // with no error anywhere — the defect `duePaymentBranch` exists to keep
    // shut on the বাকি আদায় path, inherited here for free.
    const customer = stubCustomer(2200);
    jest.spyOn(CustomerBalance, 'findOne').mockResolvedValue(null);

    await expect(
      dueSettlement.settleCustomerDue(
        {
          shopId: SHOP,
          userId: USER,
          customer,
          amount: 2200,
          branchId: BRANCH_B,
          branchScoped: true,
        },
        null
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(Payment.create).not.toHaveBeenCalled();
  });

  it('allows exactly the branch due under separate books', async () => {
    const customer = stubCustomer(5000); // more shop-wide…
    jest.spyOn(CustomerBalance, 'findOne').mockResolvedValue({ totalDue: 2200 }); // …2,200 here

    const result = await dueSettlement.settleCustomerDue(
      {
        shopId: SHOP,
        userId: USER,
        customer,
        amount: 2200,
        branchId: BRANCH_B,
        branchScoped: true,
      },
      null
    );

    expect(result.amount).toBe(2200);
    expect(result.dueBefore).toBe(2200);
    expect(result.dueAfter).toBe(0);
    expect(Payment.create).toHaveBeenCalled();
  });

  it('settles the whole খাতা down to exactly zero, not to float dust', async () => {
    // Unrounded, `2200 - 2200` is fine but an instalment history is not, and a
    // customer sitting at 1e-13 never leaves the বাকি list (`totalDue > 0`)
    // with nothing left to pay that could clear them.
    const customer = stubCustomer(2200.1);

    await dueSettlement.settleCustomerDue(
      { shopId: SHOP, userId: USER, customer, amount: 2200.1, branchId: BRANCH_B },
      null
    );

    expect(customer.totalDue).toBe(0);
    expect(customer.totalPaid).toBe(2200.1);
  });
});

/* ── B. IT IS A COLLECTION, NOT A SALE PAYMENT ────────────────────────────── */

describe('the money is written as a due collection', () => {
  const settle = (over = {}) =>
    dueSettlement.settleCustomerDue(
      {
        shopId: SHOP,
        userId: USER,
        customer: stubCustomer(2200),
        amount: 2200,
        branchId: BRANCH_B,
        viaSale: SALE,
        ...over,
      },
      null
    );

  it('types the row as due_collection so every collection report sees it', async () => {
    await settle();
    const [[[row]]] = Payment.create.mock.calls;
    expect(row.type).toBe('due_collection');
    expect(row.amount).toBe(2200);
  });

  it('tags the visit with viaSale and never with sale', async () => {
    // `sale` means "this money settles THIS invoice", and it does not — it
    // settles older ones. Using `sale` would make every settling invoice
    // unrevisable the moment it was rung up, because `reviseBlockedReason`
    // reads exactly that field to mean "money arrived after checkout".
    await settle();
    const [[[row]]] = Payment.create.mock.calls;
    expect(String(row.viaSale)).toBe(String(SALE));
    expect(row.sale).toBeUndefined();
  });

  it('leaves atCheckout false, so the drawer counts the money once', async () => {
    // The flag means "already counted inside Sale.payments[]". This money is
    // not in there — the legs carry the ৳500 bill only — so a true here would
    // make the till read short by every খাতা settled at the counter.
    await settle();
    const [[[row]]] = Payment.create.mock.calls;
    expect(row.atCheckout).toBeUndefined();
  });

  it('carries the branch, so the collecting till can see its own money', async () => {
    await settle();
    const [[[row]]] = Payment.create.mock.calls;
    expect(String(row.branch)).toBe(String(BRANCH_B));
  });

  it('moves the customer book and allocates across the branch rows', async () => {
    const customer = stubCustomer(2200);
    await settle({ customer });

    expect(customer.totalPaid).toBe(2200);
    expect(customer.totalDue).toBe(0);
    expect(customer.save).toHaveBeenCalled();
    expect(CustomerBalance.settleDue).toHaveBeenCalledWith(
      expect.objectContaining({ preferBranch: BRANCH_B, amount: 2200 }),
      null
    );
  });

  it('credits the fund account the money actually arrived in', async () => {
    await settle({ method: 'bkash' });
    expect(paymentAccountService.applyAccountDelta).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2200 })
    );
  });
});

/* ── C. BOUNDS ────────────────────────────────────────────────────────────── */

describe('the amount is coerced and bounded before anything reads it', () => {
  it.each([
    ['zero', 0],
    ['negative', -2200],
    ['unparseable', 'abc'],
    ['null', null],
    ['infinite', Infinity],
  ])('refuses %s', async (_label, amount) => {
    // A negative passes an `amount > due` check and runs the ledger BACKWARDS:
    // totalPaid down, totalDue up, plus a negative cash-in row the register
    // subtracts from the drawer.
    const customer = stubCustomer(2200);

    await expect(
      dueSettlement.settleCustomerDue(
        { shopId: SHOP, userId: USER, customer, amount, branchId: BRANCH_B },
        null
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(Payment.create).not.toHaveBeenCalled();
  });
});

/* ── D. WIRING ────────────────────────────────────────────────────────────── */

describe('createSale reads the book before it moves it', () => {
  const source = read('../services/sale.service');
  const body = methodBody(source, 'async createSale(');

  it('snapshots previousDue before the customer rollup runs', () => {
    // ORDER IS LOAD-BEARING. The rollup adds this invoice's own due to the
    // customer; reading afterwards would cap the settlement against a debt
    // this very sale had just created, letting a credit sale inflate its own
    // ceiling.
    const readAt = body.indexOf('readCollectableDue');
    const rollupAt = body.indexOf('customer.totalPurchases +=');
    const settleAt = body.indexOf('settleCustomerDue');

    expect(readAt).toBeGreaterThan(-1);
    expect(rollupAt).toBeGreaterThan(-1);
    expect(settleAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(rollupAt);
    expect(rollupAt).toBeLessThan(settleAt);
  });

  it('refuses a settlement larger than the snapshot rather than trimming it', () => {
    // Silently applying less than the cashier counted out leaves the difference
    // unaccounted for and tells nobody. An error at the till is recoverable.
    expect(body).toContain('settleAmount > (previousDue || 0)');
  });

  it('persists both snapshots onto the invoice', () => {
    const create = body.slice(body.indexOf('Sale.create'));
    expect(create).toContain('previousDue');
    expect(create).toContain('dueSettled');
  });

  it('dates the collection to the sale, not to now', () => {
    // `paidAt` is what every daily-collection figure and the cash register
    // bucket on, so a backdated invoice must carry a backdated collection.
    const call = body.slice(body.indexOf('settleCustomerDue'));
    expect(call).toContain('paidAt: occurredAt');
  });

  it('ignores a dueSettlement posted with a revision', () => {
    // A revision rewrites a basket; it is not a second chance to take money.
    // Guarded twice: the carry branch wins outright, and the settle branch
    // additionally refuses to run for anything carrying `revisedFrom`.
    const carryAt = body.indexOf('if (carryDueSnapshot) {');
    const elseAt = body.indexOf('} else if (rawDueSettlement && !revisedFrom) {');
    expect(carryAt).toBeGreaterThan(-1);
    expect(elseAt).toBeGreaterThan(carryAt);
  });

  it('refuses to settle a due on a walk-in sale', () => {
    // No customer, no খাতা, nothing the money could be applied to. Dropping it
    // silently would hand back money the shopkeeper believes was collected.
    expect(body).toContain('কাস্টমার ছাড়া আগের বাকি জমা নেওয়া যাবে না');
  });
});

describe('the field survives the route it arrives on', () => {
  const { createSale: schema } = require('../validations/sale.validation');

  const body = (over = {}) => ({
    items: [{ productId: 'a'.repeat(24), quantity: 1, unitPrice: 500 }],
    paid: 500,
    ...over,
  });

  it('carries dueSettlement through validation instead of stripping it', () => {
    // `validate.middleware` runs Joi with `stripUnknown: true` and REPLACES
    // req.body with the result, so a field the schema forgets is not merely
    // unvalidated — it is deleted before the service ever sees it. The cashier
    // would tick জমা, the money would be handed back as change, and no error
    // would be raised anywhere. This is the guard the schema header asks for.
    const { error, value } = schema.validate(body({ dueSettlement: { amount: 2200 } }), {
      abortEarly: false,
      stripUnknown: true,
    });

    expect(error).toBeUndefined();
    expect(value.dueSettlement).toEqual({ amount: 2200 });
  });

  it('accepts a named method and account for the collection leg', () => {
    const { error, value } = schema.validate(
      body({ dueSettlement: { amount: 2200, method: 'bkash', account: 'b'.repeat(24) } }),
      { abortEarly: false, stripUnknown: true }
    );

    expect(error).toBeUndefined();
    expect(value.dueSettlement.method).toBe('bkash');
  });

  it('refuses a negative amount at the boundary as well as in the service', () => {
    const { error } = schema.validate(body({ dueSettlement: { amount: -2200 } }), {
      abortEarly: false,
      stripUnknown: true,
    });

    expect(error).toBeDefined();
  });

  it('leaves an ordinary checkout untouched', () => {
    // INVARIANT GUARD. Every till in the field posts no `dueSettlement`, and
    // that payload must stay exactly as valid as it was — a required field here
    // would refuse every sale on the platform.
    const { error, value } = schema.validate(body(), { abortEarly: false, stripUnknown: true });

    expect(error).toBeUndefined();
    expect(value.dueSettlement).toBeUndefined();
  });
});

describe('a revision inherits the snapshots instead of re-deriving them', () => {
  const body = methodBody(read('../services/sale.service'), 'async reviseSale(');

  it('passes the original figures through to the replacement', () => {
    // Re-deriving would read a book the original has already moved and print
    // "পূর্বের বাকি ৳0" on the reprint of an invoice whose customer is holding
    // paper that says ৳2,200.
    expect(body).toContain('carryDueSnapshot');
    expect(body).toContain('previousDue: original.previousDue');
    expect(body).toContain('dueSettled: original.dueSettled');
  });
});

/* ── E. THE SNAPSHOTS ─────────────────────────────────────────────────────── */

describe('absent and zero are different answers', () => {
  it('leaves previousDue undefined rather than defaulting it to 0', () => {
    // Every sale written before this field existed has no value here, and a
    // reader must fall back to the live derivation for those. A schema default
    // of 0 would silently claim every historical customer owed nothing.
    const path = Sale.schema.path('previousDue');
    expect(path).toBeDefined();
    expect(path.defaultValue).toBeUndefined();
  });

  it('defaults dueSettled to 0, because nothing settled is a real answer', () => {
    expect(Sale.schema.path('dueSettled').defaultValue).toBe(0);
  });

  it('keeps viaSale null by default on every ordinary collection', () => {
    expect(Payment.schema.path('viaSale').defaultValue).toBeNull();
  });
});

/* ── readCollectableDue ───────────────────────────────────────────────────── */

describe('the book that is read is the book the shop keeps', () => {
  it('reads the branch row under separate books', async () => {
    const lean = jest.fn().mockResolvedValue({ totalDue: 2200 });
    jest.spyOn(CustomerBalance, 'findOne').mockReturnValue({ lean });

    const due = await dueSettlement.readCollectableDue({
      shopId: SHOP,
      customerId: 'C1',
      branchId: BRANCH_A,
      branchScoped: true,
    });

    expect(due).toBe(2200);
  });

  it('reads the shop-wide rollup under shared books', async () => {
    const lean = jest.fn().mockResolvedValue({ totalDue: 2200 });
    jest.spyOn(Customer, 'findOne').mockReturnValue({ session: () => ({ lean }) });

    const due = await dueSettlement.readCollectableDue({
      shopId: SHOP,
      customerId: 'C1',
      branchId: BRANCH_A,
      branchScoped: false,
    });

    expect(due).toBe(2200);
  });

  it('returns null for a walk-in, who has no book at all', async () => {
    const due = await dueSettlement.readCollectableDue({
      shopId: SHOP,
      customerId: null,
      branchId: BRANCH_A,
      branchScoped: false,
    });

    expect(due).toBeNull();
  });

  it('reads 0 for a customer with no row at this branch', async () => {
    // They owe this branch nothing, which is a real answer and not a missing
    // one — the settlement ceiling is 0 and the invoice prints ৳0.
    const lean = jest.fn().mockResolvedValue(null);
    jest.spyOn(CustomerBalance, 'findOne').mockReturnValue({ lean });

    const due = await dueSettlement.readCollectableDue({
      shopId: SHOP,
      customerId: 'C1',
      branchId: BRANCH_B,
      branchScoped: true,
    });

    expect(due).toBe(0);
  });
});
