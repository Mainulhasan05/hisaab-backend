/**
 * I-17 — a landing order never touches the shop's books.
 *
 * The decision (LANDING_PAGE_PLAN.md D8/§2.2) is that this feature is sealed off
 * from the ledger: no `Customer`, no `Sale`, no stock movement, no due. Nearly
 * every shop on this platform is an offline seller whose customer list and P&L
 * are the things they actually rely on, and a stranger who filled in a Facebook
 * ad form is not their customer in any sense they would recognise.
 *
 * The failure this guards is not a crash. It is a shopkeeper opening their
 * customer list and finding four hundred strangers in it, or a P&L that no
 * longer matches the till — and neither is reversible once it has been seeded
 * across a live tenant. So the check is STRUCTURAL: the violation is an import,
 * and an import is visible without running anything.
 *
 * This is the same shape of guard as `adminNoDelete.test.js` (which pins the
 * mounted routes) and `reportDateBuckets.test.js` (which scans services for
 * timezone-less date buckets). Both exist because the thing they protect fails
 * silently.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

/**
 * Every file that makes up the landing page feature.
 *
 * Listed explicitly rather than globbed on a name pattern: a new file added to
 * the feature has to be added here, and being made to think about it once is the
 * point. A glob would silently cover a file whose author never read this rule.
 */
const LANDING_FILES = [
  'models/LandingPage.model.js',
  'models/LandingOrder.model.js',
  'models/LandingOrderCounter.model.js',
  'services/landingPage.service.js',
  'utils/landingPageState.util.js',
  'utils/landingContract.util.js',
  'utils/landingSanitize.util.js',
  'utils/landingDocument.util.js',
];

/**
 * Models this feature may not import, and what importing each would mean.
 *
 * `Order` is on the list for a different reason from the rest: it is not the
 * ledger, but it is the storefront's worklist whose confirm path writes a Sale,
 * and sharing it would put landing orders in front of every existing query over
 * it (D9).
 */
const FORBIDDEN = Object.freeze({
  'Customer.model': 'would put ad respondents in the shop\'s customer book',
  'CustomerBalance.model': 'would book a due against a stranger',
  'Sale.model': 'would put landing orders in the shop\'s sales ledger',
  'StockTransaction.model': 'would move stock this feature does not track',
  'Payment.model': 'would record money the shop has not taken at the counter',
  'InvoiceCounter.model': 'would burn invoice numbers on orders that are not invoices',
  'Order.model': 'would put landing orders in the storefront worklist (D9)',
  'DueAdjustment.model': 'would touch the receivables ledger',
});

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * Match `require('.../<Model>.model')` in any quoting style, including the lazy
 * `require()` inside a function that a determined author might reach for to
 * dodge a top-of-file review.
 *
 * The leading `/` is load-bearing. Without it `Order.model` also matches
 * `LandingOrder.model`, and the guard fails on the feature's own model — which
 * it did on first run. A guard that cries wolf on correct code gets deleted.
 */
function forbiddenPattern(model) {
  const escaped = model.replace(/\./g, '\\.');
  return new RegExp(`require\\(\\s*['"\`][^'"\`]*\\/${escaped}['"\`]\\s*\\)`);
}

/**
 * Every `ref` in a schema, INCLUDING those inside array subdocuments.
 *
 * `schema.paths` stops at the array itself, so a ref one level down is invisible
 * to it — and one level down is precisely where a ledger reference would end up
 * if someone added "which sale did this become" to the status history.
 */
function collectRefs(schema, seen = new Set()) {
  for (const name of Object.keys(schema.paths)) {
    const p = schema.paths[name];
    if (p?.options?.ref) seen.add(p.options.ref);
    // DocumentArray and single nested both expose the child schema here.
    if (p?.schema) collectRefs(p.schema, seen);
    // `[{ type: ObjectId, ref }]` arrays keep the ref on the element caster.
    if (p?.caster?.options?.ref) seen.add(p.caster.options.ref);
  }
  return [...seen];
}

describe('every landing page file exists and is covered by this guard', () => {
  test.each(LANDING_FILES)('%s is present', (rel) => {
    expect(fs.existsSync(path.join(SRC, rel))).toBe(true);
  });
});

describe('I-17 — no ledger model is reachable from the landing feature', () => {
  test.each(LANDING_FILES)('%s imports nothing from the books', (rel) => {
    const source = read(rel);

    for (const [model, why] of Object.entries(FORBIDDEN)) {
      const pattern = forbiddenPattern(model);
      if (pattern.test(source)) {
        throw new Error(`${rel} imports ${model} — ${why}. See LANDING_PAGE_PLAN.md I-17.`);
      }
    }
  });

  test('the service does not reach the ledger through the models barrel either', () => {
    // `require('../models')` would hand it every model at once, which is a
    // complete bypass of the check above.
    const source = read('services/landingPage.service.js');
    expect(source).not.toMatch(/require\(\s*['"`]\.\.\/models['"`]\s*\)/);
  });

  test('the forbidden list itself has not been quietly emptied', () => {
    // A guard whose list is shortened stops failing and looks like it passed.
    expect(Object.keys(FORBIDDEN)).toEqual(expect.arrayContaining([
      'Customer.model', 'Sale.model', 'StockTransaction.model', 'Order.model',
    ]));
  });
});

describe('the guard is not vacuous', () => {
  test('it would catch a ledger import if one appeared', () => {
    expect(forbiddenPattern('Sale.model').test(`const S = require('../models/Sale.model');`)).toBe(true);
  });

  test('it would catch a lazily-required one too', () => {
    const hostile = `function f(){ const C = require("../models/Customer.model"); }`;
    expect(forbiddenPattern('Customer.model').test(hostile)).toBe(true);
  });

  test('it does not fire on an innocent mention in prose', () => {
    // The plan is quoted at length in these files' headers, and those comments
    // name `Sale` and `Customer` deliberately. A guard that tripped on the
    // documentation would be turned off within a week.
    expect(forbiddenPattern('Sale.model').test('// no Sale is written, and no Customer is created')).toBe(false);
  });

  test('REGRESSION: it does not fire on the feature\'s OWN LandingOrder model', () => {
    // The first version matched `Order.model` anywhere in the path, so
    // `require('../models/LandingOrder.model')` tripped the `Order.model` rule
    // and the guard failed against correct code.
    const ours = `const LandingOrder = require('../models/LandingOrder.model');`;
    expect(forbiddenPattern('Order.model').test(ours)).toBe(false);
  });

  test('and it still catches the real Order model', () => {
    expect(forbiddenPattern('Order.model').test(`require('../models/Order.model')`)).toBe(true);
  });
});

describe('the landing order model carries no ledger-shaped fields', () => {
  const LandingOrder = require('../models/LandingOrder.model');
  const paths = Object.keys(LandingOrder.schema.paths);

  test('the customer is a snapshot, not a reference', () => {
    // A `customer` path that was an ObjectId ref would reintroduce the join this
    // whole decision removes.
    expect(paths).toContain('customer.name');
    expect(paths).toContain('customer.phone');
    expect(LandingOrder.schema.path('customer.phone').instance).toBe('String');
  });

  test.each(['customer', 'sale', 'invoiceNo', 'stockTransaction', 'payment'])(
    'there is no top-level "%s" reference field',
    (field) => {
      const p = LandingOrder.schema.path(field);
      // `customer` exists as a nested object, which has no `instance` of
      // ObjectId; what must not exist is a ref.
      expect(p?.options?.ref).toBeUndefined();
    }
  );

  test('the only refs are to this feature, the shop, and the staff member acting', () => {
    // `User` on `statusHistory.by` records WHO moved the status — an audit
    // field, not a ledger reference, and the same thing every other collection
    // here does.
    //
    // The collection walks INTO array subdocuments. `schema.paths` alone stops
    // at `statusHistory` and never sees `statusHistory.by`, so a first version
    // of this assertion reported two refs and would have missed a ledger ref
    // hidden one level down — which is exactly where someone would put it.
    expect(collectRefs(LandingOrder.schema).sort()).toEqual(['LandingPage', 'Shop', 'User']);
  });

  test('the ref walk really does descend into array subdocuments', () => {
    // Guards the guard: if `collectRefs` ever stopped recursing it would return
    // a shorter list and silently start passing.
    expect(collectRefs(LandingOrder.schema)).toContain('User');
  });
});
