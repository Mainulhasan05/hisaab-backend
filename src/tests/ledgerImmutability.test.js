/**
 * Which collections may never be hard-deleted, and why the list had holes.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `immutableGuard` was applied to `Sale`, `Payment`, `Expense`, `Purchase`,
 * `DueAdjustment`, `SupplierDueAdjustment` and `PlatformPayment` — and to none
 * of `SalesReturn`, `AccountEntry` or `AccountTransfer`, which move money on
 * exactly the same footing:
 *
 *   · a `SalesReturn` has already decremented `Sale.returnedProfit`, the
 *     customer's due and the product's stock;
 *   · an `AccountEntry` has already moved `PaymentAccount.balance`, which is
 *     stored rather than derived;
 *   · an `AccountTransfer` has moved TWO balances and is read from both ends by
 *     the cash register.
 *
 * Deleting any of the three leaves those effects standing with nothing left to
 * explain them. The policy was right; its coverage was not.
 *
 * REGRESSIONS for the three newly-guarded models — they delete happily against
 * the old code — and INVARIANT GUARDS for the seven already covered.
 *
 * ── Why these drive the real query path ─────────────────────────────────────
 *
 * An earlier version of this file called `schema.s.hooks.execPre` with a bare
 * `{}` as the hook's `this`. That passed for nine models and threw a TypeError
 * on the tenth, because `Expense` registers its own `pre(/^(find|count|
 * distinct)/)` that calls `this.where(...)` — a real Query method the fake
 * context did not have. The failure was in the harness, not the guard.
 *
 * `Model.deleteMany({})` runs the same middleware the application runs, needs
 * no connection to reject (the guard fires before any I/O), and cannot drift
 * from the real path because it IS the real path.
 */
const { AppError } = require('../middleware/error.middleware');

/** Every collection that records money changing hands or changing owner. */
const GUARDED = [
  // Guarded from the start.
  'Sale',
  'Payment',
  'Expense',
  'Purchase',
  'DueAdjustment',
  'SupplierDueAdjustment',
  'PlatformPayment',
  // Added here. Each moved money and could be deleted without trace.
  'SalesReturn',
  'AccountEntry',
  'AccountTransfer',
];

/** Assert a promise rejected with the ledger guard's 403. */
async function expectRefusal(run, modelName) {
  await expect(run()).rejects.toMatchObject({
    statusCode: 403,
    // The Bengali half matters: the entire Bengali error vocabulary was once
    // built, maintained and never once seen by a shopkeeper.
    messageBn: expect.stringContaining('বাতিল'),
    message: expect.stringContaining(modelName),
  });
  await expect(run()).rejects.toBeInstanceOf(AppError);
}

describe.each(GUARDED)('%s cannot be hard-deleted', (modelName) => {
  const Model = require('../models/' + modelName + '.model');

  it('refuses a query-level deleteOne', async () => {
    await expectRefusal(() => Model.deleteOne({ _id: '000000000000000000000000' }), modelName);
  });

  it('refuses deleteMany — the one that empties a collection', async () => {
    await expectRefusal(() => Model.deleteMany({}), modelName);
  });

  it('refuses findOneAndDelete', async () => {
    await expectRefusal(() => Model.findOneAndDelete({ _id: '000000000000000000000000' }), modelName);
  });

  it('refuses a document-level deleteOne', async () => {
    // The path a service reaches for when it already holds the document.
    const doc = new Model({});
    await expectRefusal(() => doc.deleteOne(), modelName);
  });
});

describe('the policy is stated once, not per model', () => {
  it('every guarded model refuses through the same helper', () => {
    // Ten hand-written pre-hooks would drift. `immutableGuard` is one
    // implementation and the models opt in — which is what makes the list
    // above auditable at a glance.
    const source = require('fs').readFileSync(
      require.resolve('../utils/immutableGuard.util.js'), 'utf8'
    );
    for (const hook of ['deleteOne', 'deleteMany', 'findOneAndDelete']) {
      expect(source).toContain("schema.pre('" + hook + "'");
    }
  });

  it('nothing in the codebase calls a delete on a guarded model', () => {
    // A guard that first fires in production is a guard added too late.
    // Nothing called these paths when the three were added; this pins it, and
    // fails loudly if someone later writes the call instead of a void.
    const fs = require('fs');
    const path = require('path');
    const root = path.resolve(__dirname, '..');
    const pattern = new RegExp(
      '\\b(' + GUARDED.join('|') + ')\\.(deleteOne|deleteMany|findOneAndDelete)\\('
    );

    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'tests' && entry.name !== 'node_modules') walk(full);
        } else if (entry.name.endsWith('.js')) {
          // Comment lines are skipped, or this scan matches the prose that
          // explains why a call site does NOT use the guarded method — which
          // is how it first reported `admin.service.js`' own docblock.
          const hit = fs.readFileSync(full, 'utf8').split('\n')
            .findIndex((line) => {
              const t = line.trim();
              if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
              return pattern.test(line);
            });
          if (hit >= 0) offenders.push(path.relative(root, full) + ':' + (hit + 1));
        }
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });
});
