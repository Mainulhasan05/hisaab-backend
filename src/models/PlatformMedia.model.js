/**
 * PlatformMedia — one image or video in the platform's own media library.
 *
 * PLATFORM-OWNED, ADMIN-ONLY, in both directions (MEDIA_GALLERY_PLAN.md I-20).
 * No shop uploads into this collection, no shop browses it, and no shop-facing
 * route may return one of these documents. What a shop sees is the RENDERED
 * landing page, which is a public URL — never the library behind it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT `ShopMedia` WITH `shop: null`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `ShopMedia` is shop-scoped in its bones: `{ shop, hash }` is its unique dedupe
 * index, `objectKey` is prefixed `<shopId>/` so per-shop listing and cleanup are
 * one R2 call, and its bytes are charged to `Shop.storage`. Making `shop`
 * optional would make each of those either wrong or conditional.
 *
 * The specific failure worth naming is the index. MongoDB treats nulls as equal
 * in a unique compound index, so `{ shop: null, hash }` would permit exactly ONE
 * platform file per hash — and the second upload of a different image that
 * happened to collide, or more realistically any upload after a hash-scheme
 * change, would not error. It would silently return the existing document, and
 * an admin would find a landing page showing the wrong photo weeks later with
 * nothing in any log to explain it.
 *
 * ── WHO PAYS FOR THE BYTES ──────────────────────────────────────────────────
 *
 * The platform. These bytes count against `R2Account` capacity like anything
 * else — allocation goes through the same `storage.service` path, and there must
 * never be a second accounting path — but against NO `Shop.storage` quota.
 *
 * That is correct rather than convenient. Under paid setup the platform authored
 * the page (LANDING_PAGE_PLAN.md D1); charging a trader's 100MB quota for photos
 * they did not upload and cannot see would produce a storage-full error on a
 * product photo they DO care about, caused by a file they have never heard of.
 * It also unlocks the real win: dedupe is platform-wide here, so one mango photo
 * serves ten mango campaigns for ten different shops and is stored once.
 *
 * The accounting consequence is handled in the admin storage screen, which must
 * show platform usage as its own line — otherwise it appears as an unexplained
 * gap between "sum of shops" and "account used", and the overcommit figure
 * R2_STORAGE_PLAN.md §৪.৪ exists to protect quietly overstates free space.
 *
 * ── THE FOLDER IS NOT IN THE KEY ────────────────────────────────────────────
 *
 * `objectKey` is `platform/<mediaId>.<ext>`. See MediaFolder.model.js for why
 * moving a file must never touch R2 (I-19).
 */

const mongoose = require('mongoose');

const MEDIA_KINDS = Object.freeze(['image', 'video']);

const MEDIA_STATUS = Object.freeze(['staged', 'active', 'broken']);

/**
 * What may hold a reference to a file.
 *
 *   landingPage — a marked slot in `LandingPage.assets`. Attached explicitly.
 *   landingHtml — a URL found inside `LandingPage.html` by the save-time scan.
 *                 See the note on `refs` for why this second kind has to exist.
 *   poster      — a video record points at this image as its poster. Held so a
 *                 poster is never reclaimed while its video survives.
 */
const REF_KINDS = Object.freeze(['landingPage', 'landingHtml', 'poster']);

/**
 * One thing that points at this file.
 *
 * ── WHY THIS EXISTS ALONGSIDE `refCount` ────────────────────────────────────
 *
 * `refCount` answers "may this be deleted". An admin standing in front of a
 * delete button needs a different question answered: "WHAT is using this", by
 * name, with a link — and that cannot be reconstructed from a counter. In a
 * shop-side gallery that question is rare; in an admin library where one file is
 * deliberately shared across many campaigns it is asked every single time.
 *
 * This does NOT contradict the rule ShopMedia's header states. What was rejected
 * there was a second field restating the SAME fact — an `orphaned` state beside
 * a `refCount` that already implied it, two fields that could disagree. `refs`
 * carries strictly more information than the count and is its SOURCE: the
 * service writes both together, and `refCount` is `refs.length`. The invariant
 * is one writer, not one field.
 */
const mediaRefSchema = new mongoose.Schema({
  kind: { type: String, enum: REF_KINDS, required: true },
  // The LandingPage, or the PlatformMedia video for a `poster` ref.
  page: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Which slot, for `landingPage` refs. Null for the other kinds.
  key: { type: String, trim: true, default: null },
}, { _id: false });

const platformMediaSchema = new mongoose.Schema({
  /**
   * SHA-256 of the bytes actually stored. Unique PLATFORM-WIDE, with no shop
   * dimension — that is the point of this collection existing (see the header).
   *
   * As in `ShopMedia`, this hashes what we store rather than what was uploaded:
   * cross-device dedupe is not achievable and is not attempted.
   */
  hash: {
    type: String,
    required: true,
    unique: true,
  },

  // Deliberately NOT indexed on its own: a two-value enum is too low-cardinality
  // for the planner to prefer, and the only read that filters on it ("images
  // only, in this folder") is already served by the `{folder, createdAt}` index
  // with a cheap residual filter.
  kind: {
    type: String,
    enum: MEDIA_KINDS,
    required: true,
  },

  /**
   * null = the library root. A file is never orphaned by a folder delete: the
   * service refuses to delete a folder holding referenced files and otherwise
   * moves the contents up to the parent. Cascading a folder delete into file
   * deletes is the one destructive action an admin will trigger by accident.
   */
  folder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MediaFolder',
    default: null,
  },

  // ── Where it lives ────────────────────────────────────────────────────────
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'R2Account',
    required: true,
    index: true,
  },
  // `platform/<mediaId>.<ext>` — no folder path, see MediaFolder's header.
  objectKey: { type: String, required: true },
  // Images only. A video gets no derivatives: there is no transcoding on this
  // stack and there should not be (MEDIA_GALLERY_PLAN.md §6.1), so what is
  // uploaded is what is served.
  thumbKey: { type: String, default: null },
  mediumKey: { type: String, default: null },

  // Denormalised absolute URLs, for the same reason ShopMedia stores them: the
  // gallery grid renders dozens of tiles and must not join R2Account to do it.
  url: { type: String, required: true },
  thumbUrl: { type: String, default: null },
  mediumUrl: { type: String, default: null },

  // ── Size accounting ───────────────────────────────────────────────────────
  bytes: { type: Number, required: true, min: 0 },

  /**
   * Everything this record is responsible for: the object, its derivatives, and
   * for a video its poster image.
   *
   * The poster is included deliberately. It is stored as its own document (so it
   * can be served, listed and deduped like any image), but a library that
   * reported a video's cost without the poster it cannot be shown without would
   * under-report exactly the files that cost the most.
   */
  totalBytes: { type: Number, required: true, min: 0 },

  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 },

  /** Video only. 0 for an image. */
  durationSec: { type: Number, default: 0, min: 0 },

  /**
   * Video only — the image shown before playback starts.
   *
   * MANDATORY for a video, enforced in the service rather than here because a
   * poster is uploaded as a second request and the video document exists
   * between the two. Without one the browser shows a black rectangle until
   * enough has buffered, which on the 3G connection this traffic arrives over is
   * the entire above-the-fold experience of a page bought with ad money.
   */
  posterMedia: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PlatformMedia',
    default: null,
  },

  mime: { type: String, required: true },
  originalName: { type: String, default: null },

  /** The admin's own label. Searchable; shown in the picker under the tile. */
  title: { type: String, trim: true, maxlength: 200, default: null },

  /**
   * Written into the rendered `<img alt="...">`.
   *
   * Stored on the file rather than on the landing page slot because the same
   * photo means the same thing wherever it is used, and asking an author to
   * retype it per page is how it ends up empty on every page.
   */
  altText: { type: String, trim: true, maxlength: 300, default: null },

  tags: { type: [String], default: () => [] },

  /**
   * staged — uploaded, attached to nothing. Swept after 48h.
   * active — attached at least once (refCount may be 0 again after a detach).
   * broken — reconciliation found the object missing from R2.
   */
  // Not indexed on its own — `{ status, createdAt }` below has it as a prefix
  // and serves every read that filters on it. ShopMedia carries both; that is a
  // redundant index rather than a precedent to copy.
  status: {
    type: String,
    enum: MEDIA_STATUS,
    default: 'staged',
  },

  /** `refs.length`, denormalised so the reclamation sweeps can index on it. */
  refCount: { type: Number, default: 0, min: 0 },

  refs: { type: [mediaRefSchema], default: () => [] },

  /** When `refCount` last reached 0. Cleared when anything re-attaches. */
  orphanedAt: { type: Date, default: null },

  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  lastAttachedAt: { type: Date, default: null },
}, {
  timestamps: true,
});

// The gallery listing: one folder's files, newest first.
platformMediaSchema.index({ folder: 1, createdAt: -1 });

/**
 * The reverse lookup the I-18 reconciler runs on every landing-page save:
 * "which files does this page currently reference", so the difference against
 * the page's new HTML can be attached and detached in one pass.
 */
platformMediaSchema.index({ 'refs.page': 1 });

// The two reclamation sweeps, same shape as ShopMedia's.
platformMediaSchema.index({ status: 1, createdAt: 1 });       // staged past 48h
platformMediaSchema.index({ refCount: 1, orphanedAt: 1 });    // orphaned past grace

// Tag filtering in the picker.
platformMediaSchema.index({ tags: 1 });

/** Every object key this record owns — what a delete must remove from R2. */
platformMediaSchema.methods.allKeys = function allKeys() {
  return [this.objectKey, this.thumbKey, this.mediumKey].filter(Boolean);
};

/**
 * Is this file safe to reclaim?
 *
 * `refCount === 0` is NOT sufficient on its own, and that is the whole of I-18.
 * An admin may paste an R2 URL straight into a landing page's HTML, where no
 * attach ever happens; the save-time scan is what turns that into a
 * `landingHtml` ref. A parser can have bugs, so the sweep ALSO re-checks live
 * page references before deleting anything — this method is the cheap half of
 * that guard, not the whole of it.
 *
 * The failure being prevented: a page goes live, nothing holds a reference, the
 * grace period passes, the sweep deletes the object, and a campaign currently
 * spending ad money loses its hero image with nothing reporting it.
 */
platformMediaSchema.methods.isReclaimable = function isReclaimable() {
  return this.refCount === 0 && this.refs.length === 0 && this.status !== 'broken';
};

/** The shape the admin panel gets. Never leaks the bucket or the account id. */
platformMediaSchema.methods.toClientJSON = function toClientJSON() {
  return {
    _id: this._id,
    kind: this.kind,
    folder: this.folder,
    url: this.url,
    thumbUrl: this.thumbUrl || this.url,
    mediumUrl: this.mediumUrl || this.url,
    width: this.width,
    height: this.height,
    durationSec: this.durationSec,
    posterMedia: this.posterMedia,
    mime: this.mime,
    bytes: this.totalBytes,
    title: this.title || '',
    altText: this.altText || '',
    tags: this.tags,
    originalName: this.originalName,
    refCount: this.refCount,
    status: this.status,
    createdAt: this.createdAt,
  };
};

const PlatformMedia = mongoose.model('PlatformMedia', platformMediaSchema);

module.exports = PlatformMedia;
module.exports.MEDIA_KINDS = MEDIA_KINDS;
module.exports.MEDIA_STATUS = MEDIA_STATUS;
module.exports.REF_KINDS = REF_KINDS;
