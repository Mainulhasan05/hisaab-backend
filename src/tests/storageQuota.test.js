/**
 * Per-shop storage: the three states, the quota arithmetic, and the invariant
 * that keeps the image capabilities and the storage switch in agreement.
 *
 * The bug this file exists to prevent is a quiet one: `quotaMb: 0` silently
 * becoming 100MB because someone wrote `||` where `??` was needed. A shop
 * deliberately given no allowance would start accepting uploads, and nothing
 * would look wrong until the pool filled.
 */

// The feature-toggle path invalidates caches on the way out. Both reach for a
// live Mongo/Redis connection and neither is what these tests are about.
jest.mock('../utils/authCache.util', () => ({
  invalidateShopAuthCache: jest.fn().mockResolvedValue(undefined),
  invalidateUserAuthCache: jest.fn().mockResolvedValue(undefined),
  invalidateBranchCache: jest.fn().mockResolvedValue(undefined),
}));

const mongoose = require('mongoose');
const Shop = require('../models/Shop.model');
const cacheService = require('../services/cache.service');
const {
  effectiveQuotaMb,
  storageEnabled,
  storageState,
  assertCanStore,
  formatBytes,
  MB,
} = require('../utils/storageQuota.util');
const {
  FEATURES,
  FEATURE_KEYS,
  STORAGE_BACKED_FEATURES,
  featureMap,
} = require('../utils/features.util');

const SETTINGS = { defaultQuotaMb: 100, warnPercent: 80 };
const shopWith = (storage) => ({ name: 'Test Shop', storage });

describe('the capabilities are registered in both places', () => {
  it.each(['productImages', 'categoryImages'])('%s is in the FEATURES registry', (key) => {
    expect(FEATURE_KEYS).toContain(key);
    expect(FEATURES[key].bn).toBeTruthy();
    expect(FEATURES[key].en).toBeTruthy();
    expect(FEATURES[key].description).toBeTruthy();
  });

  it.each(['productImages', 'categoryImages'])('%s is on Shop.features and defaults OFF', (key) => {
    const path = Shop.schema.path(`features.${key}`);
    expect(path).toBeDefined();
    expect(path.instance).toBe('Boolean');
    expect(new Shop().features[key]).toBe(false);
  });

  it('both are declared storage-backed, and nothing else is', () => {
    expect([...STORAGE_BACKED_FEATURES].sort()).toEqual(['categoryImages', 'productImages']);
  });

  it('featureMap still lists every key as a real boolean', () => {
    const map = featureMap({ features: { productImages: true } });
    expect(map.productImages).toBe(true);
    expect(map.categoryImages).toBe(false);
    expect(map.packaging).toBe(false);
    FEATURE_KEYS.forEach((key) => expect(typeof map[key]).toBe('boolean'));
  });

  it('a brand-new shop has storage off and no quota override', () => {
    const shop = new Shop();
    expect(shop.storage.enabled).toBe(false);
    expect(shop.storage.quotaMb).toBeNull();
    expect(shop.storage.usedBytes).toBe(0);
  });
});

describe('effectiveQuotaMb — null inherits, zero does not', () => {
  it('falls back to the platform default when the shop has no override', () => {
    expect(effectiveQuotaMb(shopWith({ quotaMb: null }), 100)).toBe(100);
    expect(effectiveQuotaMb(shopWith({}), 100)).toBe(100);
    expect(effectiveQuotaMb({}, 100)).toBe(100);
    expect(effectiveQuotaMb(null, 100)).toBe(100);
  });

  it('honours a deliberate zero instead of promoting it to the default', () => {
    // The `||` version of this function returns 100 here. That is the bug.
    expect(effectiveQuotaMb(shopWith({ quotaMb: 0 }), 100)).toBe(0);
  });

  it('honours a per-shop override', () => {
    expect(effectiveQuotaMb(shopWith({ quotaMb: 500 }), 100)).toBe(500);
  });

  it('ignores nonsense rather than handing out an unusable quota', () => {
    expect(effectiveQuotaMb(shopWith({ quotaMb: -5 }), 100)).toBe(100);
    expect(effectiveQuotaMb(shopWith({ quotaMb: NaN }), 100)).toBe(100);
  });

  it('follows the platform default when it moves', () => {
    const shop = shopWith({ quotaMb: null });
    expect(effectiveQuotaMb(shop, 100)).toBe(100);
    expect(effectiveQuotaMb(shop, 250)).toBe(250);
  });
});

describe('storageEnabled fails closed', () => {
  it.each([
    [undefined, false],
    [{}, false],
    [{ enabled: false }, false],
    [{ enabled: 'true' }, false],
    [{ enabled: 1 }, false],
    [{ enabled: true }, true],
  ])('storage %p → %p', (storage, expected) => {
    expect(storageEnabled(shopWith(storage))).toBe(expected);
  });
});

describe('storageState', () => {
  it('reports usage, headroom and percentage against the effective quota', () => {
    const state = storageState(
      shopWith({ enabled: true, quotaMb: 100, usedBytes: 50 * MB, fileCount: 12 }),
      SETTINGS
    );
    expect(state.quotaBytes).toBe(100 * MB);
    expect(state.availableBytes).toBe(50 * MB);
    expect(state.percent).toBe(50);
    expect(state.fileCount).toBe(12);
    expect(state.isWarning).toBe(false);
    expect(state.isOverQuota).toBe(false);
  });

  it('distinguishes "inheriting" from "set to the same number as the default"', () => {
    expect(storageState(shopWith({ enabled: true, quotaMb: null }), SETTINGS).quotaOverrideMb).toBeNull();
    expect(storageState(shopWith({ enabled: true, quotaMb: 100 }), SETTINGS).quotaOverrideMb).toBe(100);
  });

  it('raises the warning flag from the configured threshold', () => {
    const at79 = storageState(shopWith({ enabled: true, quotaMb: 100, usedBytes: 79 * MB }), SETTINGS);
    const at85 = storageState(shopWith({ enabled: true, quotaMb: 100, usedBytes: 85 * MB }), SETTINGS);
    expect(at79.isWarning).toBe(false);
    expect(at85.isWarning).toBe(true);
  });

  it('reports over-quota without pretending anything was deleted', () => {
    // Reachable by lowering a quota under existing usage — allowed on purpose.
    const state = storageState(shopWith({ enabled: true, quotaMb: 10, usedBytes: 50 * MB }), SETTINGS);
    expect(state.isOverQuota).toBe(true);
    expect(state.availableBytes).toBe(0);
    expect(state.usedBytes).toBe(50 * MB);   // still there
  });

  it('never flags a disabled shop as warning or over-quota', () => {
    const state = storageState(shopWith({ enabled: false, quotaMb: 1, usedBytes: 900 * MB }), SETTINGS);
    expect(state.enabled).toBe(false);
    expect(state.isWarning).toBe(false);
    expect(state.isOverQuota).toBe(false);
  });
});

describe('assertCanStore — three refusals, three different answers', () => {
  it('403 STORAGE_DISABLED when the shop never got the feature', async () => {
    await expect(assertCanStore(shopWith({ enabled: false }), 1024, SETTINGS))
      .rejects.toMatchObject({ statusCode: 403, code: 'STORAGE_DISABLED' });
  });

  it('413 STORAGE_QUOTA_EXCEEDED when the allowance is used up', async () => {
    await expect(assertCanStore(
      shopWith({ enabled: true, quotaMb: 1, usedBytes: 1 * MB }), 1024, SETTINGS
    )).rejects.toMatchObject({ statusCode: 413, code: 'STORAGE_QUOTA_EXCEEDED' });
  });

  it('413, not 403, for an enabled shop with a zero allowance', async () => {
    // "Enabled with no room" is a quota problem the owner can escalate, not a
    // "your shop lacks the feature" problem. Different message, different fix.
    await expect(assertCanStore(shopWith({ enabled: true, quotaMb: 0 }), 1, SETTINGS))
      .rejects.toMatchObject({ statusCode: 413 });
  });

  it('rejects the upload that would cross the line, not just the one after it', async () => {
    const shop = shopWith({ enabled: true, quotaMb: 1, usedBytes: 1 * MB - 100 });
    await expect(assertCanStore(shop, 101, SETTINGS)).rejects.toMatchObject({ statusCode: 413 });
    await expect(assertCanStore(shop, 100, SETTINGS)).resolves.toBeTruthy();
  });

  it('carries Bengali copy on both refusals', async () => {
    const disabled = await assertCanStore(shopWith({ enabled: false }), 1, SETTINGS).catch((e) => e);
    const full = await assertCanStore(shopWith({ enabled: true, quotaMb: 0 }), 1, SETTINGS).catch((e) => e);
    expect(disabled.messageBn).toMatch(/চালু নেই/);
    expect(full.messageBn).toMatch(/কোটা শেষ/);
  });

  it('allows an upload that fits', async () => {
    const state = await assertCanStore(
      shopWith({ enabled: true, quotaMb: 100, usedBytes: 10 * MB }), 5 * MB, SETTINGS
    );
    expect(state.enabled).toBe(true);
  });
});

describe('formatBytes', () => {
  it('picks a readable unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * MB)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 * MB)).toBe('3.00 GB');
  });

  it('is safe on junk', () => {
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
  });
});

describe('the storage ↔ capability invariant', () => {
  const adminService = require('../services/admin.service');

  const SHOP_ID = new mongoose.Types.ObjectId();
  const ADMIN_ID = new mongoose.Types.ObjectId();

  const fakeShop = (over = {}) => ({
    _id: SHOP_ID,
    name: 'Test Shop',
    features: {},
    storage: { enabled: false },
    markModified: jest.fn(),
    save: jest.fn().mockResolvedValue(true),
    toObject() { return { ...this }; },
    ...over,
  });

  beforeEach(() => {
    jest.spyOn(require('../models/AuditLog.model'), 'log').mockResolvedValue(true);
    jest.spyOn(cacheService, 'bumpShopCacheVersion').mockResolvedValue(true);
  });

  afterEach(() => jest.restoreAllMocks());

  it('refuses to enable productImages while storage is off', async () => {
    jest.spyOn(Shop, 'findById').mockResolvedValue(fakeShop());

    await expect(adminService.setShopFeature(SHOP_ID, ADMIN_ID, 'productImages', true))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses to enable categoryImages while storage is off', async () => {
    jest.spyOn(Shop, 'findById').mockResolvedValue(fakeShop());

    await expect(adminService.setShopFeature(SHOP_ID, ADMIN_ID, 'categoryImages', true))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('says in Bengali what to do about it', async () => {
    jest.spyOn(Shop, 'findById').mockResolvedValue(fakeShop());
    const err = await adminService.setShopFeature(SHOP_ID, ADMIN_ID, 'productImages', true).catch((e) => e);
    expect(err.messageBn).toMatch(/স্টোরেজ/);
  });

  it('still allows DISABLING an image capability when storage is off', async () => {
    // The cascade from turning storage off leaves the flag false; an admin must
    // never be blocked from turning something further off.
    const shop = fakeShop({ features: { productImages: true } });
    jest.spyOn(Shop, 'findById').mockResolvedValue(shop);

    await expect(adminService.setShopFeature(SHOP_ID, ADMIN_ID, 'productImages', false)).resolves.toBeTruthy();
    expect(shop.features.productImages).toBe(false);
  });

  it('leaves capabilities that do not touch storage alone', async () => {
    const shop = fakeShop();
    jest.spyOn(Shop, 'findById').mockResolvedValue(shop);

    await expect(adminService.setShopFeature(SHOP_ID, ADMIN_ID, 'packaging', true)).resolves.toBeTruthy();
    expect(shop.features.packaging).toBe(true);
  });

  it('allows enabling once storage is on', async () => {
    const shop = fakeShop({ storage: { enabled: true } });
    jest.spyOn(Shop, 'findById').mockResolvedValue(shop);

    await expect(adminService.setShopFeature(SHOP_ID, ADMIN_ID, 'productImages', true)).resolves.toBeTruthy();
    expect(shop.features.productImages).toBe(true);
  });
});
