/**
 * Phase C — a supplier's payable and prepayment are two halves of ONE number.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PINS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Supplier.totalDue` used to be a pure `$inc` accumulator with no `totalPaid`
 * beside it. That works while a payable can only ever be a payable, and stops
 * the moment the shop can be IN CREDIT with a vendor — a credit is the negative
 * half of one net, and `$inc` cannot tell the halves apart.
 *
 * So every path now moves the COMPONENTS and derives both halves.
 * SUPPLIER_DUE_ADVANCE_PLAN.md S-9 is the reason this is a real migration
 * rather than a copy of the customer side: `Customer` already had `totalPaid`
 * and `Supplier` did not.
 *
 * Groups (AGENT_WORKFLOW.md §7.1):
 *
 *   A. THE ARITHMETIC — exclusivity, the net, and the brute-force sweep that
 *      makes "never both" a property rather than three examples.
 *
 *   B. THE SEED — the deploy safety net. Every supplier alive today has no
 *      `totalPaid`, and a confident zero there restates their payable as
 *      everything ever billed.
 *
 *   C. WIRING — REGRESSION, against the source. Five write paths move a
 *      supplier's book and each one must seed before it moves and derive after.
 *      A path that keeps `$inc`-ing `totalDue` is invisible at runtime until a
 *      vendor holds credit.
 */

const fs = require('fs');
const Supplier = require('../models/Supplier.model');
const SupplierBalance = require('../models/SupplierBalance.model');
const { PAYMENT_TYPES } = require('../config/constants');
const Payment = require('../models/Payment.model');

const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8');

/**
 * The source with its comments removed.
 *
 * Needed because these files EXPLAIN the shape they moved away from — the note
 * at `recordPayment` literally reads "`$inc: { totalDue: -amount }` no longer
 * says enough". Matching the raw text would fail on the documentation of the
 * fix rather than on the fix.
 */
const codeOf = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/* ── A. THE ARITHMETIC ────────────────────────────────────────────────────── */

describe('the two halves of a supplier position', () => {
  it('owes what was billed and carried in, less what was paid', () => {
    const doc = { totalAmount: 9000, openingDue: 2000, totalPaid: 3000 };
    Supplier.applyBalances(doc);
    expect(doc.totalDue).toBe(8000);
    expect(doc.advanceBalance).toBe(0);
  });

  it('holds a prepayment when more was paid than was ever owed', () => {
    // ৳50,000 against a ৳9,000 bill: the vendor is holding ৳41,000 of ours.
    // Before Phase C that clamped to zero and the money stopped existing.
    const doc = { totalAmount: 9000, openingDue: 0, totalPaid: 50000 };
    Supplier.applyBalances(doc);
    expect(doc.totalDue).toBe(0);
    expect(doc.advanceBalance).toBe(41000);
  });

  it('never carries a due and a prepayment at once', () => {
    // Brute force rather than examples: exclusivity is what makes it structurally
    // impossible for any aggregation to net one vendor's prepayment against
    // another's debt, and it is what keeps every `{ totalDue: { $gt: 0 } }`
    // query correct with no edits.
    for (let billed = 0; billed <= 2000; billed += 250) {
      for (let opening = 0; opening <= 1000; opening += 250) {
        for (let paid = 0; paid <= 3000; paid += 250) {
          const doc = { totalAmount: billed, openingDue: opening, totalPaid: paid };
          Supplier.applyBalances(doc);
          expect(doc.totalDue > 0 && doc.advanceBalance > 0).toBe(false);
          expect(doc.totalDue).toBeGreaterThanOrEqual(0);
          expect(doc.advanceBalance).toBeGreaterThanOrEqual(0);
          // The net is the whole model: the halves are its two signs.
          expect(doc.totalDue - doc.advanceBalance)
            .toBeCloseTo(billed + opening - paid, 6);
        }
      }
    }
  });

  it('quantizes, so instalments do not leave a vendor on the payable list forever', () => {
    const doc = { totalAmount: 0.1 + 0.2, openingDue: 0, totalPaid: 0.3 };
    Supplier.applyBalances(doc);
    expect(doc.totalDue).toBe(0);
    expect(doc.advanceBalance).toBe(0);
  });
});

/* ── B. THE SEED ──────────────────────────────────────────────────────────── */

describe('a supplier that predates totalPaid', () => {
  it('has no default, so "not yet known" is distinguishable from zero', () => {
    // With `default: 0` mongoose hands every legacy document a confident zero
    // on hydration and the seed can never fire. The absence IS the mechanism.
    expect(Supplier.schema.path('totalPaid').defaultValue).toBeUndefined();
  });

  it('seeds from the invariant that already held', () => {
    // ৳1,00,000 billed, ৳20,000 owed — so ৳80,000 has been paid, and that is
    // recoverable from the rollup without reading a single document.
    const legacy = { totalAmount: 100000, openingDue: 0, totalDue: 20000 };
    Supplier.backfillTotalPaid(legacy);
    expect(legacy.totalPaid).toBe(80000);

    Supplier.applyBalances(legacy);
    expect(legacy.totalDue).toBe(20000); // unchanged, which is the point
    expect(legacy.advanceBalance).toBe(0);
  });

  it('WITHOUT the seed would restate the payable as everything ever billed', () => {
    // The failure this exists to prevent, stated as arithmetic. On a real shop
    // it is lakhs of taka, written silently by an ordinary purchase entry.
    const unseeded = { totalAmount: 100000, openingDue: 0, totalDue: 20000 };
    Supplier.applyBalances(unseeded);
    expect(unseeded.totalDue).toBe(100000);
  });

  it('is idempotent — a document that has the figure is left alone', () => {
    const doc = { totalAmount: 100000, openingDue: 0, totalDue: 20000, totalPaid: 80000 };
    Supplier.backfillTotalPaid(doc);
    expect(doc.totalPaid).toBe(80000);

    const zero = { totalAmount: 5000, openingDue: 0, totalDue: 5000, totalPaid: 0 };
    Supplier.backfillTotalPaid(zero);
    expect(zero.totalPaid).toBe(0); // a real zero survives, not re-seeded
  });

  it('never seeds a negative payment history from an overstated rollup', () => {
    // The two seeded suppliers in হিসাব ফ্যাশন গ্যালারী are overstated against
    // their own documents. They must not become vendors we appear to have been
    // paid BY.
    const overstated = { totalAmount: 1000, openingDue: 0, totalDue: 5000 };
    Supplier.backfillTotalPaid(overstated);
    expect(overstated.totalPaid).toBe(0);
  });
});

/* ── C. WIRING ────────────────────────────────────────────────────────────── */

describe('every path that moves a supplier book seeds first and derives after', () => {
  const paths = [
    ['purchase.service (create + payment + cancel)', '../services/purchase.service'],
    ['purchaseReturn.service (adjustment leg)', '../services/purchaseReturn.service'],
    ['supplier.service (opening due)', '../services/supplier.service'],
  ];

  it.each(paths)('%s seeds totalPaid before moving anything', (_label, mod) => {
    expect(read(mod)).toContain('Supplier.backfillTotalPaid');
  });

  it.each(paths)('%s derives both halves rather than $inc-ing the due', (_label, mod) => {
    expect(read(mod)).toContain('Supplier.applyBalances');
    // The shape that cannot express a prepayment. If it comes back, a vendor
    // holding our money reads as owing us nothing and the money disappears.
    // Asserted on the CODE: these files explain the shape they moved away from.
    expect(codeOf(mod)).not.toMatch(/\$inc:\s*\{[^}]*totalDue/);
  });

  it('re-derives the BRANCH row too, because applyDelta can only $inc', () => {
    const purchase = read('../services/purchase.service');
    // createPurchase, recordPayment and cancelPurchase.
    expect((purchase.match(/SupplierBalance\.recomputeBalances/g) || [])).toHaveLength(3);
    expect(read('../services/purchaseReturn.service')).toContain('SupplierBalance.recomputeBalances');
    expect(read('../services/supplier.service')).toContain('SupplierBalance.recomputeBalances');
  });

  it('kept no alias for the old recomputeDue name', () => {
    // A call site still using it is one nobody thought about when the second
    // half was added; a TypeError finds it more cheaply than a branch row whose
    // advanceBalance silently stayed at zero.
    expect(SupplierBalance.recomputeDue).toBeUndefined();
    expect(typeof SupplierBalance.recomputeBalances).toBe('function');
  });
});

describe('the model layer is ready for the doors, and inert until they open', () => {
  it('gives supplier prepayments their own payment type', () => {
    // Reusing the customer `advance` would put money paid OUT into the customer
    // deposit column and the cash register's money-IN bucket.
    expect(PAYMENT_TYPES.SUPPLIER_ADVANCE).toBe('supplier_advance');
    expect(PAYMENT_TYPES.SUPPLIER_ADVANCE).not.toBe(PAYMENT_TYPES.ADVANCE);
    expect(Payment.schema.path('type').enumValues).toContain('supplier_advance');
  });

  it('lets a Payment name its supplier, for money with no bill under it', () => {
    expect(Payment.schema.path('supplier')).toBeDefined();
    expect(Payment.schema.path('supplier').options.ref).toBe('Supplier');
  });

  it('indexes the vendors holding our money, and only those', () => {
    const idx = Supplier.schema.indexes()
      .find(([keys]) => keys.advanceBalance !== undefined);
    expect(idx).toBeDefined();
    expect(idx[1].partialFilterExpression).toEqual({ advanceBalance: { $gt: 0 } });
  });

  it('mirrors the field onto the branch ledger and overlays it', () => {
    expect(SupplierBalance.schema.path('advanceBalance')).toBeDefined();
    // Without the overlay a branch holding nothing would offer to spend another
    // branch's prepayment.
    expect(read('../models/SupplierBalance.model')).toContain('advanceBalance: row?.advanceBalance || 0');
  });
});
