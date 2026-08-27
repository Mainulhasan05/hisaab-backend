/**
 * Enabling multi-branch must carry EVERYTHING into the default branch.
 *
 * The rule: flipping the flag reorganises a shop's history, it never hides any
 * of it. Nothing is deleted by the enable path — but a row left untagged, or a
 * ledger left unseeded, is unreachable from every branch-selected view, which
 * to the shop is indistinguishable from deletion.
 *
 * Three real gaps this pins, all found on a live shop:
 *
 *   1. `SupplierBalance` was not seeded AT ALL. It has no scope flag — the
 *      figures follow the active branch unconditionally — and
 *      `overlayBranchFigures` falls back to `|| 0` for a missing row, so every
 *      supplier's payable read ৳0 the instant the flag flipped.
 *
 *   2. `CustomerBalance.openingDue` was seeded as 0 while the customer carried
 *      the real figure. `setOpeningDue` measures its delta against the branch
 *      row under branch scope, so an owner re-entering the true opening due
 *      added it a SECOND time.
 *
 *   3. `DueAdjustment` / `SupplierDueAdjustment` kept `branch: null`. Both
 *      ledgers filter on branch, so every খাতা-carried opening line vanished
 *      from the খতিয়ান while its money stayed in `totalDue` — a balance with
 *      nothing left on the page to explain it.
 */

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '../services/admin.service.js'), 'utf8'
);

// The enable path only — `disableMultiBranch` and the rest of the file follow.
const enableBody = src.slice(
  src.indexOf('async enableMultiBranch'),
  src.indexOf('async disableMultiBranch')
);

describe('enableMultiBranch backfills every branch-scoped model', () => {
  // Kept as a literal list rather than derived, so ADDING a `branch` field to a
  // model without adding it here is what fails — the failure mode being fixed.
  const MUST_BACKFILL = [
    'Sale', 'Purchase', 'Expense', 'CashRegister', 'StockTransaction',
    'Payment', 'SalesReturn', 'PurchaseReturn', 'SMSLog', 'AuditLog', 'HeldCart', 'Order',
    'DueAdjustment', 'SupplierDueAdjustment',
  ];

  const listed = enableBody
    .slice(enableBody.indexOf('const branchScopedModels'), enableBody.indexOf('];', enableBody.indexOf('const branchScopedModels')));

  it.each(MUST_BACKFILL)('tags %s rows with the default branch', (model) => {
    expect(listed).toContain(model);
  });

  it('backfills before flipping the flag', () => {
    // An interrupted backfill must leave the shop single-branch and resumable,
    // not live with half its history invisible.
    expect(enableBody.indexOf('branchScopedModels')).toBeLessThan(
      enableBody.indexOf('shop.multiBranchEnabled = true')
    );
  });
});

describe('enableMultiBranch seeds both per-branch ledgers', () => {
  it('seeds CustomerBalance including openingDue', () => {
    const seed = enableBody.slice(
      enableBody.indexOf('const customerBalanceOps'),
      enableBody.indexOf('customerBalancesSeeded =')
    );

    for (const field of ['totalPurchases', 'totalPaid', 'totalDue', 'openingDue', 'purchaseCount', 'lastPurchase']) {
      expect(seed).toContain(field);
    }

    // The projection has to ask for it too, or it seeds `undefined || 0`.
    expect(seed).toMatch(/select\([^)]*openingDue/);
  });

  it('seeds SupplierBalance at all', () => {
    const seed = enableBody.slice(
      enableBody.indexOf('const supplierBalanceOps'),
      enableBody.indexOf('supplierBalancesSeeded =')
    );

    // The bulkWrite sits past `supplierBalancesSeeded =`, so it is asserted on
    // the whole enable body rather than the ops-building slice.
    expect(enableBody).toMatch(/SupplierBalance\.bulkWrite/);
    for (const field of ['totalAmount', 'totalPaid', 'totalDue', 'openingDue', 'purchaseCount']) {
      expect(seed).toContain(field);
    }
  });

  it('derives supplier totalPaid from the documented identity, clamped at zero', () => {
    // `Supplier` carries no `totalPaid` column — it only ever $incs — so paid
    // is recovered from `totalDue = max(0, totalAmount + openingDue − totalPaid)`.
    // The clamp matters: on an over-paid supplier the stored due is the CLAMPED
    // value, so the inversion can land negative, and a negative paid figure
    // makes `recomputeDue` overstate the debt on the next purchase cancel.
    expect(enableBody).toMatch(/Math\.max\(0,[\s\S]{0,80}amount \+ opening - due/);
  });

  it('maps the supplier purchase COUNT, not money, into purchaseCount', () => {
    // Vocabulary differs from Customer: on a supplier `totalPurchases` is a
    // count and its per-branch twin is `purchaseCount`. Mapping by name would
    // silently seed the count with money.
    expect(enableBody).toMatch(/purchaseCount:\s*supplier\.totalPurchases/);
  });
});
