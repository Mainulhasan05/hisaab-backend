/**
 * Phases F and H — clearing old debt at the delivery counter, and saying so on
 * the challan.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE EVENT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   "আজ ৯,০০০ টাকার মাল নিলাম, আর পুরোনো বাকির ৫০,০০০ দিলাম."
 *
 * One visit, two money events. The sale side has recorded this shape since
 * split payments shipped; the purchase side could only refuse it — and before
 * 2026-08-31 it silently DESTROYED the surplus, debiting the fund account by
 * ৳59,000 while storing `paid: 9000` (S-1).
 *
 * Groups (AGENT_WORKFLOW.md §7.1):
 *
 *   A. SEPARATION — `paid` still means money against THIS bill. The old-due
 *      money travels as its own rows. Everything downstream reads `paid` that
 *      way, so folding them together is the one thing that must not happen.
 *
 *   B. ORDER — REGRESSION in the strong sense. The settlement runs BEFORE the
 *      bill is created; run afterwards it finds the new bill in its own
 *      oldest-first walk and pays down debt that did not exist when the money
 *      changed hands.
 *
 *   C. THE SNAPSHOT (H) — `previousDue` frozen at write time, absent rather
 *      than zero when there is nothing to say.
 */

jest.mock('../models/AuditLog.model', () => ({
  create: jest.fn().mockResolvedValue([{}]),
  log: jest.fn().mockResolvedValue({}),
}));

const fs = require('fs');
const Purchase = require('../models/Purchase.model');

const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8');
const source = read('../services/purchase.service');

const methodBody = (src) => {
  const start = src.indexOf('async createPurchase(');
  const rest = src.slice(start);
  const next = rest.search(/\n {2}(?:async )?[a-zA-Z_][\w]*\s*\(/);
  return next === -1 ? rest : rest.slice(0, next);
};

const body = methodBody(source);

/**
 * The same body with its comments removed.
 *
 * The ORDER assertions below need it: the block explaining the design says
 * "Read BEFORE `Purchase.create`", so matching raw text finds that sentence
 * before it finds the call, and the check fails on its own documentation.
 */
const code = methodBody(
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
);

/* ── A. SEPARATION ────────────────────────────────────────────────────────── */

describe('old-due money is not this bill\'s `paid`', () => {
  it('routes it through the one service that allocates supplier money', () => {
    // Not a second implementation of "which bills did this settle". Four of
    // those is how two books drift apart, which is why that service exists.
    expect(body).toContain('supplierSettlement.settleSupplierDue');
  });

  it('leaves the paid ceiling in place', () => {
    // `paid` is clamped to the bill's total by `Purchase.pre('save')`, and the
    // P&L, the supplier statement and `cancelPurchase`'s reversal all read it
    // as "tendered against THIS invoice". The whole point of a separate field
    // is that this guard stays.
    expect(body).toContain('paidAmount > totalAmount');
  });

  it('refuses old-due money with no supplier to owe it to', () => {
    // A সরাসরি কেনা has no খাতা. Refusing beats ignoring: the money was
    // handed over and has to land somewhere.
    expect(body).toContain('Cannot settle old dues without a supplier');
  });
});

/* ── B. ORDER ─────────────────────────────────────────────────────────────── */

describe('the settlement happens before the bill exists', () => {
  it('settles, then creates', () => {
    // ORDER IS LOAD-BEARING. `settleSupplierDue` walks the supplier's open
    // bills oldest-first. Run after `Purchase.create`, it would find the bill
    // just written and apply the money to debt the shopkeeper had not incurred
    // when they handed it over — and `paid` would then double-count part of it.
    const settleAt = code.indexOf('settleSupplierDue');
    const createAt = code.indexOf('Purchase.create');

    expect(settleAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(settleAt).toBeLessThan(createAt);
  });

  it('reads the previous balance before both', () => {
    // Otherwise the snapshot on the slip would already have the settlement in
    // it, and পূর্বের বাকি would print as the balance AFTER paying — which is
    // the one number it must never be.
    const readAt = code.indexOf('supplierSettlement.readPayable');
    const settleAt = code.indexOf('settleSupplierDue');

    expect(readAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(settleAt);
  });

  it('refreshes the in-memory supplier after the settlement moved it', () => {
    // The rollup further down ADDS to these figures. Left stale, the new bill's
    // due would be added to a payable that still included the money just paid.
    const after = body.slice(body.indexOf('settleSupplierDue'));
    expect(after).toContain('supplierDoc.totalPaid = dueSettlement.supplier.totalPaid');
  });
});

/* ── C. THE SNAPSHOT ──────────────────────────────────────────────────────── */

describe('the challan states what was owed before it', () => {
  it('stores the figure the server read, never the client\'s', () => {
    // The client shows পূর্বের বাকি so the shopkeeper can decide what to pay.
    // Trusting it for the document would let a stale or edited page write the
    // vendor's history.
    expect(body).toContain('previousDue = before.totalDue');
    expect(body).not.toContain('purchaseData.previousDue');
  });

  it('leaves it ABSENT rather than 0 when there is no supplier', () => {
    // A third answer, and readers need it: "no snapshot was taken" is not
    // "they were owed ৳0". A default would make every reprint of an older bill
    // assert the second.
    expect(Purchase.schema.path('previousDue').defaultValue).toBeUndefined();
    expect(Purchase.schema.path('dueSettled').defaultValue).toBeUndefined();
    expect(body).toContain('...(previousDue === null ? {} : {');
  });

  it('is a snapshot, so a reprint shows what the paper showed', () => {
    // Deriving at print time would make last month's challan display today's
    // balance — a different document every time it comes off the printer, and
    // useless for reconciling against the vendor's own paper.
    const path = Purchase.schema.path('previousDue');
    expect(path.instance).toBe('Number');
    expect(read('../models/Purchase.model')).toContain('Read server-side inside the transaction');
  });

  it('is withheld from anyone who may not see purchase cost', () => {
    // The print payload is gated by `sanitizePurchases` and nothing else, so a
    // money figure it does not name is a money figure that leaks. `previousDue`
    // is the vendor relationship in one number.
    const sanitizer = read('../utils/dataSanitizer.util');
    const keys = sanitizer.slice(
      sanitizer.indexOf('const PURCHASE_MONEY_KEYS'),
      sanitizer.indexOf('function sanitizePurchases')
    );
    expect(keys).toContain("'previousDue'");
    expect(keys).toContain("'dueSettled'");
  });
});
