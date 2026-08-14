/**
 * Per-shop storage allowance — the one place "may this shop store these bytes?"
 * is answered.
 *
 * Same reasoning as `features.util`: a rule reimplemented at three call sites
 * is a rule that will disagree with itself. Every upload path, the bootstrap
 * payload and the admin panel resolve the quota through here.
 *
 * ── THE THREE STATES, ONE MORE TIME ──────────────────────────────────────────
 * `Shop.storage` can say three different "no"s and they need three different
 * answers, because they send the shop owner to three different places:
 *
 *   enabled: false  → 403. "Your shop does not have photo storage." Ask the
 *                     platform to switch it on. Nothing the owner can do alone.
 *   over quota      → 413. "You are out of space." Delete something, or ask for
 *                     a bigger allowance.
 *   quotaMb: 0      → also 413, but reached immediately. Deliberate: a zero
 *                     allowance is "enabled with no room", not "disabled".
 *
 * Collapsing these into one generic error is the most likely future regression
 * here, which is why each has its own `code` for the frontend to branch on.
 */

const { AppError } = require('../middleware/error.middleware');
const PlatformSetting = require('../models/PlatformSetting.model');

const MB = 1024 * 1024;

// Used when PlatformSetting is unreachable. Matches the schema default — a
// Mongo hiccup must not silently hand every shop unlimited space, nor zero.
const FALLBACK_QUOTA_MB = 100;
const FALLBACK_WARN_PERCENT = 80;
// How long an image with nothing pointing at it is kept before the reclamation
// sweep deletes it. Matches the schema default; the fallback matters because a
// Mongo hiccup must not shorten the grace period a shop is relying on.
const FALLBACK_ORPHAN_GRACE_DAYS = 7;

/**
 * Platform-level storage settings, with safe fallbacks.
 * Never throws: callers are on the upload path.
 */
async function platformStorageSettings() {
  try {
    const settings = await PlatformSetting.current();
    return {
      defaultQuotaMb: Number.isFinite(settings?.defaultStorageQuotaMb)
        ? settings.defaultStorageQuotaMb
        : FALLBACK_QUOTA_MB,
      warnPercent: Number.isFinite(settings?.storageWarnPercent)
        ? settings.storageWarnPercent
        : FALLBACK_WARN_PERCENT,
      orphanGraceDays: Number.isFinite(settings?.orphanGraceDays)
        ? settings.orphanGraceDays
        : FALLBACK_ORPHAN_GRACE_DAYS,
    };
  } catch (err) {
    return {
      defaultQuotaMb: FALLBACK_QUOTA_MB,
      warnPercent: FALLBACK_WARN_PERCENT,
      orphanGraceDays: FALLBACK_ORPHAN_GRACE_DAYS,
    };
  }
}

/**
 * The quota that actually applies to this shop, in MB.
 *
 * `null` means "inherit"; `0` is a real, deliberate zero and must NOT fall
 * through to the default. `?? ` rather than `||` for exactly that reason — the
 * `||` version would silently promote a zero allowance to 100MB.
 *
 * @param {Object} shop
 * @param {number} defaultQuotaMb
 * @returns {number}
 */
function effectiveQuotaMb(shop, defaultQuotaMb = FALLBACK_QUOTA_MB) {
  const own = shop?.storage?.quotaMb;
  const resolved = own === null || own === undefined ? defaultQuotaMb : own;
  return Number.isFinite(resolved) && resolved >= 0 ? resolved : defaultQuotaMb;
}

/** Whether the shop has the storage feature at all. Fails closed. */
function storageEnabled(shop) {
  return shop?.storage?.enabled === true;
}

/**
 * A complete, renderable picture of one shop's storage position.
 *
 * This is what goes into the dashboard bootstrap payload and what the admin
 * table rows are built from — one shape, so the two can never disagree about
 * what "92% full" means.
 *
 * @param {Object} shop
 * @param {{defaultQuotaMb: number, warnPercent: number}} settings
 */
function storageState(shop, settings) {
  const defaultQuotaMb = settings?.defaultQuotaMb ?? FALLBACK_QUOTA_MB;
  const warnPercent = settings?.warnPercent ?? FALLBACK_WARN_PERCENT;

  const enabled = storageEnabled(shop);
  const quotaMb = effectiveQuotaMb(shop, defaultQuotaMb);
  const quotaBytes = quotaMb * MB;
  const usedBytes = Math.max(0, shop?.storage?.usedBytes || 0);
  const percent = quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : (usedBytes > 0 ? 100 : 0);

  return {
    enabled,
    quotaMb,
    quotaBytes,
    // Null when following the platform default, so the admin UI can show the
    // "use platform default" checkbox in the right state rather than guessing
    // by comparing numbers.
    quotaOverrideMb: shop?.storage?.quotaMb ?? null,
    usedBytes,
    fileCount: shop?.storage?.fileCount || 0,
    availableBytes: Math.max(0, quotaBytes - usedBytes),
    percent: Math.round(percent * 10) / 10,
    warnPercent,
    isWarning: enabled && percent >= warnPercent && percent < 100,
    // Reachable by lowering a quota below current usage. Deliberately allowed:
    // shrinking an allowance must never delete anything. New uploads stop.
    isOverQuota: enabled && usedBytes >= quotaBytes,
    lastUploadAt: shop?.storage?.lastUploadAt || null,
    peakUsedBytes: shop?.storage?.peakUsedBytes || 0,
  };
}

/**
 * Gate an upload. Throws, or returns the state it validated against.
 *
 * @param {Object} shop
 * @param {number} incomingBytes  total bytes about to be stored (all variants)
 * @param {Object} [settings]     from `platformStorageSettings()`; fetched if absent
 */
async function assertCanStore(shop, incomingBytes, settings = null) {
  const resolved = settings || await platformStorageSettings();
  const state = storageState(shop, resolved);

  if (!state.enabled) {
    const error = new AppError(
      'Photo storage is not enabled for this shop',
      'এই দোকানে ছবি সংরক্ষণ চালু নেই — অ্যাডমিনের সাথে যোগাযোগ করুন',
      403
    );
    error.code = 'STORAGE_DISABLED';
    throw error;
  }

  const bytes = Number(incomingBytes) || 0;
  if (state.usedBytes + bytes > state.quotaBytes) {
    const error = new AppError(
      `Storage quota exceeded (${state.quotaMb}MB)`,
      `স্টোরেজ কোটা শেষ (${state.quotaMb}MB) — পুরোনো ছবি মুছুন বা অ্যাডমিনের সাথে যোগাযোগ করুন`,
      413
    );
    error.code = 'STORAGE_QUOTA_EXCEEDED';
    error.quotaMb = state.quotaMb;
    error.usedBytes = state.usedBytes;
    throw error;
  }

  return state;
}

/** Human-readable size for admin copy and log lines. */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1024 * MB)).toFixed(2)} GB`;
}

module.exports = {
  MB,
  FALLBACK_QUOTA_MB,
  FALLBACK_ORPHAN_GRACE_DAYS,
  platformStorageSettings,
  effectiveQuotaMb,
  storageEnabled,
  storageState,
  assertCanStore,
  formatBytes,
};
