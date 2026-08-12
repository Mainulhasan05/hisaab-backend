/**
 * R2Account — one Cloudflare R2 bucket in the storage pool.
 *
 * This is the storage twin of `GeminiKey`: a pool of provider accounts the
 * platform rotates between, each with a capacity, a usage counter, a status and
 * a failover story. Read `services/storage.service.js` alongside this.
 *
 * ── THE ONE WAY STORAGE DIFFERS FROM API QUOTA ───────────────────────────────
 * A Gemini key's `requestsToday` resets at midnight. `usedBytes` never resets.
 * Three consequences the schema has to carry:
 *
 *   1. A file that landed in this bucket stays here forever — the public URL is
 *      bound to this account's hostname. "Rotation" only decides where the NEXT
 *      object goes, never where an existing one lives.
 *
 *   2. Allocation must be capacity-AWARE, not just round-robin. Five accounts
 *      of 10GB behave identically under both, but the day one is upgraded to
 *      100GB, round-robin keeps filling the small ones at the same rate and
 *      they fail first. `usedRatio` is what `storage.service` sorts on.
 *
 *   3. Two concurrent uploads both see "this bucket has room" and both commit.
 *      That is what `reservedBytes` exists for — see the atomic reservation in
 *      `storage.service.reserve()`. Nothing outside that method may touch it.
 *
 * ── SECRETS ──────────────────────────────────────────────────────────────────
 * `secretAccessKeyEnc` is AES-256-GCM ciphertext (`utils/crypto.util`), never
 * plaintext, and is `select: false` so it cannot leak through a stray
 * `.find()` in some future admin listing. The only decrypt site is
 * `storage.service._clientFor()`.
 */

const mongoose = require('mongoose');

const GB = 1024 * 1024 * 1024;

const r2AccountSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'অ্যাকাউন্টের নাম দিন'],
    trim: true,
    maxlength: 80,
  },

  // ── Cloudflare connection details ─────────────────────────────────────────
  accountId: {
    type: String,
    required: [true, 'Cloudflare Account ID দিন'],
    trim: true,
  },
  bucket: {
    type: String,
    required: [true, 'Bucket নাম দিন'],
    trim: true,
  },
  // https://<accountId>.r2.cloudflarestorage.com — stored rather than derived so
  // a jurisdiction-specific endpoint (eu / fedramp) can be pasted in as-is.
  endpoint: {
    type: String,
    required: [true, 'R2 endpoint দিন'],
    trim: true,
  },
  accessKeyId: {
    type: String,
    required: [true, 'Access Key ID দিন'],
    trim: true,
  },
  // AES-256-GCM ciphertext. See the header note.
  secretAccessKeyEnc: {
    type: String,
    required: true,
    select: false,
  },

  /**
   * Where the public reads come from — `https://pub-<hash>.r2.dev` today, a
   * custom domain later. EDITABLE ON PURPOSE: moving to `cdn1.hisaab.app` is
   * meant to be "change this field, run scripts/rewrite-media-urls.js", not a
   * migration. Stored without a trailing slash; the setter enforces that so
   * URL building can always just concatenate.
   */
  publicBaseUrl: {
    type: String,
    required: [true, 'Public base URL দিন'],
    trim: true,
    set: (v) => (typeof v === 'string' ? v.trim().replace(/\/+$/, '') : v),
  },

  // ── Capacity accounting ───────────────────────────────────────────────────
  // Free tier is 10GB. This is a number WE enforce, not one Cloudflare tells
  // us — going paid is "raise this value", with no other code change.
  capacityBytes: {
    type: Number,
    default: 10 * GB,
    min: [1, 'ধারণক্ষমতা কমপক্ষে ১ বাইট হতে হবে'],
  },
  usedBytes: { type: Number, default: 0, min: 0 },
  // In-flight uploads. Incremented before the PUT, released after it settles.
  // A crash leaks this; `storage.service.releaseStaleReservations()` sweeps it.
  reservedBytes: { type: Number, default: 0, min: 0 },
  fileCount: { type: Number, default: 0, min: 0 },

  // ── R2 free-tier operation counters ───────────────────────────────────────
  // Class A = writes (PUT/DELETE/List), 1M/month free. Class B = reads, 10M.
  // Tracked because the only other way to learn we crossed the line is a bill.
  classAOpsMonth: { type: Number, default: 0, min: 0 },
  classBOpsMonth: { type: Number, default: 0, min: 0 },
  opsResetMonth: {
    type: String, // 'YYYY-MM'
    default: () => new Date().toISOString().slice(0, 7),
  },

  // ── Operational state ─────────────────────────────────────────────────────
  isActive: { type: Boolean, default: true },

  /**
   * active   — takes new uploads
   * full     — capacity reached; still serves reads
   * error    — last write failed; skipped until an admin tests it back
   * draining — deliberately excluded from allocation while its files are moved
   *            or simply left to age out. The safe state before deletion.
   */
  status: {
    type: String,
    enum: ['active', 'full', 'error', 'draining'],
    default: 'active',
  },

  // Tie-break when two accounts have the same usage ratio. Lower wins.
  priority: { type: Number, default: 0 },

  lastUsedAt: { type: Date, default: null },
  lastErrorMessage: { type: String, default: null },
  lastVerifiedAt: { type: Date, default: null },   // last successful test/reconcile

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
}, {
  timestamps: true,
});

// The allocation query: active accounts, cheapest-first. Mirrors GeminiKey's
// { isActive, status, requestsToday } index for the same reason.
r2AccountSchema.index({ isActive: 1, status: 1, usedBytes: 1 });

/** Bytes that may still be handed out, reservations already deducted. */
r2AccountSchema.virtual('availableBytes').get(function availableBytes() {
  return Math.max(0, this.capacityBytes - this.usedBytes - this.reservedBytes);
});

/** 0..1 — what `storage.service` sorts on under the `least_used` strategy. */
r2AccountSchema.virtual('usedRatio').get(function usedRatio() {
  if (!this.capacityBytes) return 1;
  return (this.usedBytes + this.reservedBytes) / this.capacityBytes;
});

/** Whether this account may receive a new object of `bytes` size right now. */
r2AccountSchema.methods.canFit = function canFit(bytes) {
  return (
    this.isActive === true &&
    this.status === 'active' &&
    this.usedBytes + this.reservedBytes + bytes <= this.capacityBytes
  );
};

/**
 * Safe shape for the admin API. The secret is `select: false` and is not
 * accepted here even if a caller hydrated it — masking happens in the service,
 * which is the only place that holds plaintext.
 */
r2AccountSchema.methods.toAdminJSON = function toAdminJSON() {
  return {
    _id: this._id,
    name: this.name,
    accountId: this.accountId,
    bucket: this.bucket,
    endpoint: this.endpoint,
    accessKeyId: this.accessKeyId,
    publicBaseUrl: this.publicBaseUrl,
    capacityBytes: this.capacityBytes,
    usedBytes: this.usedBytes,
    reservedBytes: this.reservedBytes,
    availableBytes: this.availableBytes,
    usedRatio: this.usedRatio,
    fileCount: this.fileCount,
    classAOpsMonth: this.classAOpsMonth,
    classBOpsMonth: this.classBOpsMonth,
    isActive: this.isActive,
    status: this.status,
    priority: this.priority,
    lastUsedAt: this.lastUsedAt,
    lastErrorMessage: this.lastErrorMessage,
    lastVerifiedAt: this.lastVerifiedAt,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

const R2Account = mongoose.model('R2Account', r2AccountSchema);

module.exports = R2Account;
module.exports.GB = GB;
