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
  storefront: {
    bn: 'অনলাইন দোকান',
    en: 'Online storefront',
    description:
      'A public website for this shop, built from one of the templates the ' +
      'platform has granted it, plus the separate /online panel to manage it. ' +
      'Products already marked "available online" appear on it automatically. ' +
      'Off = no /online panel and no public page; the Storefront document and ' +
      'everything in it is kept, not deleted, so the switch is reversible.',
    // NOT `requiresStorage: true`, even though a storefront plainly needs
    // photos. It requires `productImages`, and THAT is what is storage-backed.
    // Declaring storage here as well would state one fact in two places, and
    // the two would eventually disagree — the same reason `ShopMedia` answers
    // "is anything using this" from `refCount` alone rather than keeping a
    // second `orphaned` state beside it.
    //
    // The chain still reaches storage from both directions: enabling is
    // refused until `productImages` is on (which is itself refused without
    // storage), and `storageCascadeKeys()` picks this up transitively as a
    // dependent of `productImages`.
    requires: ['onlineSelling', 'productImages'],
  },
  onlineOrders: {
    bn: 'অনলাইন অর্ডার',
    en: 'Online orders',
    description:
      'Buy-now checkout on the public storefront, paid cash on delivery. Off = ' +
      'the storefront is a catalogue with call and WhatsApp buttons instead of ' +
      'a buy button, which is the finished product for a shop that does not ' +
      'run a parcel operation. Existing orders are kept.',
    requires: ['storefront'],
    /**
     * The `unavailable` gate is LIFTED — checkout exists. It read "Checkout is
     * not built yet" and refused to switch on at all.
     *
     * What a shop gets today: customers can place COD orders, and every order
     * sits at `pending` having touched nothing — no stock movement, no Sale, no
     * customer due (invariant I-9, see Order.model.js). Orders arriving is
     * therefore safe on its own.
     *
     * What is NOT here yet is the shop-side worklist that confirms them, so
     * until it lands a shop with this on should expect to read its orders and
     * ring the customer rather than press a button. That is a smaller gap than
     * it sounds — it is how these shops already work — but it is the reason to
     * switch this on deliberately, per shop, rather than for everyone.
     */
  },
  combos: {
    bn: 'কম্বো অফার',
    en: 'Combo offers',
    description:
      'Sellable bundles of other products (buy-1-get-1, gift packs). Selling ' +
      'a combo deducts each component\'s own stock; availability is derived ' +
      'from the components, never stored. Off = no combo option on the product ' +
      'form and combo products stop being sellable; existing combos and their ' +
      'sale history are kept, so the switch is reversible.',
  },
  lineDiscount: {
    bn: 'পণ্যভিত্তিক ছাড়',
    en: 'Per-item discount',
    description:
      'Lets a cashier agree a different rate on a single line at the till — ' +
      '"৳১০০ each, but ৳৯০ for you" — and prints both on the invoice. Bounded ' +
      'by the shop\'s own cap (settings.maxLineDiscountPercent) and by the ' +
      'separate `sales.discount` permission, so the owner still chooses which ' +
      'staff may use it; selling below cost is owner-only. Off = no rate ' +
      'control in the POS and a posted line rate is refused. Existing sales ' +
      'keep theirs, so the switch is reversible.',
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
 * ─────────────────────────────────────────────────────────────────────────────
 * PREREQUISITES — `requires`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `requiresStorage` was the first prerequisite this registry ever expressed:
 * a feature that writes bytes needs somewhere to put them, and enabling one
 * without storage hands the shop an upload button wired to a 403. `requires`
 * is the same idea generalised to one feature depending on another.
 *
 * `storefront` needs `onlineSelling` because a website with no way to mark a
 * product as online is a website with no products, and it needs `productImages`
 * because a catalogue of grey placeholders is the fastest way to make a shop
 * abandon the feature. Neither is a preference; both are combinations that read
 * as a bug to the shop and arrive as a support ticket to us.
 *
 * THE RULE IS ENFORCED FROM BOTH DIRECTIONS, and it has to be:
 *
 *   enabling  X → every key in `X.requires` must already be on  (missingDepsFor)
 *   disabling Y → every feature that requires Y goes off too    (dependentsOf)
 *
 * One direction alone leaves the broken combination reachable from the other.
 * That is exactly the shape the storage cascade already has — `setShopFeature`
 * refuses, `setShopStorage` cascades — and this generalises it rather than
 * adding a second, differently-behaved mechanism beside it.
 *
 * The cascade is TRANSITIVE. Turning off `onlineSelling` must also turn off
 * `onlineOrders`, which does not name `onlineSelling` at all — it depends on it
 * through `storefront`. A one-level cascade would leave `onlineOrders` on with
 * its own prerequisite off, which is precisely the state this exists to make
 * unreachable.
 */

/**
 * Validate the registry at load time.
 *
 * A `requires` naming a key that does not exist, or a cycle, would otherwise
 * surface as a feature that can never be enabled — with no error anywhere,
 * which is the failure mode `assertKnownFeature` exists to prevent for typo'd
 * flags. Cheap to check once at require-time; impossible to debug at 2am.
 */
(function assertRegistryIsSane() {
  for (const key of FEATURE_KEYS) {
    const deps = FEATURES[key].requires || [];
    if (!Array.isArray(deps)) {
      throw new Error(`Feature "${key}": \`requires\` must be an array.`);
    }
    for (const dep of deps) {
      if (!FEATURES[dep]) {
        throw new Error(
          `Feature "${key}" requires unknown feature "${dep}". ` +
          `Valid: ${FEATURE_KEYS.join(', ')}`
        );
      }
    }
  }
  // Cycle check: walk each key's transitive prerequisites and refuse to find
  // itself among them.
  for (const start of FEATURE_KEYS) {
    const seen = new Set();
    const stack = [...(FEATURES[start].requires || [])];
    while (stack.length) {
      const key = stack.pop();
      if (key === start) {
        throw new Error(`Feature "${start}" has a circular \`requires\` chain.`);
      }
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push(...(FEATURES[key].requires || []));
    }
  }
})();

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * `unavailable` — a key that is registered but cannot yet be turned on
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A flag has to exist in the registry before the feature does: the permission,
 * the nav entry, the route and the frontend's `hasFeature` call are all written
 * against the key, and `assertKnownFeature` throws for anything not listed here.
 * `onlineOrders` is in exactly that state — the panel page and the permission
 * are live, checkout is not.
 *
 * What must NOT happen is the flag being enableable while the feature is
 * missing. `onlineOrders` had no backend reference at all, so switching it on
 * changed one thing and one thing only: the orders screen stopped saying
 * "ordering is not open yet" and started saying "no orders yet" — a screen
 * whose own header comment says it exists specifically to avoid telling that
 * lie. An operator flips the toggle, the shop is told ordering works, customers
 * are told to order on a site with no cart.
 *
 * So the key stays registered and readable (`hasFeature` still answers false,
 * `featureMap` still lists it, the cascade still reaches it) and `setShopFeature`
 * refuses to set it true. Delete this line when checkout ships; nothing else has
 * to change.
 */
function unavailableReason(key) {
  assertKnownFeature(key);
  return FEATURES[key].unavailable || null;
}

/**
 * Which prerequisites of `key` are NOT satisfied for this shop?
 *
 * Returns `{ features: [key], storage: boolean }` — an empty `features` array
 * and `storage: false` means the capability is safe to enable. Direct
 * prerequisites only: enabling walks up one level at a time, because a shop
 * whose grandparent flag is off necessarily has its parent off too (that is
 * what the cascade guarantees), so naming the immediate blocker gives the
 * clearer error.
 *
 * @param {Object} shop  a Shop document or plain object
 * @param {string} key   a FEATURES key
 */
function missingDepsFor(shop, key) {
  assertKnownFeature(key);
  const meta = FEATURES[key];
  return {
    features: (meta.requires || []).filter((dep) => shop?.features?.[dep] !== true),
    storage: meta.requiresStorage === true && shop?.storage?.enabled !== true,
  };
}

/**
 * Every feature that must go off when `key` goes off, transitively.
 *
 * Does not include `key` itself. Order is not significant — the caller sets
 * them all in one write.
 *
 * @param {string} key a FEATURES key
 * @returns {string[]}
 */
function dependentsOf(key) {
  assertKnownFeature(key);
  const out = new Set();
  const stack = [key];
  while (stack.length) {
    const current = stack.pop();
    for (const candidate of FEATURE_KEYS) {
      if (out.has(candidate)) continue;
      if ((FEATURES[candidate].requires || []).includes(current)) {
        out.add(candidate);
        stack.push(candidate);
      }
    }
  }
  return [...out];
}

/**
 * Every feature that must go off when image storage goes off.
 *
 * The storage-backed ones themselves, plus everything that transitively
 * depends on any of them. `adminStorage.service` used to cascade only
 * STORAGE_BACKED_FEATURES; with `storefront` requiring `productImages`, that
 * would have left a shop with a live website and no photos on it.
 *
 * @returns {string[]}
 */
function storageCascadeKeys() {
  const out = new Set(STORAGE_BACKED_FEATURES);
  for (const key of STORAGE_BACKED_FEATURES) {
    for (const dependent of dependentsOf(key)) out.add(dependent);
  }
  return [...out];
}

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
  missingDepsFor,
  unavailableReason,
  dependentsOf,
  storageCascadeKeys,
  hasFeature,
  shopHasFeature,
  featureMap,
  assertKnownFeature,
  requireFeature,
  requireAnyFeature,
};
