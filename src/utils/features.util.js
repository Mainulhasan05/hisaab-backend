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
});

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

module.exports = {
  FEATURES,
  FEATURE_KEYS,
  hasFeature,
  shopHasFeature,
  featureMap,
  assertKnownFeature,
};
