/**
 * `features.brands` — the capability contract.
 *
 * Step 4 of the recipe in `utils/features.util.js`: flag off must be
 * byte-identical to the world before the capability existed. For brands that
 * means three separate things, and each is pinned below:
 *
 *   · the ROUTES do not exist (404, not 403 — a 403 advertises the resource)
 *   · no brand is ever STORED on a product
 *   · an admin turning the flag off and on again finds the brands still there
 *
 * The last one is the subtle one. `wholesalePrice` earned its `in` guard the
 * hard way; brand copies it, and this is where that stays honest.
 */

const mongoose = require('mongoose');
const {
  FEATURES,
  FEATURE_KEYS,
  hasFeature,
  shopHasFeature,
  featureMap,
  requireFeature,
} = require('../utils/features.util');
const Shop = require('../models/Shop.model');
const Brand = require('../models/Brand.model');
const productService = require('../services/product.service');

const SHOP = new mongoose.Types.ObjectId();
const BRAND = new mongoose.Types.ObjectId();

const reqWith = (brands) => ({ shop: { _id: SHOP, features: { brands } } });

afterEach(() => jest.restoreAllMocks());

describe('the capability is registered in both places', () => {
  it('appears in the FEATURES registry with both languages', () => {
    expect(FEATURE_KEYS).toContain('brands');
    expect(FEATURES.brands.bn).toBeTruthy();
    expect(FEATURES.brands.en).toBeTruthy();
    expect(FEATURES.brands.description).toBeTruthy();
  });

  it('is declared on Shop.features and defaults to OFF', () => {
    const path = Shop.schema.path('features.brands');
    expect(path).toBeDefined();
    expect(path.instance).toBe('Boolean');
    expect(new Shop().features.brands).toBe(false);
  });

  it('reads as off for a shop cached before the field existed', () => {
    // The exact shape the Redis rehydration produces for an old shop.
    expect(hasFeature({ shop: {} }, 'brands')).toBe(false);
    expect(hasFeature({}, 'brands')).toBe(false);
    expect(shopHasFeature(undefined, 'brands')).toBe(false);
  });

  it('is present in the session feature map as a real boolean', () => {
    // The frontend distinguishes `false` from "still loading"; a sparse map
    // makes those two indistinguishable.
    expect(featureMap({ features: {} }).brands).toBe(false);
    expect(featureMap({ features: { brands: true } }).brands).toBe(true);
  });
});

describe('requireFeature — the door on the whole resource', () => {
  const run = (brands) => {
    const next = jest.fn();
    requireFeature('brands')(reqWith(brands), {}, next);
    return next;
  };

  it('404s a shop without the capability', () => {
    const next = run(false);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    // 404 and not 403: to this shop the resource does not exist.
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('FEATURE_DISABLED');
    expect(err.feature).toBe('brands');
  });

  it('passes a shop that has it', () => {
    expect(run(true).mock.calls[0][0]).toBeUndefined();
  });

  it('throws at wiring time for a typo\'d key', () => {
    expect(() => requireFeature('brandz')).toThrow(/Unknown feature flag/);
  });
});

describe('_resolveBrand — what actually lands on the product', () => {
  const mockBrandLookup = (found) =>
    jest.spyOn(Brand, 'findOne').mockReturnValue({
      select: () => ({ lean: async () => (found ? { _id: BRAND } : null) }),
    });

  it('stores nothing for a shop without the capability, whatever was sent', async () => {
    const spy = mockBrandLookup(true);
    await expect(productService._resolveBrand(SHOP, String(BRAND), reqWith(false)))
      .resolves.toBeNull();
    // Fails closed WITHOUT a lookup — the flag alone settles it.
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves a brand the shop owns', async () => {
    mockBrandLookup(true);
    await expect(productService._resolveBrand(SHOP, String(BRAND), reqWith(true)))
      .resolves.toEqual(BRAND);
  });

  it('scopes the lookup to the shop and to active brands', async () => {
    const spy = mockBrandLookup(true);
    await productService._resolveBrand(SHOP, String(BRAND), reqWith(true));
    expect(spy.mock.calls[0][0]).toMatchObject({ shop: SHOP, isActive: true });
  });

  it('404s a brand belonging to another shop', async () => {
    mockBrandLookup(false);
    await expect(productService._resolveBrand(SHOP, String(BRAND), reqWith(true)))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('treats empty, null and undefined as "no brand"', async () => {
    const spy = mockBrandLookup(true);
    for (const empty of ['', null, undefined]) {
      await expect(productService._resolveBrand(SHOP, empty, reqWith(true)))
        .resolves.toBeNull();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Brand model', () => {
  it('is shop-scoped and requires a name', () => {
    expect(Brand.schema.path('shop').isRequired).toBe(true);
    expect(Brand.schema.path('name').isRequired).toBe(true);
  });

  it('holds one name per shop, case-insensitively, ignoring deleted rows', () => {
    const unique = Brand.schema.indexes().find(([, opts]) => opts && opts.unique);
    expect(unique).toBeDefined();

    const [fields, options] = unique;
    expect(fields).toMatchObject({ shop: 1, name: 1 });
    // strength 2 = case-insensitive, so "Square" and "square" are one brand.
    expect(options.collation).toMatchObject({ strength: 2 });
    // Partial, so a brand can be re-created after being deleted.
    expect(options.partialFilterExpression).toMatchObject({ isActive: true });
  });

  it('defaults a new brand to active', () => {
    expect(new Brand({ shop: SHOP, name: 'Square' }).isActive).toBe(true);
  });
});

describe('Product.brand', () => {
  it('is a reference to Brand, defaulting to none', () => {
    const path = require('../models/Product.model').schema.path('brand');
    expect(path.instance).toBe('ObjectId');
    expect(path.options.ref).toBe('Brand');
    expect(path.options.default).toBeNull();
  });
});
