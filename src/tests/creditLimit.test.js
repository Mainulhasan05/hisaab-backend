/**
 * বাকির সীমা — the ceiling on what one customer may owe.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `creditLimit` was named in `auditDiff.util.js`'s tracked-field list and in
 * `auditDiff.test.js` before any such field existed — a dangling reference to a
 * control nobody had built. Until it did, any staff member could extend
 * unlimited credit to anyone and the owner found out at the aging report, after
 * the money was gone.
 *
 * ── What these tests pin ────────────────────────────────────────────────────
 *
 *   A. INERT BY DEFAULT — a walk-in, and every customer with no limit set, must
 *      check out exactly as before. That is every customer on the platform on
 *      the day this shipped.
 *   B. THE PROJECTION — the check runs on what the customer will owe AFTER the
 *      settlement, so paying money off is never what gets refused.
 *   C. SHOP-WIDE — the ceiling is checked against `Customer.totalDue`, not the
 *      branch book, or a ৳10,000 limit becomes ৳30,000 across three branches.
 *   D. THE OVERRIDE — passable with the permission, refused without it, and it
 *      returns a record, because the audit entry IS the control.
 *   E. THE WRITE SIDE — setting a limit takes the same permission.
 */

const {
  limitFor,
  projectedDue,
  assertWithinCreditLimit,
  resolveCreditLimit,
} = require('../utils/creditLimit.util');

// `hasPermission` reads `req.user.permissions`, NOT `req.permissions`. Getting
// that wrong produces a fixture that denies everything and tests that pass for
// the wrong reason.

/** A cashier: no owner flag, no override permission. */
const cashier = () => ({
  user: {
    isOwner: false,
    permissions: { customers: { view: true, create: true, update: true, credit_override: false } },
  },
});

/** A manager the owner has handed the override to. */
const approver = () => ({
  user: { isOwner: false, permissions: { customers: { credit_override: true } } },
});

const owner = () => ({ user: { isOwner: true, permissions: {} } });

const customer = (over = {}) => ({
  name: 'করিম',
  phone: '01711223344',
  totalDue: 8000,
  creditLimit: 10000,
  ...over,
});

// ── A. Inert by default ─────────────────────────────────────────────────────

describe('A · a shop that has never set a limit notices nothing', () => {
  it('passes a walk-in with no customer at all', () => {
    expect(
      assertWithinCreditLimit({ customer: null, newDue: 999999 }, cashier())
    ).toBeNull();
  });

  it.each([
    ['unset', undefined],
    ['zero — the schema default on every existing row', 0],
    ['null', null],
    ['a cleared number input', NaN],
    ['a negative left by pre-schema data', -500],
  ])('treats %s as no limit', (_label, creditLimit) => {
    // A limit that arrived as `NaN` from a cleared box must not start refusing
    // sales. Every one of these reads as unlimited, deliberately.
    expect(limitFor(customer({ creditLimit }))).toBe(0);
    expect(
      assertWithinCreditLimit(
        { customer: customer({ creditLimit, totalDue: 500000 }), newDue: 500000 },
        cashier()
      )
    ).toBeNull();
  });
});

// ── B. The projection ───────────────────────────────────────────────────────

describe('B · the check runs on what they will owe, not on what they owe now', () => {
  it('allows a sale that stays inside the ceiling', () => {
    // ৳8,000 owed, ৳1,500 more, ৳10,000 limit → ৳9,500. Fine.
    expect(
      assertWithinCreditLimit({ customer: customer(), newDue: 1500 }, cashier())
    ).toBeNull();
  });

  it('allows landing exactly on the ceiling', () => {
    // The comparison is `>`, not `>=`. A limit of ৳10,000 means ৳10,000 is
    // allowed — refusing the round number an owner typed reads as an off-by-one
    // bug to the person standing at the till.
    expect(
      assertWithinCreditLimit({ customer: customer(), newDue: 2000 }, cashier())
    ).toBeNull();
  });

  it('subtracts the due settled at this checkout before judging', () => {
    // THE REGRESSION. A customer at ৳8,000 against a ৳10,000 ceiling walks in,
    // pays ৳5,000 off, then buys ৳4,000 on credit. They end at ৳7,000 — LOWER
    // than they started. Checking before the settlement would refuse exactly
    // the behaviour the limit exists to encourage.
    expect(
      assertWithinCreditLimit(
        { customer: customer(), dueSettled: 5000, newDue: 4000 },
        cashier()
      )
    ).toBeNull();

    expect(projectedDue({ customer: customer(), dueSettled: 5000, newDue: 4000 })).toBe(7000);
  });

  it('floors the projection at zero', () => {
    // Over-settling cannot produce a negative balance that then "absorbs" a
    // future sale. `deriveDue` clamps the same way everywhere else.
    expect(projectedDue({ customer: customer({ totalDue: 100 }), dueSettled: 500 })).toBe(0);
  });

  it('refuses a sale that crosses the ceiling, naming the figures', () => {
    // "Limit exceeded" tells a cashier nothing they can act on. They need to
    // know how much to collect first, so the message carries all three numbers.
    let err;
    try {
      assertWithinCreditLimit({ customer: customer(), newDue: 3500 }, cashier());
    } catch (e) { err = e; }

    expect(err.statusCode).toBe(400);
    expect(err.messageBn).toContain('10000');
    expect(err.messageBn).toContain('11500');
    expect(err.messageBn).toContain('1500');
  });
});

// ── C. Shop-wide ────────────────────────────────────────────────────────────

describe('C · the ceiling belongs to the human, not to the till', () => {
  it('judges against the shop-wide rollup, never a branch figure', () => {
    // Under SEPARATE customer books the branch balance can be far below the
    // shop-wide one. Checking the branch figure would let a ৳10,000 limit
    // become ৳30,000 across three branches — the exact hole this closes.
    //
    // The util is handed the `Customer` document and reads `totalDue` off it;
    // it is never given a branch balance to be tempted by. Asserted as "the
    // projection is built from totalDue", which is the phrasing that survives
    // someone passing a branch row in later.
    const c = customer({ totalDue: 9500, creditLimit: 10000 });
    expect(projectedDue({ customer: c, newDue: 1000 })).toBe(10500);
    expect(() => assertWithinCreditLimit({ customer: c, newDue: 1000 }, cashier())).toThrow();
  });
});

// ── D. The override ─────────────────────────────────────────────────────────

describe('D · the block is passable, and every pass is on the record', () => {
  it('refuses the override to someone without the permission', () => {
    // 403, not a silent downgrade to the 400 block. A cashier who tapped
    // "approve" has to be told the tap did nothing, or they will believe the
    // sale went through over the limit and stop trusting the figure.
    let err;
    try {
      assertWithinCreditLimit(
        { customer: customer(), newDue: 3500, override: true },
        cashier()
      );
    } catch (e) { err = e; }

    expect(err.statusCode).toBe(403);
  });

  it('lets an approver through and hands back the record to audit', () => {
    // The returned object is the whole point: the control is not the refusal,
    // it is that passing it writes an entry naming who approved what. A
    // boolean return would have made the audit entry impossible to write.
    const record = assertWithinCreditLimit(
      { customer: customer(), newDue: 3500, override: true },
      approver()
    );

    expect(record).toEqual({
      limit: 10000,
      previousDue: 8000,
      projectedDue: 11500,
      exceededBy: 1500,
      customerName: 'করিম',
    });
  });

  it('lets the owner through without a permissions object', () => {
    expect(
      assertWithinCreditLimit({ customer: customer(), newDue: 3500, override: true }, owner())
    ).toMatchObject({ exceededBy: 1500 });
  });

  it('returns null — not a record — when the override was unnecessary', () => {
    // A POS that always sends `creditOverride: true` must not produce an audit
    // entry on every ordinary sale. Nothing was overridden, so there is nothing
    // to record.
    expect(
      assertWithinCreditLimit({ customer: customer(), newDue: 100, override: true }, approver())
    ).toBeNull();
  });

  it('does not refuse an internal call with no request', () => {
    // `reviseSale` re-runs a checkout that was already approved once. Re-judging
    // it would make an over-limit sale uncorrectable — the shopkeeper could
    // neither fix the invoice nor leave it wrong.
    expect(
      assertWithinCreditLimit({ customer: customer(), newDue: 3500, override: true }, null)
    ).toMatchObject({ exceededBy: 1500 });
  });
});

// ── E. The write side ───────────────────────────────────────────────────────

describe('E · setting a ceiling takes the same permission as passing one', () => {
  it('is a no-op when nothing was asked for', () => {
    // Every ordinary customer edit. Returning `undefined` is what lets the
    // caller spread-or-skip rather than write an explicit undefined.
    for (const raw of [undefined, null, '']) {
      expect(resolveCreditLimit(raw, cashier())).toBeUndefined();
    }
  });

  it('refuses a cashier', () => {
    let err;
    try { resolveCreditLimit(20000, cashier()); } catch (e) { err = e; }
    expect(err.statusCode).toBe(403);
  });

  it('accepts an approver and quantizes the figure', () => {
    expect(resolveCreditLimit('10000.005', approver())).toBe(10000.01);
    expect(resolveCreditLimit(0, approver())).toBe(0); // clearing the ceiling
  });

  it('rejects a negative or malformed ceiling as a 400, not a 403', () => {
    // The shape is wrong regardless of who is asking, so the shape is checked
    // first — an owner typing "-5" should be told the number is wrong, not that
    // they lack permission.
    for (const bad of [-1, 'abc', Infinity]) {
      let err;
      try { resolveCreditLimit(bad, owner()); } catch (e) { err = e; }
      expect(err?.statusCode).toBe(400);
    }
  });
});
