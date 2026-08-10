/**
 * Wholesale pricing — `Shop.features.wholesale` + `Customer.isWholesale`.
 *
 * Groups, and it matters which is which (AGENT_WORKFLOW.md §7.1). Measured, not
 * assumed: with `priceTierFor` and `sellingPriceFor` reverted to their
 * pre-feature bodies, exactly 2 of these 22 fail.
 *
 *   A. FLAG-OFF IDENTITY — INVARIANT GUARDS. Pass both before and after, by
 *      construction. They fail only if someone later widens the feature to
 *      shops that never enabled it. The I-6 tripwire.
 *
 *   B. TIER RESOLUTION — REGRESSIONS. The 2 that fail on the old code, which
 *      had no concept of a price tier at all. These are the tests that prove
 *      the feature does anything.
 *
 *   C. FALLBACK — GUARDS, not regressions, and worth being honest about: the
 *      old code charged retail unconditionally, so "a wholesale customer is
 *      charged retail when the product has no wholesale price" passes against
 *      it trivially. Their job is forward-looking — to stop someone later
 *      making the missing-price case throw, or charge ৳0, or refuse the sale.
 *
 *   D. WRITE GATES — REGRESSIONS in the weak sense: the functions they exercise
 *      did not exist before, so there is nothing for them to fail against. They
 *      are the 403s that stop a cashier granting themselves wholesale rates
 *      through a route that carries no Joi schema.
 *
 * Deliberately NOT here: that `createSale` resolves its customer BEFORE the
 * item loop. That ordering is what makes any of this reachable at all, and a
 * mocked unit test would pass with the old ordering too (§7.2) — the models are
 * mocked, so a customer looked up too late still "returns" one. It is verified
 * by reading the call site and by the manual pass in §7.3.
 */

const mongoose = require('mongoose');
const {
  PRICE_TIERS,
  DEFAULT_TIER,
  priceTierFor,
  hasWholesalePrice,
  sellingPriceFor,
  normalizeWholesalePrice,
  resolveWholesaleFlag,
} = require('../utils/pricing.util');
const { FEATURE_KEYS, FEATURES, featureMap } = require('../utils/features.util');

const SHOP = new mongoose.Types.ObjectId();

/** A shop that has never had a capability switched on (Redis-cached, pre-field). */
const plainReq = () => ({ shop: { _id: SHOP } });
/** A shop with wholesale explicitly off. */
const offReq = () => ({ shop: { _id: SHOP, features: { wholesale: false } } });
/** A shop with wholesale on. */
const onReq = () => ({ shop: { _id: SHOP, features: { wholesale: true } } });
/** Owner of a shop with wholesale on — the only role that may set the flag. */
const ownerReq = () => ({ ...onReq(), user: { isOwner: true } });
/** Cashier of the same shop. */
const staffReq = () => ({ ...onReq(), user: { isOwner: false } });
/** Owner of a shop whose capability is off. */
const ownerFlagOffReq = () => ({ ...offReq(), user: { isOwner: true } });

const wholesaleCustomer = { name: 'পাইকার', isWholesale: true };
const retailCustomer = { name: 'খুচরা', isWholesale: false };

/** Retail ৳১০০, wholesale ৳৮০. */
const twoPriced = { name: 'চাল', sellingPrice: 100, wholesalePrice: 80 };
/** Retail only — the common case even in a wholesale-enabled shop. */
const retailOnly = { name: 'কলম', sellingPrice: 15 };

/* ════════════════════════════════════════════════════════════════════════
 * A. FLAG-OFF IDENTITY — INVARIANT GUARDS (I-6)
 * ════════════════════════════════════════════════════════════════════════ */
describe('A. flag off — nothing changes (invariant guards)', () => {
  test('a missing features object reads as OFF, not as truthy', () => {
    // `req.shop` is rehydrated from Redis. A shop cached before this key
    // existed has no `features` at all, and reading that as enabled would hand
    // wholesale pricing to every shop on the platform at once.
    expect(priceTierFor(plainReq(), wholesaleCustomer)).toBe('retail');
    expect(priceTierFor(offReq(), wholesaleCustomer)).toBe('retail');
    expect(priceTierFor(undefined, wholesaleCustomer)).toBe('retail');
    expect(priceTierFor({}, wholesaleCustomer)).toBe('retail');
  });

  test('a wholesale customer at a flag-off shop is billed the retail price', () => {
    // The whole of I-6 in one assertion: the data says wholesale, the shop has
    // not bought the capability, so the number is the one it has always been.
    const tier = priceTierFor(offReq(), wholesaleCustomer);
    expect(sellingPriceFor(twoPriced, tier)).toBe(100);
  });

  test('a non-boolean isWholesale never reads as on', () => {
    expect(priceTierFor(onReq(), { isWholesale: 'true' })).toBe('retail');
    expect(priceTierFor(onReq(), { isWholesale: 1 })).toBe('retail');
    expect(priceTierFor(onReq(), { isWholesale: {} })).toBe('retail');
  });

  test('no customer — a walk-in — is always retail', () => {
    expect(priceTierFor(onReq(), null)).toBe('retail');
    expect(priceTierFor(onReq(), undefined)).toBe('retail');
    expect(priceTierFor(ownerReq(), {})).toBe('retail');
  });

  test('a cleared or absent wholesale price is legal with the flag off', () => {
    // Every product form in every flag-off shop posts this shape. Refusing it
    // would 403 ordinary product edits platform-wide.
    expect(normalizeWholesalePrice(undefined, false)).toBeUndefined();
    expect(normalizeWholesalePrice(null, false)).toBeUndefined();
    expect(normalizeWholesalePrice('', false)).toBeUndefined();
    expect(normalizeWholesalePrice(0, false)).toBeUndefined();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * B. TIER RESOLUTION — THE REGRESSIONS (both failures land here)
 * ════════════════════════════════════════════════════════════════════════ */
describe('B. tier resolution (regressions)', () => {
  test('flag on + wholesale customer = the wholesale price', () => {
    const tier = priceTierFor(onReq(), wholesaleCustomer);
    expect(tier).toBe('wholesale');
    expect(sellingPriceFor(twoPriced, tier)).toBe(80);
  });

  test('flag on + ordinary customer = the retail price', () => {
    const tier = priceTierFor(onReq(), retailCustomer);
    expect(tier).toBe('retail');
    expect(sellingPriceFor(twoPriced, tier)).toBe(100);
  });

  test('a variant is priced by its OWN two prices', () => {
    // `sellingPriceFor` takes a product or a variant precisely so these cannot
    // drift. A variant without a wholesale rate falls back to its own retail
    // price, never to the parent product's.
    const variant = { sku: 'C-500', sellingPrice: 50, wholesalePrice: 42 };
    const bare = { sku: 'C-750', sellingPrice: 60 };
    expect(sellingPriceFor(variant, 'wholesale')).toBe(42);
    expect(sellingPriceFor(bare, 'wholesale')).toBe(60);
  });

  test('the tier list and default are the two the Sale schema stores', () => {
    expect(PRICE_TIERS).toEqual(['retail', 'wholesale']);
    expect(DEFAULT_TIER).toBe('retail');
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C. FALLBACK — GUARDS (see the header: these pass against the old code too)
 * ════════════════════════════════════════════════════════════════════════ */
describe('C. missing wholesale price falls back to retail', () => {
  test('no wholesale price at all — the sale still goes through, at retail', () => {
    // The behaviour that makes the feature adoptable on day one, with a
    // thousand already-priced products and no second price on any of them.
    const tier = priceTierFor(onReq(), wholesaleCustomer);
    expect(sellingPriceFor(retailOnly, tier)).toBe(15);
  });

  test('zero is absent, not free', () => {
    // A cleared money box posts 0. Billing ৳0 for a carton of rice because
    // someone emptied a field is not a discount.
    expect(hasWholesalePrice({ sellingPrice: 100, wholesalePrice: 0 })).toBe(false);
    expect(sellingPriceFor({ sellingPrice: 100, wholesalePrice: 0 }, 'wholesale')).toBe(100);
    expect(sellingPriceFor({ sellingPrice: 100, wholesalePrice: null }, 'wholesale')).toBe(100);
    expect(sellingPriceFor({ sellingPrice: 100, wholesalePrice: '' }, 'wholesale')).toBe(100);
  });

  test('a garbage wholesale price does not poison the line', () => {
    expect(sellingPriceFor({ sellingPrice: 100, wholesalePrice: NaN }, 'wholesale')).toBe(100);
    expect(sellingPriceFor({ sellingPrice: 100, wholesalePrice: 'abc' }, 'wholesale')).toBe(100);
    expect(sellingPriceFor({ sellingPrice: 100, wholesalePrice: Infinity }, 'wholesale')).toBe(100);
  });

  test('a missing retail price reads as 0, not NaN', () => {
    // `createSale` refuses a priceless product by name; this just guarantees
    // the arithmetic downstream never sees NaN and silently produces a NaN
    // invoice total.
    expect(sellingPriceFor({}, 'retail')).toBe(0);
    expect(sellingPriceFor(null, 'wholesale')).toBe(0);
  });

  test('hasWholesalePrice distinguishes fallback from a genuine price match', () => {
    // A product whose two prices are equal DID get a wholesale rate. Deriving
    // "did this fall back" by comparing the numbers would report it as a
    // fallback and mislabel the line in the POS.
    expect(hasWholesalePrice({ sellingPrice: 50, wholesalePrice: 50 })).toBe(true);
    expect(hasWholesalePrice({ sellingPrice: 50 })).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * D. ENTITLEMENT / WRITE GATES — REGRESSIONS
 * ════════════════════════════════════════════════════════════════════════ */
describe('D. write gates', () => {
  test('posting a wholesale price without the capability is refused, not ignored', () => {
    // Silently dropping it would ship a product whose form said ৳৮/পিস and
    // whose data held nothing — the mismatch that surfaces months later at a
    // till. Mirrors `normalizePackaging`.
    expect(() => normalizeWholesalePrice(8, false)).toThrow();
    try {
      normalizeWholesalePrice(8, false);
    } catch (err) {
      expect(err.statusCode).toBe(403);
    }
  });

  test('a positive wholesale price is stored when the capability is on', () => {
    expect(normalizeWholesalePrice(8, true)).toBe(8);
    expect(normalizeWholesalePrice('8.5', true)).toBe(8.5);
  });

  test('a negative or malformed price is a 400, with or without the flag', () => {
    for (const bad of [-1, 'abc', NaN, Infinity]) {
      expect(() => normalizeWholesalePrice(bad, true)).toThrow();
      try {
        normalizeWholesalePrice(bad, true);
      } catch (err) {
        expect(err.statusCode).toBe(400);
      }
    }
  });

  test('the customer flag gate is owner-only and flag-gated', () => {
    expect(resolveWholesaleFlag(true, ownerReq())).toBe(true);
    expect(resolveWholesaleFlag(false, ownerReq())).toBe(false);

    // A cashier may not promote a customer, even at a shop that has the
    // capability — this is the gate that survives the missing Joi schema on
    // the customer routes.
    expect(() => resolveWholesaleFlag(true, staffReq())).toThrow();
    // Nor may an owner, at a shop without the capability.
    expect(() => resolveWholesaleFlag(true, ownerFlagOffReq())).toThrow();

    for (const req of [staffReq(), ownerFlagOffReq()]) {
      try {
        resolveWholesaleFlag(true, req);
      } catch (err) {
        expect(err.statusCode).toBe(403);
      }
    }
  });

  test('saying nothing about the field leaves the stored value alone', () => {
    // The case that keeps the toggle reversible: an ordinary name edit at a
    // shop whose capability was just switched off must not demote anybody.
    expect(resolveWholesaleFlag(undefined, staffReq())).toBeUndefined();
    expect(resolveWholesaleFlag(null, staffReq())).toBeUndefined();
    expect(resolveWholesaleFlag('', staffReq())).toBeUndefined();
    expect(resolveWholesaleFlag(undefined, offReq())).toBeUndefined();
  });

  test('the platform admin may set the flag without being a shop owner', () => {
    // Admin writes into a shop carry no `req.user.isOwner` — M-7. Without the
    // exemption every admin-side customer edit in a wholesale shop would 403.
    expect(resolveWholesaleFlag(true, { ...onReq(), isAdmin: true })).toBe(true);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * E. REGISTRY WIRING
 * ════════════════════════════════════════════════════════════════════════ */
describe('E. capability registry', () => {
  test('wholesale is a registered capability with a Bengali label', () => {
    // `assertKnownFeature` throws on an unregistered key, so a typo anywhere
    // would otherwise read as permanently off with no error. The admin panel
    // renders from this registry, which is why no admin-side code changed.
    expect(FEATURE_KEYS).toContain('wholesale');
    expect(FEATURES.wholesale.bn).toBeTruthy();
    expect(FEATURES.wholesale.en).toBeTruthy();
  });

  test('featureMap lists wholesale as a real boolean for every shop', () => {
    // Sparse maps make "off" and "still loading" indistinguishable on the
    // client, which is a flicker on every page load.
    expect(featureMap({}).wholesale).toBe(false);
    expect(featureMap({ features: { wholesale: true } }).wholesale).toBe(true);
    expect(featureMap(null).wholesale).toBe(false);
  });
});
