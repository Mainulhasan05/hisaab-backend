/**
 * The image pipeline's contract.
 *
 * What is pinned here is what cannot be seen by looking at a working upload:
 * that a re-picked photo costs nothing, that an image's three renditions never
 * split across buckets, that one shop cannot reference another's media, that
 * `refCount` moves exactly once per save, and that turning the capability off
 * does not delete anybody's photos.
 *
 * The renditions are generated with the real `sharp` — a mock there would pin
 * our expectations rather than the library's behaviour, and "the thumbnail came
 * out 1600px wide" is precisely the class of bug worth catching.
 */

const mongoose = require('mongoose');
const sharp = require('sharp');

const ShopMedia = require('../models/ShopMedia.model');
const Shop = require('../models/Shop.model');
const PlatformSetting = require('../models/PlatformSetting.model');
const R2Account = require('../models/R2Account.model');
const mediaService = require('../services/media.service');
const storageService = require('../services/storage.service');
const platformMediaService = require('../services/platformMedia.service');
const productService = require('../services/product.service');

const id = () => new mongoose.Types.ObjectId();
const MB = 1024 * 1024;

const shopFixture = (over = {}) => ({
  _id: id(),
  storage: { enabled: true, quotaMb: 100, usedBytes: 0, fileCount: 0, ...(over.storage || {}) },
  ...over,
});

/** A real, decodable image — `_renderAll` runs sharp for actual. */
const imageBuffer = (width = 800, height = 600, shade = 30) =>
  sharp({
    create: { width, height, channels: 3, background: { r: shade, g: shade + 10, b: shade + 20 } },
  }).png().toBuffer();

const fileOf = (buffer, originalname = 'photo.png') => ({
  buffer,
  originalname,
  mimetype: 'image/png',
});

/** The shape `storage.uploadGroup` returns, for whatever keys it was handed. */
const groupResultFor = (objects, accountId = id()) => ({
  account: accountId,
  accountName: 'acc-1',
  bytes: objects.reduce((sum, o) => sum + o.body.length, 0),
  objects: objects.map((o) => ({
    key: o.key,
    url: `https://pub.r2.dev/${o.key}`,
    bytes: o.body.length,
  })),
});

beforeEach(() => {
  jest.spyOn(PlatformSetting, 'current').mockResolvedValue({
    defaultStorageQuotaMb: 100,
    storageWarnPercent: 80,
  });
  // `matchedCount` is what `_chargeShopUsage` reads to decide whether the shop
  // was allowed these bytes, so the default fixture has to say "allowed". Tests
  // that want the quota to refuse override it with `matchedCount: 0`.
  jest.spyOn(Shop, 'updateOne').mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
});

afterEach(() => {
  jest.restoreAllMocks();
  storageService._clients.clear();
});

// ── Renditions ──────────────────────────────────────────────────────────────

describe('rendition generation', () => {
  it('produces exactly three WebP renditions, each within its own cap', async () => {
    const out = await mediaService._renderAll(await imageBuffer(2000, 1500));

    expect(out.map((r) => r.name)).toEqual(['original', 'medium', 'thumb']);
    expect(out.find((r) => r.name === 'original').width).toBe(1600);
    expect(out.find((r) => r.name === 'medium').width).toBe(600);
    expect(out.find((r) => r.name === 'thumb').width).toBe(200);

    for (const r of out) {
      const meta = await sharp(r.buffer).metadata();
      expect(meta.format).toBe('webp');
    }
  });

  it('never upscales — a small photo stays small rather than growing to 1600px', async () => {
    const out = await mediaService._renderAll(await imageBuffer(240, 180));
    expect(out.find((r) => r.name === 'original').width).toBe(240);
    // The thumb still shrinks; only enlargement is refused.
    expect(out.find((r) => r.name === 'thumb').width).toBe(200);
  });

  it('strips metadata, so a shopkeeper\'s GPS tag never reaches a public bucket', async () => {
    const withExif = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .withMetadata({ exif: { IFD0: { Copyright: 'secret-studio', Software: 'test' } } })
      .jpeg()
      .toBuffer();

    const out = await mediaService._renderAll(withExif);
    const meta = await sharp(out[0].buffer).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it('refuses an unreadable file with a 400 rather than storing garbage', async () => {
    await expect(mediaService._renderAll(Buffer.from('this is not an image')))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

// ── Dedupe and quota ────────────────────────────────────────────────────────

describe('upload', () => {
  it('re-uploading the same photo costs zero bytes and zero R2 operations', async () => {
    const shop = shopFixture();
    const existing = { _id: id(), totalBytes: 1234 };

    jest.spyOn(ShopMedia, 'findOne').mockResolvedValue(existing);
    const group = jest.spyOn(storageService, 'uploadGroup');
    const create = jest.spyOn(ShopMedia, 'create');

    const result = await mediaService.uploadImage(shop, fileOf(await imageBuffer()));

    expect(result.deduped).toBe(true);
    expect(result.media).toBe(existing);
    expect(group).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    // Nothing was stored, so nothing may be charged.
    expect(Shop.updateOne).not.toHaveBeenCalled();
  });

  it('a dedupe hit still works for a shop with no room left for new bytes', async () => {
    // The gate must sit AFTER the dedupe check: an image the shop already owns
    // and already paid for cannot be refused for lack of space.
    const shop = shopFixture({ storage: { enabled: true, quotaMb: 1, usedBytes: 1 * MB - 10 } });
    jest.spyOn(ShopMedia, 'findOne').mockResolvedValue({ _id: id() });

    const result = await mediaService.uploadImage(shop, fileOf(await imageBuffer()));
    expect(result.deduped).toBe(true);
  });

  it('refuses a shop without storage with 403 STORAGE_DISABLED, before decoding anything', async () => {
    const shop = shopFixture({ storage: { enabled: false } });
    const findOne = jest.spyOn(ShopMedia, 'findOne');

    await expect(mediaService.uploadImage(shop, fileOf(await imageBuffer())))
      .rejects.toMatchObject({ statusCode: 403, code: 'STORAGE_DISABLED' });

    // It bailed out before doing any image work at all.
    expect(findOne).not.toHaveBeenCalled();
  });

  it('refuses an over-quota shop with 413, not 403 — a different person fixes each', async () => {
    const shop = shopFixture({ storage: { enabled: true, quotaMb: 1, usedBytes: 1 * MB - 10 } });
    jest.spyOn(ShopMedia, 'findOne').mockResolvedValue(null);

    await expect(mediaService.uploadImage(shop, fileOf(await imageBuffer(1200, 900))))
      .rejects.toMatchObject({ statusCode: 413, code: 'STORAGE_QUOTA_EXCEEDED' });
  });

  it('charges the shop for all three renditions, not just the full-size one', async () => {
    const shop = shopFixture();
    jest.spyOn(ShopMedia, 'findOne').mockResolvedValue(null);

    let captured = null;
    jest.spyOn(storageService, 'uploadGroup').mockImplementation(async (objects) => {
      captured = objects;
      return groupResultFor(objects);
    });
    jest.spyOn(ShopMedia, 'create').mockImplementation(async (doc) => doc);

    const { media, deduped } = await mediaService.uploadImage(shop, fileOf(await imageBuffer()));

    expect(deduped).toBe(false);
    expect(captured).toHaveLength(3);

    const sumOfAll = captured.reduce((s, o) => s + o.body.length, 0);
    expect(media.totalBytes).toBe(sumOfAll);
    // `bytes` is the full-size object alone, and must be the smaller number.
    expect(media.bytes).toBeLessThan(media.totalBytes);

    const [, update] = Shop.updateOne.mock.calls[0];
    // An aggregation pipeline, so `peakUsedBytes` can be raised in the same
    // atomic step as `usedBytes`.
    expect(Array.isArray(update)).toBe(true);
    expect(JSON.stringify(update)).toContain('storage.peakUsedBytes');
  });

  it('keys every rendition under the shop prefix and one media id', async () => {
    const shop = shopFixture();
    jest.spyOn(ShopMedia, 'findOne').mockResolvedValue(null);

    let captured = null;
    jest.spyOn(storageService, 'uploadGroup').mockImplementation(async (objects) => {
      captured = objects;
      return groupResultFor(objects);
    });
    jest.spyOn(ShopMedia, 'create').mockImplementation(async (doc) => doc);

    const { media } = await mediaService.uploadImage(shop, fileOf(await imageBuffer()));

    expect(captured.map((o) => o.key)).toEqual([
      `${shop._id}/${media._id}.webp`,
      `${shop._id}/${media._id}_m.webp`,
      `${shop._id}/${media._id}_t.webp`,
    ]);
    // The shop prefix is what makes per-shop cleanup one R2 call.
    captured.forEach((o) => expect(o.key.startsWith(`${shop._id}/`)).toBe(true));
  });

  it('lands as staged with no references — a save is what makes it active', async () => {
    const shop = shopFixture();
    jest.spyOn(ShopMedia, 'findOne').mockResolvedValue(null);
    jest.spyOn(storageService, 'uploadGroup').mockImplementation(async (o) => groupResultFor(o));
    jest.spyOn(ShopMedia, 'create').mockImplementation(async (doc) => doc);

    const { media } = await mediaService.uploadImage(shop, fileOf(await imageBuffer()));
    expect(media.status).toBe('staged');
    expect(media.refCount).toBe(0);
  });

  it('hands back the winner and unwinds its own bytes when two identical uploads race', async () => {
    const shop = shopFixture();
    const winner = { _id: id() };

    jest.spyOn(ShopMedia, 'findOne')
      .mockResolvedValueOnce(null)      // the dedupe read: both racers miss
      .mockResolvedValueOnce(winner);   // the re-read after the index rejects us

    const accountId = id();
    jest.spyOn(storageService, 'uploadGroup')
      .mockImplementation(async (o) => groupResultFor(o, accountId));
    jest.spyOn(ShopMedia, 'create').mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));

    jest.spyOn(storageService, 'getAccountWithSecret').mockResolvedValue({ _id: accountId });
    const del = jest.spyOn(storageService, 'deleteObjects').mockResolvedValue({ deleted: [], errors: [] });
    const uncommit = jest.spyOn(storageService, 'uncommit').mockResolvedValue();

    const result = await mediaService.uploadImage(shop, fileOf(await imageBuffer()));

    expect(result).toEqual({ media: winner, deduped: true });
    // The three objects we wrote and will not record are removed, and the bytes
    // go back to the account — otherwise every race permanently shrinks a bucket.
    expect(del.mock.calls[0][1]).toHaveLength(3);
    expect(uncommit).toHaveBeenCalled();

    // ...and the shop is not billed for a document that does not exist. The
    // charge is claimed before the write and refunded when it fails, so what has
    // to net to zero is the PAIR — checking that `updateOne` was never called
    // would only pin the old fire-and-forget shape.
    const [charge, refund] = Shop.updateOne.mock.calls;
    const bytesIn = charge[1][0].$set['storage.usedBytes'].$max[1].$add[1];
    const bytesOut = refund[1][0].$set['storage.usedBytes'].$max[1].$subtract[1];
    expect(bytesIn).toBe(bytesOut);
    expect(refund[0]).toEqual({ _id: shop._id });
  });
});

// ── The group upload contract ───────────────────────────────────────────────

describe('uploadGroup — one image, one account', () => {
  const KEY = 'a'.repeat(64);
  const account = (over = {}) => ({
    _id: id(), name: 'acc', bucket: 'b', publicBaseUrl: 'https://pub.r2.dev',
    capacityBytes: 10 * 1024 * MB, usedBytes: 0, reservedBytes: 0, priority: 0, ...over,
  });

  beforeEach(() => {
    process.env.STORAGE_ENC_KEY = KEY;
    jest.spyOn(storageService, 'commit').mockResolvedValue();
    jest.spyOn(storageService, 'release').mockResolvedValue();
    jest.spyOn(storageService, 'markError').mockResolvedValue();
  });

  afterEach(() => { delete process.env.STORAGE_ENC_KEY; });

  it('reserves the SUM once and puts every object in the same bucket', async () => {
    const acc = account();
    const reserve = jest.spyOn(storageService, 'reserve').mockResolvedValue(acc);
    const send = jest.fn().mockResolvedValue({});
    jest.spyOn(storageService, '_clientFor').mockReturnValue({ send });

    const result = await storageService.uploadGroup([
      { key: 'k.webp', body: Buffer.alloc(300), contentType: 'image/webp' },
      { key: 'k_m.webp', body: Buffer.alloc(120), contentType: 'image/webp' },
      { key: 'k_t.webp', body: Buffer.alloc(40), contentType: 'image/webp' },
    ]);

    expect(reserve).toHaveBeenCalledTimes(1);
    // First arg only: the second is the live `tried` array, which the caller
    // pushes onto after this call, so the recorded reference is not what it was.
    expect(reserve.mock.calls[0][0]).toBe(460);
    expect(send).toHaveBeenCalledTimes(3);
    send.mock.calls.forEach(([cmd]) => expect(cmd.input.Bucket).toBe('b'));
    expect(String(result.account)).toBe(String(acc._id));
    // Every op is charged: the free tier is metered in operations as well as
    // bytes, and one-per-group would under-report by 3x on the only write path.
    expect(storageService.commit).toHaveBeenCalledWith(acc._id, 460, { files: 3, classAOps: 3 });
  });

  it('moves the WHOLE set to the next account and deletes the partial write', async () => {
    const bad = account({ name: 'bad', bucket: 'b1', publicBaseUrl: 'https://pub1.r2.dev' });
    const good = account({ name: 'good', bucket: 'b2', publicBaseUrl: 'https://pub2.r2.dev' });

    jest.spyOn(storageService, 'reserve')
      .mockResolvedValueOnce(bad)
      .mockResolvedValueOnce(good);

    const send = jest.fn()
      .mockResolvedValueOnce({})                                  // first object lands on `bad`
      .mockRejectedValueOnce(new Error('connection reset'))       // second fails
      .mockResolvedValue({});                                     // then all of them on `good`
    jest.spyOn(storageService, '_clientFor').mockReturnValue({ send });
    const del = jest.spyOn(storageService, 'deleteObjects').mockResolvedValue({ deleted: [], errors: [] });

    const result = await storageService.uploadGroup([
      { key: 'k.webp', body: Buffer.alloc(10) },
      { key: 'k_m.webp', body: Buffer.alloc(10) },
      { key: 'k_t.webp', body: Buffer.alloc(10) },
    ]);

    // All three URLs come from the SAME account — a split set would make the
    // recorded account a lie and leave two objects unreclaimable.
    result.objects.forEach((o) => expect(o.url.startsWith('https://pub2.r2.dev/')).toBe(true));
    // The one object that did land on the abandoned account is cleaned up.
    expect(del).toHaveBeenCalledWith(bad, ['k.webp']);
    expect(storageService.release).toHaveBeenCalledWith(bad._id, 30);
  });
});

// ── Tenant boundary ─────────────────────────────────────────────────────────

describe('resolveOwned', () => {
  it('refuses a media id belonging to another shop', async () => {
    const mine = id();
    const theirs = id();
    // The query is shop-scoped, so the foreign id simply does not come back.
    jest.spyOn(ShopMedia, 'find').mockResolvedValue([{ _id: mine }]);

    await expect(mediaService.resolveOwned(id(), [mine, theirs]))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('always scopes the lookup to the shop', async () => {
    const shopId = id();
    const find = jest.spyOn(ShopMedia, 'find').mockResolvedValue([]);
    await mediaService.resolveOwned(shopId, [id()]).catch(() => {});
    expect(find.mock.calls[0][0]).toMatchObject({ shop: shopId });
  });

  it('still resolves a broken record, so a missing file cannot make a product unsaveable', async () => {
    const mediaId = id();
    const find = jest.spyOn(ShopMedia, 'find').mockResolvedValue([{ _id: mediaId, status: 'broken' }]);

    const map = await mediaService.resolveOwned(id(), [mediaId]);
    expect(map.get(String(mediaId))).toBeTruthy();
    expect(find.mock.calls[0][0].status).toBeUndefined();
  });

  it('does not query at all for an empty list', async () => {
    const find = jest.spyOn(ShopMedia, 'find');
    expect((await mediaService.resolveOwned(id(), [])).size).toBe(0);
    expect((await mediaService.resolveOwned(id(), [null, undefined, ''])).size).toBe(0);
    expect(find).not.toHaveBeenCalled();
  });
});

// ── Reference counting ──────────────────────────────────────────────────────

describe('reconcileRefs', () => {
  const capture = () => {
    const calls = [];
    jest.spyOn(ShopMedia, 'updateMany').mockImplementation(async (filter, update) => {
      calls.push({ filter, update });
      return { modifiedCount: 1 };
    });
    return calls;
  };

  it('does nothing at all when the reference set is unchanged', async () => {
    const a = id();
    const update = jest.spyOn(ShopMedia, 'updateMany');

    const result = await mediaService.reconcileRefs(id(), [a], [a]);

    expect(result).toEqual({ attached: [], detached: [] });
    expect(update).not.toHaveBeenCalled();
  });

  it('bumps the new ones and graduates them out of staged', async () => {
    const calls = capture();
    const media = id();

    await mediaService.reconcileRefs(id(), [], [media]);

    expect(calls[0].update.$inc).toEqual({ refCount: 1 });
    expect(calls[0].update.$set.orphanedAt).toBeNull();
    // Only `staged` graduates — `broken` must stay broken, because re-pointing a
    // product at a missing object does not put the bytes back.
    expect(calls[1].filter.status).toBe('staged');
    expect(calls[1].update).toEqual({ $set: { status: 'active' } });
  });

  it('decrements the dropped ones and starts the orphan clock at zero', async () => {
    const calls = capture();
    const media = id();

    await mediaService.reconcileRefs(id(), [media], []);

    expect(calls[0].update.$inc).toEqual({ refCount: -1 });
    // Guarded, so a count that is already wrong cannot be driven negative.
    expect(calls[0].filter.refCount).toEqual({ $gt: 0 });

    expect(calls[1].filter.refCount).toBe(0);
    // Scoped to a null clock, so an image orphaned last week does not have its
    // grace period reset by an unrelated save.
    expect(calls[1].filter.orphanedAt).toBeNull();
    expect(calls[1].update.$set.orphanedAt).toBeInstanceOf(Date);
  });

  it('counts one product using the same photo twice as ONE reference', async () => {
    const calls = capture();
    const media = id();

    const result = await mediaService.reconcileRefs(id(), [], [media, media, String(media)]);

    expect(result.attached).toEqual([String(media)]);
    expect(calls[0].filter._id.$in).toEqual([String(media)]);
  });

  it('scopes every write to the shop', async () => {
    const calls = capture();
    const shopId = id();
    await mediaService.reconcileRefs(shopId, [id()], [id()]);
    calls.forEach((c) => expect(String(c.filter.shop)).toBe(String(shopId)));
  });

  it('swallows a database failure — a broken counter must not fail a product save', async () => {
    jest.spyOn(ShopMedia, 'updateMany').mockRejectedValue(new Error('mongo is down'));
    await expect(mediaService.reconcileRefs(id(), [], [id()])).resolves.toBeTruthy();
  });
});

describe('collecting a product\'s references', () => {
  it('finds them on catalogue rows and on variants alike, ignoring external URLs', () => {
    const a = id();
    const b = id();

    const ids = mediaService.mediaIdsOfProduct({
      catalogImages: [
        { mediaId: a, url: 'https://pub.r2.dev/x.webp' },
        { mediaId: null, url: 'https://i.ibb.co/legacy.jpg' },   // ImgBB: not ours
      ],
      variants: [
        { imageMediaId: b },
        { imageMediaId: null },
        { image: 'https://i.ibb.co/legacy2.jpg' },
      ],
    }).map(String);

    expect(ids.sort()).toEqual([String(a), String(b)].sort());
  });

  it('is empty for a product with no photos', () => {
    expect(mediaService.mediaIdsOfProduct({ catalogImages: [], variants: [] })).toEqual([]);
    expect(mediaService.mediaIdsOfProduct(null)).toEqual([]);
  });
});

// ── The capability switch ───────────────────────────────────────────────────

describe('productImages off', () => {
  const reqWith = (productImages) => ({ shop: { features: { productImages } } });

  it('drops the payload\'s image keys instead of applying them', async () => {
    const resolve = jest.spyOn(mediaService, 'resolveOwned');
    const data = {
      name: 'x',
      catalogImages: [{ mediaId: id(), url: 'https://pub.r2.dev/a.webp' }],
      variants: [{ sku: 'v1', imageMediaId: id() }],
    };

    await productService._applyImageRefs(id(), data, reqWith(false));

    // Absent, NOT emptied: `Object.assign` then leaves the stored array alone,
    // so an admin turning the flag off does not erase the shop's photos.
    expect('catalogImages' in data).toBe(false);
    expect('imageMediaId' in data.variants[0]).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('takes the URLs from our own records, never from the client', async () => {
    const mediaId = id();
    jest.spyOn(mediaService, 'resolveOwned').mockResolvedValue(new Map([[
      String(mediaId),
      { _id: mediaId, url: 'https://pub.r2.dev/real.webp', mediumUrl: 'https://pub.r2.dev/real_m.webp', thumbUrl: 'https://pub.r2.dev/real_t.webp' },
    ]]));

    const data = {
      catalogImages: [{ mediaId, url: 'https://evil.example/attacker.png', thumbnail: 'https://evil.example/t.png' }],
    };
    await productService._applyImageRefs(id(), data, reqWith(true));

    expect(data.catalogImages[0].url).toBe('https://pub.r2.dev/real_m.webp');
    expect(data.catalogImages[0].thumbnail).toBe('https://pub.r2.dev/real_t.webp');
  });

  it('lets a legacy ImgBB row through untouched and invents no mediaId for it', async () => {
    jest.spyOn(mediaService, 'resolveOwned').mockResolvedValue(new Map());

    const data = { catalogImages: [{ url: 'https://i.ibb.co/legacy.jpg', thumbnail: 'https://i.ibb.co/t.jpg' }] };
    await productService._applyImageRefs(id(), data, reqWith(true));

    expect(data.catalogImages[0]).toMatchObject({
      mediaId: null,
      url: 'https://i.ibb.co/legacy.jpg',
    });
  });

  it('caps our own photos per product but exempts legacy rows', async () => {
    const ids = Array.from({ length: 6 }, () => id());
    jest.spyOn(mediaService, 'resolveOwned').mockResolvedValue(
      new Map(ids.map((m) => [String(m), { _id: m, url: 'u', mediumUrl: 'm', thumbUrl: 't' }]))
    );

    await expect(productService._applyImageRefs(id(), {
      catalogImages: ids.map((mediaId) => ({ mediaId })),
    }, reqWith(true))).rejects.toMatchObject({ statusCode: 400 });

    // Seven ImgBB rows on an old product must still save — refusing would make
    // an old photo the reason a price cannot be corrected.
    jest.spyOn(mediaService, 'resolveOwned').mockResolvedValue(new Map());
    const legacy = { catalogImages: Array.from({ length: 7 }, (_, i) => ({ url: `https://i.ibb.co/${i}.jpg` })) };
    await expect(productService._applyImageRefs(id(), legacy, reqWith(true))).resolves.toBeUndefined();
    expect(legacy.catalogImages).toHaveLength(7);
  });

  it('leaves exactly one primary, whatever the client sent', async () => {
    jest.spyOn(mediaService, 'resolveOwned').mockResolvedValue(new Map());

    const none = { catalogImages: [{ url: 'a' }, { url: 'b' }] };
    await productService._applyImageRefs(id(), none, reqWith(true));
    expect(none.catalogImages.filter((r) => r.isPrimary)).toHaveLength(1);
    expect(none.catalogImages[0].isPrimary).toBe(true);

    const many = { catalogImages: [{ url: 'a' }, { url: 'b', isPrimary: true }, { url: 'c', isPrimary: true }] };
    await productService._applyImageRefs(id(), many, reqWith(true));
    expect(many.catalogImages.filter((r) => r.isPrimary)).toHaveLength(1);
    expect(many.catalogImages[1].isPrimary).toBe(true);
  });
});

// ── Variant plumbing ────────────────────────────────────────────────────────

describe('variant image fields', () => {
  it('stores imageMediaId as a real column, not as a printed attribute', () => {
    const mediaId = id();
    const [variant] = productService._formatVariants([
      { sku: 'v1', buyingPrice: 1, sellingPrice: 2, image: 'https://pub.r2.dev/a.webp', imageMediaId: mediaId },
    ]);

    expect(String(variant.imageMediaId)).toBe(String(mediaId));
    // The trap this file's own comments warn about: an unlisted key is swept
    // into `attributes.custom` and rendered on the invoice beside size and colour.
    expect(variant.attributes.custom).toBeUndefined();
  });

  it('is null for a variant with no photo of ours', () => {
    const [variant] = productService._formatVariants([
      { sku: 'v1', buyingPrice: 1, sellingPrice: 2, image: 'https://i.ibb.co/legacy.jpg' },
    ]);
    expect(variant.imageMediaId).toBeNull();
  });
});

// ── The maintenance job ─────────────────────────────────────────────────────

describe('storage maintenance job', () => {
  const { runMaintenanceCycle } = require('../jobs/storageMaintenance.job');

  const NOTHING = { scanned: 0, deleted: 0, skipped: 0, failed: 0, bytes: 0 };

  // The platform media library is a second tenant of the same pool with its own
  // two sweeps (MEDIA_GALLERY_PLAN.md §7). Its results ride on the same object.
  const PLATFORM_NOTHING = { ...NOTHING, protected: 0 };

  /** The six routines the cycle drives, each independently overridable. */
  const stub = ({
    released = 0,
    rolled = 0,
    staged = NOTHING,
    orphaned = NOTHING,
    platformStaged = PLATFORM_NOTHING,
    platformOrphaned = PLATFORM_NOTHING,
  } = {}) => {
    const settle = (v) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
    jest.spyOn(storageService, 'releaseStaleReservations').mockImplementation(() => settle(released));
    jest.spyOn(storageService, 'rollMonthlyOps').mockImplementation(() => settle(rolled));
    jest.spyOn(mediaService, 'sweepStagedMedia').mockImplementation(() => settle(staged));
    jest.spyOn(mediaService, 'sweepOrphanedMedia').mockImplementation(() => settle(orphaned));
    jest.spyOn(platformMediaService, 'sweepStaged').mockImplementation(() => settle(platformStaged));
    jest.spyOn(platformMediaService, 'sweepOrphaned').mockImplementation(() => settle(platformOrphaned));
  };

  it('runs every repair and reports what it fixed', async () => {
    const staged = { ...NOTHING, scanned: 4, deleted: 4, bytes: 900 };
    const orphaned = { ...NOTHING, scanned: 1, deleted: 1, bytes: 100 };
    const platformStaged = { ...PLATFORM_NOTHING, scanned: 2, deleted: 2, bytes: 300 };
    stub({ released: 2, rolled: 5, staged, orphaned, platformStaged });

    expect(await runMaintenanceCycle()).toEqual({
      released: 2,
      rolled: 5,
      staged,
      orphaned,
      platformStaged,
      platformOrphaned: PLATFORM_NOTHING,
    });
  });

  it('a failing platform sweep does not cost the shop sweeps their pass', async () => {
    // The two tenants share a bucket and nothing else. Wiring them into one
    // try block would let a bug in the admin library stop every shop's
    // reclamation — which is the half that keeps shops under their quota.
    const staged = { ...NOTHING, scanned: 3, deleted: 3, bytes: 700 };
    stub({ staged, platformStaged: new Error('library sweep exploded') });

    const result = await runMaintenanceCycle();
    expect(result.staged).toEqual(staged);
    expect(result.platformStaged).toBeNull();
    expect(result.platformOrphaned).toEqual(PLATFORM_NOTHING);
  });

  it('and a failing shop sweep does not cost the platform one', async () => {
    const platformOrphaned = { ...PLATFORM_NOTHING, scanned: 1, deleted: 1, bytes: 50 };
    stub({ staged: new Error('R2 unreachable'), platformOrphaned });

    const result = await runMaintenanceCycle();
    expect(result.staged).toBeNull();
    expect(result.platformOrphaned).toEqual(platformOrphaned);
  });

  it('still sweeps reservations when the month roll fails, and never throws', async () => {
    // The reservation sweep is the half that unblocks uploads; it must not be
    // skipped because an unrelated counter reset hit a write conflict.
    stub({ released: 3, rolled: new Error('write conflict') });

    expect(await runMaintenanceCycle()).toMatchObject({ released: 3, rolled: 0 });
  });

  it('survives the sweep itself failing — a timer callback that throws kills the process', async () => {
    stub({ released: new Error('mongo down') });

    await expect(runMaintenanceCycle()).resolves.toMatchObject({ released: 0, rolled: 0 });
  });

  it('reclaims orphans even when the staged sweep blows up', async () => {
    // The two sweeps free different classes of waste. One failing must not cost
    // the other its pass, or a single bad account stops all reclamation.
    const orphaned = { ...NOTHING, scanned: 2, deleted: 2, bytes: 4096 };
    stub({ staged: new Error('R2 unreachable'), orphaned });

    const result = await runMaintenanceCycle();
    expect(result.staged).toBeNull();
    expect(result.orphaned).toEqual(orphaned);
  });

  it('only zeroes reservations older than the TTL, so a live upload is untouched', async () => {
    const updateMany = jest.spyOn(R2Account, 'updateMany').mockResolvedValue({ modifiedCount: 0 });
    await storageService.releaseStaleReservations();

    const [filter, update] = updateMany.mock.calls[0];
    expect(filter.reservedBytes).toEqual({ $gt: 0 });
    expect(filter.lastUsedAt.$lt).toBeInstanceOf(Date);
    expect(update).toEqual({ $set: { reservedBytes: 0 } });
  });
});
