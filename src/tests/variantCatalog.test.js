/**
 * Reading a shop's variant vocabulary out of its own products.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS BEING PINNED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The option lists a shopkeeper sees are DERIVED, not stored: every value is
 * read back out of `Product.variants[].attributes` so that a size typed into
 * the product form once is a button from then on, with no catalogue to
 * maintain and no migration to run. See `variantCatalog.service`.
 *
 * That makes the aggregation load-bearing in a way a normal read is not — if it
 * throws, or silently returns nothing, the feature does not degrade loudly, it
 * degrades back to "the shop sees generic presets and has to retype", which is
 * exactly the complaint it was built to answer. Two shapes are dangerous:
 *
 *   1. `$objectToArray` raises on a missing or null input. Most products
 *      predate custom attributes and have no `custom` bucket at all, so an
 *      unguarded stage would take out the aggregation for nearly every shop.
 *
 *   2. `attributes.custom` is `Mixed`. Nothing at the schema level stops a bad
 *      write putting a string or an array there, and one such product must not
 *      be able to break the option list for the whole shop.
 *
 * The MERGE — which values are offered, which built-ins are demoted, what
 * hiding does — is a pure function tested on the client, where it lives:
 * `hisaab-frontend/tests/variantCatalog.test.mjs`.
 */

const mongoose = require('mongoose');

jest.mock('../services/cache.service', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  deletePattern: jest.fn().mockResolvedValue(undefined),
}));

const Product = require('../models/Product.model');
const cacheService = require('../services/cache.service');
const variantCatalogService = require('../services/variantCatalog.service');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();

/** The pipeline the service builds, captured so its shape can be asserted. */
let pipeline;

const stubAggregate = (rows) => {
  jest.spyOn(Product, 'aggregate').mockImplementation((stages) => {
    pipeline = stages;
    return { option: () => Promise.resolve(rows) };
  });
};

beforeEach(() => {
  pipeline = null;
  cacheService.get.mockResolvedValue(null);
  // `jest.restoreAllMocks` restores spies, not the call history of a module
  // mocked by factory — so without this the cache assertions below count every
  // earlier test's writes as well.
  cacheService.set.mockClear();
  cacheService.deletePattern.mockClear();
});

afterEach(() => jest.restoreAllMocks());

/* ══════════════════════════════════════════════════════════════════════════
 * The shape that comes back
 * ══════════════════════════════════════════════════════════════════════════ */

describe('readUsedValues', () => {
  it('returns each type\'s values, commonest first', async () => {
    // The order is the server's job: `$sort` runs before the `$group` that
    // builds the arrays, so what arrives here is already ranked. A client that
    // re-sorted would make the chip row reshuffle between loads.
    stubAggregate([
      { _id: 'size', values: ['36', '34', '38'] },
      { _id: 'color', values: ['লাল'] },
    ]);

    const used = await variantCatalogService.readUsedValues(SHOP);

    expect(used).toEqual({ size: ['36', '34', '38'], color: ['লাল'] });
  });

  it('is empty for a shop with no variant products', async () => {
    // A complete, correct answer — not a failure. The client renders the
    // built-in presets on `{}`, which is exactly what a new shop should see.
    stubAggregate([]);
    expect(await variantCatalogService.readUsedValues(SHOP)).toEqual({});
  });

  it('caps how many values one type may report', async () => {
    // A shop that has mistyped its way to four hundred "sizes" must not be
    // handed four hundred buttons — nor four hundred strings on every product
    // form load.
    const many = Array.from({ length: 200 }, (_, i) => `v${i}`);
    stubAggregate([{ _id: 'size', values: many }]);

    const used = await variantCatalogService.readUsedValues(SHOP);
    expect(used.size).toHaveLength(variantCatalogService.MAX_VALUES_PER_TYPE);
  });

  it('ignores a row with no type', async () => {
    stubAggregate([{ _id: null, values: ['x'] }, { _id: 'size', values: ['M'] }]);
    expect(await variantCatalogService.readUsedValues(SHOP)).toEqual({ size: ['M'] });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * The pipeline itself
 * ══════════════════════════════════════════════════════════════════════════ */

describe('the aggregation', () => {
  const stageNamed = (name) => pipeline.find((s) => Object.keys(s)[0] === name);

  beforeEach(async () => {
    stubAggregate([]);
    await variantCatalogService.readUsedValues(SHOP);
  });

  it('scopes to the shop, and to active products only', async () => {
    // A deleted or deactivated product is not part of the shop's range, and
    // offering its sizes would resurrect the vocabulary of a line they dropped.
    const match = pipeline[0].$match;
    expect(String(match.shop)).toBe(String(SHOP));
    expect(match.isActive).toBe(true);
    expect(match.shop).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it('guards $objectToArray against a missing custom bucket', () => {
    /**
     * The failure that would have hit almost every shop. `$objectToArray`
     * raises on a null or missing input, and most products have no `custom`
     * bucket at all — so without both the `$type` test and the `$ifNull`, the
     * whole aggregation errors and every shop falls back to generic presets.
     */
    const project = JSON.stringify(stageNamed('$project'));
    expect(project).toContain('$objectToArray');
    expect(project).toContain('$ifNull');
    expect(project).toContain('$type');
  });

  it('keeps only non-empty strings', () => {
    // A variant with a size but no colour carries `color: null`, and an empty
    // string is a value the form should never have accepted. Neither is an
    // option anybody chose, and both would render as a blank button.
    const matches = pipeline.filter((s) => s.$match);
    const valueGuard = matches.find((s) => s.$match['pairs.v']);
    expect(valueGuard.$match['pairs.v']).toEqual({ $type: 'string', $ne: '' });
  });

  it('sorts by usage before grouping into arrays', () => {
    // Order matters literally: a `$sort` after the second `$group` would sort
    // the TYPES, not the values inside them, and the ranking would be lost.
    const sortIndex = pipeline.findIndex((s) => s.$sort);
    const groupIndexes = pipeline
      .map((s, i) => (s.$group ? i : -1))
      .filter((i) => i >= 0);

    expect(sortIndex).toBeGreaterThan(groupIndexes[0]);
    expect(sortIndex).toBeLessThan(groupIndexes[1]);
    expect(pipeline[sortIndex].$sort.uses).toBe(-1);
  });

  it('drops products with no variants before unwinding them', () => {
    const unwindIndex = pipeline.findIndex((s) => s.$unwind === '$variants');
    const guardIndex = pipeline.findIndex((s) => s.$match?.['variants.0']);
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(unwindIndex);
  });
});

describe('branch scope', () => {
  it('narrows to the selected branch', async () => {
    // A branch that has never sold ৫০০ml should not be offered it as though it
    // were part of their own range — the same rule every other product read on
    // this platform follows.
    stubAggregate([]);
    await variantCatalogService.readUsedValues(SHOP, {
      shop: { _id: SHOP },
      branchId: BRANCH,
    });

    expect(String(pipeline[0].$match.branch)).toBe(String(BRANCH));
  });

  it('stays shop-wide with no branch selected', async () => {
    stubAggregate([]);
    await variantCatalogService.readUsedValues(SHOP, { shop: { _id: SHOP } });
    expect(pipeline[0].$match.branch).toBeUndefined();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * Caching
 * ══════════════════════════════════════════════════════════════════════════ */

describe('caching', () => {
  it('serves a cached vocabulary without touching the database', async () => {
    // This is fetched while the shopkeeper is looking at an empty product form.
    // It must not wait on an aggregation over every product they own.
    cacheService.get.mockResolvedValue({ size: ['36'] });
    const spy = jest.spyOn(Product, 'aggregate');

    expect(await variantCatalogService.getUsedValues(SHOP)).toEqual({ size: ['36'] });
    expect(spy).not.toHaveBeenCalled();
  });

  it('caches per branch, so two branches cannot serve each other\'s range', async () => {
    stubAggregate([]);
    await variantCatalogService.getUsedValues(SHOP, { shop: { _id: SHOP }, branchId: BRANCH });
    await variantCatalogService.getUsedValues(SHOP, { shop: { _id: SHOP } });

    const keys = cacheService.set.mock.calls.map(([key]) => key);
    expect(new Set(keys).size).toBe(2);
    expect(keys.some((k) => k.endsWith(':all'))).toBe(true);
    expect(keys.some((k) => k.endsWith(`:${BRANCH}`))).toBe(true);
  });

  it('falls back to the built-in presets when the aggregation fails', async () => {
    /**
     * `{}` is a real and complete answer — a shop with no variant products —
     * and the client renders the built-in presets on it. So a broken
     * aggregation costs a shop its personalised chip list and nothing else.
     *
     * The alternative is a product form that will not open because an option
     * list could not be computed, and no option list is worth that.
     */
    jest.spyOn(Product, 'aggregate').mockImplementation(() => ({
      option: () => Promise.reject(new Error('PlanExecutor error')),
    }));

    await expect(variantCatalogService.getUsedValues(SHOP)).resolves.toEqual({});
    // And nothing is cached, so the next load retries rather than serving the
    // failure back for fifteen minutes.
    expect(cacheService.set).not.toHaveBeenCalled();
  });

  it('drops every branch\'s copy on invalidate', async () => {
    // A product write can change the vocabulary of whichever branch it belongs
    // to, and the shop-wide list as well. Clearing one key would leave the
    // other stale — which reads as "I typed the size and it did not stick".
    await variantCatalogService.invalidate(SHOP);
    expect(cacheService.deletePattern).toHaveBeenCalledWith(`variantOptions:${SHOP}:*`);
  });
});
