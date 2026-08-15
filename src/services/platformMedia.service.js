/**
 * The platform media library — upload, references, reclamation.
 *
 * ADMIN-ONLY in both directions (MEDIA_GALLERY_PLAN.md I-20). No shop-facing
 * route may call into this file.
 *
 * ── THIS SERVICE HAS NO CONSUMERS, AND THAT IS THE POINT ────────────────────
 *
 * The library stores files, tracks bytes, and answers "what is using this". It
 * does not know what a landing page is, or a template, or anything else that
 * might one day hold a reference. Consumers REGISTER themselves at startup
 * (`registerConsumer`) and talk to the library through `setOwnerRefs`; the
 * library talks back only through the callbacks they supplied.
 *
 * If an `import` of some other feature appears in this file, the dependency has
 * been inverted and the fix belongs in that feature.
 *
 * ── THE QUOTA IS A COMPARE-AND-SWAP, FOR THE SAME REASON THE SHOP ONE IS ────
 *
 * `media.service` explains it at length: reading a used-bytes figure and then
 * incrementing it is a race whose window is the width of an HTTP upload, and two
 * uploads inside that window both measure themselves against the same stale
 * number. So the allowance is re-checked against the LIVE `PlatformSetting`
 * document inside the same round trip that increments it. Losing matches
 * nothing and is a 413.
 *
 * The charge happens BEFORE the objects are written and is refunded if the write
 * fails, so the counter can never claim fewer bytes than the bucket holds.
 */

const nodeCrypto = require('crypto');
const mongoose = require('mongoose');

const PlatformMedia = require('../models/PlatformMedia.model');
const PlatformSetting = require('../models/PlatformSetting.model');
const storageService = require('./storage.service');
const imagePipeline = require('../utils/imagePipeline.util');
const { AppError } = require('../middleware/error.middleware');
const {
  MB,
  assertPlatformCanStore,
  platformMediaSettings,
  platformMediaState,
  platformStorageSettings,
} = require('../utils/storageQuota.util');
const logger = require('../utils/logger.util');

// Matches `media.service`: long enough to cover "I'll finish this tomorrow",
// short enough that an abandoned upload is not held for a week.
const STAGED_TTL_MS = 48 * 60 * 60 * 1000;

const RECLAIM_BATCH = 200;

/** Page size for the gallery grid. */
const LIST_LIMIT = 60;

class PlatformMediaService {
  constructor() {
    /**
     * ownerType -> { label, resolve, confirmInUse }
     *
     * A Map rather than a constant so the set of consumers is a runtime fact.
     * See the header: a hard-coded list here would make every new consumer a
     * change to this file.
     */
    this._consumers = new Map();
  }

  // ── The consumer registry ─────────────────────────────────────────────────

  /**
   * Declare that a feature may hold references to library files.
   *
   * @param {Object} consumer
   * @param {string} consumer.ownerType     the consumer's own name, e.g. 'landingPage'
   * @param {string} consumer.label         Bengali label for the "used by" list
   * @param {Function} [consumer.resolve]   async (ownerIds) => [{ id, label, href, isLive }]
   * @param {Function} [consumer.confirmInUse] async (mediaIds) => mediaIds still in use
   */
  registerConsumer({ ownerType, label, resolve = null, confirmInUse = null }) {
    const key = String(ownerType || '').trim();
    if (!key) throw new Error('registerConsumer needs an ownerType');

    if (this._consumers.has(key)) {
      // Not fatal — a test re-requiring a module would hit it — but it means two
      // features chose one name, and the second would silently answer for the
      // first's references.
      logger.warn(`Media consumer "${key}" was registered twice; the later registration wins`);
    }

    this._consumers.set(key, { label: label || key, resolve, confirmInUse });
  }

  /** For tests and for the admin screen's "used by" grouping. */
  consumers() {
    return [...this._consumers.entries()].map(([ownerType, c]) => ({ ownerType, label: c.label }));
  }

  assertOwnerType(ownerType) {
    if (!this._consumers.has(String(ownerType))) {
      throw new AppError(
        `Unknown media consumer "${ownerType}" — register it before attaching references`,
        'অজানা রেফারেন্স উৎস',
        400
      );
    }
  }

  // ── Readiness ─────────────────────────────────────────────────────────────

  async isReady() {
    if (!imagePipeline.isAvailable()) return false;
    return storageService.isConfigured();
  }

  /**
   * May a video be served to real traffic yet?
   *
   * False while every serving bucket is still on an `r2.dev` public hostname.
   * Cloudflare rate-limits `r2.dev` and states it is not for production traffic
   * (R2_STORAGE_PLAN.md §৭.৩); a 20MB video to a few thousand visitors is
   * exactly the load that gets throttled, and the failure reads downstream as
   * "the page is broken".
   *
   * The library reports the fact. Refusing to PUBLISH on it is the consumer's
   * job — see MEDIA_GALLERY_PLAN.md §6.4.
   */
  async isVideoServable() {
    const R2Account = require('../models/R2Account.model');
    const accounts = await R2Account.find({ isActive: true }).select('publicBaseUrl').lean();
    if (accounts.length === 0) return false;
    return accounts.every((a) => !/(^|\/\/)[^/]*\br2\.dev\b/i.test(String(a.publicBaseUrl || '')));
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  /**
   * Store one image in the library.
   *
   * Ordering is the same as `media.service.uploadImage` and for the same
   * reasons: render first (cheap to fail, and it reveals the true byte cost),
   * then dedupe (a hit stores nothing, so it must precede the byte gate), then
   * charge, then write.
   *
   * @param {Object} file      multer memory-storage file
   * @param {Object} [options] { folder, title, altText, tags, adminId }
   */
  async uploadImage(file, { folder = null, title = null, altText = null, tags = [], adminId = null } = {}) {
    imagePipeline.assertAvailable();

    const buffer = file?.buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new AppError('Please select an image file', 'একটি ছবি নির্বাচন করুন', 400);
    }

    // Cheap pre-flight so an already-full library refuses before we decode.
    const settings = await platformMediaSettings();
    await assertPlatformCanStore(0, settings);

    const renditions = await imagePipeline.renderAll(buffer);
    const original = renditions.find((r) => r.name === 'original');
    const totalBytes = renditions.reduce((sum, r) => sum + r.buffer.length, 0);

    const hash = nodeCrypto.createHash('sha256').update(original.buffer).digest('hex');

    // Platform-wide, with no shop dimension — the whole point of this being its
    // own collection. One photo used in twenty places is stored once.
    const existing = await PlatformMedia.findOne({ hash });
    if (existing) {
      // A dedupe hit still honours an explicit folder: the admin uploading into
      // a folder means "I want it here", and silently leaving it where a
      // previous upload put it looks like the upload failed.
      if (folder && String(existing.folder || '') !== String(folder)) {
        existing.folder = folder;
        await existing.save();
      }
      return { media: existing, deduped: true };
    }

    await assertPlatformCanStore(totalBytes, settings);

    const quotaBytes = (settings.quotaMb ?? 0) * MB;
    const charged = await this._chargeUsage(totalBytes, 1, quotaBytes);
    if (!charged) {
      // Lost the race against a concurrent upload. Re-read and produce the real
      // numbers rather than guessing at a message.
      await assertPlatformCanStore(totalBytes, await platformMediaSettings());
      throw new AppError(
        'Could not reserve library space, please try again',
        'গ্যালারিতে জায়গা বরাদ্দ করা যায়নি, আবার চেষ্টা করুন',
        413
      );
    }

    // Generated up front because the object keys embed it — the alternative is
    // uploading to a temporary key and renaming, and a rename in S3 is a copy
    // plus a delete.
    const mediaId = new mongoose.Types.ObjectId();

    const objects = renditions.map((r) => ({
      key: `platform/${mediaId}${r.suffix}.webp`,
      body: r.buffer,
      contentType: imagePipeline.CONTENT_TYPE,
      metadata: { scope: 'platform', rendition: r.name },
    }));

    let group;
    try {
      group = await storageService.uploadGroup(objects);
    } catch (err) {
      await this._refundUsage(totalBytes, 1);
      throw err;
    }

    const urlFor = (suffix) =>
      group.objects.find((o) => o.key === `platform/${mediaId}${suffix}.webp`)?.url || '';

    try {
      const media = await PlatformMedia.create({
        _id: mediaId,
        hash,
        kind: 'image',
        folder: folder || null,
        account: group.account,
        objectKey: `platform/${mediaId}.webp`,
        mediumKey: `platform/${mediaId}_m.webp`,
        thumbKey: `platform/${mediaId}_t.webp`,
        url: urlFor(''),
        mediumUrl: urlFor('_m'),
        thumbUrl: urlFor('_t'),
        bytes: original.buffer.length,
        totalBytes,
        width: original.width,
        height: original.height,
        mime: imagePipeline.CONTENT_TYPE,
        originalName: typeof file.originalname === 'string' ? file.originalname.slice(0, 200) : null,
        title: title ? String(title).slice(0, 200) : null,
        altText: altText ? String(altText).slice(0, 300) : null,
        tags: normalizeTags(tags),
        status: 'staged',
        refCount: 0,
        uploadedBy: adminId,
      });

      return { media, deduped: false };
    } catch (err) {
      // The bytes are in the bucket with no document pointing at them. Unwind
      // first, decide what to report after.
      await this._discardObjects(group, objects.map((o) => o.key));
      await this._refundUsage(totalBytes, 1);

      // Two identical uploads raced past the dedupe read; the unique `hash`
      // index caught the loser. From the caller's side that is a dedupe hit.
      if (err?.code === 11000) {
        const winner = await PlatformMedia.findOne({ hash });
        if (winner) return { media: winner, deduped: true };
      }
      throw err;
    }
  }

  // ── References — the consumer contract ────────────────────────────────────

  /**
   * Declare the complete set of files one owner references, for one origin.
   *
   * Whole-set reconciliation rather than attach/detach calls, for the reason
   * `media.service.reconcileRefs` gives: consumers save whole documents, so a
   * form the user abandons, a request that fails halfway or a tab closed
   * mid-edit can never leave a reference behind — the refs only move when the
   * owner document moves.
   *
   * `origin` partitions the set. A `scanned` pass replaces only what a previous
   * scan found and never touches what the owner attached explicitly; collapsing
   * the two would make each pass delete the other's work.
   *
   * One owner referencing the same file under two keys collapses to ONE
   * reference — the same decision `reconcileRefs` documents. `refCount` answers
   * "may this be deleted", and 1-vs-2 there changes nothing except the ways it
   * can drift.
   *
   * @param {string} ownerType
   * @param {ObjectId|string} ownerId
   * @param {Array<{mediaId, key?}|string>} entries
   * @param {Object} [options] { origin }
   */
  async setOwnerRefs(ownerType, ownerId, entries, { origin = 'explicit' } = {}) {
    this.assertOwnerType(ownerType);

    const oid = toObjectId(ownerId);
    if (!oid) throw new AppError('A valid ownerId is required', 'রেফারেন্স আইডি সঠিক নয়', 400);

    const desired = new Map();
    for (const raw of entries || []) {
      const mediaId = toObjectId(typeof raw === 'object' && raw !== null ? raw.mediaId : raw);
      if (!mediaId) continue;
      const key = typeof raw === 'object' && raw?.key ? String(raw.key).slice(0, 120) : null;
      if (!desired.has(String(mediaId))) desired.set(String(mediaId), { mediaId, key });
    }

    const match = { ownerType, ownerId: oid, origin };

    const current = await PlatformMedia.find({ refs: { $elemMatch: match } })
      .select('_id')
      .lean();

    const currentIds = current.map((c) => String(c._id));
    const detach = currentIds.filter((id) => !desired.has(id));

    if (detach.length > 0) await this._detachRefs(detach, match);
    if (desired.size > 0) await this._attachRefs([...desired.values()], match);

    return { attached: [...desired.keys()], detached: detach };
  }

  /** Drop every reference an owner holds — call when the owner is deleted. */
  async releaseOwner(ownerType, ownerId) {
    const oid = toObjectId(ownerId);
    if (!oid) return { detached: [] };

    const match = { ownerType: String(ownerType), ownerId: oid };
    const current = await PlatformMedia.find({ refs: { $elemMatch: match } })
      .select('_id')
      .lean();

    if (current.length === 0) return { detached: [] };
    await this._detachRefs(current.map((c) => c._id), match);
    return { detached: current.map((c) => String(c._id)) };
  }

  /** Every file one owner references, hydrated. */
  async mediaForOwner(ownerType, ownerId) {
    const oid = toObjectId(ownerId);
    if (!oid) return [];
    return PlatformMedia.find({ refs: { $elemMatch: { ownerType: String(ownerType), ownerId: oid } } });
  }

  /** Total bytes one owner is responsible for (MEDIA_GALLERY_PLAN.md §5.4). */
  async usageForOwner(ownerType, ownerId) {
    const oid = toObjectId(ownerId);
    if (!oid) return { bytes: 0, files: 0 };

    const [row] = await PlatformMedia.aggregate([
      { $match: { refs: { $elemMatch: { ownerType: String(ownerType), ownerId: oid } } } },
      { $group: { _id: null, bytes: { $sum: '$totalBytes' }, files: { $sum: 1 } } },
    ]);

    return { bytes: row?.bytes || 0, files: row?.files || 0 };
  }

  /**
   * Turn raw refs into something an admin can read: a name and a link per user.
   *
   * This is why `refs` exists at all rather than a bare counter — an admin about
   * to delete a file needs to know WHAT is using it, and that cannot be
   * reconstructed from a number.
   *
   * A consumer with no `resolve` degrades to its label plus the raw id rather
   * than disappearing: an unresolvable reference still blocks a delete, and
   * hiding it would make the block look like a bug.
   */
  async describeRefs(mediaDocs) {
    const byType = new Map();
    for (const doc of mediaDocs || []) {
      for (const ref of doc.refs || []) {
        const type = String(ref.ownerType);
        if (!byType.has(type)) byType.set(type, new Set());
        byType.get(type).add(String(ref.ownerId));
      }
    }

    const out = [];
    for (const [ownerType, idSet] of byType) {
      const consumer = this._consumers.get(ownerType);
      const ids = [...idSet];

      if (!consumer?.resolve) {
        out.push(...ids.map((id) => ({
          ownerType,
          label: consumer?.label || ownerType,
          id,
          href: null,
        })));
        continue;
      }

      try {
        // eslint-disable-next-line no-await-in-loop
        const resolved = await consumer.resolve(ids);
        out.push(...(resolved || []).map((r) => ({ ownerType, label: consumer.label, ...r })));
      } catch (err) {
        // A consumer that throws must not take the gallery screen down with it.
        logger.warn(`Media consumer "${ownerType}" failed to resolve refs: ${err.message}`);
        out.push(...ids.map((id) => ({ ownerType, label: consumer.label, id, href: null })));
      }
    }

    return out;
  }

  /**
   * Ask every consumer whether it is still using any of these files — the I-18
   * backstop.
   *
   * `refs` is maintained by consumers, and a consumer that scans free-form
   * content for URLs is running a parser. Parsers have bugs. So before anything
   * is deleted the library asks directly, and a consumer that says "yes" wins
   * over a `refCount` of zero.
   *
   * FAILS CLOSED: a consumer that throws or times out is treated as claiming
   * everything it was asked about. Deleting bytes because a callback errored is
   * the one outcome this guard exists to prevent.
   *
   * @param {Array<ObjectId|string>} mediaIds
   * @returns {Promise<Set<string>>} ids that are still in use
   */
  async confirmInUse(mediaIds) {
    const ids = (mediaIds || []).map(String);
    const inUse = new Set();
    if (ids.length === 0) return inUse;

    for (const [ownerType, consumer] of this._consumers) {
      if (!consumer.confirmInUse) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const claimed = await consumer.confirmInUse(ids);
        (claimed || []).forEach((id) => inUse.add(String(id)));
      } catch (err) {
        logger.error(
          `Media consumer "${ownerType}" failed its in-use check; treating all ` +
          `${ids.length} candidate(s) as in use: ${err.message}`
        );
        ids.forEach((id) => inUse.add(id));
      }
    }

    return inUse;
  }

  // ── Library management ────────────────────────────────────────────────────

  /**
   * The gallery grid.
   *
   * `folder: null` means the root — files in no folder — and is deliberately
   * distinct from "no filter", which is what `folder: undefined` means. Merging
   * the two would hide unfiled files behind a filter nobody thinks to clear.
   */
  async list({ folder, kind = null, search = null, tag = null, page = 1, limit = LIST_LIMIT } = {}) {
    const query = {};
    if (folder !== undefined) query.folder = folder ? toObjectId(folder) : null;
    if (kind) query.kind = kind;
    if (tag) query.tags = String(tag);

    if (search) {
      const rx = new RegExp(escapeRegex(String(search).trim()), 'i');
      query.$or = [{ title: rx }, { originalName: rx }, { altText: rx }];
    }

    const safeLimit = Math.min(Math.max(Number(limit) || LIST_LIMIT, 1), 200);
    const safePage = Math.max(Number(page) || 1, 1);

    const [items, total] = await Promise.all([
      PlatformMedia.find(query)
        .sort({ createdAt: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit),
      PlatformMedia.countDocuments(query),
    ]);

    return { items, total, page: safePage, limit: safeLimit };
  }

  async getById(mediaId) {
    const media = await PlatformMedia.findById(mediaId);
    if (!media) throw new AppError('File not found', 'ফাইলটি পাওয়া যায়নি', 404);
    return media;
  }

  /** Metadata only — never the bytes, the key or the account. */
  async update(mediaId, { title, altText, tags, folder }) {
    const media = await this.getById(mediaId);

    if (title !== undefined) media.title = title ? String(title).slice(0, 200) : null;
    if (altText !== undefined) media.altText = altText ? String(altText).slice(0, 300) : null;
    if (tags !== undefined) media.tags = normalizeTags(tags);
    // Metadata, not an object move — see MediaFolder.model.js (I-19).
    if (folder !== undefined) media.folder = folder ? toObjectId(folder) : null;

    await media.save();
    return media;
  }

  /**
   * Remove a file from the library.
   *
   * Refused while anything references it. Otherwise it is DETACHED and marked
   * orphaned, not hard-deleted: `STORAGE_HANDOFF.md` §৪.৪ makes hard delete
   * platform-wide forbidden, and the grace period is what makes "I deleted the
   * wrong file" recoverable for a week.
   */
  async remove(mediaId) {
    const media = await this.getById(mediaId);

    if (media.refCount > 0 || (media.refs || []).length > 0) {
      const usedBy = await this.describeRefs([media]);
      const error = new AppError(
        'This file is still in use',
        'এই ফাইলটি এখনো ব্যবহৃত হচ্ছে — আগে সেখান থেকে সরান',
        409
      );
      error.code = 'MEDIA_IN_USE';
      error.usedBy = usedBy;
      throw error;
    }

    // Ask the consumers too. A file with an empty `refs` may still be pasted
    // into someone's content if their scanner missed it (I-18).
    const claimed = await this.confirmInUse([media._id]);
    if (claimed.has(String(media._id))) {
      const error = new AppError(
        'A consumer reports this file is still in use',
        'এই ফাইলটি এখনো কোথাও ব্যবহৃত হচ্ছে',
        409
      );
      error.code = 'MEDIA_IN_USE';
      throw error;
    }

    if (!media.orphanedAt) {
      media.orphanedAt = new Date();
      await media.save();
    }

    return { orphanedAt: media.orphanedAt };
  }

  /** The library's storage position, for the admin screens. */
  async usage() {
    return platformMediaState(await platformMediaSettings());
  }

  // ── Reclamation ───────────────────────────────────────────────────────────

  /** Files uploaded and never attached to anything. */
  async sweepStaged({ olderThanMs = STAGED_TTL_MS, limit = RECLAIM_BATCH } = {}) {
    const cutoff = new Date(Date.now() - olderThanMs);
    return this._reclaim(
      { status: 'staged', refCount: 0, createdAt: { $lt: cutoff } },
      limit,
      'staged'
    );
  }

  /** Files whose last reference went away longer than the grace period ago. */
  async sweepOrphaned({ graceDays = null, limit = RECLAIM_BATCH } = {}) {
    const days = Number.isFinite(graceDays)
      ? graceDays
      : (await platformStorageSettings()).orphanGraceDays;

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return this._reclaim(
      { refCount: 0, orphanedAt: { $ne: null, $lt: cutoff }, status: { $ne: 'broken' } },
      limit,
      'orphaned'
    );
  }

  /**
   * Claim and delete rows matching `filter`, up to `limit`.
   *
   * Same claim-before-delete shape as `media.service._reclaim` — each row is
   * removed with a `findOneAndDelete` carrying the FULL predicate, so two
   * concurrent sweeps cannot both decrement the byte counters, and a reference
   * added between the read and the delete saves the file.
   *
   * What is different here is the consumer check (I-18): the candidate list is
   * filtered through `confirmInUse` BEFORE anything is claimed.
   */
  async _reclaim(filter, limit, label) {
    const result = { scanned: 0, deleted: 0, skipped: 0, protected: 0, failed: 0, bytes: 0 };

    const candidates = await PlatformMedia.find(filter)
      .select('_id account objectKey thumbKey mediumKey totalBytes')
      .limit(limit)
      .lean();

    result.scanned = candidates.length;
    if (candidates.length === 0) return result;

    // I-18 mechanism 2. Anything a consumer still claims is left alone, and the
    // skip is logged loudly: a count that keeps rising means some consumer's
    // reference bookkeeping is broken, and this log is how that gets noticed
    // rather than discovered as a missing image months later.
    const claimed = await this.confirmInUse(candidates.map((c) => c._id));
    const safe = candidates.filter((c) => !claimed.has(String(c._id)));
    result.protected = candidates.length - safe.length;

    if (result.protected > 0) {
      logger.warn(
        `Reclamation (${label}): ${result.protected} file(s) had refCount 0 but a ` +
        'consumer still claims them — reference bookkeeping is out of step'
      );
    }

    const taken = [];
    for (const candidate of safe) {
      // eslint-disable-next-line no-await-in-loop
      const doc = await PlatformMedia.findOneAndDelete({ ...filter, _id: candidate._id }).lean();
      if (doc) taken.push(doc);
      else result.skipped += 1;
    }

    // Grouped by account: `deleteObjects` is one batched R2 call per bucket, and
    // per-file calls would turn a 200-row sweep into 200 Class A operations.
    const byAccount = new Map();
    for (const doc of taken) {
      const key = String(doc.account);
      if (!byAccount.has(key)) byAccount.set(key, []);
      byAccount.get(key).push(doc);
    }

    for (const [accountId, docs] of byAccount) {
      const keys = docs.flatMap((d) => [d.objectKey, d.thumbKey, d.mediumKey].filter(Boolean));
      const bytes = docs.reduce((sum, d) => sum + (d.totalBytes || 0), 0);

      try {
        // eslint-disable-next-line no-await-in-loop
        const account = await storageService.getAccountWithSecret(accountId);
        // eslint-disable-next-line no-await-in-loop
        await storageService.deleteObjects(account, keys);
        // eslint-disable-next-line no-await-in-loop
        await storageService.uncommit(accountId, bytes, { files: keys.length });
        result.deleted += docs.length;
        result.bytes += bytes;
      } catch (err) {
        result.failed += docs.length;
        logger.error(
          `Reclamation (${label}): deleted ${docs.length} row(s) but could not clear ` +
          `${keys.length} object(s) from account ${accountId}: ${err.message}. ` +
          'Reconciliation will collect them.'
        );
      }

      // The library's counters come back regardless of what R2 did — the rows
      // are gone either way, so leaving the bytes charged would report space
      // that nothing can reach.
      // eslint-disable-next-line no-await-in-loop
      await this._refundUsage(bytes, docs.length);
    }

    if (result.deleted > 0 || result.failed > 0 || result.protected > 0) {
      logger.info(
        `Reclamation (${label}, platform): deleted ${result.deleted}, ` +
        `freed ${Math.round(result.bytes / 1024)}KB, skipped ${result.skipped}, ` +
        `protected ${result.protected}, failed ${result.failed}`
      );
    }

    return result;
  }

  /**
   * Recompute the library's byte counters from the documents themselves.
   *
   * The counterpart of `recalculateShopStorage`. The counters are incremental so
   * that the upload gate can be atomic, and anything incremental drifts — a
   * refund that failed, a process killed between two writes. This is the repair,
   * and it is the only thing that may write these two fields other than the
   * charge and refund paths.
   */
  async recalculateUsage() {
    const [row] = await PlatformMedia.aggregate([
      { $group: { _id: null, bytes: { $sum: '$totalBytes' }, files: { $sum: 1 } } },
    ]);

    const bytes = row?.bytes || 0;
    const files = row?.files || 0;

    await PlatformSetting.updateOne(
      { key: 'platform' },
      { $set: { platformMediaUsedBytes: bytes, platformMediaFileCount: files } },
      { upsert: true }
    );

    return { usedBytes: bytes, fileCount: files };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Claim `bytes` of the library's allowance, or refuse.
   *
   * The filter is the enforcement: it compares the LIVE counter against the
   * allowance in the same round trip that increments it. Exactly the shape
   * `media.service._chargeShopUsage` uses, and for the same race.
   */
  async _chargeUsage(bytes, files, quotaBytes) {
    const res = await PlatformSetting.updateOne(
      {
        key: 'platform',
        $expr: {
          $lte: [
            { $add: [{ $ifNull: ['$platformMediaUsedBytes', 0] }, bytes] },
            quotaBytes,
          ],
        },
      },
      [
        {
          $set: {
            platformMediaUsedBytes: {
              $max: [0, { $add: [{ $ifNull: ['$platformMediaUsedBytes', 0] }, bytes] }],
            },
            platformMediaFileCount: {
              $max: [0, { $add: [{ $ifNull: ['$platformMediaFileCount', 0] }, files] }],
            },
          },
        },
      ]
    );

    return res.matchedCount > 0;
  }

  /**
   * Give bytes back. Never throws — every caller is already unwinding a failure
   * and is about to report something more useful. An over-counted library
   * refuses uploads it could have allowed, which is the safe direction, and
   * `recalculateUsage` repairs it.
   */
  async _refundUsage(bytes, files) {
    try {
      await PlatformSetting.updateOne({ key: 'platform' }, [
        {
          $set: {
            platformMediaUsedBytes: {
              $max: [0, { $subtract: [{ $ifNull: ['$platformMediaUsedBytes', 0] }, bytes] }],
            },
            platformMediaFileCount: {
              $max: [0, { $subtract: [{ $ifNull: ['$platformMediaFileCount', 0] }, files] }],
            },
          },
        },
      ]);
    } catch (err) {
      logger.warn(
        `Could not refund ${bytes}B to the platform library: ${err.message}. ` +
        'recalculateUsage will repair it.'
      );
    }
  }

  /** Remove objects written but not recorded, and give the bytes back. */
  async _discardObjects(group, keys) {
    try {
      const account = await storageService.getAccountWithSecret(group.account);
      await storageService.deleteObjects(account, keys);
      await storageService.uncommit(group.account, group.bytes, { files: keys.length });
    } catch (err) {
      logger.warn(
        `Could not unwind ${keys.length} orphaned platform object(s) on account ` +
        `${group.account}: ${err.message}. Reconciliation will collect them.`
      );
    }
  }

  /**
   * Add or refresh one owner's reference on each file.
   *
   * Written as an aggregation-pipeline update so `refCount` is recomputed from
   * the array in the SAME atomic step that changes it. The read-modify-write
   * alternative lets two consumers saving at once leave the count disagreeing
   * with the array it is supposed to summarise — and `refCount` is what the
   * reclamation sweeps index on, so a drifted count is a deleted file.
   */
  async _attachRefs(entries, match) {
    const ops = entries.map(({ mediaId, key }) => ({
      updateOne: {
        filter: { _id: mediaId },
        update: [
          { $set: { refs: { $concatArrays: [withoutMatching(match), [{ ...match, key }]] } } },
          {
            $set: {
              refCount: { $size: '$refs' },
              orphanedAt: null,
              lastAttachedAt: '$$NOW',
              // Only `staged` graduates. A `broken` record — one reconciliation
              // found missing from R2 — must stay broken; pointing something at
              // it does not put the bytes back in the bucket.
              status: { $cond: [{ $eq: ['$status', 'staged'] }, 'active', '$status'] },
            },
          },
        ],
      },
    }));

    if (ops.length > 0) await PlatformMedia.bulkWrite(ops);
  }

  /** Drop one owner's references from each file, and start the grace clock. */
  async _detachRefs(mediaIds, match) {
    await PlatformMedia.updateMany(
      { _id: { $in: mediaIds } },
      [
        { $set: { refs: withoutMatching(match) } },
        { $set: { refCount: { $size: '$refs' } } },
        {
          $set: {
            // Scoped so a file orphaned last week does not have its clock reset
            // by an unrelated save.
            orphanedAt: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$refCount', 0] },
                    { $eq: [{ $ifNull: ['$orphanedAt', null] }, null] },
                  ],
                },
                '$$NOW',
                '$orphanedAt',
              ],
            },
          },
        },
      ]
    );
  }
}

/**
 * `$filter` that removes every ref matching an owner (and origin, when given).
 *
 * `origin` is optional in the match so `releaseOwner` can drop everything an
 * owner holds, while `setOwnerRefs` replaces only one origin's set.
 */
function withoutMatching(match) {
  const conds = [
    { $eq: ['$$r.ownerType', match.ownerType] },
    { $eq: ['$$r.ownerId', match.ownerId] },
  ];
  if (match.origin) conds.push({ $eq: ['$$r.origin', match.origin] });

  return {
    $filter: {
      input: { $ifNull: ['$refs', []] },
      as: 'r',
      cond: { $not: [{ $and: conds }] },
    },
  };
}

/** Lowercased, de-duplicated, bounded. Tags are a filter, not free text. */
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of tags) {
    const tag = String(raw || '').trim().toLowerCase().slice(0, 40);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 20) break;
  }
  return out;
}

function toObjectId(value) {
  if (!value) return null;
  const str = String(value);
  if (!mongoose.Types.ObjectId.isValid(str)) return null;
  return new mongoose.Types.ObjectId(str);
}

function escapeRegex(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = new PlatformMediaService();
// Exported so tests can build an instance with its own consumer registry — the
// singleton's registry is process-wide, and a test that registers into it would
// leak into every other test in the run.
module.exports.PlatformMediaService = PlatformMediaService;
module.exports.STAGED_TTL_MS = STAGED_TTL_MS;
module.exports.RECLAIM_BATCH = RECLAIM_BATCH;
module.exports.LIST_LIMIT = LIST_LIMIT;
module.exports.withoutMatching = withoutMatching;
module.exports.normalizeTags = normalizeTags;
