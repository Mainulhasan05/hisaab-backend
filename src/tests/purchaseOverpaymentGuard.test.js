/**
 * S-1 — a purchase cannot be paid more than it is worth.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PINS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Purchase.pre('save')` clamps `paid` to `totalAmount`. The fund-account debit
 * loop in `createPurchase` does NOT — it runs off the raw `payments[]` legs. So
 * ৳50,000 entered against a ৳9,000 bill debited the account by ৳50,000, stored
 * `paid: 9000`, moved the supplier's খাতা by ৳9,000, and raised nothing.
 * ৳41,000 left the drawer and landed nowhere.
 *
 * Neither recalc script can find that money either: `recalc-supplier-balances`
 * sums `purchase.paid`, which is the CLAMPED figure, so the loss is invisible
 * to the one tool written to catch this class of error.
 *
 * Groups (AGENT_WORKFLOW.md §7.1):
 *
 *   A. THE CLAMP — passes before and after. It is here because the clamp is
 *      what made the loss silent, and a future reader who "fixes" it by
 *      unclamping `paid` would move the ৳41,000 onto the bill instead, which is
 *      the bug `Sale.paid`'s own clamp was written to end.
 *
 *   B. THE GUARD — REGRESSION. Against the pre-fix service every case here
 *      fails: there is no guard to find and no ordering to prove.
 *
 * ── Why against the SOURCE ──────────────────────────────────────────────────
 *
 * `createPurchase` opens a transaction and touches products, stock, batches,
 * the stock ledger, the supplier rollup and the branch ledger before it reaches
 * the money. Reaching it needs a database. Same reason `dueSettlementAtCheckout`
 * §D, `cashDrawerNoDoubleCount` and `fundAccountWiring` read their services off
 * disk — and what matters here is ORDER, which is exactly what a source read
 * can prove and a mocked call cannot.
 *
 * The clamp itself is asserted against the real schema, because that half is
 * reachable without any of the above.
 */

const fs = require('fs');
const mongoose = require('mongoose');
const Purchase = require('../models/Purchase.model');

const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8');

/** The body of the named async method, up to the next method at the same depth. */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return '';
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n {2}(?:async )?[a-zA-Z_][\w]*\s*\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

/* ── A. THE CLAMP THAT MADE IT SILENT ─────────────────────────────────────── */

describe('Purchase.pre(save) still clamps paid, which is why the guard is needed', () => {
  it('trims paid to totalAmount without complaining', async () => {
    const doc = new Purchase({
      shop: new mongoose.Types.ObjectId(),
      invoiceNo: 'PUR-TEST-1',
      createdBy: new mongoose.Types.ObjectId(),
      // A real line, because document validation is itself a pre-save hook and
      // runs first — an invalid doc never reaches the clamp, and a test built
      // on one proves nothing about it.
      items: [{
        product: new mongoose.Types.ObjectId(),
        productName: 'চাল',
        quantity: 1,
        unitPrice: 9000,
        total: 9000,
      }],
      totalAmount: 9000,
      paid: 50000,
    });

    // Run the pre('save') chain the way mongoose would, without a database.
    await new Promise((resolve, reject) => {
      doc.schema.s.hooks.execPre('save', doc, (err) => (err ? reject(err) : resolve()));
    });

    // The clamp is CORRECT and stays: `Purchase.paid` is summed by the P&L, the
    // supplier statement and `cancelPurchase`'s reversal, so it must never
    // carry money that does not belong to this bill. The defect was never the
    // clamp — it was that nothing upstream refused the surplus first.
    expect(doc.paid).toBe(9000);
    expect(doc.due).toBe(0);
  });
});

/* ── B. THE GUARD, AND WHERE IT SITS ──────────────────────────────────────── */

describe('createPurchase refuses an over-payment before any money moves', () => {
  const source = read('../services/purchase.service');
  const body = methodBody(source, 'async createPurchase(');

  it('has the guard at all', () => {
    expect(body).toContain('paidAmount > totalAmount');
  });

  it('refuses rather than clamping quietly', () => {
    // Silently keeping ৳9,000 of a ৳50,000 counted out at the counter leaves
    // ৳41,000 unaccounted for and tells nobody. An error at the counter is
    // recoverable; a fund account short by ৳41,000 three weeks later is not.
    const guard = body.slice(body.indexOf('paidAmount > totalAmount'));
    expect(guard).toContain('400');
    expect(guard).toContain('AppError');
  });

  it('names the maximum so the number in the box can be fixed', () => {
    const guard = body.slice(body.indexOf('paidAmount > totalAmount'), body.indexOf('paidAmount > totalAmount') + 600);
    expect(guard).toContain('${totalAmount}');
  });

  it('fires BEFORE the fund accounts are debited', () => {
    // ORDER IS LOAD-BEARING, and it is the whole bug. `applyAccountDelta` runs
    // off `leg.amount`, which is the UNCLAMPED figure — so a guard placed after
    // it would refuse the purchase having already moved the money.
    const guardAt = body.indexOf('paidAmount > totalAmount');
    const debitAt = body.indexOf('applyAccountDelta');

    expect(guardAt).toBeGreaterThan(-1);
    expect(debitAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(debitAt);
  });

  it('fires AFTER the split legs are summed, so a split payload is covered too', () => {
    // `paidAmount` is overwritten by the sum of `payments[]` when one is sent.
    // A guard above that line would check the ignored top-level `paid` and wave
    // through a split whose legs total ৳50,000 — the same leak by another door.
    const sumAt = body.indexOf('payments.reduce((sum, p)');
    const guardAt = body.indexOf('paidAmount > totalAmount');

    expect(sumAt).toBeGreaterThan(-1);
    expect(sumAt).toBeLessThan(guardAt);
  });
});
