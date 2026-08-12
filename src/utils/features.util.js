/**
 * Feature Flags — the single sanctioned way to ask whether a shop has an
 * opt-in capability turned on.
 *
 * Services must not read `req.shop.features.x` by hand. Two reasons, both of
 * which have already cost this codebase a bug in the `multiBranchEnabled` era:
 *
 *   1. `req.shop` is rehydrated from Redis in the auth middleware. A shop cached
 *      before the field existed has `features === undefined`, and
 *      `undefined.packaging` throws a TypeError on a hot path. `hasFeature`
 *      returns false instead.
 *
 *   2. A flag must fail CLOSED. `Boolean(shop.features?.packaging)` is easy to
 *      write as `shop.features?.packaging !== false`, which reads `undefined`
 *      as ON and hands the extended feature to every shop on the platform.
 *      There is exactly one implementation here so that cannot happen twice.
 *
 * Adding a capability:
 *   1. add the key to `Shop.model.js` `features` with `default: false`
 *   2. add it to FEATURES below with a one-line description
 *   3. gate the UI on it via the frontend `usePermissions().hasFeature`
 *   4. write the invariant test: flag off => behaviour byte-identical to before
 *
 * There is deliberately no "enable everything for plan X" shortcut. Capability
 * and subscription plan are different axes; coupling them means a billing
 * change silently alters what a shop's screens look like.
 */

const { AppError } = require('../middleware/error.middleware');

/**
 * The capability registry. Keys here MUST match `Shop.features` keys exactly —
 * `assertKnownFeature` is what stops a typo'd flag from reading as permanently
 * off with no error anywhere.
 */
const FEATURES = Object.freeze({
  packaging: {
    bn: 'একক ও খুচরা বিক্রি',
    en: 'Units & loose selling',
    description:
      'Fractional quantities for weight/volume/length units, the extended unit ' +
      'list, and the "x how many" helper on purchase entry. Off = the shop sees ' +
      'the original 13 units, integers only.',
  },
  wholesale: {
    bn: 'পাইকারি বিক্রি',
    en: 'Wholesale pricing',
    description:
      'A second price per product, charged automatically to customers marked ' +
      'as wholesale buyers. Products with no wholesale price fall back to the ' +
      'retail one. Off = one price per product, as before.',
  },
  brands: {
    bn: 'ব্র্যান্ড ব্যবস্থাপনা',
    en: 'Brand management',
    description:
      'A brand list the shop maintains itself, and a brand picker on the ' +
      'product form. Managing brands rides on the categories permission. ' +
      'Off = no brand field anywhere and no brand is stored, as before.',
  },
  productImages: {
    bn: 'পণ্যের ছবি',
    en: 'Product photos',
    description:
      'Photos on products and on individual variants, stored in the platform ' +
      'R2 pool and counted against the shop\'s storage quota. Uploading is ' +
      'never required to save a product. Off = no image control on the product ' +
      'form; existing photos are kept, not deleted.',
    requiresStorage: true,
  },
  categoryImages: {
    bn: 'ক্যাটাগরির ছবি',
    en: 'Category photos',
    description:
      'One photo per category. Independent of productImages — a shop may have ' +
      'either, both or neither. Off = no image control on the category form; ' +
      'existing photos are kept.',
    requiresStorage: true,
  },
  onlineSelling: {
    bn: 'অনলাইনে বিক্রি',
    en: 'Online selling',
    description:
      'Lets the shop choose, per product, whether it appears online — plus the ' +
      'online price override, the online description and the featured flag. ' +
      'Off = no online section on the product form and every product is stored ' +
      'as offline. Existing settings are kept, not cleared, so the switch is ' +
      'reversible.',
  },
});

/**
 * Capabilities that cannot be on while `Shop.storage.enabled` is false.
 *
 * A feature that writes bytes needs somewhere to put them. Without this list
 * the panel would happily hand a shop an upload button wired to a 403, which
 * looks like a bug to the shop and to support. `admin.service.setShopFeature`
 * enforces it on the way in, and disabling storage cascades these off.
 */
const STORAGE_BACKED_FEATURES = Object.freeze(
  Object.keys(FEATURES).filter((key) => FEATURES[key].requiresStorage === true)
);

/** Every valid feature key. */
const FEATURE_KEYS = Object.freeze(Object.keys(FEATURES));

/**
 * @param {string} key
 * @throws {Error} at call time, not request time — a typo is a code bug
 */
function assertKnownFeature(key) {
  if (!FEATURES[key]) {
    throw new Error(
      `Unknown feature flag "${key}". Valid: ${FEATURE_KEYS.join(', ')}. ` +
      'Add it to FEATURES in utils/features.util.js and to Shop.model.js features.'
    );
  }
}

/**
 * Is this capability on for the shop on this request?
 *
 * Fails closed on every uncertainty: no request, no shop, no features object,
 * non-boolean value. Never throws for a caller-supplied request shape.
 *
 * @param {Object} req    the Express request (needs `req.shop`)
 * @param {string} key    a FEATURES key
 * @returns {boolean}
 */
function hasFeature(req, key) {
  assertKnownFeature(key);
  return req?.shop?.features?.[key] === true;
}

/**
 * Same question, given a shop document instead of a request. For jobs, seeders
 * and scripts that have no `req`. Prefer `hasFeature` inside request handlers.
 *
 * @param {Object} shop
 * @param {string} key
 * @returns {boolean}
 */
function shopHasFeature(shop, key) {
  assertKnownFeature(key);
  return shop?.features?.[key] === true;
}

/**
 * The full flag map for a shop, with every known key present as a real boolean.
 *
 * This is what goes on the auth/session response. It must list EVERY key, not
 * just the enabled ones — the frontend renders `hasFeature('x') === false`
 * differently from "key absent, still loading", and a sparse object makes those
 * two indistinguishable.
 *
 * @param {Object} shop
 * @returns {Object<string, boolean>}
 */
function featureMap(shop) {
  const map = {};
  for (const key of FEATURE_KEYS) {
    map[key] = shop?.features?.[key] === true;
  }
  return map;
}

/**
 * Route guard: refuse the whole endpoint when the capability is off.
 *
 * For features that add ROUTES rather than fields. `packaging` and `wholesale`
 * only widen existing payloads, so they are checked inside the services that
 * read them; a capability with its own resource needs the door shut too, or the
 * API keeps serving a feature the shop cannot see and has not been given.
 *
 * 404, not 403: to a shop without the capability the resource does not exist,
 * and a 403 would advertise that it does. Mount it AFTER `protect`, which is
 * what puts `req.shop` there to read.
 *
 * @param {string} key a FEATURES key
 */
function requireFeature(key) {
  assertKnownFeature(key);
  return (req, res, next) => {
    if (!hasFeature(req, key)) {
      const error = new AppError(
        'Not found',
        'এই সুবিধাটি আপনার দোকানে চালু নেই',
        404
      );
      error.code = 'FEATURE_DISABLED';
      error.feature = key;
      return next(error);
    }
    return next();
  };
}

/**
 * Route guard: open the endpoint if ANY of these capabilities is on.
 *
 * For a resource shared by several features rather than owned by one. The
 * upload endpoint is the case it was written for: `productImages` and
 * `categoryImages` are independent axes, and a shop given only the second still
 * has to be able to put a photo on a category. Gating on `productImages` alone
 * would hand that shop a feature it cannot use.
 *
 * Same 404-not-403 reasoning as `requireFeature`.
 *
 * @param {string[]} keys FEATURES keys; at least one must be on
 */
function requireAnyFeature(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('requireAnyFeature needs at least one feature key');
  }
  keys.forEach(assertKnownFeature);

  return (req, res, next) => {
    if (keys.some((key) => hasFeature(req, key))) return next();

    const error = new AppError(
      'Not found',
      'এই সুবিধাটি আপনার দোকানে চালু নেই',
      404
    );
    error.code = 'FEATURE_DISABLED';
    error.feature = keys.join('|');
    return next(error);
  };
}

module.exports = {
  FEATURES,
  FEATURE_KEYS,
  STORAGE_BACKED_FEATURES,
  hasFeature,
  shopHasFeature,
  featureMap,
  assertKnownFeature,
  requireFeature,
  requireAnyFeature,
};
