/**
 * The R2 storage pool.
 *
 * One place decides which Cloudflare bucket the next object goes into, does the
 * PUT, keeps the byte counters honest, and fails over when a bucket misbehaves.
 * `services/media.service.js` (image pipeline) is its only intended caller —
 * nothing else should construct an S3 client.
 *
 * The shape is deliberately the same as `gemini.service`: a pool of provider
 * accounts, a "pick the least loaded one" selector, per-account status, and a
 * retry loop that moves to the next account rather than failing the request.
 *
 * ── THE RESERVATION DANCE ────────────────────────────────────────────────────
 * The naive version — "find the emptiest bucket, upload, add the bytes" — has a
 * race with a window the width of an HTTP upload. Two 400MB uploads both see
 * 500MB free, both proceed, and the bucket ends up 300MB over capacity with no
 * way to notice until a write fails at Cloudflare.
 *
 * So every upload is three steps:
 *
 *   reserve(bytes)  → atomic $inc of reservedBytes, guarded by a $expr that
 *                     re-checks capacity INSIDE the update. Losing the race
 *                     means the update matches nothing and we try the next
 *                     account. No locks, no transactions, one round trip.
 *   put(...)        → the actual object write
 *   commit()/release() → move the bytes from reserved to used, or give them back
 *
 * `release` runs in a `finally`. A process killed between reserve and release
 * leaks a reservation, which is why `releaseStaleReservations()` exists and why
 * the daily job must call it — a leaked reservation is invisible except as a
 * bucket that mysteriously stops accepting uploads.
 *
 * ── WHAT THIS SERVICE DOES NOT DO ────────────────────────────────────────────
 * No image processing, no per-shop quota, no refCounting. Those belong to the
 * media layer. This service knows about buckets and bytes.
 */

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

const R2Account = require('../models/R2Account.model');
const PlatformSetting = require('../models/PlatformSetting.model');
const { AppError } = require('../middleware/error.middleware');
const crypto = require('../utils/crypto.util');
const logger = require('../utils/logger.util');

// How many different accounts one upload may try before giving up. Beyond a
// handful the user is waiting on a queue of failures; better to surface it.
const MAX_ATTEMPTS = 3;

// A reservation older than this cannot belong to a live request — the upload
// timeout is far shorter — so it is a leak from a crashed process.
const RESERVATION_TTL_MS = 60 * 60 * 1000; // 1 hour

class StorageService {
  constructor() {
    /** @type {Map<string, {client: S3Client, at: number}>} keyed by account id */
    this._clients = new Map();
  }

  // ── Configuration ─────────────────────────────────────────────────────────

  /**
   * Whether the pool can accept an upload at all.
   * Both halves matter: accounts with no encryption key are unusable, and an
   * encryption key with no accounts has nowhere to put anything.
   */
  async isConfigured() {
    if (!crypto.isConfigured()) return false;
    const count = await R2Account.countDocuments({ isActive: true, status: 'active' });
    return count > 0;
  }

  /** The allocation strategy, defaulting safely when settings are unreachable. */
  async getStrategy() {
    try {
      const settings = await PlatformSetting.current();
      return settings?.storageStrategy === 'round_robin' ? 'round_robin' : 'least_used';
    } catch (err) {
      logger.warn(`Could not read storageStrategy, defaulting to least_used: ${err.message}`);
      return 'least_used';
    }
  }

  // ── Client construction ───────────────────────────────────────────────────

  /**
   * An S3 client for one account. Cached — building a client per upload means
   * re-decrypting the secret and re-doing credential resolution every time.
   *
   * The account MUST have been loaded with `.select('+secretAccessKeyEnc')`.
   *
   * @param {Object} account hydrated R2Account with the secret field
   * @returns {S3Client}
   */
  _clientFor(account) {
    const id = String(account._id);
    const cached = this._clients.get(id);
    // `updatedAt` busts the cache when an admin edits credentials — otherwise a
    // corrected key would not take effect until the process restarted.
    const stamp = account.updatedAt ? new Date(account.updatedAt).getTime() : 0;
    if (cached && cached.stamp === stamp) return cached.client;

    if (!account.secretAccessKeyEnc) {
      throw new AppError(
        'R2 account was loaded without its secret key — this is a bug in the caller',
        'স্টোরেজ অ্যাকাউন্ট সঠিকভাবে লোড হয়নি',
        500
      );
    }

    const secretAccessKey = crypto.isEncrypted(account.secretAccessKeyEnc)
      ? crypto.decrypt(account.secretAccessKeyEnc)
      // Tolerated so a hand-inserted document during setup does not 500. Never
      // written this way by our own code — the admin service always encrypts.
      : account.secretAccessKeyEnc;

    const client = new S3Client({
      region: 'auto',
      endpoint: account.endpoint,
      credentials: { accessKeyId: account.accessKeyId, secretAccessKey },
      // R2 rejects the flexible-checksum headers the SDK started sending by
      // default in v3.729+ (`x-amz-checksum-crc32` on every PUT). Without these
      // two lines every upload fails with an opaque signature error. This is
      // the workaround Cloudflare documents; do not remove without testing an
      // actual PUT against R2.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });

    this._clients.set(id, { client, stamp });
    return client;
  }

  /** Drop a cached client — call after credentials change or an account is removed. */
  forgetClient(accountId) {
    this._clients.delete(String(accountId));
  }

  // ── Allocation ────────────────────────────────────────────────────────────

  /**
   * Reserve capacity for one object, atomically.
   *
   * Returns the account that won, with its secret loaded and ready to upload
   * with. The caller MUST eventually call `commit()` or `release()` with the
   * same byte count.
   *
   * @param {number} bytes         size of the object about to be written
   * @param {string[]} excludeIds  accounts already tried and failed this request
   * @returns {Promise<Object>} hydrated R2Account (with secret)
   */
  async reserve(bytes, excludeIds = []) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      throw new AppError('Invalid object size for reservation', 'ফাইলের সাইজ সঠিক নয়', 400);
    }

    const strategy = await this.getStrategy();
    const excluded = excludeIds.map(String);

    const candidates = await R2Account.find({
      isActive: true,
      status: 'active',
      _id: { $nin: excluded },
    }).select('_id capacityBytes usedBytes reservedBytes priority').lean();

    const roomy = candidates.filter(
      (a) => a.usedBytes + a.reservedBytes + bytes <= a.capacityBytes
    );

    if (roomy.length === 0) {
      throw new AppError(
        'Every storage account is full or unavailable',
        'সবগুলো স্টোরেজ অ্যাকাউন্ট পূর্ণ — অ্যাডমিনের সাথে যোগাযোগ করুন',
        507
      );
    }

    const ordered = strategy === 'round_robin'
      ? await this._orderByRoundRobin(roomy)
      : this._orderByUsedRatio(roomy);

    // Try each in turn. The $expr re-checks capacity as part of the update, so
    // whoever wins the write is guaranteed to fit — a loser simply matches
    // nothing and we move on. This is the entire concurrency story.
    for (const candidate of ordered) {
      const won = await R2Account.findOneAndUpdate(
        {
          _id: candidate._id,
          isActive: true,
          status: 'active',
          $expr: {
            $lte: [
              { $add: ['$usedBytes', '$reservedBytes', bytes] },
              '$capacityBytes',
            ],
          },
        },
        {
          $inc: { reservedBytes: bytes },
          $set: { lastUsedAt: new Date() },
        },
        { new: true }
      ).select('+secretAccessKeyEnc');

      if (won) return won;
    }

    throw new AppError(
      'Could not reserve storage capacity — all candidates were taken concurrently',
      'স্টোরেজ বরাদ্দ করা যায়নি, আবার চেষ্টা করুন',
      507
    );
  }

  /** Lowest (used+reserved)/capacity first; `priority` breaks ties. */
  _orderByUsedRatio(accounts) {
    return [...accounts].sort((a, b) => {
      const ra = (a.usedBytes + a.reservedBytes) / (a.capacityBytes || 1);
      const rb = (b.usedBytes + b.reservedBytes) / (b.capacityBytes || 1);
      if (ra !== rb) return ra - rb;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return String(a._id).localeCompare(String(b._id));
    });
  }

  /**
   * Strict rotation by a stored cursor.
   *
   * The cursor advances on every allocation, so consecutive uploads land on
   * consecutive accounts regardless of how full each one is. Kept because it is
   * the behaviour people mean when they say "round robin"; `least_used` is the
   * default because this one degrades badly the moment capacities differ.
   */
  async _orderByRoundRobin(accounts) {
    // Stable order first, so the cursor means the same thing across processes.
    const stable = [...accounts].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return String(a._id).localeCompare(String(b._id));
    });

    let start = 0;
    try {
      const settings = await PlatformSetting.findOneAndUpdate(
        { key: 'platform' },
        { $inc: { storageRoundRobinCursor: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      start = Math.abs(settings?.storageRoundRobinCursor || 0) % stable.length;
    } catch (err) {
      logger.warn(`Round-robin cursor unavailable, falling back to order: ${err.message}`);
    }

    return [...stable.slice(start), ...stable.slice(0, start)];
  }

  /** Turn a reservation into used capacity after a successful write. */
  async commit(accountId, bytes, { files = 1, classAOps = 1 } = {}) {
    await R2Account.updateOne(
      { _id: accountId },
      {
        $inc: {
          usedBytes: bytes,
          fileCount: files,
          reservedBytes: -bytes,
          classAOpsMonth: classAOps,
        },
        $set: { lastUsedAt: new Date(), lastErrorMessage: null },
      }
    );

    // Flip to `full` once there is no room left, so allocation stops
    // considering it instead of failing the $expr on every future upload.
    await this._markFullIfExhausted(accountId);
  }

  /**
   * Hand a reservation back. Never throws — it runs in `finally` blocks, and an
   * exception here would mask the real upload error the caller is about to
   * report.
   */
  async release(accountId, bytes) {
    try {
      await R2Account.updateOne(
        { _id: accountId },
        { $inc: { reservedBytes: -bytes } }
      );
      // Guard against a double-release or a stale-sweeper overlap driving the
      // counter below zero, which would then over-report free space.
      await R2Account.updateOne(
        { _id: accountId, reservedBytes: { $lt: 0 } },
        { $set: { reservedBytes: 0 } }
      );
    } catch (err) {
      logger.warn(`Failed to release ${bytes}B reservation on ${accountId}: ${err.message}`);
    }
  }

  /** Bytes released, in used terms — after a successful delete. */
  async uncommit(accountId, bytes, { files = 1 } = {}) {
    await R2Account.updateOne(
      { _id: accountId },
      { $inc: { usedBytes: -bytes, fileCount: -files, classAOpsMonth: 1 } }
    );
    await R2Account.updateOne(
      { _id: accountId, usedBytes: { $lt: 0 } },
      { $set: { usedBytes: 0 } }
    );
    await R2Account.updateOne(
      { _id: accountId, fileCount: { $lt: 0 } },
      { $set: { fileCount: 0 } }
    );
    // Space freed up — a `full` account can take writes again.
    await R2Account.updateOne(
      { _id: accountId, status: 'full', $expr: { $lt: ['$usedBytes', '$capacityBytes'] } },
      { $set: { status: 'active' } }
    );
  }

  async _markFullIfExhausted(accountId) {
    await R2Account.updateOne(
      {
        _id: accountId,
        status: 'active',
        $expr: { $gte: [{ $add: ['$usedBytes', '$reservedBytes'] }, '$capacityBytes'] },
      },
      { $set: { status: 'full' } }
    );
  }

  /**
   * Take an account out of rotation after a write failure.
   *
   * Not `isActive: false` — that reads as "an admin switched this off". `error`
   * says "the platform stopped trusting it", and the admin panel offers a Test
   * button to put it back.
   */
  async markError(accountId, message) {
    try {
      await R2Account.updateOne(
        { _id: accountId },
        {
          $set: {
            status: 'error',
            lastErrorMessage: String(message || 'Unknown storage error').slice(0, 500),
          },
        }
      );
      logger.warn(`R2 account ${accountId} marked as error: ${message}`);
    } catch (err) {
      logger.warn(`Failed to mark R2 account ${accountId} as error: ${err.message}`);
    }
  }

  // ── Object operations ─────────────────────────────────────────────────────

  /**
   * Write one object, choosing an account and failing over on error.
   *
   * @param {Object}  params
   * @param {string}  params.key          object key, e.g. `<shopId>/<mediaId>.webp`
   * @param {Buffer}  params.body
   * @param {string}  params.contentType
   * @param {Object}  [params.metadata]   small string map stored on the object
   * @returns {Promise<{account, key, url, bytes}>}
   */
  async upload({ key, body, contentType = 'application/octet-stream', metadata = {} }) {
    const group = await this.uploadGroup([{ key, body, contentType, metadata }]);
    const [only] = group.objects;
    return {
      account: group.account,
      accountName: group.accountName,
      key: only.key,
      url: only.url,
      bytes: only.bytes,
    };
  }

  /**
   * Write several objects that must live or die together, on ONE account.
   *
   * This exists because `ShopMedia` records a single `account` for an image and
   * its thumbnail and its medium rendition. Uploading the three separately
   * would let them land in three different buckets, and then:
   *
   *   · reclamation deletes all three keys from the one recorded account, so
   *     two of them survive forever as ghosts nobody can find, and
   *   · `uncommit` returns the whole byte total to one account, quietly
   *     corrupting the capacity figures on all three.
   *
   * So the reservation covers the SUM, and failover moves the entire set to the
   * next account rather than retrying the one object that failed. Objects
   * already written to the abandoned account are deleted on the way out —
   * best-effort, because at that point the account is already misbehaving, and
   * a leftover object is a reconciliation ghost rather than a correctness bug.
   *
   * @param {Array<{key: string, body: Buffer, contentType?: string, metadata?: Object}>} objects
   * @returns {Promise<{account, accountName, bytes, objects: Array<{key, url, bytes}>}>}
   */
  async uploadGroup(objects) {
    if (!Array.isArray(objects) || objects.length === 0) {
      throw new AppError('Nothing to upload', 'আপলোড করার মতো কিছু নেই', 400);
    }

    for (const obj of objects) {
      if (!obj?.key || !Buffer.isBuffer(obj.body) || obj.body.length === 0) {
        throw new AppError('Nothing to upload', 'আপলোড করার মতো কিছু নেই', 400);
      }
    }

    if (!crypto.isConfigured()) {
      throw new AppError(
        'Storage encryption key is not configured (STORAGE_ENC_KEY)',
        'স্টোরেজ সার্ভিস কনফিগার করা হয়নি',
        503
      );
    }

    const totalBytes = objects.reduce((sum, o) => sum + o.body.length, 0);
    const tried = [];
    let lastError = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let account;
      try {
        account = await this.reserve(totalBytes, tried);
      } catch (err) {
        // Nothing left to reserve. If earlier accounts failed at the transport
        // level, that is the more actionable error — "all accounts are full" is
        // misleading when the truth is "all three we tried rejected the write".
        if (tried.length > 0 && lastError) break;
        throw err;
      }

      tried.push(String(account._id));
      let committed = false;

      // Built before the write loop's try/catch on purpose: a decrypt failure
      // means OUR key is wrong, not that Cloudflare misbehaved, and marking
      // every account as `error` for it would take the whole pool down and
      // require an admin to re-test each one by hand.
      let client;
      try {
        client = this._clientFor(account);
      } catch (err) {
        await this.release(account._id, totalBytes);
        throw err;
      }

      const written = [];
      try {
        for (const obj of objects) {
          await client.send(new PutObjectCommand({
            Bucket: account.bucket,
            Key: obj.key,
            Body: obj.body,
            ContentType: obj.contentType || 'application/octet-stream',
            // Product images are immutable — a new image is a new key — so they
            // can be cached for a year. This is the single biggest lever on R2
            // Class B operations and on how the gallery feels on a slow phone.
            CacheControl: 'public, max-age=31536000, immutable',
            Metadata: obj.metadata || {},
          }));
          written.push(obj.key);
        }

        await this.commit(account._id, totalBytes, {
          files: objects.length,
          // Every PUT is one Class A operation, and the free tier is counted in
          // operations as well as bytes. Charging one per group would under-
          // report by 3x on the only path that writes anything.
          classAOps: objects.length,
        });
        committed = true;

        return {
          account: account._id,
          accountName: account.name,
          bytes: totalBytes,
          objects: objects.map((obj) => ({
            key: obj.key,
            url: this.publicUrlFor(account, obj.key),
            bytes: obj.body.length,
          })),
        };
      } catch (err) {
        lastError = err;
        logger.warn(
          `R2 upload failed on account "${account.name}" ` +
          `(${written.length}/${objects.length} written, key ${objects[written.length]?.key}): ${err.message}`
        );
        await this.markError(account._id, err.message);
        if (written.length > 0) {
          // Not awaited for correctness, but awaited anyway: the caller is about
          // to fail over and we would rather the partial set be gone before the
          // next attempt writes the same logical image somewhere else.
          await this.deleteObjects(account, written).catch(() => {});
        }
        // Continue to the next account.
      } finally {
        if (!committed) await this.release(account._id, totalBytes);
      }
    }

    throw new AppError(
      `Upload failed on ${tried.length} storage account(s): ${lastError?.message || 'unknown error'}`,
      'ছবি আপলোড করা যায়নি, একটু পরে আবার চেষ্টা করুন',
      502
    );
  }

  /**
   * Delete objects from ONE account.
   *
   * Byte accounting is the caller's job (it knows what each key weighed) — pass
   * the total to `uncommit` afterwards. Returns the keys R2 confirmed gone.
   *
   * @param {Object} account  hydrated R2Account (secret loaded)
   * @param {string[]} keys   max 1000 per call, an S3 API limit
   */
  async deleteObjects(account, keys) {
    if (!Array.isArray(keys) || keys.length === 0) return { deleted: [], errors: [] };

    const client = this._clientFor(account);
    const deleted = [];
    const errors = [];

    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      try {
        const res = await client.send(new DeleteObjectsCommand({
          Bucket: account.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: false },
        }));
        (res.Deleted || []).forEach((d) => deleted.push(d.Key));
        (res.Errors || []).forEach((e) => errors.push({ key: e.Key, message: e.Message }));
      } catch (err) {
        logger.warn(`R2 batch delete failed on "${account.name}": ${err.message}`);
        chunk.forEach((k) => errors.push({ key: k, message: err.message }));
      }
    }

    await R2Account.updateOne({ _id: account._id }, { $inc: { classAOpsMonth: 1 } });
    return { deleted, errors };
  }

  /**
   * List object keys under a prefix. Used by reconciliation, not by request
   * handlers — this is Class B operations and a full bucket walk is expensive.
   */
  async listObjects(account, { prefix = '', continuationToken = null, maxKeys = 1000 } = {}) {
    const res = await this._clientFor(account).send(new ListObjectsV2Command({
      Bucket: account.bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken || undefined,
      MaxKeys: maxKeys,
    }));

    await R2Account.updateOne({ _id: account._id }, { $inc: { classBOpsMonth: 1 } });

    return {
      objects: (res.Contents || []).map((o) => ({
        key: o.Key,
        size: o.Size,
        lastModified: o.LastModified,
      })),
      nextToken: res.IsTruncated ? res.NextContinuationToken : null,
    };
  }

  /**
   * Verify credentials against the live bucket.
   *
   * Takes raw fields rather than a document so the admin panel can test an
   * account BEFORE saving it — the alternative is storing a broken credential
   * and discovering it on a user's first upload.
   */
  async testConnection({ endpoint, accessKeyId, secretAccessKey, bucket }) {
    if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
      return { ok: false, error: 'endpoint, accessKeyId, secretAccessKey and bucket are all required' };
    }

    const client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });

    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return { ok: true };
    } catch (err) {
      const code = err?.$metadata?.httpStatusCode;
      let hint = err.message;
      if (code === 403) hint = 'Access denied — check the API token permissions (needs Object Read & Write)';
      if (code === 404) hint = `Bucket "${bucket}" not found on this account`;
      return { ok: false, error: hint, statusCode: code || null };
    } finally {
      client.destroy?.();
    }
  }

  // ── Housekeeping ──────────────────────────────────────────────────────────

  /**
   * Zero out reservations left behind by crashed processes.
   *
   * Blunt on purpose: it cannot tell a leaked reservation from a live one, so
   * it only runs against accounts whose last activity is older than the TTL. A
   * genuinely long upload would have touched `lastUsedAt` when it reserved.
   *
   * @returns {Promise<number>} accounts corrected
   */
  async releaseStaleReservations(ttlMs = RESERVATION_TTL_MS) {
    const cutoff = new Date(Date.now() - ttlMs);
    const res = await R2Account.updateMany(
      { reservedBytes: { $gt: 0 }, lastUsedAt: { $lt: cutoff } },
      { $set: { reservedBytes: 0 } }
    );
    if (res.modifiedCount > 0) {
      logger.info(`Released stale byte reservations on ${res.modifiedCount} R2 account(s)`);
    }
    return res.modifiedCount;
  }

  /** Reset the Class A/B counters when the calendar month turns over. */
  async rollMonthlyOps() {
    const month = new Date().toISOString().slice(0, 7);
    if (this._lastOpsRollMonth === month) return 0;

    const res = await R2Account.updateMany(
      { opsResetMonth: { $ne: month } },
      { $set: { classAOpsMonth: 0, classBOpsMonth: 0, opsResetMonth: month } }
    );
    this._lastOpsRollMonth = month;
    return res.modifiedCount;
  }

  // ── Reads for the admin panel ─────────────────────────────────────────────

  /** Public URL for an object. The one place account hostnames are applied. */
  publicUrlFor(account, key) {
    if (!account?.publicBaseUrl || !key) return '';
    return `${String(account.publicBaseUrl).replace(/\/+$/, '')}/${String(key).replace(/^\/+/, '')}`;
  }

  /**
   * Pool totals for the storage dashboard.
   *
   * `allocated` (the sum of every enabled shop's quota) is deliberately NOT
   * computed here — it belongs to the shop side and is joined in the admin
   * service, which is what turns these numbers into the overcommit ratio.
   */
  async getPoolSummary() {
    const [totals] = await R2Account.aggregate([
      {
        $group: {
          _id: null,
          accounts: { $sum: 1 },
          activeAccounts: {
            $sum: { $cond: [{ $and: [{ $eq: ['$isActive', true] }, { $eq: ['$status', 'active'] }] }, 1, 0] },
          },
          capacityBytes: { $sum: '$capacityBytes' },
          // Only accounts that can actually take writes count as usable space.
          usableCapacityBytes: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$isActive', true] }, { $eq: ['$status', 'active'] }] },
                '$capacityBytes',
                0,
              ],
            },
          },
          usedBytes: { $sum: '$usedBytes' },
          reservedBytes: { $sum: '$reservedBytes' },
          fileCount: { $sum: '$fileCount' },
          classAOpsMonth: { $sum: '$classAOpsMonth' },
          classBOpsMonth: { $sum: '$classBOpsMonth' },
        },
      },
    ]);

    const base = totals || {
      accounts: 0,
      activeAccounts: 0,
      capacityBytes: 0,
      usableCapacityBytes: 0,
      usedBytes: 0,
      reservedBytes: 0,
      fileCount: 0,
      classAOpsMonth: 0,
      classBOpsMonth: 0,
    };
    delete base._id;

    return {
      ...base,
      freeBytes: Math.max(0, base.capacityBytes - base.usedBytes - base.reservedBytes),
      usedPercent: base.capacityBytes ? (base.usedBytes / base.capacityBytes) * 100 : 0,
      encryptionConfigured: crypto.isConfigured(),
    };
  }

  /** One account with its secret, for operations that need to talk to R2. */
  async getAccountWithSecret(accountId) {
    const account = await R2Account.findById(accountId).select('+secretAccessKeyEnc');
    if (!account) {
      throw new AppError('Storage account not found', 'স্টোরেজ অ্যাকাউন্ট পাওয়া যায়নি', 404);
    }
    return account;
  }
}

module.exports = new StorageService();
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
module.exports.RESERVATION_TTL_MS = RESERVATION_TTL_MS;
