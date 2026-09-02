/**
 * অগ্রিম handed over WITH the goods — the purchase side's counter deposit.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PINS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * "মাল ১২০ টাকার, দিলাম ৫,০০০" is an ordinary thing to do at a vendor's
 * counter, and `createPurchase` could only refuse it: `paid > totalAmount` was
 * a 400 whose message sent the shopkeeper to the supplier page to do it in two
 * steps. The sale side has taken the mirror of this since `advanceDeposit`
 * shipped on `createSale`; this is the other half.
 *
 * Groups (AGENT_WORKFLOW.md §7.1):
 *
 *   A. THE LEG EXISTS AND IS ROUTED — the surplus reaches the one service that
 *      knows how to allocate it, carrying `allowAdvance`.
 *
 *   B. `paid` STILL MEANS THE BILL — the invariant every report, the P&L and
 *      `cancelPurchase`'s reversal read it by. The prepayment must never be
 *      swept into it.
 *
 *   C. THE CEILING STILL HOLDS — an ordinary পুরোনো বাকি payment keeps its
 *      over-payment refusal by construction, not by everyone remembering.
 *
 *   D. OWNER-ONLY — the same bar `POST /suppliers/:id/advance` carries, because
 *      paying ahead parts with cash for nothing yet received.
 */

const fs = require('fs');

const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8');

const SRC = read('../services/purchase.service');

/** The `createPurchase` settlement block, isolated so a match elsewhere in the
 *  file — `recordPayment` also settles — cannot satisfy an assertion here. */
const SETTLEMENT_BLOCK = (() => {
  const start = SRC.indexOf('const settleRequested = toMoney(purchaseData.dueSettlement)');
  const end = SRC.indexOf('const [purchase] = await Purchase.create(');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('createPurchase settlement block not found — update this test');
  }
  return SRC.slice(start, end);
})();

/* ── A. THE LEG EXISTS AND IS ROUTED ──────────────────────────────────────── */

describe('the surplus reaches the settlement service', () => {
  it('reads advanceDeposit off the request body', () => {
    // Named the same as the sale side's field on purpose: one idea, one name,
    // or a shopkeeper-facing API needs two words for the same thing.
    expect(SETTLEMENT_BLOCK).toContain('toMoney(purchaseData.advanceDeposit)');
  });

  it('enters the settlement on a deposit alone, not only on an old-due payment', () => {
    /**
     * The exact shape that 500-ed on the sale side for months: a PURE deposit
     * sends `advanceDeposit` with no `dueSettlement` beside it. Guarding the
     * block on `settleRequested > 0` alone would make the prepayment
     * unreachable for the vendor nobody is owed anything by — which is most of
     * the vendors a shop pays ahead.
     */
    expect(SETTLEMENT_BLOCK).toContain('if (settleRequested > 0 || advanceDeposit > 0)');
  });

  it('hands over ONE amount and lets the service split it', () => {
    // The two-row rule lives inside `settleSupplierDue`: it writes the khata
    // row and the advance row by the debt it finds. Splitting here instead
    // would mean a second implementation of an allocation that must not drift.
    expect(SETTLEMENT_BLOCK).toMatch(
      /amount:\s*quantizeMoney\(settleRequested \+ advanceDeposit\)/
    );
  });

  it('passes allowAdvance, gated on a deposit actually being asked for', () => {
    expect(SETTLEMENT_BLOCK).toMatch(/allowAdvance:\s*advanceDeposit > 0/);
  });
});

/* ── B. `paid` STILL MEANS MONEY AGAINST THIS BILL ────────────────────────── */

describe('the prepayment never leaks into purchase.paid', () => {
  it('leaves the paid ceiling in place', () => {
    /**
     * `paid` is what the P&L, the supplier statement, `recalc-supplier-balances`
     * and `cancelPurchase`'s reversal all read as "money against THIS bill".
     * Raising the ceiling to admit the surplus — rather than routing it — is
     * the change that would silently destroy it again: `Purchase.pre('save')`
     * clamps `paid` to `totalAmount` while the fund-account debit loop runs off
     * the raw legs, so the difference leaves the drawer and lands nowhere.
     */
    expect(SRC).toContain('if (paidAmount > totalAmount)');
  });

  it('never adds the deposit to paidAmount', () => {
    expect(SRC).not.toMatch(/paidAmount\s*[+]=\s*advanceDeposit/);
    expect(SRC).not.toMatch(/paid:\s*quantizeMoney\(paidAmount \+ advanceDeposit\)/);
  });

  it('still recomputes the vendor pool after the bill exists', () => {
    /**
     * ORDER IS LOAD-BEARING. The settlement runs BEFORE `Purchase.create` — run
     * after, its oldest-first walk would pay down debt the shopkeeper had not
     * yet incurred. The reallocation runs AFTER, so this bill is in the queue
     * and a prepayment cannot skip the delivery it arrived with.
     *
     * `advanceApplied` is RECOMPUTED and never patched; this is the only writer.
     */
    expect(SRC).toContain('reallocateSupplierAdvance');
    const settleAt = SRC.indexOf('const [purchase] = await Purchase.create(');
    const reallocAt = SRC.indexOf('advanceAllocations = await supplierSettlement.reallocateSupplierAdvance');
    expect(reallocAt).toBeGreaterThan(settleAt);
  });
});

/* ── C. THE CEILING STILL HOLDS FOR EVERY OTHER CALLER ────────────────────── */

describe('an ordinary পুরোনো বাকি payment keeps its refusal', () => {
  it('does not hardcode allowAdvance true', () => {
    // `allowAdvance` defaults false on `settleSupplierDue` precisely so a
    // caller cannot acquire the surplus by forgetting. A literal `true` here
    // would hand every old-due payment on this screen an unbounded ceiling.
    expect(SETTLEMENT_BLOCK).not.toMatch(/allowAdvance:\s*true/);
  });

  it('refuses a deposit with no vendor to hold it', () => {
    // A সরাসরি কেনা has no account to prepay. Refused rather than ignored:
    // silently dropping it while the form says the money was handed over is
    // the worst of both.
    expect(SETTLEMENT_BLOCK).toContain('সরবরাহকারী ছাড়া অগ্রিম দেওয়া যাবে না');
  });
});

/* ── D. OWNER-ONLY ────────────────────────────────────────────────────────── */

describe('paying a vendor ahead is the owner’s decision', () => {
  it('refuses a non-owner, in the service and not only in the UI', () => {
    /**
     * Enforced here rather than by route middleware because the route also
     * carries ordinary deliveries a cashier must keep being able to record:
     * `rbac('purchases','create')` is right for the bill and too weak for the
     * prepayment. Mirrors `ownerOnly` on `POST /suppliers/:id/advance`.
     */
    expect(SETTLEMENT_BLOCK).toContain('req.user?.isOwner');
    expect(SETTLEMENT_BLOCK).toContain('শুধুমাত্র দোকান মালিক সরবরাহকারীকে অগ্রিম দিতে পারবেন');
  });

  it('checks the owner gate only when a deposit was asked for', () => {
    // An ordinary delivery by a cashier must not meet an owner check. The gate
    // sits inside `if (advanceDeposit > 0)`.
    const gateAt = SETTLEMENT_BLOCK.indexOf('req.user?.isOwner');
    const guardAt = SETTLEMENT_BLOCK.indexOf('if (advanceDeposit > 0)');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeGreaterThan(guardAt);
  });
});
