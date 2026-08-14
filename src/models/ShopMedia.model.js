/**
 * ShopMedia — one uploaded image, wherever it ended up in the R2 pool.
 *
 * The bridge between `R2Account` (which bucket, how many bytes) and the things
 * that show pictures (`Product.images`, `variants[].image`, `Category.image`).
 * It is also the gallery's backing store and the only reason unused images can
 * ever be reclaimed.
 *
 * ── WHY A SEPARATE COLLECTION AND NOT JUST A URL ON THE PRODUCT ──────────────
 * A bare URL cannot answer any of the questions that keep storage from growing
 * forever: how big is it, who else uses it, which bucket holds it, has anyone
 * used it since. Three concrete things fall out of having a document:
 *
 *   · DEDUPE — `hash` is unique per shop, so re-uploading the same photo to a
 *     second variant costs zero bytes and zero R2 operations.
 *   · RECLAMATION — `refCount` plus `orphanedAt` is what lets a nightly job say
 *     "nothing has pointed at this for a week, delete it" without guessing.
 *   · MIGRATION — `account` + `objectKey` mean every URL can be rebuilt. That
 *     is what makes moving off `pub-xxx.r2.dev` onto a custom domain a script
 *     rather than a migration. See scripts/rewrite-media-urls.js.
 *
 * ── STATUS vs refCount ───────────────────────────────────────────────────────
 * Deliberately NOT a four-state enum with an `orphaned` member. "Is anything
 * using this" is already answered by `refCount`, and a second field claiming
 * the same fact is a bug waiting for the two to disagree. `orphanedAt` is a
 * timestamp, not a state: it records WHEN refCount last reached zero so the
 * grace period can be measured, and is cleared the moment something re-attaches.
 */

const mongoose = require('mongoose');

const shopMediaSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },

  /**
   * SHA-256 of the bytes we actually stored (post-compression), not of the file
   * the user picked. Two phones compressing the same photo produce different
   * bytes and so different hashes — cross-device dedupe is not achievable and
   * is not attempted. Within one device and one shop, re-picking the same image
   * is free, which is the case that actually happens.
   */
  hash: { type: String, required: true },

  // ── Where it lives ────────────────────────────────────────────────────────
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'R2Account',
    required: true,
    index: true,
  },
  // `<shopId>/<mediaId>.webp`. The shop prefix makes per-shop listing and
  // per-shop cleanup a single R2 call instead of a full bucket walk.
  objectKey: { type: String, required: true },
  thumbKey: { type: String, default: null },
  mediumKey: { type: String, default: null },

  /**
   * Denormalised absolute URLs.
   *
   * Yes, these are derivable from `account.publicBaseUrl + objectKey`. They are
   * stored anyway because the product list renders dozens of thumbnails per
   * page and must not join a second collection to do it. The cost is that
   * changing a bucket's public hostname requires a rewrite pass — which is a
   * once-a-year script, against a per-request join. See the plan's §7.4.
   */
  url: { type: String, required: true },
  thumbUrl: { type: String, default: null },
  mediumUrl: { type: String, default: null },

  // ── Size accounting ───────────────────────────────────────────────────────
  bytes: { type: Number, required: true, min: 0 },       // the original object
  // original + thumb + medium. THIS is what counts against the shop's quota and
  // against the account's capacity — billing the shop only for the full-size
  // image would under-count real usage by roughly a third.
  totalBytes: { type: Number, required: true, min: 0 },

  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 },
  mime: { type: String, default: 'image/webp' },
  originalName: { type: String, default: null },

  /**
   * staged — uploaded, not yet attached to anything. Swept after 48h.
   * active — attached at least once (refCount may still be 0 after a detach).
   * broken — reconciliation found the object missing from R2.
   */
  status: {
    type: String,
    enum: ['staged', 'active', 'broken'],
    default: 'staged',
    index: true,
  },

  // How many products / variants / categories point at this image.
  refCount: { type: Number, default: 0, min: 0 },

  // Set when refCount reaches 0, cleared when something re-attaches. Null on a
  // referenced image. The reclamation job measures the grace period from here.
  orphanedAt: { type: Date, default: null },

  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastAttachedAt: { type: Date, default: null },
}, {
  timestamps: true,
});

// Dedupe. Scoped to the shop, never global: sharing an object between tenants
// would mean one shop's delete could blank another's product page, and would
// leak the fact that two shops uploaded the same file.
shopMediaSchema.index({ shop: 1, hash: 1 }, { unique: true });

// Gallery listing: newest first, within one shop.
shopMediaSchema.index({ shop: 1, status: 1, createdAt: -1 });

// The two reclamation sweeps.
shopMediaSchema.index({ status: 1, createdAt: 1 });          // staged older than 48h
shopMediaSchema.index({ refCount: 1, orphanedAt: 1 });       // orphaned past grace

/** Every object key this record owns — what a delete has to remove from R2. */
shopMediaSchema.methods.allKeys = function allKeys() {
  return [this.objectKey, this.thumbKey, this.mediumKey].filter(Boolean);
};

/** The shape the frontend gets. Never leaks the bucket or the account id. */
shopMediaSchema.methods.toClientJSON = function toClientJSON() {
  return {
    _id: this._id,
    url: this.url,
    thumbUrl: this.thumbUrl || this.url,
    mediumUrl: this.mediumUrl || this.url,
    width: this.width,
    height: this.height,
    bytes: this.totalBytes,
    originalName: this.originalName,
    createdAt: this.createdAt,
  };
};

const ShopMedia = mongoose.model('ShopMedia', shopMediaSchema);

module.exports = ShopMedia;
