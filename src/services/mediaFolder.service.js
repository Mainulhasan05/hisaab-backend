/**
 * Folders in the platform media library.
 *
 * ADMIN-ONLY (MEDIA_GALLERY_PLAN.md I-20). Nothing shop-facing calls into here.
 *
 * ── THE ONE THING TO UNDERSTAND BEFORE CHANGING ANYTHING ────────────────────
 *
 * `parent` is the truth. `path` is derived from it and stored for the two reads
 * that actually happen — "everything under /aam-2026" and the breadcrumb. This
 * service is the ONLY writer of `path`, and `rebuildPaths()` can regenerate
 * every one of them from `parent` alone.
 *
 * That last property is what makes `move()` safe without a transaction. A move
 * rewrites a subtree with one `updateMany`; if the process dies midway some
 * descendants keep a stale `path`, which is wrong but not lost — `parent` still
 * says where they belong, and the repair is one function call. The alternative
 * shapes (path as truth, or no stored path) trade a repairable inconsistency for
 * an unrepairable one or for a round trip per level on every tree render.
 *
 * ── NO OBJECT EVER MOVES IN R2 ──────────────────────────────────────────────
 *
 * A file's `objectKey` does not contain its folder (I-19, MediaFolder.model.js).
 * Everything here is metadata. If a change to this file makes you reach for
 * `storage.service`, the invariant is being broken.
 */

const mongoose = require('mongoose');

const MediaFolder = require('../models/MediaFolder.model');
const PlatformMedia = require('../models/PlatformMedia.model');
const { AppError } = require('../middleware/error.middleware');
const logger = require('../utils/logger.util');

const { MAX_DEPTH } = MediaFolder;

/** How many siblings to try before giving up on auto-suffixing a slug. */
const MAX_SLUG_ATTEMPTS = 50;

class MediaFolderService {
  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * Every folder, ordered so a caller can build the tree in one pass without
   * sorting: parents always precede their children because a parent's path is a
   * prefix of its children's.
   */
  async list() {
    const folders = await MediaFolder.find().sort({ path: 1 }).lean();
    return folders;
  }

  /**
   * The tree, with each node's own and cumulative byte totals.
   *
   * Totals are AGGREGATED, never stored. A rolling counter on a tree drifts the
   * first time a move, a delete and an upload interleave, and a wrong number on
   * a storage screen is worse than a slow one — this runs on an admin screen,
   * not a hot path (MEDIA_GALLERY_PLAN.md §5.2).
   */
  async listWithUsage() {
    const folders = await MediaFolder.find().sort({ path: 1 }).lean();

    // One grouped pass over the whole library rather than one aggregation per
    // folder: the collection is small, and N+1 aggregations on a tree render is
    // the shape that gets slow without anyone noticing why.
    const perFolder = await PlatformMedia.aggregate([
      { $group: { _id: '$folder', bytes: { $sum: '$totalBytes' }, files: { $sum: 1 } } },
    ]);

    return rollUpUsage(folders, perFolder);
  }

  /** One folder, or a 404. */
  async getById(folderId) {
    const folder = await MediaFolder.findById(folderId);
    if (!folder) {
      throw new AppError('Folder not found', 'ফোল্ডারটি পাওয়া যায়নি', 404);
    }
    return folder;
  }

  /** Every folder id in a subtree, the folder itself included. */
  async subtreeIds(folder) {
    const descendants = await MediaFolder.find(
      { path: { $regex: `^${escapeRegex(folder.path)}/` } }
    ).select('_id').lean();
    return [folder._id, ...descendants.map((d) => d._id)];
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Create a folder under `parentId` (null = root).
   *
   * @param {Object} input  { name, slug?, parent?, description? }
   * @param {ObjectId|string} adminId
   */
  async create({ name, slug = null, parent = null, description = '' }, adminId = null) {
    const label = String(name || '').trim();
    if (!label) {
      throw new AppError('Folder name is required', 'ফোল্ডারের নাম দিন', 400);
    }

    let parentDoc = null;
    let depth = 0;
    let basePath = '';

    if (parent) {
      parentDoc = await this.getById(parent);
      depth = parentDoc.depth + 1;
      basePath = parentDoc.path;

      if (depth > MAX_DEPTH) {
        throw new AppError(
          `Folder nesting is limited to ${MAX_DEPTH + 1} levels`,
          `ফোল্ডার সর্বোচ্চ ${MAX_DEPTH + 1} স্তর পর্যন্ত হতে পারে`,
          400
        );
      }
    }

    const finalSlug = await this._resolveSlug(slug || label, parentDoc?._id || null);

    try {
      const folder = await MediaFolder.create({
        name: label,
        slug: finalSlug,
        parent: parentDoc?._id || null,
        path: MediaFolder.joinPath(basePath, finalSlug),
        depth,
        description: String(description || '').trim(),
        createdBy: adminId,
      });
      return folder;
    } catch (err) {
      if (err?.code === 11000) {
        // Two admins created the same folder at once. The unique index is the
        // authority; `_resolveSlug` only reduces how often this is reached.
        throw new AppError(
          'A folder with that name already exists here',
          'এই জায়গায় একই নামের ফোল্ডার আগে থেকেই আছে',
          409
        );
      }
      throw err;
    }
  }

  /**
   * Change the label or description. Deliberately NOT the slug.
   *
   * Renaming the label must not move the folder: `path` feeds a prefix index and
   * appears in URLs and logs, and rewriting an entire subtree every time someone
   * fixes a typo is cost with no benefit. The identifier and the label are
   * separate fields precisely so this operation can be one document write.
   */
  async rename(folderId, { name, description }, adminId = null) {
    const folder = await this.getById(folderId);

    if (name !== undefined) {
      const label = String(name || '').trim();
      if (!label) {
        throw new AppError('Folder name is required', 'ফোল্ডারের নাম দিন', 400);
      }
      folder.name = label;
    }
    if (description !== undefined) {
      folder.description = String(description || '').trim();
    }
    folder.updatedBy = adminId;

    await folder.save();
    return folder;
  }

  /**
   * Move a folder (and everything under it) to a new parent.
   *
   * Three refusals, and each one is a real failure that would otherwise be
   * silent:
   *
   *   · into itself or its own descendant — would detach the subtree from the
   *     root entirely. Every listing walks from the root, so the folder and all
   *     its files would simply vanish from the UI while still holding bytes.
   *   · past the depth cap — measured on the DEEPEST DESCENDANT, not on the
   *     folder being moved. Moving a two-level subtree one level down buries its
   *     leaves, and checking only the moved folder's own new depth would let
   *     that through.
   *   · slug collision at the destination — `path` is unique, so the write would
   *     fail anyway; refusing here produces a message that says which name.
   */
  async move(folderId, newParentId = null, adminId = null) {
    const folder = await this.getById(folderId);
    const oldPath = folder.path;

    const parentDoc = newParentId ? await this.getById(newParentId) : null;

    if (String(folder.parent || '') === String(parentDoc?._id || '')) {
      return folder; // Already there. Not an error, and not a rewrite either.
    }

    const descendants = await MediaFolder.find(
      { path: { $regex: `^${escapeRegex(oldPath)}/` } }
    ).select('_id path depth').lean();

    // The refusals and the arithmetic; see `planMove`.
    const { newPath, newDepth, shift } = planMove(folder, parentDoc, descendants, MAX_DEPTH);

    const clash = await MediaFolder.findOne({
      parent: parentDoc?._id || null,
      slug: folder.slug,
      _id: { $ne: folder._id },
    }).lean();
    if (clash) {
      throw new AppError(
        `A folder named "${folder.slug}" already exists at the destination`,
        `গন্তব্যে "${folder.slug}" নামের ফোল্ডার আগে থেকেই আছে`,
        409
      );
    }

    folder.parent = parentDoc?._id || null;
    folder.path = newPath;
    folder.depth = newDepth;
    folder.updatedBy = adminId;
    await folder.save();

    if (descendants.length > 0) {
      // One pass. `$concat` on the stored path rather than recomputing from
      // `parent` per document, so the whole subtree is rewritten server-side.
      await MediaFolder.updateMany(
        { _id: { $in: descendants.map((d) => d._id) } },
        [
          {
            $set: {
              path: {
                $concat: [newPath, { $substrCP: ['$path', oldPath.length, { $strLenCP: '$path' }] }],
              },
              depth: { $add: ['$depth', shift] },
            },
          },
        ]
      );
    }

    return folder;
  }

  /**
   * Delete a folder.
   *
   * Refused while anything in the subtree is referenced — with the names of what
   * is using it, because "cannot delete" without that list leaves the admin
   * guessing. Otherwise the contents are moved UP to the parent, never deleted:
   * cascading a folder delete into file deletes is the one destructive action an
   * admin will trigger by accident, and files that survive are recoverable while
   * bytes that do not are gone.
   *
   * @param {Object} deps  { describeRefs } — injected from platformMedia.service
   *                       so this file does not depend on the reference registry
   */
  async remove(folderId, { describeRefs = null } = {}) {
    // Before a destructive operation, make the derived fields trustworthy.
    // `subtreeIds` finds descendants by path prefix, so a stale path left by an
    // interrupted `move` would under-report the subtree — and the folder would
    // be deleted while a descendant survived, pointing at a parent that no
    // longer exists and reachable from no listing. Cheap, and it turns the one
    // failure mode this method has into one it cannot have.
    await this.rebuildPaths();

    const folder = await this.getById(folderId);
    const ids = await this.subtreeIds(folder);

    const referenced = await PlatformMedia.find({
      folder: { $in: ids },
      refCount: { $gt: 0 },
    }).select('_id title originalName refs').limit(20).lean();

    if (referenced.length > 0) {
      const users = describeRefs ? await describeRefs(referenced) : [];
      const error = new AppError(
        `${referenced.length} file(s) in this folder are still in use`,
        'এই ফোল্ডারের কিছু ফাইল এখনো ব্যবহৃত হচ্ছে — আগে সেগুলো সরান',
        409
      );
      error.code = 'FOLDER_NOT_EMPTY';
      error.files = referenced.map((f) => ({
        _id: f._id,
        name: f.title || f.originalName || String(f._id),
      }));
      error.usedBy = users;
      throw error;
    }

    // FILES move up to the surviving parent. SUBFOLDERS are deleted with the
    // folder — that is what deleting a folder means — but no file is ever
    // deleted with it. Files survive because they cost bytes and are
    // recoverable; an empty folder costs nothing and is trivially recreated.
    //
    // Done before the delete so a failure here leaves the folder intact rather
    // than leaving its files pointing at a folder that no longer exists.
    await PlatformMedia.updateMany(
      { folder: { $in: ids } },
      { $set: { folder: folder.parent || null } }
    );

    // Defensive: after the rebuild above nothing should match, since anything
    // parented inside the subtree is itself in the subtree. It is kept because
    // matching nothing costs one query, and the case it covers — a folder whose
    // `parent` points into the subtree but whose path did not — would otherwise
    // be silently orphaned by the delete below.
    await MediaFolder.updateMany(
      { parent: { $in: ids }, _id: { $nin: ids } },
      { $set: { parent: folder.parent || null } }
    );

    await MediaFolder.deleteMany({ _id: { $in: ids } });

    // Only does work if the defensive re-parent above found something; its new
    // path and depth are derived from a parent that just changed.
    await this.rebuildPaths();

    return { deleted: ids.length, movedTo: folder.parent || null };
  }

  // ── Repair ────────────────────────────────────────────────────────────────

  /**
   * Regenerate every `path` and `depth` from `parent`.
   *
   * The safety net the header describes: `parent` is truth, so this can always
   * reconstruct the derived fields — after an interrupted `move`, after a manual
   * database edit, or after a bug in this file. Idempotent, and cheap on a
   * collection an admin edits by hand.
   *
   * @returns {Promise<{scanned: number, fixed: number}>}
   */
  async rebuildPaths() {
    const all = await MediaFolder.find().select('_id parent slug path depth').lean();
    const byParent = new Map();
    for (const f of all) {
      const key = String(f.parent || 'root');
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(f);
    }

    const updates = [];
    const walk = (parentKey, basePath, depth) => {
      for (const f of byParent.get(parentKey) || []) {
        const path = MediaFolder.joinPath(basePath, f.slug);
        if (f.path !== path || f.depth !== depth) {
          updates.push({
            updateOne: { filter: { _id: f._id }, update: { $set: { path, depth } } },
          });
        }
        walk(String(f._id), path, depth + 1);
      }
    };
    walk('root', '', 0);

    if (updates.length > 0) {
      await MediaFolder.bulkWrite(updates);
      logger.info(`Rebuilt ${updates.length} media folder path(s)`);
    }

    return { scanned: all.length, fixed: updates.length };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Turn a label into a slug that is free among its siblings.
   *
   * A Bengali folder name slugifies to nothing — which is expected, not an
   * error, because `name` is the label and `slug` is only the path segment. Such
   * a folder becomes `folder`, `folder-2`, `folder-3`. Refusing instead would
   * make the admin invent an English name for a Bengali folder every time.
   */
  async _resolveSlug(source, parentId) {
    const base = slugify(source) || 'folder';

    for (let i = 0; i < MAX_SLUG_ATTEMPTS; i += 1) {
      const candidate = i === 0 ? base : `${base}-${i + 1}`;
      // eslint-disable-next-line no-await-in-loop
      const taken = await MediaFolder.exists({ parent: parentId, slug: candidate });
      if (!taken) return candidate;
    }

    throw new AppError(
      `Could not find a free slug for "${source}"`,
      'এই নামে ফোল্ডার বানানো যায়নি — অন্য নাম দিন',
      409
    );
  }
}

/**
 * Fold per-folder file totals into own + cumulative figures for a whole tree.
 *
 * Pure, and exported, because this is the arithmetic behind every number on the
 * storage screen and it is the kind that goes subtly wrong — a folder counted
 * into its grandparent twice, or a root-level file lost entirely — in a way no
 * one notices until the totals are used to decide something.
 *
 * Walked deepest-first so a child's cumulative total is final before its parent
 * reads it, which is what makes one pass sufficient at any depth.
 *
 * @param {Array} folders  lean MediaFolder docs, any order
 * @param {Array} rows     [{ _id: folderId|null, bytes, files }] from a $group
 */
function rollUpUsage(folders, rows) {
  const own = new Map(
    (rows || []).map((r) => [String(r._id), { bytes: r.bytes || 0, files: r.files || 0 }])
  );

  const byId = new Map(folders.map((f) => [String(f._id), f]));
  const cumulative = new Map();
  const ordered = [...folders].sort((a, b) => b.depth - a.depth);

  for (const folder of ordered) {
    const id = String(folder._id);
    const mine = own.get(id) || { bytes: 0, files: 0 };
    const acc = cumulative.get(id) || { bytes: 0, files: 0 };
    const total = { bytes: mine.bytes + acc.bytes, files: mine.files + acc.files };
    cumulative.set(id, total);

    // Guarded on the parent still existing: a folder whose parent was deleted
    // out from under it must not silently drop its bytes out of every total.
    // They surface at the root instead, where someone can see them.
    const parentId = folder.parent ? String(folder.parent) : null;
    if (parentId && byId.has(parentId)) {
      const parentAcc = cumulative.get(parentId) || { bytes: 0, files: 0 };
      cumulative.set(parentId, {
        bytes: parentAcc.bytes + total.bytes,
        files: parentAcc.files + total.files,
      });
    }
  }

  // A $group on a null field keys the bucket as null, which stringifies to
  // 'null'. These are the files sitting outside every folder — shown as
  // "(ফোল্ডারবিহীন)" rather than hidden, because a file nobody can see is a file
  // nobody will ever reclaim.
  const rootUsage = own.get('null') || own.get('undefined') || { bytes: 0, files: 0 };

  return {
    folders: folders.map((f) => {
      const id = String(f._id);
      const mine = own.get(id) || { bytes: 0, files: 0 };
      const total = cumulative.get(id) || { bytes: 0, files: 0 };
      return {
        ...f,
        ownBytes: mine.bytes,
        ownFiles: mine.files,
        totalBytes: total.bytes,
        totalFiles: total.files,
      };
    }),
    root: { ownBytes: rootUsage.bytes, ownFiles: rootUsage.files },
  };
}

/**
 * The three refusals and the depth arithmetic of a move, with no database in
 * sight — see `move()` for what each refusal prevents.
 *
 * Pure and exported so the cases that are hard to reach through the service
 * (a three-level subtree moved one level down, a folder dropped into its own
 * grandchild) can be tested directly.
 *
 * @param {Object} folder       { _id, slug, path, depth, parent }
 * @param {Object|null} parent  destination folder, or null for the root
 * @param {Array} descendants   [{ depth }] everything under `folder`
 * @param {number} maxDepth
 * @returns {{ newPath: string, newDepth: number, shift: number }}
 */
function planMove(folder, parent, descendants = [], maxDepth = MAX_DEPTH) {
  if (parent) {
    if (String(parent._id) === String(folder._id)) {
      throw new AppError(
        'A folder cannot be moved into itself',
        'ফোল্ডারকে তার নিজের ভিতরে সরানো যাবে না',
        400
      );
    }
    if (parent.path === folder.path || String(parent.path).startsWith(`${folder.path}/`)) {
      throw new AppError(
        'A folder cannot be moved into its own subfolder',
        'ফোল্ডারকে তার নিজের সাবফোল্ডারে সরানো যাবে না',
        400
      );
    }
  }

  const newDepth = parent ? parent.depth + 1 : 0;
  const shift = newDepth - folder.depth;

  // The deepest DESCENDANT, not the folder itself. Moving a two-level subtree
  // one level down buries its leaves; checking only the moved folder's own new
  // depth lets that straight through.
  const deepest = descendants.reduce((max, d) => Math.max(max, d.depth), folder.depth);
  if (deepest + shift > maxDepth) {
    throw new AppError(
      `Moving this folder would nest its contents past ${maxDepth + 1} levels`,
      `এই ফোল্ডার সরালে ভিতরের ফোল্ডারগুলো ${maxDepth + 1} স্তরের বেশি গভীরে চলে যাবে`,
      400
    );
  }

  return {
    newPath: MediaFolder.joinPath(parent?.path || '', folder.slug),
    newDepth,
    shift,
  };
}

/** ASCII, lowercase, hyphen-separated, bounded to the model's segment pattern. */
function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/** A path goes into a `$regex`, so its own characters must not be operators. */
function escapeRegex(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = new MediaFolderService();
module.exports.slugify = slugify;
module.exports.escapeRegex = escapeRegex;
module.exports.rollUpUsage = rollUpUsage;
module.exports.planMove = planMove;
module.exports.MAX_SLUG_ATTEMPTS = MAX_SLUG_ATTEMPTS;
