/**
 * `features.onlineSelling` — the capability contract.
 *
 * Step 4 of the recipe in `utils/features.util.js`: flag off must be identical
 * to the world before the capability existed. Here that means three things, and
 * the middle one is the bug this feature was created to fix:
 *
 *   · a flag-off shop can never store an online product, even if the request
 *     body asks for one
 *   · NOTHING is online by default — the old default was `true`, so hiding the
 *     UI silently opted every new product into a surface nobody chose
 *   · an admin turning the flag off and on again finds the stored settings
 *     intact, the same `in`-guard promise `brand` and `wholesalePrice` make
 */

const mongoose = require('mongoose');
const {
  FEATURES,
  FEATURE_KEYS,
  hasFeature,
  shopHasFeature,
  featureMap,
} = require('../utils/features.util');
const Shop = require('../models/Shop.model');
const Product = require('../models/Product.model');
const productService = require('../services/product.service');
const productValidation = require('../validations/product.validation');

const SHOP = new mongoose.Types.ObjectId();
const reqWith = (onlineSelling) => ({ shop: { _id: SHOP, features: { onlineSelling } } });

afterEach(() => jest.restoreAllMocks());

describe('the capability is registered in both places', () => {
  it('appears in the FEATURES registry with both languages', () => {
    expect(FEATURE_KEYS).toContain('onlineSelling');
    expect(FEATURES.onlineSelling.bn).toBeTruthy();
    expect(FEATURES.onlineSelling.en).toBeTruthy();
    expect(FEATURES.onlineSelling.description).toBeTruthy();
  });

  it('is declared on Shop.features and defaults to OFF', () => {
    const path = Shop.schema.path('features.onlineSelling');
    expect(path).toBeDefined();
    expect(path.instance).toBe('Boolean');
    expect(new Shop().features.onlineSelling).toBe(false);
  });

  it('needs no storage — it writes no bytes', () => {
    expect(FEATURES.onlineSelling.requiresStorage).toBeUndefined();
  });

  it('reads as off for a shop cached before the field existed', () => {
    expect(hasFeature({ shop: {} }, 'onlineSelling')).toBe(false);
    expect(hasFeature({}, 'onlineSelling')).toBe(false);
    expect(shopHasFeature(undefined, 'onlineSelling')).toBe(false);
  });

  it('is present in the session feature map as a real boolean', () => {
    expect(featureMap({ features: {} }).onlineSelling).toBe(false);
    expect(featureMap({ features: { onlineSelling: true } }).onlineSelling).toBe(true);
  });
});

describe('nothing is online unless somebody said so', () => {
  it('defaults the model field to false', () => {
    expect(new Product().isAvailableOnline).toBe(false);
  });

  it('defaults the CREATE payload to false', () => {
    const { error, value } = productValidation.createProduct.validate({
      code: 'P1',
      name: 'চাল',
      category: String(new mongoose.Types.ObjectId()),
      unit: 'kg',
      buyingPrice: 10,
      sellingPrice: 12,
      stock: 5,
      hasVariants: false,
    }, { abortEarly: false, stripUnknown: true });

    expect(error).toBeUndefined();
    // THE regression this feature exists to prevent. When this read `true`, a
    // hidden UI meant every product in every shop was created as online.
    expect(value.isAvailableOnline).toBe(false);
  });

  it('invents no value on UPDATE — absent still means "leave it alone"', () => {
    const { value } = productValidation.updateProduct.validate(
      { name: 'নতুন নাম' },
      { abortEarly: false, stripUnknown: true }
    );
    expect(value).not.toHaveProperty('isAvailableOnline');
  });
});

describe('_applyOnlineFields — the gate', () => {
  it('FORCES a create to offline for a flag-off shop, whatever the body asked for', () => {
    const data = {
      isAvailableOnline: true,
      onlinePrice: 900,
      onlineDescription: 'buy me',
      isFeaturedOnline: true,
    };
    productService._applyOnlineFields(data, reqWith(false), { create: true });

    // Forced, not merely dropped: a create has nothing stored to preserve, and
    // the client is not the authority on whether this shop may sell online.
    expect(data.isAvailableOnline).toBe(false);
    expect(data).not.toHaveProperty('onlinePrice');
    expect(data).not.toHaveProperty('onlineDescription');
    expect(data).not.toHaveProperty('isFeaturedOnline');
  });

  it('DROPS the keys on an update, so a switched-off capability loses no data', () => {
    const data = {
      name: 'দাম ঠিক করা',
      isAvailableOnline: true,
      onlinePrice: 900,
      onlineDescription: 'buy me',
      isFeaturedOnline: true,
    };
    productService._applyOnlineFields(data, reqWith(false));

    // Absent, NOT false: `Object.assign` then leaves every stored value alone,
    // which is what makes the admin toggle reversible rather than one-way.
    expect(data).not.toHaveProperty('isAvailableOnline');
    expect(data).not.toHaveProperty('onlinePrice');
    expect(data).not.toHaveProperty('onlineDescription');
    expect(data).not.toHaveProperty('isFeaturedOnline');
    expect(data.name).toBe('দাম ঠিক করা');
  });

  it('honours the form exactly when the capability is on — including an unticked box', () => {
    const on = { isAvailableOnline: true, onlinePrice: 900, isFeaturedOnline: true };
    productService._applyOnlineFields(on, reqWith(true));
    expect(on).toEqual({ isAvailableOnline: true, onlinePrice: 900, isFeaturedOnline: true });

    // `false` from a shop that HAS the feature is a real decision to withdraw a
    // product from the online surface, not an absent value to be ignored.
    const off = { isAvailableOnline: false };
    productService._applyOnlineFields(off, reqWith(true));
    expect(off.isAvailableOnline).toBe(false);
  });

  it('gates all four fields together', () => {
    // Splitting them would let a flag-off shop store an online price — a number
    // that means nothing and that something would eventually render.
    const data = { onlinePrice: 900, onlineDescription: 'x', isFeaturedOnline: true };
    productService._applyOnlineFields(data, reqWith(false));
    expect(Object.keys(data)).toEqual([]);
  });
});

// The list filter's three states are pinned in `onlineSellingFilter.test.js` —
// asserting the built query needs the models stubbed at module level, which
// cannot share a file with the real-model checks above.
