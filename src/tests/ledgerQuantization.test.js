/**
 * The customer ledger is quantized to paisa on every write.
 *
 * ── The bug these pin ───────────────────────────────────────────────────────
 *
 * `invoiceMath.util.js` quantizes the INVOICE's due, and its header explains
 * exactly why: an unrounded `total - paid` lands on 1.4e-14 rather than 0, the
 * invoice joins the বাকি list (`due: { $gt: 0 }`), and the residue can never be
 * cleared because there is nothing left to pay.
 *
 * The LEDGER — `Customer.deriveDue`, `addPurchase/addPayment/refund`,
 * `collectDuePayment` and `CustomerBalance.settleDue` — did the same subtraction
 * with no quantization at all.
 *
 * It survived because the obvious test case cannot catch it. When a customer
 * buys and pays the identical figure, `totalPurchases` and `totalPaid`
 * accumulate the SAME sequence of doubles, stay bit-identical, and subtract to
 * exactly 0. The failure needs the two sums to diverge — which is what happens
 * the moment anyone buys once and pays in instalments, i.e. the entire point of
 * a বাকি book. A simulation of 100k such transactions produced a phantom due on
 * 28% of them, growing to 1.1e-6 by the end.
 *
 * So these tests deliberately use ASYMMETRIC payment schedules. A version of
 * this suite built on symmetric ones passes against the unfixed code.
 */
const Customer = require('../models/Customer.model');
const { quantizeMoney } = require('../utils/quantity.util');

/** `deriveDue`'s inputs, as a plain object — the static takes a doc-like. */
const ledger = (totalPurchases, totalPaid, openingDue = 0) => ({
  totalPurchases, totalPaid, openingDue,
});

describe('Customer.deriveDue', () => {
  it('returns exactly zero for a book that has been paid off in instalments', () => {
    // ৳10.42 bought, settled as 3.86 + 4.27 + 2.29 — three unequal legs, each
    // paisa-exact, summing to 10.419999999999998. Not every split diverges;
    // this one does, and it diverges DOWNWARD, which is the direction that
    // matters: `purchases - paid` is then +1.8e-15, a positive phantom due.
    const purchases = 10.42;
    const paid = 3.86 + 4.27 + 2.29;

    expect(paid).not.toBe(purchases);        // the float divergence, made visible
    expect(purchases - paid).toBeGreaterThan(0); // ...and it reads as money owed

    expect(Customer.deriveDue(ledger(purchases, paid))).toBe(0);
  });

  it('the unfixed formula really did leave a phantom due — not a hypothetical', () => {
    const purchases = 10.42;
    const paid = 3.86 + 4.27 + 2.29;
    const unquantized = Math.max(0, purchases + 0 - paid);

    // What the old `deriveDue` returned. `> 0` is the whole bug: this customer
    // matches `totalDue: { $gt: 0 }` and sits on the বাকি list forever, with
    // nothing left to pay that could ever clear them.
    expect(unquantized).toBeGreaterThan(0);
    expect(unquantized).toBeLessThan(0.005);
    expect(Customer.deriveDue(ledger(purchases, paid))).toBe(0);
  });

  it('never returns a sub-paisa residue, over a long asymmetric history', () => {
    let purchases = 0;
    let paid = 0;
    const rand = ((s) => () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff))(7);

    for (let i = 0; i < 20000; i++) {
      const amt = Math.round(rand() * 100000) / 100;
      purchases += amt;
      // Settled in three uneven legs that sum to the invoice exactly.
      const a = Math.round(amt * 0.37 * 100) / 100;
      const b = Math.round(amt * 0.41 * 100) / 100;
      paid += a;
      paid += b;
      paid += Math.round((amt - a - b) * 100) / 100;

      const due = Customer.deriveDue(ledger(purchases, paid));
      // The assertion that fails without quantization: a fully-settled book must
      // read zero, not 4.5e-13. `> 0` is what puts a customer on the বাকি list.
      expect(due).toBe(0);
    }
  });

  it('still carries the openingDue term', () => {
    // The term must survive quantization — dropping it is the OTHER way these
    // two books drift. See DueAdjustment.model.js.
    expect(Customer.deriveDue(ledger(500, 200, 300))).toBe(600);
    expect(Customer.deriveDue(ledger(0, 0, 3835))).toBe(3835);
  });

  it('clamps at zero for an over-refunded customer', () => {
    expect(Customer.deriveDue(ledger(100, 250))).toBe(0);
  });

  it('rounds a genuine part-paisa figure the same way the invoice does', () => {
    // Whatever the ledger says must agree to the paisa with what
    // `invoiceMath.computeInvoiceTotals` would store for the same numbers.
    const due = Customer.deriveDue(ledger(1000.005, 0));
    expect(due).toBe(quantizeMoney(1000.005));
  });

  it('tolerates missing and malformed fields', () => {
    expect(Customer.deriveDue(undefined)).toBe(0);
    expect(Customer.deriveDue({})).toBe(0);
    expect(Customer.deriveDue(ledger(undefined, undefined))).toBe(0);
  });
});

describe('Customer instance ledger methods', () => {
  /** A doc-like with just the surface these methods touch. */
  const doc = (over = {}) => Object.assign(
    {
      totalPurchases: 0,
      totalPaid: 0,
      openingDue: 0,
      totalDue: 0,
      purchaseCount: 0,
      constructor: Customer,
      save: jest.fn().mockResolvedValue(undefined),
    },
    over
  );

  it('addPurchase keeps both running sums on paisa', async () => {
    const c = doc();
    await Customer.prototype.addPurchase.call(c, 33.333, 10.005);
    expect(c.totalPurchases).toBe(33.33);
    expect(c.totalPaid).toBe(10.01);
    expect(c.totalDue).toBe(23.32);
    expect(c.purchaseCount).toBe(1);
  });

  it('addPayment settles an instalment book to exactly zero', async () => {
    const c = doc({ totalPurchases: 1000.1, totalDue: 1000.1 });
    for (const leg of [370.04, 410.04, 220.02]) {
      await Customer.prototype.addPayment.call(c, leg);
    }
    expect(c.totalPaid).toBe(1000.1);
    expect(c.totalDue).toBe(0);
  });

  it('refund keeps totalPurchases on paisa', async () => {
    const c = doc({ totalPurchases: 100.1, totalPaid: 100.1, purchaseCount: 1 });
    await Customer.prototype.refund.call(c, 33.37);
    expect(c.totalPurchases).toBe(66.73);
    expect(c.totalDue).toBe(0);
    expect(c.purchaseCount).toBe(0);
  });

  it('purchaseCount never goes negative', async () => {
    const c = doc({ purchaseCount: 0 });
    await Customer.prototype.refund.call(c, 10);
    expect(c.purchaseCount).toBe(0);
  });
});

/**
 * `round2` in customer.service used its own
 * `Math.round((n + Number.EPSILON) * 100) / 100`. That looks equivalent to
 * `quantizeMoney` and is not: `Number.EPSILON` is an ABSOLUTE 2.2e-16, so adding
 * it stops mattering above ~2 and the helper rounded ~0.8% of paisa-boundary
 * values the other way from the rest of the codebase.
 *
 * `CustomerBalance.reduceOpening` used the same form on two fields it PERSISTS,
 * so that one-paisa disagreement went into the book.
 */
describe('one rounding rule across the codebase', () => {
  const legacyRound2 = (n) => Math.round(((n || 0) + Number.EPSILON) * 100) / 100;

  it('the legacy helper really did disagree — this is not a hypothetical', () => {
    const disagreements = [];
    for (let i = 0; i < 200000; i++) {
      const v = i / 800;
      if (legacyRound2(v) !== quantizeMoney(v)) disagreements.push(v);
    }
    expect(disagreements.length).toBeGreaterThan(0);
    // Representative cases, so a reader can see the shape of the error.
    expect(legacyRound2(2.135)).toBe(2.13);
    expect(quantizeMoney(2.135)).toBe(2.14);
    expect(legacyRound2(8.165)).toBe(8.16);
    expect(quantizeMoney(8.165)).toBe(8.17);
  });

  /**
   * Behavioural, not a source scan: the two persisted figures must land on the
   * value `quantizeMoney` gives, whatever form the code uses to get there.
   */
  it('reduceOpening persists figures that agree with quantizeMoney', async () => {
    const CustomerBalance = require('../models/CustomerBalance.model');
    const row = {
      branch: 'b1',
      openingDue: 8.165,
      totalDue: 8.165,
      save: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(CustomerBalance, 'find').mockReturnValue({ sort: () => Promise.resolve([row]) });

    // Take a part of it, leaving a figure that lands on a paisa boundary.
    const applied = await CustomerBalance.reduceOpening({
      shop: 's1', customer: 'c1', preferBranch: 'b1', amount: 1,
    });

    expect(applied).toBe(1);
    // 8.165 - 1 = 7.165 -> 7.17 under quantizeMoney; the legacy helper gave 7.16.
    expect(row.openingDue).toBe(quantizeMoney(8.165 - 1));
    expect(row.totalDue).toBe(quantizeMoney(8.165 - 1));
    expect(row.openingDue).toBe(legacyRound2(8.165 - 1) + 0.01);

    jest.restoreAllMocks();
  });
});

/**
 * `CustomerBalance.settleDue` allocates a due collection across branches. It
 * decremented `totalDue` directly, unrounded, so a branch row settled to 1e-13
 * and stayed on the branch বাকি list (`getBranchDueSummary` and the branch
 * customer list both filter `totalDue: { $gt: 0 }`).
 */
describe('CustomerBalance.settleDue', () => {
  const CustomerBalance = require('../models/CustomerBalance.model');

  /** A row stand-in that records what it was saved with. */
  const row = (branch, totalDue) => ({
    branch,
    totalDue,
    totalPaid: 0,
    save: jest.fn().mockResolvedValue(undefined),
  });

  afterEach(() => jest.restoreAllMocks());

  function stubRows(rows) {
    jest.spyOn(CustomerBalance, 'find').mockReturnValue({
      sort: () => Promise.resolve(rows),
    });
    jest.spyOn(CustomerBalance, 'applyDelta').mockResolvedValue(undefined);
  }

  it('settles a branch row to exactly zero, not to float dust', async () => {
    const r = row('b1', 370.04 + 410.04 + 220.02); // a sum that is not 1000.10
    stubRows([r]);

    await CustomerBalance.settleDue({
      shop: 's1', customer: 'c1', preferBranch: 'b1', amount: 1000.1,
    });

    expect(r.totalDue).toBe(0);
    expect(r.totalPaid).toBe(1000.1);
    // The property that matters: this row no longer matches `totalDue: {$gt:0}`.
    expect(r.totalDue > 0).toBe(false);
  });

  it('spreads across branches without leaving a residue on any of them', async () => {
    const a = row('b1', 33.33);
    const b = row('b2', 66.67);
    stubRows([a, b]);

    const applied = await CustomerBalance.settleDue({
      shop: 's1', customer: 'c1', preferBranch: 'b1', amount: 100,
    });

    expect(a.totalDue).toBe(0);
    expect(b.totalDue).toBe(0);
    // Σ applied === the collection, exactly.
    expect(applied.reduce((s, x) => s + x.amount, 0)).toBe(100);
  });

  it('leaves a partly-settled row on a paisa figure', async () => {
    const r = row('b1', 100);
    stubRows([r]);

    await CustomerBalance.settleDue({
      shop: 's1', customer: 'c1', preferBranch: 'b1', amount: 33.33,
    });

    expect(r.totalDue).toBe(66.67);
    expect(r.totalPaid).toBe(33.33);
  });
});
