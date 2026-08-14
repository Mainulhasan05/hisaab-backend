/**
 * The capability prerequisite chain — `requires`, and the cascade that keeps
 * it honest from both directions.
 *
 * These are INVARIANT GUARDS, not regressions: nothing here was ever broken in
 * production. They exist because the failure mode of a broken chain is silent —
 * a shop with a live website and no photos on it, or a capability that can
 * never be enabled because a prerequisite is misspelled — and the storage
 * cascade this generalises has already been the subject of one careful design
 * note in adminStorage.service.
 */

const Shop = require('../models/Shop.model');
const {
  FEATURES,
  FEATURE_KEYS,
  STORAGE_BACKED_FEATURES,
  missingDepsFor,
  dependentsOf,
  storageCascadeKeys,
} = require('../utils/features.util');

/** A shop with exactly the given features on, and storage as asked. */
const shopWith = (features = {}, storageEnabled = true) => ({
  features,
  storage: { enabled: storageEnabled },
});

describe('the registry is internally consistent', () => {
  it('every `requires` names a real feature', () => {
    for (const key of FEATURE_KEYS) {
      for (const dep of FEATURES[key].requires || []) {
        expect(FEATURE_KEYS).toContain(dep);
      }
    }
  });

  it('the new capabilities are on Shop.features and default OFF', () => {
    for (const key of ['storefront', 'onlineOrders']) {
      const path = Shop.schema.path(`features.${key}`);
      expect(path).toBeDefined();
      expect(path.instance).toBe('Boolean');
      expect(new Shop().features[key]).toBe(false);
    }
  });

  it('a brand-new shop has no template grants', () => {
    expect(new Shop().storefront.allowedTemplates).toEqual([]);
  });

  it('storefront does not re-declare storage its prerequisite already carries', () => {
    // `storefront` requires `productImages`, which IS storage-backed. Declaring
    // `requiresStorage` here too would state one fact in two places. The chain
    // still reaches storage — see the cascade test below.
    expect(STORAGE_BACKED_FEATURES).not.toContain('storefront');
    expect(FEATURES.storefront.requires).toContain('productImages');
  });
});

describe('missingDepsFor — what blocks enabling', () => {
  it('names the missing prerequisite rather than just failing', () => {
    const shop = shopWith({ onlineSelling: true, productImages: false });
    expect(missingDepsFor(shop, 'storefront').features).toEqual(['productImages']);
  });

  it('reports storage separately from features', () => {
    const shop = shopWith({}, false);
    const missing = missingDepsFor(shop, 'productImages');
    expect(missing.storage).toBe(true);
    expect(missing.features).toEqual([]);
  });

  it('is satisfied when the whole chain is on', () => {
    const shop = shopWith({ onlineSelling: true, productImages: true });
    expect(missingDepsFor(shop, 'storefront')).toEqual({ features: [], storage: false });
    const withStorefront = shopWith({
      onlineSelling: true, productImages: true, storefront: true,
    });
    expect(missingDepsFor(withStorefront, 'onlineOrders').features).toEqual([]);
  });

  it('a feature with no prerequisites is never blocked', () => {
    expect(missingDepsFor(shopWith({}, false), 'packaging')).toEqual({
      features: [], storage: false,
    });
  });

  it('fails closed on a shop object with no features at all', () => {
    // A shop rehydrated from a cache written before these fields existed.
    expect(missingDepsFor({}, 'storefront').features).toEqual(['onlineSelling', 'productImages']);
  });
});

describe('dependentsOf — what disabling takes with it', () => {
  it('is transitive', () => {
    // onlineOrders names `storefront`, not `onlineSelling`. It still has to go.
    expect(dependentsOf('onlineSelling').sort()).toEqual(['onlineOrders', 'storefront']);
  });

  it('covers the direct case', () => {
    expect(dependentsOf('storefront')).toEqual(['onlineOrders']);
  });

  it('is empty for a leaf capability', () => {
    expect(dependentsOf('onlineOrders')).toEqual([]);
    expect(dependentsOf('packaging')).toEqual([]);
  });
});

describe('storageCascadeKeys — turning storage off cannot orphan a website', () => {
  it('includes the storage-backed features themselves', () => {
    const keys = storageCascadeKeys();
    for (const key of STORAGE_BACKED_FEATURES) expect(keys).toContain(key);
  });

  it('includes everything that transitively depends on one of them', () => {
    // This is the whole point. `storefront` requires `productImages`; cascading
    // only the direct list would leave a shop with a live public storefront and
    // no photos on it — worse than the upload-button-wired-to-a-403 the storage
    // cascade was written to prevent.
    const keys = storageCascadeKeys();
    expect(keys).toContain('storefront');
    expect(keys).toContain('onlineOrders');
  });
});

describe('I-8 — a shop untouched by an admin behaves as it always did', () => {
  it('every capability, old and new, defaults to false', () => {
    const shop = new Shop();
    for (const key of FEATURE_KEYS) {
      expect(shop.features[key]).toBe(false);
    }
  });

  it('the new capabilities cannot be reached without an explicit chain of grants', () => {
    // The path from "brand new shop" to "public website" is four deliberate
    // admin actions: storage, productImages, onlineSelling, storefront. There
    // is no shortcut and no default that skips one.
    const shop = shopWith({}, false);
    expect(missingDepsFor(shop, 'storefront').features.length).toBeGreaterThan(0);
    expect(missingDepsFor(shop, 'onlineOrders').features).toEqual(['storefront']);
  });
});
