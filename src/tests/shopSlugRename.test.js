/**
 * Renaming a shop's public address.
 *
 * Two things are asserted, and only two, because only two can hurt somebody:
 *
 *   REGRESSION — an old address must keep resolving. The whole design rests on
 *     `resolveStorefront` querying `previousSlugs` as well as `slug`; drop that
 *     `$or` arm and every link a renamed shop ever shared 404s, silently, with
 *     the shop's own customers being the ones who find out.
 *
 *   INVARIANT GUARD — an address, once used, is spent. Nothing has broken this;
 *     it is here because the failure is the nastiest one available: shop B
 *     takes the slug shop A vacated, and A's stickers and Facebook posts start
 *     sending A's customers to B's catalogue. A uniqueness check that looked at
 *     `slug` alone would pass that.
 *
 * The rest — length bounds, reserved words, folding — is `validateSlug`, tested
 * directly against the util rather than through a mocked service.
 */

const mongoose = require('mongoose');

const makeLean = (result) => ({
  select: function () { return this; },
  lean: () => Promise.resolve(result),
});

jest.mock('../models/Shop.model', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Storefront.model', () => ({ findOne: jest.fn() }));
jest.mock('../models/StorefrontTemplate.model', () => {
  const fn = jest.fn();
  fn.SLOT_KEYS = [];
  return { findOne: fn, SLOT_KEYS: [] };
});
jest.mock('../models/Product.model', () => ({
  find: jest.fn(), aggregate: jest.fn(() => Promise.resolve([])), countDocuments: jest.fn(() => Promise.resolve(0)),
}));
jest.mock('../models/Category.model', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/AuditLog.model', () => ({ create: jest.fn(() => Promise.resolve({})) }));
jest.mock('../models/PlatformMedia.model', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../services/cache.service', () => ({ bumpShopCacheVersion: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/platformMedia.service', () => ({ registerConsumer: jest.fn() }));
jest.mock('../utils/authCache.util', () => ({ invalidateShopAuthCache: jest.fn(() => Promise.resolve()) }));
jest.mock('../utils/logger.util', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const Shop = require('../models/Shop.model');
const Storefront = require('../models/Storefront.model');
const StorefrontTemplate = require('../models/StorefrontTemplate.model');
const publicService = require('../services/publicStorefront.service');
const adminStorefrontService = require('../services/adminStorefront.service');
const { validateSlug } = require('../utils/shopSlug.util');

const SHOP_ID = new mongoose.Types.ObjectId();
const ADMIN_ID = new mongoose.Types.ObjectId();
const DAY = 24 * 60 * 60 * 1000;

const servableShop = () => ({
  _id: SHOP_ID,
  name: 'STUDENT HUB',
  slug: 'student-hub',
  previousSlugs: ['student-hub-3di3eo'],
  isActive: true,
  features: { storefront: true },
  subscription: { plan: 'paid', expiresAt: new Date(Date.now() + 90 * DAY) },
  access: {},
});

describe('validateSlug', () => {
  it('folds a human-typed name to a URL slug', () => {
    expect(validateSlug('Student Hub')).toMatchObject({ valid: true, slug: 'student-hub' });
    expect(validateSlug('  STUDENT__HUB  ')).toMatchObject({ valid: true, slug: 'student-hub' });
  });

  it('refuses what a shop must not be able to hold', () => {
    expect(validateSlug('admin').valid).toBe(false);       // reads as ours
    expect(validateSlug('ab').valid).toBe(false);          // too short
    expect(validateSlug('12345').valid).toBe(false);       // reads as an id
    expect(validateSlug('হিসাব').valid).toBe(false);        // folds to nothing
    expect(validateSlug('x'.repeat(49)).valid).toBe(false); // too long
  });
});

describe('resolveStorefront — old addresses', () => {
  beforeEach(() => jest.clearAllMocks());

  it('serves a shop on a slug it used to have', async () => {
    Shop.findOne.mockReturnValue(makeLean(servableShop()));
    Storefront.findOne.mockReturnValue(makeLean({
      shop: SHOP_ID, status: 'live', published: { template: 'bazar' },
    }));
    StorefrontTemplate.findOne.mockReturnValue(makeLean({ key: 'bazar', slots: [] }));

    const { shop } = await publicService.resolveStorefront('student-hub-3di3eo');

    // The query must look at both fields, or the old link is a 404.
    const filter = Shop.findOne.mock.calls[0][0];
    expect(filter).toEqual({
      $or: [{ slug: 'student-hub-3di3eo' }, { previousSlugs: 'student-hub-3di3eo' }],
    });
    // …and what comes back is the CURRENT address, so every link the page
    // renders and the canonical tag point at the new one.
    expect(shop.slug).toBe('student-hub');
  });
});

describe('setShopSlug', () => {
  beforeEach(() => jest.clearAllMocks());

  const shopDoc = (over = {}) => ({
    _id: SHOP_ID,
    name: 'STUDENT HUB',
    slug: 'student-hub-3di3eo',
    previousSlugs: [],
    save: jest.fn(function () { return Promise.resolve(this); }),
    ...over,
  });

  it('keeps the old address and moves to the new one', async () => {
    const doc = shopDoc();
    Shop.findById.mockResolvedValue(doc);
    Shop.findOne.mockReturnValue(makeLean(null));
    Storefront.findOne.mockReturnValue(makeLean(null));

    const res = await adminStorefrontService.setShopSlug(SHOP_ID, ADMIN_ID, 'Student Hub');

    expect(res).toMatchObject({ slug: 'student-hub', changed: true });
    expect(doc.slug).toBe('student-hub');
    expect(doc.previousSlugs).toEqual(['student-hub-3di3eo']);
  });

  it('refuses an address another shop has ever held', async () => {
    Shop.findById.mockResolvedValue(shopDoc());
    // The clash is on the OTHER shop's history, not its current slug — the case
    // a `{ slug }`-only check would wave through.
    Shop.findOne.mockReturnValue(makeLean({ _id: new mongoose.Types.ObjectId(), name: 'Other' }));

    await expect(
      adminStorefrontService.setShopSlug(SHOP_ID, ADMIN_ID, 'student-hub')
    ).rejects.toMatchObject({ statusCode: 409 });

    const filter = Shop.findOne.mock.calls[0][0];
    expect(filter.$or).toEqual([{ slug: 'student-hub' }, { previousSlugs: 'student-hub' }]);
  });

  it('is a no-op when the address is already what was asked for', async () => {
    const doc = shopDoc({ slug: 'student-hub' });
    Shop.findById.mockResolvedValue(doc);

    const res = await adminStorefrontService.setShopSlug(SHOP_ID, ADMIN_ID, 'student-hub');

    expect(res.changed).toBe(false);
    expect(doc.save).not.toHaveBeenCalled();
    expect(Shop.findOne).not.toHaveBeenCalled();
  });
});
