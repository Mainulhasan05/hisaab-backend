/**
 * The image pipeline: bytes in, a `ShopMedia` document out.
 *
 * Sits between the HTTP layer and `storage.service`. Everything about IMAGES
 * lives here — resizing, the three renditions, dedupe, the per-shop quota, and
 * the reference counting that eventually lets an unused photo be deleted.
 * `storage.service` below it knows only about buckets and bytes; the product
 * and category services above it know only about media ids.
 *
 * ── THE ONE RULE THAT MAKES THE OLD AND NEW WORLDS COEXIST ───────────────────
 * `POST /products/:id/images` still uploads to ImgBB and still writes rows into
 * `catalogImages[]`. Those rows have NO `mediaId`. This pipeline writes rows
 * that DO. So:
 *
 *     mediaId != null  →  our bytes. Quota, refCount, reclamation, URL rewrite.
 *     mediaId == null  →  somebody else's URL. Do not touch, do not count.
 *
 * Nothing here may ever invent a `mediaId` for a row that did not come from the
 * R2 pool, and nothing may reclaim bytes for a row that has none.
 *
 * ── WHY THREE RENDITIONS AND NOT ONE ─────────────────────────────────────────
 * The product grid draws dozens of images on a phone that is often on 3G.
 * Serving the full-size photo there costs roughly 20x the bytes of a thumbnail
 * for pixels nobody can see. The client already compresses before uploading
 * (P2), so the "original" arriving here is already ~200KB; the renditions are
 * about render cost and bandwidth, not about storage.
 *
 * All three go to ONE account via `storage.uploadGroup` — see the comment there
 * for what splitting them would break.
 *
 * ── WHAT COUNTS AGAINST THE QUOTA, AND WHEN ──────────────────────────────────
 * `totalBytes` (all three renditions) is charged at UPLOAD time, not at attach
 * time, because the bytes are in the bucket the moment they are written whether
 * or not a product ever points at them. A staged image the user abandons is
 * real storage until the 48h sweep reclaims it. Charging at attach time would
 * let a shop fill a bucket with unattached uploads and never exceed its quota.
 *
 * ── WHY THE CHARGE IS A COMPARE-AND-SWAP, NOT A READ THEN A WRITE ────────────
 * `req.shop` is rehydrated from the `auth:user:{id}` Redis entry, TTL 300s. So
 * the `shop` handed to `uploadImage` carries a `storage.usedBytes` that can be
 * five minutes old, and NOTHING invalidates that cache on upload — an upload is
 * not an admin action. Gating on it alone means every upload inside one cache
 * window is measured against the same stale figure, and a 100MB shop can write
 * several hundred MB before the number it is being judged against catches up.
 *
 * So the quota is enforced the same way bucket capacity is in `storage.service`:
 * a conditional `updateOne` whose filter re-checks the allowance against the
 * LIVE document, inside the same round trip that increments it. Losing the race
 * matches nothing and is a 413. `assertCanStore` stays as the cheap pre-flight
 * because it produces the three distinct errors the frontend branches on; this
 * is the authority.
 *
 * The charge happens BEFORE the objects are written and is refunded if the write
 * fails, so the counter never claims fewer bytes than the bucket actually holds.
 * The opposite ordering — write, then charge — leaves bytes in R2 with no way to
 * bill them if the process dies in between.
 */

const nodeCrypto = require('crypto');
const mongoose = require('mongoose');

const ShopMedia = require('../models/ShopMedia.model');
const Shop = require('../models/Shop.model');
const storageService = require('./storage.service');
const { AppError } = require('../middleware/error.middleware');
const {
  MB,
  assertCanStore,
  platformStorageSettings,
  effectiveQuotaMb,
} = require('../utils/storageQuota.util');
const logger = require('../utils/logger.util');

// Loaded defensively like `imageUpload.service` does, but treated very
// differently: the ImgBB path can fall back to shipping the raw buffer, while
// this one must not. Without sharp we cannot resize, cannot make renditions,
// and would be storing a 4MB camera JPEG under a name that claims to be a
// 200KB WebP. Missing sharp is a 503, not a degraded mode.
let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  logger.warn('sharp is not available — R2 image uploads will be refused with 503');
}

/**
 * The renditions, widest first.
 *
 * `original` is a cap rather than a size: a client-compressed 1200px photo is
 * stored at 1200px, not upscaled. 1600 is the point past which a product photo
 * stops looking better on any phone screen and starts only costing money.
 *
 * Quality drops with size on purpose — WebP artefacts that are visible at full
 * size are invisible at 200px, and the thumbnail is the rendition that gets
 * fetched dozens of times per screen.
 */
const RENDITIONS = Object.freeze([
  { name: 'original', maxDim: 1600, quality: 80, suffix: '' },
  { name: 'medium', maxDim: 600, quality: 75, suffix: '_m' },
  { name: 'thumb', maxDim: 200, quality: 70, suffix: '_t' },
]);

// A guard against a decompression bomb — a 100MB PNG that is 200x200 of solid
// colour, or a crafted image whose declared dimensions would allocate gigabytes
// in sharp's pixel buffer. Multer's 20MB file cap does not protect against this
// because the danger is in the DECODED size.
const MAX_PIXELS = 50_000_000; // 50MP

const CONTENT_TYPE = 'image/webp';

// How long an upload nobody attached is kept. Long enough to cover "I'll finish
// this product tomorrow morning", short enough that an abandoned form is not
// charged to the shop for a week.
const STAGED_TTL_MS = 48 * 60 * 60 * 1000;

// Rows per sweep pass. Each one is a claim round trip plus its share of a
// batched R2 delete, so this bounds how long a single pass holds the job's
// timer — the sweep runs again in an hour and picks up whatever is left.
const RECLAIM_BATCH = 200;

class MediaService {
  /** Whether an upload can even be attempted right now. */
  async isReady() {
    if (!sharp) return false;
    return storageService.isConfigured();
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  /**
   * Turn an uploaded file into a stored, staged `ShopMedia`.
   *
   * Ordering matters and is not arbitrary:
   *   1. decode + resize     — cheap to fail, and tells us the real byte cost
   *   2. hash + dedupe       — a hit stores nothing, so it must come BEFORE the
   *                            byte-count gate; otherwise a shop sitting just
   *                            under its quota could not re-use a photo it
   *                            already owns and already paid for
   *   3. quota gate          — now that the true `totalBytes` is known
   *   4. upload + persist
   *
   * @param {Object} shop      the shop document (needs `storage`)
   * @param {Object} file      multer memory-storage file
   * @param {Object} [options] { userId }
   * @returns {Promise<{media: Object, deduped: boolean}>}
   */
  async uploadImage(shop, file, { userId = null } = {}) {
    if (!sharp) {
      throw new AppError(
        'Image processing is unavailable on this server (sharp failed to load)',
        'সার্ভারে ছবি প্রসেসিং সুবিধা নেই — অ্যাডমিনের সাথে যোগাযোগ করুন',
        503
      );
    }

    const shopId = shop?._id;
    if (!shopId) {
      throw new AppError('Shop context is missing', 'দোকান পাওয়া যায়নি', 400);
    }

    const buffer = file?.buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new AppError('Please select an image file', 'একটি ছবি নির্বাচন করুন', 400);
    }

    // A zero-byte pre-flight. It catches the two states that no amount of
    // processing can rescue — storage switched off, or already past the quota —
    // so a disabled shop gets its 403 without us decoding a 4MB JPEG first. The
    // real check runs below, once the true byte cost is known.
    const settings = await platformStorageSettings();
    await assertCanStore(shop, 0, settings);

    const renditions = await this._renderAll(buffer);
    const original = renditions.find((r) => r.name === 'original');
    const totalBytes = renditions.reduce((sum, r) => sum + r.buffer.length, 0);

    // Hashed over the bytes we STORE, not the bytes we received — see the note
    // on `ShopMedia.hash`. Two phones compressing the same photo will not match
    // and are not meant to.
    const hash = nodeCrypto.createHash('sha256').update(original.buffer).digest('hex');

    const existing = await ShopMedia.findOne({ shop: shopId, hash });
    if (existing) {
      // Zero bytes, zero R2 operations, no quota movement. The picker re-
      // selecting the same file is the common case this exists for.
      return { media: existing, deduped: true };
    }

    await assertCanStore(shop, totalBytes, settings);

    // The real gate. `quotaMb` may be read from the cached shop safely — it only
    // ever changes through an admin action, and those invalidate the auth cache.
    // `usedBytes` may not, so it is compared inside the update instead.
    const quotaBytes = effectiveQuotaMb(shop, settings.defaultQuotaMb) * MB;
    const charged = await this._chargeShopUsage(shopId, totalBytes, 1, quotaBytes);
    if (!charged) {
      await this._throwLiveStorageError(shopId, totalBytes, settings);
    }

    // Generated up front because the object keys embed it — the alternative is
    // uploading to a temporary key and renaming, which S3 has no cheap way to
    // do (a rename is a copy plus a delete, and doubles the write cost).
    const mediaId = new mongoose.Types.ObjectId();

    const objects = renditions.map((r) => ({
      key: `${shopId}/${mediaId}${r.suffix}.webp`,
      body: r.buffer,
      contentType: CONTENT_TYPE,
      metadata: { shop: String(shopId), rendition: r.name },
    }));

    let group;
    try {
      group = await storageService.uploadGroup(objects);
    } catch (err) {
      // Nothing was stored, so the shop must not be billed for it. Every exit
      // from here on has to reach a refund or the counter drifts upward on
      // failures alone — the drift `recalculateShopStorage` exists to repair,
      // and which nobody notices until a shop is refused at 60MB of real use.
      await this._refundShopUsage(shopId, totalBytes, 1);
      throw err;
    }

    const urlFor = (suffix) =>
      group.objects.find((o) => o.key === `${shopId}/${mediaId}${suffix}.webp`)?.url || '';

    let media;
    try {
      media = await ShopMedia.create({
        _id: mediaId,
        shop: shopId,
        hash,
        account: group.account,
        objectKey: `${shopId}/${mediaId}.webp`,
        mediumKey: `${shopId}/${mediaId}_m.webp`,
        thumbKey: `${shopId}/${mediaId}_t.webp`,
        url: urlFor(''),
        mediumUrl: urlFor('_m'),
        thumbUrl: urlFor('_t'),
        bytes: original.buffer.length,
        totalBytes,
        width: original.width,
        height: original.height,
        mime: CONTENT_TYPE,
        originalName: typeof file.originalname === 'string'
          ? file.originalname.slice(0, 200)
          : null,
        status: 'staged',
        refCount: 0,
        uploadedBy: userId,
      });
    } catch (err) {
      // Whatever went wrong, the bytes are already in the bucket with no
      // document pointing at them. Unwind first, decide what to report after.
      await this._discardObjects(group, objects.map((o) => o.key));
      await this._refundShopUsage(shopId, totalBytes, 1);

      // Two identical uploads raced past the dedupe read and both wrote; the
      // unique {shop, hash} index caught the loser. From the user's side this
      // is simply a dedupe hit that took slightly longer. The refund above is
      // what keeps the shop from being charged twice for one stored image.
      if (err?.code === 11000) {
        const winner = await ShopMedia.findOne({ shop: shopId, hash });
        if (winner) return { media: winner, deduped: true };
      }

      throw err;
    }

    return { media, deduped: false };
  }

  /**
   * Decode once, resize three times.
   *
   * `.rotate()` with no argument applies the EXIF orientation tag and then
   * drops it — which is both the "EXIF strip" half of the plan and the fix for
   * photos that appear sideways only on some devices. sharp writes no metadata
   * unless asked, so GPS coordinates in a shopkeeper's photo do not reach a
   * public bucket.
   */
  async _renderAll(buffer) {
    let meta;
    try {
      meta = await sharp(buffer).metadata();
    } catch (err) {
      throw new AppError(
        `Unreadable image: ${err.message}`,
        'ছবিটি পড়া যায়নি — অন্য একটি ছবি চেষ্টা করুন',
        400
      );
    }

    if (!meta?.width || !meta?.height) {
      throw new AppError(
        'Unreadable image: no dimensions',
        'ছবিটি পড়া যায়নি — অন্য একটি ছবি চেষ্টা করুন',
        400
      );
    }

    if (meta.width * meta.height > MAX_PIXELS) {
      throw new AppError(
        `Image is ${meta.width}x${meta.height}, over the ${MAX_PIXELS / 1_000_000}MP limit`,
        'ছবিটি অনেক বড় — ছোট করে আবার চেষ্টা করুন',
        400
      );
    }

    const out = [];
    for (const spec of RENDITIONS) {
      try {
        const { data, info } = await sharp(buffer)
          .rotate()
          .resize({
            width: spec.maxDim,
            height: spec.maxDim,
            fit: 'inside',
            // A 200px photo must not be blown up to 1600px: it would look worse
            // AND cost more bytes than the file we were given.
            withoutEnlargement: true,
          })
          .webp({ quality: spec.quality })
          .toBuffer({ resolveWithObject: true });

        out.push({
          name: spec.name,
          suffix: spec.suffix,
          buffer: data,
          width: info.width,
          height: info.height,
        });
      } catch (err) {
        throw new AppError(
          `Could not process image (${spec.name}): ${err.message}`,
          'ছবিটি প্রসেস করা যায়নি — অন্য একটি ছবি চেষ্টা করুন',
          400
        );
      }
    }

    return out;
  }

  /**
   * Remove objects we wrote but will not record, and give the bytes back.
   *
   * Never throws: every caller is already on an error path and is about to
   * report something more useful than "cleanup failed".
   */
  async _discardObjects(group, keys) {
    try {
      const account = await storageService.getAccountWithSecret(group.account);
      await storageService.deleteObjects(account, keys);
      await storageService.uncommit(group.account, group.bytes, { files: keys.length });
    } catch (err) {
      logger.warn(
        `Could not unwind ${keys.length} orphaned object(s) on account ${group.account}: ${err.message}. ` +
        'Reconciliation will collect them.'
      );
    }
  }

  /**
   * Claim `bytes` of the shop's allowance, or refuse.
   *
   * The filter is the enforcement: it re-reads `storage.enabled` and compares
   * the LIVE `usedBytes` against the allowance in the same round trip that
   * increments it, so two uploads racing at 99MB of a 100MB quota cannot both
   * win. Exactly the shape `storage.service.reserve` uses for bucket capacity —
   * the shop layer had the same race and no equivalent guard.
   *
   * An aggregation-pipeline update so `peakUsedBytes` can be raised against the
   * value being written in the same atomic step. The read-modify-write version
   * loses the high-water mark whenever two uploads land together, which is
   * exactly when usage is interesting.
   *
   * @param {ObjectId|string} shopId
   * @param {number} bytes       total bytes across every rendition
   * @param {number} files
   * @param {number} quotaBytes  the effective allowance, already resolved
   * @returns {Promise<boolean>} false when the shop may not store these bytes
   */
  async _chargeShopUsage(shopId, bytes, files, quotaBytes) {
    const res = await Shop.updateOne(
      {
        _id: shopId,
        // Re-checked here, not just in the pre-flight: an admin disabling
        // storage while an upload is in flight must stop it.
        'storage.enabled': true,
        $expr: {
          $lte: [
            { $add: [{ $ifNull: ['$storage.usedBytes', 0] }, bytes] },
            quotaBytes,
          ],
        },
      },
      [
        {
          $set: {
            'storage.usedBytes': {
              $max: [0, { $add: [{ $ifNull: ['$storage.usedBytes', 0] }, bytes] }],
            },
            'storage.fileCount': {
              $max: [0, { $add: [{ $ifNull: ['$storage.fileCount', 0] }, files] }],
            },
            'storage.lastUploadAt': '$$NOW',
          },
        },
        {
          $set: {
            'storage.peakUsedBytes': {
              $max: [{ $ifNull: ['$storage.peakUsedBytes', 0] }, '$storage.usedBytes'],
            },
          },
        },
      ]
    );

    return res.matchedCount > 0;
  }

  /**
   * Give back bytes that never made it into a bucket.
   *
   * Never throws: every caller is already unwinding a failed upload and is about
   * to report something more useful. A refund that fails leaves the shop
   * over-counted, which is the safe direction — it refuses uploads it could have
   * allowed, and `recalculateShopStorage` repairs it.
   *
   * `fileCount` is floored at zero rather than decremented blindly, so a double
   * refund cannot drive the counter negative and start over-reporting free space.
   */
  async _refundShopUsage(shopId, bytes, files) {
    try {
      await Shop.updateOne({ _id: shopId }, [
        {
          $set: {
            'storage.usedBytes': {
              $max: [0, { $subtract: [{ $ifNull: ['$storage.usedBytes', 0] }, bytes] }],
            },
            'storage.fileCount': {
              $max: [0, { $subtract: [{ $ifNull: ['$storage.fileCount', 0] }, files] }],
            },
          },
        },
      ]);
    } catch (err) {
      logger.warn(
        `Could not refund ${bytes}B of storage usage to shop ${shopId}: ${err.message}. ` +
        'Recalculate will repair it.'
      );
    }
  }

  /**
   * Turn a lost quota race into the error the user should actually see.
   *
   * The CAS filter has three ways to match nothing — storage switched off
   * mid-flight, the allowance genuinely exhausted, or the shop deleted — and the
   * frontend branches on `STORAGE_DISABLED` vs `STORAGE_QUOTA_EXCEEDED` because
   * the two send the shopkeeper to completely different places. So re-read the
   * live document and let `assertCanStore` pick, rather than guessing 413.
   *
   * Only ever called on the failure path, so the extra read costs nothing that
   * matters.
   */
  async _throwLiveStorageError(shopId, bytes, settings) {
    const fresh = await Shop.findById(shopId).select('storage').lean();
    if (fresh) {
      // Throws 403 or 413 with the right code and the real numbers in the
      // message. `assertCanStore` is the same function the pre-flight used.
      await assertCanStore(fresh, bytes, settings);
    }

    // Reached only if the state changed back underneath us between the failed
    // update and this read. Refusing is still correct — we hold no reservation.
    const error = new AppError(
      'Could not reserve storage for this image, please try again',
      'ছবির জন্য জায়গা বরাদ্দ করা যায়নি, আবার চেষ্টা করুন',
      413
    );
    error.code = 'STORAGE_QUOTA_EXCEEDED';
    throw error;
  }

  // ── Ownership ─────────────────────────────────────────────────────────────

  /**
   * Resolve caller-supplied media ids to documents this shop actually owns.
   *
   * THE tenant boundary for images. A product payload is client-controlled, so
   * without this a shop could reference another shop's `mediaId`, and would then
   * hold a reference that shop's reclamation job cannot see — one shop's cleanup
   * silently blanking another's catalogue.
   *
   * Unknown or foreign ids are a 400, never a silent drop: quietly ignoring them
   * would save a product whose photo the user can see in the form and cannot see
   * afterwards, with no error to explain it.
   *
   * @param {ObjectId|string} shopId
   * @param {Array<ObjectId|string>} ids
   * @returns {Promise<Map<string, Object>>} keyed by id string
   */
  async resolveOwned(shopId, ids) {
    const wanted = uniqueIds(ids);
    if (wanted.length === 0) return new Map();

    // `broken` records are deliberately still resolvable. A product already
    // pointing at an image reconciliation could not find in R2 must remain
    // saveable — refusing here would mean a missing file makes the product
    // uneditable, which turns a cosmetic problem into a blocking one.
    const docs = await ShopMedia.find({
      _id: { $in: wanted },
      shop: shopId,
    });

    const map = new Map(docs.map((d) => [String(d._id), d]));

    const missing = wanted.filter((id) => !map.has(String(id)));
    if (missing.length > 0) {
      throw new AppError(
        `Unknown or inaccessible media: ${missing.join(', ')}`,
        'নির্বাচিত ছবিটি পাওয়া যায়নি — আবার আপলোড করুন',
        400
      );
    }

    return map;
  }

  // ── Reference counting ────────────────────────────────────────────────────

  /**
   * Apply the difference between what an entity pointed at and what it now
   * points at.
   *
   * Called from `product.service` and `category.service` on every save. Doing it
   * at save time rather than through a client-driven attach/detach API is what
   * keeps `refCount` honest: a form the user abandons, a request that fails
   * halfway, a tab closed mid-edit — none of them can leave a count behind,
   * because the count only ever moves when the document moves.
   *
   * Ids are de-duplicated per call on purpose. One product using the same photo
   * in two catalogue slots is ONE reference: `refCount` answers "may this be
   * deleted", and 1-vs-2 there changes nothing except the ways it can drift.
   *
   * Never throws. A refCount that failed to move is a reclamation problem the
   * weekly reconciliation fixes; a product save that 500s because of it is a
   * shopkeeper who cannot save their product.
   *
   * @param {ObjectId|string} shopId
   * @param {Array} previousIds  media ids the entity referenced before
   * @param {Array} nextIds      media ids it references now
   * @returns {Promise<{attached: string[], detached: string[]}>}
   */
  async reconcileRefs(shopId, previousIds, nextIds) {
    const before = uniqueIds(previousIds).map(String);
    const after = uniqueIds(nextIds).map(String);

    const attached = after.filter((id) => !before.includes(id));
    const detached = before.filter((id) => !after.includes(id));

    if (attached.length === 0 && detached.length === 0) {
      return { attached: [], detached: [] };
    }

    const now = new Date();

    try {
      if (attached.length > 0) {
        await ShopMedia.updateMany(
          { _id: { $in: attached }, shop: shopId },
          { $inc: { refCount: 1 }, $set: { orphanedAt: null, lastAttachedAt: now } }
        );
        // Only `staged` graduates. A `broken` record — one reconciliation found
        // missing from R2 — must stay broken; re-pointing a product at it does
        // not put the bytes back in the bucket.
        await ShopMedia.updateMany(
          { _id: { $in: attached }, shop: shopId, status: 'staged' },
          { $set: { status: 'active' } }
        );
      }

      if (detached.length > 0) {
        // `refCount > 0` in the filter, not `$max` afterwards: the schema floors
        // it at 0 anyway, and a decrement that would go negative means the count
        // was already wrong — better to leave it at zero than to drive it below.
        await ShopMedia.updateMany(
          { _id: { $in: detached }, shop: shopId, refCount: { $gt: 0 } },
          { $inc: { refCount: -1 } }
        );
        // Start the grace clock on whatever just reached zero. Scoped to
        // `orphanedAt: null` so an image orphaned last week does not have its
        // clock reset by an unrelated save.
        await ShopMedia.updateMany(
          { _id: { $in: detached }, shop: shopId, refCount: 0, orphanedAt: null },
          { $set: { orphanedAt: now } }
        );
      }
    } catch (err) {
      logger.error(
        `refCount reconcile failed for shop ${shopId} ` +
        `(+${attached.length}/-${detached.length}): ${err.message}`
      );
    }

    return { attached, detached };
  }

  /** Every media id a product references, across catalogue photos and variants. */
  mediaIdsOfProduct(product) {
    if (!product) return [];
    const fromCatalog = (product.catalogImages || []).map((img) => img?.mediaId);
    const fromVariants = (product.variants || []).map((v) => v?.imageMediaId);
    return uniqueIds([...fromCatalog, ...fromVariants]);
  }

  /** Every media id a category references. One, or none. */
  mediaIdsOfCategory(category) {
    if (!category) return [];
    return uniqueIds([category.imageMediaId]);
  }

  // ── Reclamation ───────────────────────────────────────────────────────────
  //
  // Two sweeps, one mechanism. Everything above this line only ever ADDS bytes;
  // this is the half that takes them back, and without it `usedBytes` is
  // monotonically increasing and every quota is eventually reached by images
  // nothing has pointed at for months.
  //
  //   staged   — uploaded, never attached to anything. The user opened the form,
  //              picked a photo, and closed the tab. 48h.
  //   orphaned — attached once, since detached (product deleted, photo replaced).
  //              `orphanedAt` records when the count hit zero. 7 days by default.
  //
  // ── THE CLAIM ────────────────────────────────────────────────────────────
  // Each row is removed with a `findOneAndDelete` carrying the FULL sweep
  // predicate, not just its id. That single call is what makes the sweep safe
  // against the two races that matter:
  //
  //   · two workers sweeping at once — only one delete matches, so the byte
  //     counters are decremented exactly once. Double-decrementing would make a
  //     bucket report free space it does not have.
  //   · a save re-attaching between the read and the delete — `reconcileRefs`
  //     has already raised `refCount` and cleared `orphanedAt`, so the predicate
  //     no longer matches and the image survives. This is why the whole
  //     condition is re-asserted at delete time rather than trusting the read.
  //
  // The row is claimed BEFORE the objects are deleted. If R2 then fails, the
  // bytes outlive their row and become a reconciliation ghost — recoverable, and
  // far cheaper than the alternative ordering, where a crash between the two
  // leaves a live-looking record pointing at objects that are already gone.

  /**
   * Delete images uploaded but never attached to anything.
   *
   * @param {Object} [options]
   * @param {number} [options.olderThanMs]  default 48h
   * @param {number} [options.limit]        rows per pass
   */
  async sweepStagedMedia({ olderThanMs = STAGED_TTL_MS, limit = RECLAIM_BATCH } = {}) {
    const cutoff = new Date(Date.now() - olderThanMs);
    return this._reclaim(
      {
        status: 'staged',
        refCount: 0,
        createdAt: { $lt: cutoff },
      },
      limit,
      'staged'
    );
  }

  /**
   * Delete images whose last reference went away longer than the grace period
   * ago.
   *
   * `broken` rows are excluded: reconciliation has already found their objects
   * missing from R2, so there is nothing to delete and their byte counters need
   * the repair path, not this one.
   *
   * @param {Object} [options]
   * @param {number} [options.graceDays]  defaults to PlatformSetting.orphanGraceDays
   * @param {number} [options.limit]
   */
  async sweepOrphanedMedia({ graceDays = null, limit = RECLAIM_BATCH } = {}) {
    const days = Number.isFinite(graceDays)
      ? graceDays
      : (await platformStorageSettings()).orphanGraceDays;

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return this._reclaim(
      {
        refCount: 0,
        orphanedAt: { $ne: null, $lt: cutoff },
        status: { $ne: 'broken' },
      },
      limit,
      'orphaned'
    );
  }

  /**
   * Claim and delete every row matching `filter`, up to `limit`.
   *
   * @param {Object} filter  the sweep predicate; re-asserted on every claim
   * @param {number} limit
   * @param {string} label   for the log line
   * @returns {Promise<{scanned, deleted, skipped, failed, bytes}>}
   */
  async _reclaim(filter, limit, label) {
    const result = { scanned: 0, deleted: 0, skipped: 0, failed: 0, bytes: 0 };

    const candidates = await ShopMedia.find(filter)
      .select('_id shop account objectKey thumbKey mediumKey totalBytes')
      .limit(limit)
      .lean();

    result.scanned = candidates.length;
    if (candidates.length === 0) return result;

    // Claim first, in full, before touching R2. A row that no longer matches was
    // re-attached in the meantime and is simply left alone.
    const claimed = [];
    for (const candidate of candidates) {
      const doc = await ShopMedia.findOneAndDelete({ ...filter, _id: candidate._id }).lean();
      if (doc) claimed.push(doc);
      else result.skipped += 1;
    }

    // Grouped by account because `deleteObjects` is one batched R2 call per
    // bucket — per-image calls would turn a 200-row sweep into 200 round trips
    // and 200 Class A operations.
    const byAccount = new Map();
    for (const doc of claimed) {
      const key = String(doc.account);
      if (!byAccount.has(key)) byAccount.set(key, []);
      byAccount.get(key).push(doc);
    }

    for (const [accountId, docs] of byAccount) {
      const keys = docs.flatMap((d) => [d.objectKey, d.thumbKey, d.mediumKey].filter(Boolean));
      const bytes = docs.reduce((sum, d) => sum + (d.totalBytes || 0), 0);

      try {
        const account = await storageService.getAccountWithSecret(accountId);
        await storageService.deleteObjects(account, keys);
        await storageService.uncommit(accountId, bytes, { files: keys.length });
        result.deleted += docs.length;
        result.bytes += bytes;
      } catch (err) {
        // The rows are already gone, so these bytes are now ghosts in the
        // bucket. Counted as failures and logged loudly: the weekly
        // reconciliation is what collects them, and a rising number here means
        // an account is unreachable rather than that the sweep is misbehaving.
        result.failed += docs.length;
        logger.error(
          `Reclamation (${label}): deleted ${docs.length} row(s) but could not clear ` +
          `${keys.length} object(s) from account ${accountId}: ${err.message}. ` +
          'Reconciliation will collect them.'
        );
      }

      // The shop's counters come back regardless of what R2 did. The row is gone
      // either way, so leaving the bytes charged would bill a shop for storage
      // it can no longer see or reach.
      const byShop = new Map();
      for (const doc of docs) {
        const key = String(doc.shop);
        const prev = byShop.get(key) || { bytes: 0, files: 0 };
        byShop.set(key, { bytes: prev.bytes + (doc.totalBytes || 0), files: prev.files + 1 });
      }
      for (const [shopId, totals] of byShop) {
        await this._refundShopUsage(shopId, totals.bytes, totals.files);
      }
    }

    if (result.deleted > 0 || result.failed > 0) {
      logger.info(
        `Reclamation (${label}): deleted ${result.deleted}, ` +
        `freed ${Math.round(result.bytes / 1024)}KB, ` +
        `skipped ${result.skipped} (re-attached), failed ${result.failed}`
      );
    }

    return result;
  }
}

/**
 * Normalise a mixed bag of ObjectIds, strings, nulls and subdocument fields
 * into a list of distinct, valid ObjectIds.
 *
 * Tolerant by design: it is fed raw client payloads and hydrated documents
 * alike, and a malformed id there is a 400 from `resolveOwned`, not a crash
 * here.
 */
function uniqueIds(ids) {
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of ids) {
    if (raw === null || raw === undefined || raw === '') continue;
    const str = String(raw);
    if (!mongoose.Types.ObjectId.isValid(str)) continue;
    if (seen.has(str)) continue;
    seen.add(str);
    out.push(new mongoose.Types.ObjectId(str));
  }
  return out;
}

module.exports = new MediaService();
module.exports.RENDITIONS = RENDITIONS;
module.exports.MAX_PIXELS = MAX_PIXELS;
module.exports.STAGED_TTL_MS = STAGED_TTL_MS;
module.exports.RECLAIM_BATCH = RECLAIM_BATCH;
module.exports.uniqueIds = uniqueIds;
