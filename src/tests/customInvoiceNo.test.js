/**
 * Shop-chosen invoice numbers — a trader running their own series.
 *
 * Groups, and it matters which is which (AGENT_WORKFLOW.md §7.1):
 *
 *   A. NOTHING NAMED — INVARIANT GUARDS. Pass before and after by construction.
 *      Every checkout on the platform sends no `invoiceNo`, and that path must
 *      stay silent for every shop and every seller — including the shops
 *      without the capability, which is all of them. A gate that fired on the
 *      absent case would refuse every sale on the platform. This is the
 *      tripwire, not a regression test.
 *
 *   B. THE TWO GATES. The capability the platform sells and the permission the
 *      owner grants, checked independently and in that order. Both are
 *      REGRESSIONS in the weak sense — `resolveCustomInvoiceNo` did not exist,
 *      so there is nothing in the old code for them to fail against.
 *
 *   C. THE STRING. What may be stored on a document that gets printed on 58mm
 *      paper, texted, searched with a regex and read back by a human comparing
 *      it to a carbon copy. `~` is the one that carries real weight: it is what
 *      `reviseSale` renames a superseded invoice with, and that trick is only
 *      safe while no real number contains one.
 *
 *   D. WIRING — GUARDS. That the Joi schema carries `invoiceNo`, that the
 *      capability is registered, and that no preset hands the permission out.
 *      Cheap, and D catches the failure that is invisible from the outside:
 *      `validate.middleware` runs with `stripUnknown: true`, so a field missing
 *      from the schema is DELETED before the service sees it — the owner would
 *      type `A-1043`, get `INV-MAIN-20260816-0004`, and no error would be
 *      raised anywhere.
 *
 * Deliberately NOT here: that a duplicate number is actually refused. That is
 * the `{shop, invoiceNo}` unique index doing its job inside MongoDB, and a
 * mocked unit test asserting it would be testing the mock (§7.2). What IS
 * pinned here is that nothing in this feature tries to check uniqueness itself
 * — the util has no database access at all — and that `createSale` is wired to
 * stop retrying when the number was chosen rather than generated.
 */

const mongoose = require('mongoose');

const {
  resolveCustomInvoiceNo,
  MAX_LENGTH,
  REVISION_MARKER,
} = require('../utils/invoiceNo.util');
const {
  MODULES,
  ACTION_LABELS,
  ROLE_PRESETS,
} = require('../config/permissions');
const {
  FEATURES,
  FEATURE_KEYS,
  featureMap,
  shopHasFeature,
} = require('../utils/features.util');
const saleValidation = require('../validations/sale.validation');

const id = () => new mongoose.Types.ObjectId();

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** A shop the platform HAS sold its own numbering to. */
const enabledShop = () => ({ _id: id(), features: { customInvoiceNo: true } });
/** Every other shop on the platform. */
const plainShop = () => ({ _id: id(), features: {} });
/** A shop cached before the flag existed — `features` is undefined entirely. */
const legacyShop = () => ({ _id: id() });

const ownerReq = (shop) => ({ shop, user: { isOwner: true } });
/** A seller explicitly granted `sales.invoice_no`. */
const grantedReq = (shop) => ({
  shop,
  user: {
    isOwner: false,
    permissions: { sales: { view: true, create: true, invoice_no: true } },
  },
});
/** May sell, may not choose the number — the default for every staff role. */
const plainCashierReq = (shop) => ({
  shop,
  user: { isOwner: false, permissions: { sales: { view: true, create: true } } },
});

describe('A. nothing named — invariant guards', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
  ])('%s returns null and throws nothing, for the OWNER of an enabled shop', (_l, raw) => {
    const shop = enabledShop();
    expect(resolveCustomInvoiceNo({ raw, req: ownerReq(shop), shop })).toBeNull();
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
  ])('%s returns null for a cashier in a shop WITHOUT the capability', (_l, raw) => {
    // The one that matters. Every ordinary POS payload on the platform takes
    // this path, and either gate running before the absent check would refuse
    // every sale in every shop.
    const shop = plainShop();
    expect(resolveCustomInvoiceNo({ raw, req: plainCashierReq(shop), shop })).toBeNull();
  });

  test('a shop cached before the flag existed still sells', () => {
    // `features` undefined, not just the key. `shopHasFeature` fails closed, so
    // the capability reads off — but the absent-number path never consults it.
    const shop = legacyShop();
    expect(shopHasFeature(shop, 'customInvoiceNo')).toBe(false);
    expect(resolveCustomInvoiceNo({ raw: undefined, req: plainCashierReq(shop), shop })).toBeNull();
  });

  test('no request and no shop at all (a script or seeder) is not a violation', () => {
    expect(resolveCustomInvoiceNo({ raw: undefined })).toBeNull();
  });
});

describe('B. the two gates', () => {
  test('a shop WITHOUT the capability is refused 400 — not silently ignored', () => {
    // The whole argument for refusing: the invoice is a physical object. A
    // number typed and quietly replaced puts the customer's copy and the shop's
    // book permanently out of step, and nobody finds out for months.
    expect.assertions(3);
    const shop = plainShop();
    try {
      resolveCustomInvoiceNo({ raw: 'A-1043', req: ownerReq(shop), shop });
    } catch (err) {
      expect(err.statusCode).toBe(400);
      expect(err.messageBn).toContain('চালু নেই');
      expect(err.messageBn).toBeTruthy();
    }
  });

  test('the capability is checked BEFORE the permission', () => {
    // Order matters for the message: an owner of a shop without the capability
    // must be told the shop lacks it, not that they lack permission — they
    // would then go looking in the roles screen for a switch that is not there.
    expect.assertions(2);
    const shop = plainShop();
    try {
      resolveCustomInvoiceNo({ raw: 'A-1043', req: plainCashierReq(shop), shop });
    } catch (err) {
      expect(err.statusCode).toBe(400);
      expect(err.statusCode).not.toBe(403);
    }
  });

  test('capability on, but a cashier WITHOUT `sales.invoice_no` is refused 403', () => {
    expect.assertions(2);
    const shop = enabledShop();
    try {
      resolveCustomInvoiceNo({ raw: 'A-1043', req: plainCashierReq(shop), shop });
    } catch (err) {
      expect(err.statusCode).toBe(403);
      expect(err.messageBn).toContain('অনুমতি');
    }
  });

  test('capability on and the permission granted — the number is taken', () => {
    const shop = enabledShop();
    expect(resolveCustomInvoiceNo({ raw: 'A-1043', req: grantedReq(shop), shop })).toBe('A-1043');
  });

  test('the owner needs no explicit grant', () => {
    const shop = enabledShop();
    expect(resolveCustomInvoiceNo({ raw: 'A-1043', req: ownerReq(shop), shop })).toBe('A-1043');
  });
});

describe('C. the string', () => {
  const shop = enabledShop();
  const ok = (raw) => resolveCustomInvoiceNo({ raw, req: ownerReq(shop), shop });
  const rejected = (raw) => {
    try {
      ok(raw);
      return null;
    } catch (err) {
      return err;
    }
  };

  test(`"${REVISION_MARKER}" is refused — reviseSale reserves it`, () => {
    // Load-bearing. `reviseSale` renames a superseded invoice to `<number>~r1`
    // to free the unique key; a live invoice literally called `A-1043~r1` would
    // collide with the rename of `A-1043`, inside a transaction, at the till.
    const err = rejected(`A-1043${REVISION_MARKER}r1`);
    expect(err?.statusCode).toBe(400);
    expect(err?.messageBn).toContain(REVISION_MARKER);
  });

  test('longer than the ceiling is refused', () => {
    expect(rejected('A'.repeat(MAX_LENGTH + 1))?.statusCode).toBe(400);
    expect(ok('A'.repeat(MAX_LENGTH))).toHaveLength(MAX_LENGTH);
  });

  test('whitespace only is refused rather than stored blank', () => {
    // `''` means "generate one" and returns null at rule 1. `'   '` is a
    // different thing — somebody typed in the box — and storing it would put an
    // invisible invoice number on a document that must be findable.
    expect(rejected('   ')?.statusCode).toBe(400);
  });

  test.each([
    ['control characters', 'A-104 3'],
    ['a zero-width joiner', 'A-10‍43'],
    ['an RTL override', 'A-‮1043'],
    ['a null byte', 'A-1043 '],
    ['a leading punctuation mark', '-1043'],
    ['a leading dot', '.1043'],
    ['a combining mark with no letter to sit on', 'ি1043'],
  ])('%s is refused', (_label, raw) => {
    expect(rejected(raw)?.statusCode).toBe(400);
  });

  test.each([
    ['a plain serial', '1043'],
    ['a slashed series', '2026/A-1043'],
    ['a hashed one', '#1043'],
    ['a dotted one', 'HFG.1043'],
    ['an underscored one', 'HFG_1043'],
    ['a parenthesised suffix', 'A-1043(2)'],
    ['Bengali digits', '১০৪৩'],
    ['a Bengali prefix', 'হিসাব-১০৪৩'],
  ])('%s is accepted', (_label, raw) => {
    expect(ok(raw)).toBe(raw);
  });

  test('trimmed, and internal whitespace runs collapse to one space', () => {
    expect(ok('  INV   1043  ')).toBe('INV 1043');
    // A trailing newline is whitespace, not a control character to refuse — it
    // is what a paste from a spreadsheet or the offline queue brings with it.
    expect(ok('A-1043\n')).toBe('A-1043');
  });

  test('case is preserved exactly as typed', () => {
    // This string is printed. An owner who capitalises their series a
    // particular way is entitled to have it come out that way.
    expect(ok('HFG/26-a1043')).toBe('HFG/26-a1043');
  });

  test('the util never touches the database', () => {
    // Uniqueness is the unique index's job, decided on the insert, and a
    // read-then-write check here would be raceable by two tills in the same
    // millisecond. Pinned structurally: the module requires no model.
    const source = require('fs').readFileSync(
      require.resolve('../utils/invoiceNo.util'),
      'utf8'
    );
    expect(source).not.toMatch(/require\(['"]\.\.\/models/);
    // Calls, not the words — the header explains at length why uniqueness is
    // NOT checked here, so a prose match would fail on its own documentation.
    expect(source).not.toMatch(/\.(findOne|countDocuments|exists|find)\s*\(/);
  });
});

describe('D. wiring', () => {
  test('the createSale schema carries `invoiceNo` — stripUnknown would eat it', () => {
    const { error, value } = saleValidation.createSale.validate(
      {
        items: [{ productId: id().toString(), quantity: 1 }],
        invoiceNo: 'A-1043',
      },
      { stripUnknown: true, abortEarly: false }
    );
    expect(error).toBeUndefined();
    // The assertion that matters: it SURVIVED the strip.
    expect(value.invoiceNo).toBe('A-1043');
  });

  test('an ordinary payload with no invoiceNo still validates', () => {
    const { error, value } = saleValidation.createSale.validate(
      { items: [{ productId: id().toString(), quantity: 1 }] },
      { stripUnknown: true, abortEarly: false }
    );
    expect(error).toBeUndefined();
    expect(value.invoiceNo).toBeUndefined();
  });

  test('the Joi ceiling matches the util ceiling', () => {
    // Two files state the same number; this is what stops them drifting apart
    // and producing a Joi error where the util would have given a Bengali one.
    const { error } = saleValidation.createSale.validate(
      {
        items: [{ productId: id().toString(), quantity: 1 }],
        invoiceNo: 'A'.repeat(MAX_LENGTH + 1),
      },
      { stripUnknown: true, abortEarly: false }
    );
    expect(error).toBeDefined();
  });

  test('`customInvoiceNo` is a registered capability, off by default', () => {
    expect(FEATURE_KEYS).toContain('customInvoiceNo');
    expect(FEATURES.customInvoiceNo.bn).toBeTruthy();
    expect(FEATURES.customInvoiceNo.en).toBeTruthy();
    // It appears in the admin panel from this alone — no admin-side change.
    expect(FEATURES.customInvoiceNo.description).toBeTruthy();
    // Off for a shop nobody has touched, and for one cached before it existed.
    expect(featureMap({}).customInvoiceNo).toBe(false);
    expect(featureMap(null).customInvoiceNo).toBe(false);
    expect(featureMap({ features: { customInvoiceNo: true } }).customInvoiceNo).toBe(true);
  });

  test('it needs no other capability and no storage', () => {
    // It writes no bytes and adds no route — it changes one string on a
    // document that is written either way.
    expect(FEATURES.customInvoiceNo.requires).toEqual([]);
    expect(FEATURES.customInvoiceNo.requiresStorage).toBeUndefined();
    // And it can actually be switched on — no `unavailable` placeholder.
    expect(FEATURES.customInvoiceNo.unavailable).toBeUndefined();
  });

  test('`sales.invoice_no` is a real action with a label, separate from `create`', () => {
    expect(MODULES.sales.actions).toContain('invoice_no');
    expect(ACTION_LABELS.invoice_no).toBeDefined();
    // It renders in the roles matrix from this alone — no frontend change.
    expect(ACTION_LABELS.invoice_no.label).toBeTruthy();
  });

  test('NO preset grants it — it starts owner-only', () => {
    // Unlike `backdate` and `revise`, which widened to the counter because the
    // person standing there is the one who knows. Which series the shop's paper
    // runs on is not that kind of decision, so an owner who wants to delegate
    // grants it explicitly in the roles screen.
    for (const [name, preset] of Object.entries(ROLE_PRESETS)) {
      expect([name, preset.permissions.sales?.invoice_no === true]).toEqual([name, false]);
    }
  });

  test('createSale stops retrying when the number was chosen, not generated', () => {
    // The retry loop exists to redraw the NEXT counter value after a race.
    // A typed number has no next value, so retrying reposts the identical
    // string three times and then reports the third failure — and the duplicate
    // has to surface as INVOICE_NO_TAKEN, which is what tells the offline queue
    // this 409 will never resolve on its own.
    const source = require('fs').readFileSync(
      require.resolve('../services/sale.service'),
      'utf8'
    );
    expect(source).toMatch(/const chosen = forceInvoiceNo \|\| customInvoiceNo/);
    expect(source).toMatch(/!chosen && attempt < maxRetries - 1/);
    expect(source).toMatch(/INVOICE_NO_TAKEN/);
    // And `forceInvoiceNo` must outrank a typed one, or revising an invoice
    // would write the replacement under a different number than the one already
    // printed on the customer's copy.
    expect(source).toMatch(/forceInvoiceNo\s*\|\|\s*customInvoiceNo\s*\|\|\s*await this\.generateInvoiceNumber/);
  });
});
