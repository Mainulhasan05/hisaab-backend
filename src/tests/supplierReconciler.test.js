/**
 * `recalc-supplier-balances.js` — the supplier books' only second opinion.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SUITE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This script is what the supplier payment doors (SUPPLIER_DUE_ADVANCE_PLAN.md
 * phases E–G) will be checked against. A reconciler that is itself wrong does
 * not merely fail to catch drift — with `--apply` it WRITES its own arithmetic
 * into the book it was pointed at.
 *
 * It was wrong. Until 2026-08-31 it computed
 *
 *     totalPaid = Σ purchase.paid  +  Σ purchase_payment rows
 *
 * while `recordPayment` folds every later settlement INTO `purchase.paid`
 * (`purchasePaymentAllocation.test.js` pins that: a ৳700 payment raises the
 * bills' `paid` by ৳700 *and* writes a ৳700 row). Every later settlement was
 * therefore counted twice, understating the payable by its full amount. A
 * ৳10,000 bill paid ৳3,000 afterwards rebuilt as ৳4,000 owed instead of ৳7,000.
 *
 * Groups (AGENT_WORKFLOW.md §7.1):
 *
 *   A. THE ARITHMETIC — pure functions, real numbers. The clamp, the net, and
 *      the shop-wide rollup that must not be a sum of clamped branch halves.
 *
 *   B. THE AGGREGATION SHAPE — REGRESSION, against the SOURCE. What the script
 *      counts cannot be reached without a database (there is no in-memory Mongo
 *      in this project — FINANCE_GAP_ANALYSIS.md F17), so the properties that
 *      matter are pinned where they are written. Same reason `codCourier`
 *      reads `recalc-account-balances.js` off disk.
 */

const fs = require('fs');
const {
  finalise,
  rollUpBySupplier,
  BILL_LESS_SUPPLIER_TYPES,
} = require('../../scripts/recalc-supplier-balances');
const { PAYMENT_TYPES } = require('../config/constants');

const source = fs.readFileSync(
  require.resolve('../../scripts/recalc-supplier-balances.js'), 'utf8'
);

const row = (over = {}) => ({
  supplier: 'S1', branch: null,
  totalAmount: 0, totalPaid: 0, openingDue: 0, purchaseCount: 0,
  ...over,
});

/* ── A. THE ARITHMETIC ────────────────────────────────────────────────────── */

describe('the payable is derived from components, and the clamp keeps the offcut', () => {
  it('owes what was billed plus carried in, less what was paid', () => {
    const r = finalise(row({ totalAmount: 10000, openingDue: 2000, totalPaid: 3000 }));
    expect(r.net).toBe(9000);
    expect(r.totalDue).toBe(9000);
    expect(r.impliedAdvance).toBe(0);
  });

  it('reports an over-payment as an implied advance instead of clamping it away', () => {
    // The signature of the leak closed on 2026-08-31: ৳50,000 typed against a
    // ৳9,000 bill. `totalDue` structurally cannot hold the ৳41,000, so the
    // script keeps it beside the clamp rather than letting it vanish silently —
    // which is what made the leak survive as long as it did.
    const r = finalise(row({ totalAmount: 9000, totalPaid: 50000 }));
    expect(r.net).toBe(-41000);
    expect(r.totalDue).toBe(0);
    expect(r.impliedAdvance).toBe(41000);
  });

  it('never reports a due and an advance at once', () => {
    for (const [billed, paid] of [[0, 0], [100, 0], [0, 100], [999.99, 1000.01], [5, 5]]) {
      const r = finalise(row({ totalAmount: billed, totalPaid: paid }));
      expect(r.totalDue > 0 && r.impliedAdvance > 0).toBe(false);
      expect(r.totalDue - r.impliedAdvance).toBeCloseTo(r.net, 6);
    }
  });
});

describe('the shop-wide figure is one clamp on one net, not a sum of clamps', () => {
  it('nets an over-paid branch against an owed one', () => {
    // Separate branch books, same vendor: Dhaka is ৳1,000 over-paid, নয়াগোলা
    // owes ৳3,000. The shop owes ৳2,000. Summing the CLAMPED branch dues gives
    // ৳3,000 — overstating the payable by exactly the over-payment, which is
    // the mistake the customer-side recalc had to be corrected for.
    const agg = rollUpBySupplier([
      finalise(row({ supplier: 'S1', branch: 'B1', totalAmount: 5000, totalPaid: 6000 })),
      finalise(row({ supplier: 'S1', branch: 'B2', totalAmount: 3000, totalPaid: 0 })),
    ]).get('S1');

    expect(agg.branchDueSum).toBe(3000); // what the branch rows store
    expect(agg.totalDue).toBe(2000);     // what the shop actually owes
    expect(agg.net).toBe(2000);
  });

  it('agrees with the branch sum in the ordinary case', () => {
    // No branch over-paid, so the clamp is inert and the two figures coincide.
    // This is the state every shop is in today, and the reason the divergence
    // above went unnoticed.
    const agg = rollUpBySupplier([
      finalise(row({ supplier: 'S1', branch: 'B1', totalAmount: 5000, totalPaid: 1000 })),
      finalise(row({ supplier: 'S1', branch: 'B2', totalAmount: 3000, totalPaid: 0 })),
    ]).get('S1');

    expect(agg.branchDueSum).toBe(agg.totalDue);
    expect(agg.totalDue).toBe(7000);
  });

  it('carries the opening due into the rollup', () => {
    // Dropping this term would report every shop that onboarded paper-খাতা
    // supplier debt as drifted, and with --apply would write that away.
    const agg = rollUpBySupplier([
      finalise(row({ supplier: 'S1', branch: 'B1', openingDue: 200000 })),
    ]).get('S1');

    expect(agg.openingDue).toBe(200000);
    expect(agg.totalDue).toBe(200000);
  });
});

/* ── B. THE AGGREGATION SHAPE ─────────────────────────────────────────────── */

describe('what the script counts', () => {
  it('does NOT add bill-attributed payment rows on top of purchase.paid', () => {
    // THE REGRESSION, and it is the `purchase` predicate that carries it.
    //
    // The old aggregate matched `purchase: { $ne: null }` and joined back
    // through the bill to find the supplier — which is to say it counted
    // exactly the rows `recordPayment` had ALREADY folded into `purchase.paid`.
    // The new one matches rows with no bill under them at all. The two
    // predicates are each other's complement, so this is the assertion that
    // separates the fixed script from the broken one.
    const block = source.slice(source.indexOf("collection('payments')"));
    const aggregate = block.slice(0, block.indexOf(']).toArray()'));

    expect(aggregate).toContain('purchase: null');
    expect(aggregate).not.toContain('purchase: { $ne: null }');

    // No join, because there is no bill to join to — and reintroducing one is
    // how the double count would come back.
    expect(aggregate).not.toContain('$lookup');
    expect(aggregate).not.toContain('purchaseDoc');

    // One aggregate over payments, so a second one cannot quietly re-add them.
    expect(source.match(/collection\('payments'\)/g) || []).toHaveLength(1);
  });

  it('excludes voided payments', () => {
    // Inert today — cancelling a purchase is the only thing that voids its
    // payments, and those were excluded transitively. Load-bearing the moment
    // a payment-void endpoint exists, which the advance work requires.
    expect(source).toContain('LIVE_PAYMENT');
    const block = source.slice(source.indexOf("collection('payments')"));
    expect(block).toContain('...LIVE_PAYMENT');
  });

  it('names its payment types from the constants, not as literals', () => {
    // Matched on membership rather than the exact literal: the set legitimately
    // grows (a supplier advance type is coming), and a test that fails on an
    // ADDITION is testing punctuation. What must hold is that the type a
    // standalone supplier payment will carry is counted.
    expect(BILL_LESS_SUPPLIER_TYPES).toContain(PAYMENT_TYPES.PURCHASE_PAYMENT);
    expect(source).toContain('PAYMENT_TYPES.PURCHASE_PAYMENT');
  });

  it('counts purchases once, excluding cancelled ones', () => {
    const block = source.slice(source.indexOf("collection('purchases')"));
    expect(block).toContain("status: { $ne: 'cancelled' }");
    expect(block).toContain("totalPaid: { $sum: '$paid' }");
  });
});

describe('what the script checks, and what it refuses to repair', () => {
  it('visits every shop, not only the multi-branch ones', () => {
    // The shop-wide rollup is the only book a single-branch shop has, and it
    // had no second opinion at all while this script filtered on
    // `multiBranchEnabled` — which is most shops (AGENT_WORKFLOW.md I-1).
    expect(source).not.toContain('const shopFilter = { multiBranchEnabled: true }');
    expect(source).toContain('const shopFilter = {}');
  });

  it('compares Supplier.totalDue against the documents, not against the branch sum', () => {
    expect(source).toContain('Supplier.totalDue is');
    expect(source).toContain('documents say');
  });

  it('never restates a shop-wide rollup unless explicitly asked to', () => {
    // A drifted rollup normally got that way through a live write path, and
    // restating it destroys the evidence before anyone has found which one.
    // The `suppliers` write exists for the other case — seeded history that no
    // write path of ours ever maintained — and it is gated on BOTH flags.
    const repair = source.slice(source.indexOf("db.collection('suppliers').bulkWrite") - 1200);
    expect(repair).toContain('APPLY && REPAIR_SUPPLIERS');

    // And the flag is off by default: no other spelling reaches that write.
    expect(source).toContain("const REPAIR_SUPPLIERS = process.argv.includes('--repair-suppliers')");
  });

  it('repairs the components, not just the figure derived from them', () => {
    // Restating `totalDue` while leaving `totalPaid` wrong would put the rollup
    // right for exactly as long as it took the next purchase to re-derive it
    // from the same bad input — Phase C made every path derive.
    const push = source.slice(source.indexOf('supplierRepairs.push({'));
    for (const field of ['totalDue', 'totalPaid', 'totalAmount', 'advanceBalance']) {
      expect(push.slice(0, 900)).toContain(field);
    }
  });

  it('does not fail the run on an implied advance', () => {
    // It is a finding about the DATA, not a disagreement between two books.
    // Exiting non-zero would leave every run red until supplier advances ship.
    // A repair run that actually wrote is not a failure either — the mismatch
    // it counted is the thing it just corrected.
    expect(source).toContain('process.exit(mismatches > 0 && !(APPLY && REPAIR_SUPPLIERS) ? 1 : 0)');
    expect(source).toContain('impliedAdvances');
  });
});
