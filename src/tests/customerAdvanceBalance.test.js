/**
 * Customer advance balance — the derived half of `totalDue`.
 *
 * These cover the LAYER, not the feature: at this phase no code path can
 * create an `advance` payment yet, so what is pinned here is the arithmetic and
 * the exclusivity invariant that everything built on top will depend on.
 *
 * The one thing worth stating plainly, because it is the whole design: due and
 * advance are not two numbers. They are one signed number — the net position —
 * split at zero. Every test below is really asking the same question from a
 * different side: can the pair ever disagree with the components that produced
 * them?
 *
 * See ADVANCE_PAYMENT_PLAN.md §1.
 */
const Customer = require('../models/Customer.model');

const net = (purchases, opening, paid) => ({
  totalPurchases: purchases,
  openingDue: opening,
  totalPaid: paid,
});

describe('deriveAdvance — the negative half of the net position', () => {
  it('is zero for a customer who owes money', () => {
    expect(Customer.deriveAdvance(net(1000, 0, 300))).toBe(0);
  });

  it('is zero for a customer who is exactly square', () => {
    expect(Customer.deriveAdvance(net(1000, 0, 1000))).toBe(0);
  });

  it('is what the customer overpaid, when they overpaid', () => {
    // The brief's case: ৳300 of goods, ৳1,000 handed over, ৳700 left on deposit.
    expect(Customer.deriveAdvance(net(300, 0, 1000))).toBe(700);
  });

  it('counts opening debt against the credit', () => {
    // ৳1,000 paid, ৳300 of goods, but ৳500 carried in from the paper খাতা.
    // They are ৳200 in credit, not ৳700 — the old debt is real debt.
    expect(Customer.deriveAdvance(net(300, 500, 1000))).toBe(200);
  });

  it('reads a missing document as zero rather than NaN', () => {
    expect(Customer.deriveAdvance(undefined)).toBe(0);
    expect(Customer.deriveAdvance({})).toBe(0);
  });

  it('quantizes, so instalments cannot leave a residue of credit', () => {
    // Same failure `deriveDue` quantizes against, on the other side of zero: an
    // unrounded residue here would put a squared-off customer on a "holds
    // credit" list forever, with nothing to spend.
    const doc = net(0.1 + 0.2, 0, 0.3);
    expect(Customer.deriveAdvance(doc)).toBe(0);
  });
});

describe('applyBalances — the pair can never contradict each other', () => {
  const cases = [
    ['plain debt', net(1000, 0, 300), { totalDue: 700, advanceBalance: 0 }],
    ['square', net(1000, 0, 1000), { totalDue: 0, advanceBalance: 0 }],
    ['plain credit', net(300, 0, 1000), { totalDue: 0, advanceBalance: 700 }],
    ['credit against opening debt', net(300, 500, 1000), { totalDue: 0, advanceBalance: 200 }],
    ['opening debt outweighs the credit', net(300, 900, 1000), { totalDue: 200, advanceBalance: 0 }],
    ['nothing at all', net(0, 0, 0), { totalDue: 0, advanceBalance: 0 }],
  ];

  it.each(cases)('%s', (_name, doc, expected) => {
    Customer.applyBalances(doc);
    expect(doc.totalDue).toBe(expected.totalDue);
    expect(doc.advanceBalance).toBe(expected.advanceBalance);
  });

  it('never leaves both halves non-zero, over a wide sweep', () => {
    /**
     * INV-A1/A2, brute-forced. This is the invariant every read site leans on:
     * twelve `{ totalDue: { $gt: 0 } }` queries stay correct without a single
     * edit precisely because a customer in credit has a `totalDue` of exactly
     * zero, not a small one.
     */
    for (let purchases = 0; purchases <= 400; purchases += 37) {
      for (let opening = 0; opening <= 400; opening += 41) {
        for (let paid = 0; paid <= 800; paid += 53) {
          const doc = net(purchases, opening, paid);
          Customer.applyBalances(doc);
          expect(doc.totalDue >= 0).toBe(true);
          expect(doc.advanceBalance >= 0).toBe(true);
          expect(doc.totalDue === 0 || doc.advanceBalance === 0).toBe(true);
        }
      }
    }
  });

  it('keeps due − advance equal to the net position (INV-A3)', () => {
    for (const [, doc] of cases.map((c) => [c[0], { ...c[1] }])) {
      const expectedNet = doc.totalPurchases + doc.openingDue - doc.totalPaid;
      Customer.applyBalances(doc);
      expect(doc.totalDue - doc.advanceBalance).toBeCloseTo(expectedNet, 2);
    }
  });

  it('tolerates a null document instead of throwing', () => {
    expect(Customer.applyBalances(null)).toBeNull();
  });
});

describe('deriveDue is unchanged by the addition', () => {
  it('still clamps a credit position to zero', () => {
    // The guarantee that makes this safe to ship inert: every existing caller
    // of `deriveDue` sees exactly what it saw before.
    expect(Customer.deriveDue(net(300, 0, 1000))).toBe(0);
    expect(Customer.deriveDue(net(1000, 0, 300))).toBe(700);
  });
});


describe('opening debt nets against a credit balance', () => {
  /**
   * The owner's decision, pinned: carried-in খাতা debt CONSUMES an advance
   * rather than stacking beside it.
   *
   * Exercised through `applyBalances` rather than the service, because the
   * arithmetic is the decision — the service's job is only to call it. What
   * would break without this is not a wrong total but an impossible one: a
   * customer both owing and in credit at the same instant.
   */
  const advanceHolder = () => ({ totalPurchases: 300, openingDue: 0, totalPaid: 1000 });

  it('eats into the deposit instead of creating a due', () => {
    const c = advanceHolder();
    Customer.applyBalances(c);
    expect(c.advanceBalance).toBe(700);

    c.openingDue += 500;              // owner records ৳500 of paper-খাতা debt
    Customer.applyBalances(c);

    expect(c.totalDue).toBe(0);       // they still owe nothing…
    expect(c.advanceBalance).toBe(200); // …and ৳500 of their credit is spoken for
  });

  it('flips to a genuine due once the old debt outgrows the deposit', () => {
    const c = advanceHolder();
    c.openingDue += 900;
    Customer.applyBalances(c);

    expect(c.totalDue).toBe(200);
    expect(c.advanceBalance).toBe(0);
  });

  it('never leaves the customer owing AND in credit at once', () => {
    for (let opening = 0; opening <= 1500; opening += 25) {
      const c = { ...advanceHolder(), openingDue: opening };
      Customer.applyBalances(c);
      expect(c.totalDue === 0 || c.advanceBalance === 0).toBe(true);
    }
  });

  it('the reduction floor still forbids an adjustment MINTING credit', () => {
    /**
     * G6, restated against the derived model. `_applyDueAdjustment` clamps a
     * reduction at `−min(openingDue, totalDue)`, and `totalDue` is `max(0, net)`
     * — so the largest write-off allowed is exactly the debt that is really
     * there, and the net position can never be carried below zero by a
     * correction. Money enters through a money door or not at all.
     */
    const c = { totalPurchases: 1000, openingDue: 500, totalPaid: 200 };
    Customer.applyBalances(c);
    expect(c.totalDue).toBe(1300);

    const shopFloor = -Math.min(c.openingDue, c.totalDue);
    expect(shopFloor).toBe(-500); // bounded by the opening debt, not the total

    c.openingDue += shopFloor;
    Customer.applyBalances(c);
    expect(c.openingDue).toBe(0);
    expect(c.advanceBalance).toBe(0); // no credit was conjured
    expect(c.totalDue).toBe(800);
  });

  it('a write-off cannot mint credit even for a customer who overpaid on goods', () => {
    // Overpaid ৳300 on goods but carries ৳500 of paper debt: net +৳200.
    const c = { totalPurchases: 700, openingDue: 500, totalPaid: 1000 };
    Customer.applyBalances(c);
    expect(c.totalDue).toBe(200);

    // The floor is the SMALLER of the two, so at most ৳200 comes off — not the
    // full ৳500 of opening, which would have left them ৳300 in credit.
    const shopFloor = -Math.min(c.openingDue, c.totalDue);
    expect(shopFloor).toBe(-200);

    c.openingDue += shopFloor;
    Customer.applyBalances(c);
    expect(c.totalDue).toBe(0);
    expect(c.advanceBalance).toBe(0);
  });
});
