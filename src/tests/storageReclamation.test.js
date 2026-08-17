/**
 * How storage is given back.
 *
 * Everything in `mediaPipeline.test.js` covers bytes going IN. This file covers
 * the three things that were missing and that together decide whether a shop's
 * quota is a real limit or a number that only ever goes up:
 *
 *   1. THE CHARGE IS A RACE-FREE CLAIM. `req.shop` is a Redis-cached document
 *      with a `usedBytes` up to five minutes stale, and nothing invalidates it
 *      on upload. Gating on that value alone lets a shop write far past its
 *      allowance inside one cache window, so the allowance is enforced by a
 *      conditional update against the live document instead.
 *   2. DELETING SOMETHING RELEASES ITS PHOTOS. A product or category that
 *      leaves every listing must drop its references, or `refCount` never
 *      reaches zero, `orphanedAt` is never stamped, and the sweep below can
 *      never see the image.
 *   3. THE SWEEPS ACTUALLY DELETE. Both claim each row with the full predicate
 *      re-asserted, which is what makes them safe to run concurrently and safe
 *      against a save that re-attaches an image a moment before it is collected.
 */

const mongoose = require('mongoose');

const ShopMedia = require('../models/ShopMedia.model');
const Shop = require('../models/Shop.model');
const Product = require('../models/Product.model');
const Category = require('../models/Category.model');
const AuditLog = require('../models/AuditLog.model');
const PlatformSetting = require('../models/PlatformSetting.model');

const mediaService = require('../services/media.service');
const storageService = require('../services/storage.service');
const productService = require('../services/product.service');
const categoryService = require('../services/category.service');
const cacheService = require('../services/cache.service');

const id = () => new mongoose.Types.ObjectId();
const MB = 1024 * 1024;

const shopFixture = (over = {}) => ({
  _id: id(),
  storage: { enabled: true, quotaMb: 100, usedBytes: 0, fileCount: 0, ...(over.storage || {}) },
  ...over,
});

/** A ShopMedia row as the sweeps read it — lean, only the fields they use. */
const mediaRow = (over = {}) => {
  const mediaId = over._id || id();
  const shop = over.shop || id();
  return {
    _id: mediaId,
    shop,
    account: over.account || id(),
    objectKey: `${shop}/${mediaId}.webp`,
    thumbKey: `${shop}/${mediaId}_t.webp`,
    mediumKey: `${shop}/${mediaId}_m.webp`,
    totalBytes: 3000,
    ...over,
  };
};

beforeEach(() => {
  jest.spyOn(PlatformSetting, 'current').mockResolvedValue({
    defaultStorageQuotaMb: 100,
    storageWarnPercent: 80,
    orphanGraceDays: 7,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  storageService._clients.clear();
});

// ── 1. The quota is claimed, not merely checked ─────────────────────────────

describe('per-shop quota is enforced against the live document', () => {
  it('compares the allowance to the stored usedBytes, not the one on the passed shop', async () => {
    const shop = shopFixture({ storage: { enabled: true, quotaMb: 100, usedBytes: 0 } });
    const update = jest.spyOn(Shop, 'updateOne').mockResolvedValue({ matchedCount: 1 });

    await mediaService._chargeShopUsage(shop._id, 5000, 1, 100 * MB);

    const [filter] = update.mock.calls[0];
    // The whole point: the number being compared comes from the document
    // (`$storage.usedBytes`), not from the caller's copy of it.
    expect(filter.$expr.$lte[0].$add[0]).toEqual({ $ifNull: ['$storage.usedBytes', 0] });
    expect(filter.$expr.$lte[0].$add[1]).toBe(5000);
    expect(filter.$expr.$lte[1]).toBe(100 * MB);
    // And a shop whose storage was switched off mid-flight loses the race too.
    expect(filter['storage.enabled']).toBe(true);
  });

  it('reports the charge refused when the conditional update matches nothing', async () => {
    jest.spyOn(Shop, 'updateOne').mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    await expect(mediaService._chargeShopUsage(id(), 1, 1, 10)).resolves.toBe(false);
  });

  it('never writes a byte to R2 when the claim is lost', async () => {
    // The stale-cache scenario in one test: the shop object says there is room,
    // the database says there is not. The upload must lose.
    const shop = shopFixture({ storage: { enabled: true, quotaMb: 100, usedBytes: 0 } });
    jest.spyOn(ShopMedia, 'findOne').mockResolvedValue(null);
    jest.spyOn(Shop, 'updateOne').mockResolvedValue({ matchedCount: 0 });
    jest.spyOn(Shop, 'findById').mockReturnValue({
      select: () => ({ lean: async () => ({ storage: { enabled: true, quotaMb: 100, usedBytes: 100 * MB } }) }),
    });
    const uploadGroup = jest.spyOn(storageService, 'uploadGroup');

    const sharp = require('sharp');
    const file = {
      buffer: await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .png().toBuffer(),
      originalname: 'p.png',
      mimetype: 'image/png',
    };

    await expect(mediaService.uploadImage(shop, file))
      .rejects.toMatchObject({ statusCode: 413, code: 'STORAGE_QUOTA_EXCEEDED' });

    expect(uploadGroup).not.toHaveBeenCalled();
  });

  it('tells a shop disabled mid-flight that it is disabled, not that it is full', async () => {
    // Both look identical from the failed update — one matched nothing either
    // way — and the two send the shopkeeper to completely different places.
    jest.spyOn(Shop, 'findById').mockReturnValue({
      select: () => ({ lean: async () => ({ storage: { enabled: false, quotaMb: 100, usedBytes: 0 } }) }),
    });

    await expect(mediaService._throwLiveStorageError(id(), 100, { defaultQuotaMb: 100, warnPercent: 80 }))
      .rejects.toMatchObject({ statusCode: 403, code: 'STORAGE_DISABLED' });
  });

  it('refunds the claim when the objects never make it into the bucket', async () => {
    const update = jest.spyOn(Shop, 'updateOne').mockResolvedValue({ matchedCount: 1 });
    const shopId = id();

    await mediaService._refundShopUsage(shopId, 4096, 1);

    const [filter, pipeline] = update.mock.calls[0];
    expect(filter).toEqual({ _id: shopId });
    expect(pipeline[0].$set['storage.usedBytes'].$max[1].$subtract[1]).toBe(4096);
    // Floored at zero: a double refund must not drive the counter negative and
    // start over-reporting free space.
    expect(pipeline[0].$set['storage.usedBytes'].$max[0]).toBe(0);
  });

  it('does not throw when the refund itself fails — the caller is already failing', async () => {
    jest.spyOn(Shop, 'updateOne').mockRejectedValue(new Error('mongo down'));
    await expect(mediaService._refundShopUsage(id(), 10, 1)).resolves.toBeUndefined();
  });
});

// ── 2. Deleting something releases its photos ───────────────────────────────

describe('deleting an entity detaches its media', () => {
  it('releases a product photo when the product is soft-deleted', async () => {
    const shopId = id();
    const mediaId = id();
    const product = {
      _id: id(),
      name: 'Rice',
      code: 'R-1',
      catalogImages: [{ mediaId }],
      variants: [],
      save: jest.fn().mockResolvedValue(true),
    };

    jest.spyOn(Product, 'findOne').mockResolvedValue(product);
    // The combo guard asks "is this product a component of a live combo?" — an
    // ordinary product is not.
    jest.spyOn(Product, 'find').mockReturnValue({ select: () => Promise.resolve([]) });
    jest.spyOn(AuditLog, 'create').mockResolvedValue({});
    jest.spyOn(cacheService, 'delete').mockResolvedValue(true);
    const reconcile = jest.spyOn(mediaService, 'reconcileRefs').mockResolvedValue({ attached: [], detached: [] });

    await productService.deleteProduct(shopId, id(), product._id);

    // Nothing points at it any more, so the grace clock has to start. Without
    // this the image is charged to the shop for as long as the shop exists.
    const [calledShop, previous, next] = reconcile.mock.calls[0];
    expect(String(calledShop)).toBe(String(shopId));
    expect(previous.map(String)).toEqual([String(mediaId)]);
    expect(next).toEqual([]);
  });

  it('reads the media ids before the save, while the document still has them', async () => {
    const product = {
      _id: id(),
      name: 'X',
      code: 'X-1',
      catalogImages: [{ mediaId: id() }],
      variants: [{ sku: 'v1', imageMediaId: id() }],
      // If the ids were read after this, a future change that cleared them on
      // delete would silently make the detach a no-op.
      save: jest.fn().mockImplementation(function clear() {
        this.catalogImages = [];
        this.variants = [];
        return Promise.resolve(true);
      }),
    };

    jest.spyOn(Product, 'findOne').mockResolvedValue(product);
    // Combo guard — see the note in the test above.
    jest.spyOn(Product, 'find').mockReturnValue({ select: () => Promise.resolve([]) });
    jest.spyOn(AuditLog, 'create').mockResolvedValue({});
    jest.spyOn(cacheService, 'delete').mockResolvedValue(true);
    const reconcile = jest.spyOn(mediaService, 'reconcileRefs').mockResolvedValue({ attached: [], detached: [] });

    await productService.deleteProduct(id(), id(), product._id);

    expect(reconcile.mock.calls[0][1]).toHaveLength(2);
  });

  it('releases a category photo and its subcategories photos together', async () => {
    const shopId = id();
    const ownImage = id();
    const subImage = id();

    const category = { _id: id(), imageMediaId: ownImage, isActive: true, save: jest.fn().mockResolvedValue(true) };

    jest.spyOn(Category, 'findOne').mockResolvedValue(category);
    jest.spyOn(Product, 'countDocuments').mockResolvedValue(0);
    jest.spyOn(Category, 'find').mockReturnValue({
      select: () => ({ lean: async () => [{ _id: id(), imageMediaId: subImage }] }),
    });
    jest.spyOn(Category, 'updateMany').mockResolvedValue({});
    jest.spyOn(categoryService, 'invalidateCache').mockResolvedValue(true);
    const reconcile = jest.spyOn(mediaService, 'reconcileRefs').mockResolvedValue({ attached: [], detached: [] });

    await categoryService.deleteCategory(shopId, category._id);

    // A subcategory deactivated by the cascade is just as gone as its parent —
    // its photo has to be released in the same breath or nothing ever will.
    const [, previous, next] = reconcile.mock.calls[0];
    expect(previous.map(String).sort()).toEqual([String(ownImage), String(subImage)].sort());
    expect(next).toEqual([]);
  });

  it('does not detach a category that refuses to delete because it still holds products', async () => {
    jest.spyOn(Category, 'findOne').mockResolvedValue({ _id: id(), imageMediaId: id() });
    // The subcategory read now happens BEFORE the product count, because the
    // guard counts the whole subtree rather than the one row — a parent whose
    // subcategory holds stock must refuse too. Unmocked, this reaches for a
    // real connection and the test times out rather than failing usefully.
    jest.spyOn(Category, 'find').mockReturnValue({
      select: () => ({ lean: async () => [] }),
    });
    jest.spyOn(Product, 'countDocuments').mockResolvedValue(3);
    const reconcile = jest.spyOn(mediaService, 'reconcileRefs');

    await expect(categoryService.deleteCategory(id(), id())).rejects.toMatchObject({ statusCode: 400 });
    expect(reconcile).not.toHaveBeenCalled();
  });
});

// ── 3. The sweeps ───────────────────────────────────────────────────────────

describe('reclamation sweeps', () => {
  /** Wire the R2 side so a sweep can run end to end without a bucket. */
  const stubStorage = () => {
    const account = { _id: id(), name: 'acc', bucket: 'b' };
    jest.spyOn(storageService, 'getAccountWithSecret').mockResolvedValue(account);
    return {
      account,
      deleteObjects: jest.spyOn(storageService, 'deleteObjects').mockResolvedValue({ deleted: [], errors: [] }),
      uncommit: jest.spyOn(storageService, 'uncommit').mockResolvedValue(),
      refund: jest.spyOn(mediaService, '_refundShopUsage').mockResolvedValue(),
    };
  };

  const findReturning = (rows) =>
    jest.spyOn(ShopMedia, 'find').mockReturnValue({
      select: () => ({ limit: () => ({ lean: async () => rows }) }),
    });

  it('only considers staged rows nothing has ever pointed at, past the TTL', async () => {
    const find = findReturning([]);
    await mediaService.sweepStagedMedia();

    const [filter] = find.mock.calls[0];
    expect(filter.status).toBe('staged');
    expect(filter.refCount).toBe(0);
    expect(filter.createdAt.$lt).toBeInstanceOf(Date);
    // 48h back, give or take the milliseconds this test took to get here.
    const ageMs = Date.now() - filter.createdAt.$lt.getTime();
    expect(Math.abs(ageMs - mediaService.STAGED_TTL_MS)).toBeLessThan(5000);
  });

  it('deletes the objects, gives the bytes back to the account and to the shop', async () => {
    const shop = id();
    const account = id();
    const rows = [mediaRow({ shop, account }), mediaRow({ shop, account })];

    findReturning(rows);
    const stubs = stubStorage();
    jest.spyOn(ShopMedia, 'findOneAndDelete').mockImplementation((f) => ({
      lean: async () => rows.find((r) => String(r._id) === String(f._id)) || null,
    }));

    const result = await mediaService.sweepStagedMedia();

    expect(result).toMatchObject({ scanned: 2, deleted: 2, skipped: 0, failed: 0, bytes: 6000 });
    // One batched R2 call for the bucket, not one per image: three keys each.
    expect(stubs.deleteObjects).toHaveBeenCalledTimes(1);
    expect(stubs.deleteObjects.mock.calls[0][1]).toHaveLength(6);
    expect(stubs.uncommit).toHaveBeenCalledWith(String(account), 6000, { files: 6 });
    // And the shop stops being billed for them — the half that makes a quota
    // recoverable rather than a one-way ratchet.
    expect(stubs.refund).toHaveBeenCalledWith(String(shop), 6000, 2);
  });

  it('re-asserts the whole predicate when claiming, so a re-attached image survives', async () => {
    const row = mediaRow();
    findReturning([row]);
    stubStorage();
    // Nothing matched: `reconcileRefs` raised refCount between the read and the
    // claim. This is the race the claim exists for.
    const claim = jest.spyOn(ShopMedia, 'findOneAndDelete').mockReturnValue({ lean: async () => null });

    const result = await mediaService.sweepStagedMedia();

    const [filter] = claim.mock.calls[0];
    expect(filter.refCount).toBe(0);
    expect(filter.status).toBe('staged');
    expect(String(filter._id)).toBe(String(row._id));
    expect(result).toMatchObject({ scanned: 1, deleted: 0, skipped: 1 });
  });

  it('splits the R2 calls per account, because a media group only ever lives in one', async () => {
    const a1 = id();
    const a2 = id();
    const rows = [mediaRow({ account: a1 }), mediaRow({ account: a2 })];

    findReturning(rows);
    const stubs = stubStorage();
    jest.spyOn(ShopMedia, 'findOneAndDelete').mockImplementation((f) => ({
      lean: async () => rows.find((r) => String(r._id) === String(f._id)) || null,
    }));

    await mediaService.sweepStagedMedia();

    expect(stubs.deleteObjects).toHaveBeenCalledTimes(2);
    expect(stubs.uncommit.mock.calls.map((c) => c[1])).toEqual([3000, 3000]);
  });

  it('still refunds the shop when R2 refuses the delete, and counts it as failed', async () => {
    const shop = id();
    const rows = [mediaRow({ shop })];

    findReturning(rows);
    const stubs = stubStorage();
    stubs.deleteObjects.mockRejectedValue(new Error('bucket unreachable'));
    jest.spyOn(ShopMedia, 'findOneAndDelete').mockReturnValue({ lean: async () => rows[0] });

    const result = await mediaService.sweepStagedMedia();

    // The row is gone either way, so leaving the bytes charged would bill a shop
    // for storage it can no longer see. The objects become a reconciliation
    // ghost, which is what `failed` is reporting.
    expect(result).toMatchObject({ deleted: 0, failed: 1 });
    expect(stubs.refund).toHaveBeenCalledWith(String(shop), 3000, 1);
  });

  it('measures the orphan grace period from the platform setting', async () => {
    PlatformSetting.current.mockResolvedValue({ orphanGraceDays: 3 });
    const find = findReturning([]);

    await mediaService.sweepOrphanedMedia();

    const [filter] = find.mock.calls[0];
    const ageDays = (Date.now() - filter.orphanedAt.$lt.getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.round(ageDays)).toBe(3);
    expect(filter.refCount).toBe(0);
    expect(filter.orphanedAt.$ne).toBeNull();
  });

  it('leaves broken rows alone — there is nothing in the bucket left to delete', async () => {
    const find = findReturning([]);
    await mediaService.sweepOrphanedMedia();
    expect(find.mock.calls[0][0].status).toEqual({ $ne: 'broken' });
  });

  it('takes a bounded bite, so one pass cannot monopolise the job timer', async () => {
    const limit = jest.fn().mockReturnValue({ lean: async () => [] });
    jest.spyOn(ShopMedia, 'find').mockReturnValue({ select: () => ({ limit }) });

    await mediaService.sweepStagedMedia();
    expect(limit).toHaveBeenCalledWith(mediaService.RECLAIM_BATCH);
  });
});
