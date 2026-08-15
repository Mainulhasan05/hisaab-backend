/**
 * MediaFolder — one drawer in the platform's admin media library.
 *
 * PLATFORM-OWNED, ADMIN-ONLY. No shop creates, reads, edits or sees one. See
 * MEDIA_GALLERY_PLAN.md §2.2 and I-20: the library is a standalone admin tool
 * with no shop-facing surface in this phase or any later one, and folders are
 * how an admin keeps one piece of work's files together.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A FOLDER IS METADATA. IT IS NOT PART OF THE OBJECT KEY. (I-19)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `PlatformMedia.objectKey` is `platform/<mediaId>.<ext>` and contains no folder
 * path. Moving a file between folders is therefore one field update on one
 * document — no R2 traffic at all.
 *
 * Encoding the folder into the key instead would make every move a server-side
 * copy plus a delete plus a URL rewrite. That is three operations that can
 * half-fail, and the half-failure worth naming is: the copy succeeds, the URL
 * rewrite does not, and whatever was referencing the file in production is left
 * pointing at an object that is about to be deleted.
 *
 * R2_STORAGE_PLAN.md §৭.৪ already took this trade once, accepting denormalised
 * URLs and a once-a-year rewrite script rather than a per-request join. Taking
 * it again here keeps the two consistent; reversing it in one place would mean
 * two different answers to "where does an object live".
 *
 * ── WHY `path` IS STORED AS WELL AS `parent` ────────────────────────────────
 *
 * `parent` is the truth — it is what the unique sibling-name index is built on
 * and what a move rewrites. `path` is derived from it and stored anyway, because
 * the two reads that actually happen are "everything under /aam-2026" (a prefix
 * match on one indexed string) and "show me the breadcrumb" (no query at all).
 * Walking `parent` upward for either means one round trip per level on a screen
 * that renders a whole tree.
 *
 * The cost is that renaming or moving a folder must rewrite `path` on every
 * descendant. That is one `updateMany` with a `^/old-path` prefix, on a
 * collection an admin edits by hand a few times a week. See
 * `mediaFolder.service` for the rewrite; nothing else may write `path`.
 */

const mongoose = require('mongoose');

/**
 * How deep the tree may go, counting the root level as 0.
 *
 * Three levels — `/aam-2026/hero/mobile` — and no more. A gallery is a picker,
 * not a filesystem: past three levels the admin is navigating instead of
 * finding, and the fix for that is search and tags (MEDIA_GALLERY_PLAN.md G2),
 * not more nesting. The cap is enforced in the service on create and on move,
 * because a move can bury a whole subtree and the depth that matters is the
 * DEEPEST DESCENDANT's, not the moved folder's own.
 */
const MAX_DEPTH = 2;

/** Path segment rules. Kept ASCII so a path is safe in a URL and in a log line. */
const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const mediaFolderSchema = new mongoose.Schema({
  /**
   * What the admin sees. Bengali is expected and fine — this is a label, not an
   * identifier. The identifier is `slug`, below.
   */
  name: {
    type: String,
    required: [true, 'ফোল্ডারের নাম দিন'],
    trim: true,
    maxlength: [80, 'নাম ৮০ অক্ষরের বেশি হতে পারবে না'],
  },

  /**
   * The ASCII segment this folder contributes to `path`.
   *
   * Separate from `name` because `path` is matched with a regex prefix and
   * appears in URLs and logs, and a Bengali folder name would put multi-byte
   * characters into both. Derived from `name` on create when the admin does not
   * supply one, and stable thereafter — renaming the label does not move the
   * folder, which is the behaviour that avoids rewriting every descendant every
   * time someone fixes a typo.
   */
  slug: {
    type: String,
    required: [true, 'ফোল্ডারের slug দিন'],
    lowercase: true,
    trim: true,
    match: [SEGMENT_PATTERN, 'slug ইংরেজি ছোট হাতের অক্ষর, সংখ্যা ও হাইফেন দিয়ে লিখুন'],
  },

  /** null = a root folder. */
  parent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MediaFolder',
    default: null,
  },

  /**
   * Denormalised, always leading-slash, never trailing: '/aam-2026/hero'.
   * A root folder's path is '/aam-2026'. Written only by `mediaFolder.service`.
   */
  path: {
    type: String,
    required: true,
    trim: true,
  },

  /** 0 for a root folder. Capped at MAX_DEPTH; see the constant. */
  depth: {
    type: Number,
    required: true,
    min: 0,
    max: MAX_DEPTH,
  },

  description: {
    type: String,
    trim: true,
    maxlength: [300, 'বিবরণ ৩০০ অক্ষরের বেশি হতে পারবে না'],
  },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
}, {
  timestamps: true,
});

/**
 * The prefix read: "everything under /aam-2026", which is how the gallery lists
 * a folder's contents including its subfolders and how a per-folder byte total
 * is aggregated.
 */
mediaFolderSchema.index({ path: 1 }, { unique: true });

/**
 * No two siblings may share a slug, or `path` could not be unique and a prefix
 * match would return two different folders' files as one.
 *
 * `parent` is null for roots, and MongoDB compares nulls as equal in a unique
 * index — which is exactly what is wanted here: two root folders may not share
 * a slug either.
 */
mediaFolderSchema.index({ parent: 1, slug: 1 }, { unique: true });

/** The tree render: children of one folder, in a stable order. */
mediaFolderSchema.index({ parent: 1, name: 1 });

/** Build a child path without every caller re-deriving the slash rules. */
mediaFolderSchema.statics.joinPath = function joinPath(parentPath, slug) {
  const base = String(parentPath || '').replace(/\/+$/, '');
  return `${base}/${slug}`;
};

/** The shape the admin panel gets. */
mediaFolderSchema.methods.toClientJSON = function toClientJSON() {
  return {
    _id: this._id,
    name: this.name,
    slug: this.slug,
    parent: this.parent,
    path: this.path,
    depth: this.depth,
    description: this.description || '',
    createdAt: this.createdAt,
  };
};

const MediaFolder = mongoose.model('MediaFolder', mediaFolderSchema);

module.exports = MediaFolder;
module.exports.MAX_DEPTH = MAX_DEPTH;
module.exports.SEGMENT_PATTERN = SEGMENT_PATTERN;
