/**
 * Admin-side storage management: the R2 account pool, and each shop's slice of
 * it.
 *
 * Kept out of `admin.service.js` (2400 lines and counting) because storage is a
 * self-contained subsystem with its own vocabulary. The only thing that reaches
 * back into the older service is the feature cascade — see
 * `setShopStorage()`'s note about disabling.
 *
 * ── WHAT THIS FILE IS CAREFUL ABOUT ──────────────────────────────────────────
 *  · Secrets are encrypted on the way in and never leave, in any shape. The
 *    admin UI gets `accessKeyId` (an id, not a secret) and nothing else.
 *  · An account with files in it cannot be deleted. Deleting the row would
 *    orphan every object in the bucket with no way left to find them — the
 *    account row IS the map.
 *  · Lowering a quota never deletes anything.
 *  · Allocated capacity is reported next to real capacity, because the two
 *    diverge quietly and only one of them is a bill.
 */

const mongoose = require('mongoose');

const R2Account = require('../models/R2Account.model');
const ShopMedia = require('../models/ShopMedia.model');
const Shop = require('../models/Shop.model');
const AuditLog = require('../models/AuditLog.model');
const PlatformSetting = require('../models/PlatformSetting.model');

const storageService = require('./storage.service');
const cacheService = require('./cache.service');
const crypto = require('../utils/crypto.util');
const { AppError } = require('../middleware/error.middleware');
const { invalidateShopAuthCache } = require('../utils/authCache.util');
const { STORAGE_BACKED_FEATURES, FEATURES, storageCascadeKeys } = require('../utils/features.util');
const {
  MB,
  platformStorageSettings,
  storageState,
  formatBytes,
} = require('../utils/storageQuota.util');
const logger = require('../utils/logger.util');

class AdminStorageService {
  // ══ ACCOUNT POOL ═════════════════════════════════════════════════════════

  /** Every account, safe-shaped, cheapest-first so the next upload's target is obvious. */
  async listAccounts() {
    const accounts = await R2Account.find().sort({ priority: 1, createdAt: 1 });
    return accounts.map((a) => a.toAdminJSON());
  }

  /**
   * Add a bucket to the pool.
   *
   * The credentials are verified against the live bucket BEFORE the document is
   * written. Storing an unverified credential means the first person to find
   * out it is wrong is a shop owner watching an upload fail.
   */
  async createAccount(adminId, payload) {
    this._assertEncryptionReady();

    const {
      name, accountId, bucket, endpoint, accessKeyId, secretAccessKey,
      publicBaseUrl, capacityBytes, priority,
    } = payload || {};

    if (!name || !accountId || !bucket || !endpoint || !accessKeyId || !secretAccessKey || !publicBaseUrl) {
      throw new AppError(
        'name, accountId, bucket, endpoint, accessKeyId, secretAccessKey and publicBaseUrl are all required',
        'সবগুলো তথ্য পূরণ করুন',
        400
      );
    }

    const test = await storageService.testConnection({ endpoint, accessKeyId, secretAccessKey, bucket });
    if (!test.ok) {
      throw new AppError(
        `Could not reach the bucket: ${test.error}`,
        `বাকেটে সংযোগ করা যায়নি: ${test.error}`,
        400
      );
    }

    const account = await R2Account.create({
      name,
      accountId,
      bucket,
      endpoint,
      accessKeyId,
      secretAccessKeyEnc: crypto.encrypt(secretAccessKey),
      publicBaseUrl,
      capacityBytes: this._parseCapacity(capacityBytes),
      priority: Number.isFinite(priority) ? priority : 0,
      lastVerifiedAt: new Date(),
      createdBy: adminId,
    });

    await AuditLog.log({
      admin: adminId,
      action: 'storage_account_create',
      description: `স্টোরেজ অ্যাকাউন্ট "${name}" যোগ করা হয়েছে (${formatBytes(account.capacityBytes)})`,
      entity: { type: 'storage_account', id: account._id, name },
    });

    return account.toAdminJSON();
  }

  /**
   * Edit an account.
   *
   * `secretAccessKey` is optional: an empty value means "leave the stored one
   * alone". That is what lets an admin fix a typo'd bucket name without having
   * to go back to Cloudflare for a credential they cannot read out of our UI.
   */
  async updateAccount(id, adminId, payload) {
    const account = await R2Account.findById(id).select('+secretAccessKeyEnc');
    if (!account) {
      throw new AppError('Storage account not found', 'স্টোরেজ অ্যাকাউন্ট পাওয়া যায়নি', 404);
    }

    const before = {
      name: account.name,
      bucket: account.bucket,
      publicBaseUrl: account.publicBaseUrl,
      capacityBytes: account.capacityBytes,
      isActive: account.isActive,
    };

    const {
      name, accountId, bucket, endpoint, accessKeyId, secretAccessKey,
      publicBaseUrl, capacityBytes, priority, isActive,
    } = payload || {};

    if (name !== undefined) account.name = name;
    if (accountId !== undefined) account.accountId = accountId;
    if (bucket !== undefined) account.bucket = bucket;
    if (endpoint !== undefined) account.endpoint = endpoint;
    if (accessKeyId !== undefined) account.accessKeyId = accessKeyId;
    if (publicBaseUrl !== undefined) account.publicBaseUrl = publicBaseUrl;
    if (priority !== undefined) account.priority = Number(priority) || 0;
    if (isActive !== undefined) account.isActive = isActive === true;

    if (secretAccessKey) {
      this._assertEncryptionReady();
      account.secretAccessKeyEnc = crypto.encrypt(secretAccessKey);
    }

    if (capacityBytes !== undefined) {
      const next = this._parseCapacity(capacityBytes);
      // Shrinking below what is already stored would make `availableBytes`
      // negative and the allocation $expr permanently false — a silently dead
      // account. Refuse, and say by how much.
      if (next < account.usedBytes) {
        throw new AppError(
          `Capacity cannot be below current usage (${formatBytes(account.usedBytes)})`,
          `ধারণক্ষমতা বর্তমান ব্যবহারের (${formatBytes(account.usedBytes)}) চেয়ে কম দেওয়া যাবে না`,
          400
        );
      }
      account.capacityBytes = next;
    }

    // Credentials changed → re-verify before trusting them, and clear any
    // `error` status the old ones earned.
    if (secretAccessKey || accessKeyId !== undefined || endpoint !== undefined || bucket !== undefined) {
      const test = await storageService.testConnection({
        endpoint: account.endpoint,
        accessKeyId: account.accessKeyId,
        secretAccessKey: secretAccessKey || crypto.decrypt(account.secretAccessKeyEnc),
        bucket: account.bucket,
      });
      if (!test.ok) {
        throw new AppError(
          `Could not reach the bucket with these details: ${test.error}`,
          `এই তথ্য দিয়ে বাকেটে সংযোগ করা যায়নি: ${test.error}`,
          400
        );
      }
      account.lastVerifiedAt = new Date();
      if (account.status === 'error') {
        account.status = account.usedBytes >= account.capacityBytes ? 'full' : 'active';
        account.lastErrorMessage = null;
      }
    }

    await account.save();
    storageService.forgetClient(account._id);

    await AuditLog.log({
      admin: adminId,
      action: 'storage_account_update',
      description: `স্টোরেজ অ্যাকাউন্ট "${account.name}" আপডেট করা হয়েছে`,
      entity: { type: 'storage_account', id: account._id, name: account.name },
      changes: {
        before,
        after: {
          name: account.name,
          bucket: account.bucket,
          publicBaseUrl: account.publicBaseUrl,
          capacityBytes: account.capacityBytes,
          isActive: account.isActive,
          secretRotated: Boolean(secretAccessKey),
        },
      },
    });

    return account.toAdminJSON();
  }

  /** Live credential check for an existing account. Also clears `error` on success. */
  async testAccount(id) {
    const account = await storageService.getAccountWithSecret(id);

    const result = await storageService.testConnection({
      endpoint: account.endpoint,
      accessKeyId: account.accessKeyId,
      secretAccessKey: crypto.isEncrypted(account.secretAccessKeyEnc)
        ? crypto.decrypt(account.secretAccessKeyEnc)
        : account.secretAccessKeyEnc,
      bucket: account.bucket,
    });

    if (result.ok) {
      account.lastVerifiedAt = new Date();
      if (account.status === 'error') {
        account.status = account.usedBytes >= account.capacityBytes ? 'full' : 'active';
        account.lastErrorMessage = null;
      }
      await account.save();
    } else {
      account.lastErrorMessage = String(result.error).slice(0, 500);
      await account.save();
    }

    return { ...result, account: account.toAdminJSON() };
  }

  /**
   * Move an account between `active` and `draining`.
   *
   * Draining is not deactivating: reads keep working, only allocation stops.
   * It is the honest way to retire a bucket — the alternative, flipping
   * `isActive` off, is indistinguishable in the UI from "temporarily broken".
   */
  async setAccountDraining(id, adminId, draining) {
    const account = await R2Account.findById(id);
    if (!account) {
      throw new AppError('Storage account not found', 'স্টোরেজ অ্যাকাউন্ট পাওয়া যায়নি', 404);
    }

    const previous = account.status;
    if (draining) {
      account.status = 'draining';
    } else {
      account.status = account.usedBytes >= account.capacityBytes ? 'full' : 'active';
      account.lastErrorMessage = null;
    }
    await account.save();

    await AuditLog.log({
      admin: adminId,
      action: 'storage_account_update',
      description: draining
        ? `স্টোরেজ অ্যাকাউন্ট "${account.name}" ড্রেইনিং করা হয়েছে (নতুন আপলোড বন্ধ)`
        : `স্টোরেজ অ্যাকাউন্ট "${account.name}" পুনরায় সক্রিয় করা হয়েছে`,
      entity: { type: 'storage_account', id: account._id, name: account.name },
      changes: { before: { status: previous }, after: { status: account.status } },
    });

    return account.toAdminJSON();
  }

  /**
   * There is deliberately NO deleteAccount.
   *
   * Retiring a bucket is `setAccountDraining(true)` followed by
   * `updateAccount({ isActive: false })`. Two reasons the row stays:
   *
   *   1. Panel policy — hard deletion is disabled platform-wide, and the
   *      runtime guard (`assertAdminMayDelete`) refuses DELETE under /api/admin
   *      regardless of what any router mounts. See adminNoDelete.test.js.
   *
   *   2. The account document is the ONLY map from a stored object back to the
   *      bucket that holds it. `publicBaseUrl` rebuilds URLs, `endpoint` +
   *      credentials perform deletes, `accountId` identifies it at Cloudflare.
   *      Erase the row and every file it ever held becomes unreachable — not
   *      deleted, just permanently unaccounted for, still costing money.
   *
   * One retired document costs nothing and keeps that map forever.
   */


  // ══ POOL SUMMARY & OVERCOMMIT ════════════════════════════════════════════

  /**
   * The dashboard's headline numbers.
   *
   * `allocatedBytes` — the sum of every ENABLED shop's quota — is the number
   * that goes missing from most storage dashboards, and it is the one that
   * predicts the outage. Capacity is what we have; allocated is what we have
   * promised. Overcommit is normal and desirable (nobody fills their quota);
   * overcommit you did not know about is how a pool fills up on a Tuesday.
   */
  async getSummary() {
    const [pool, settings, allocation] = await Promise.all([
      storageService.getPoolSummary(),
      platformStorageSettings(),
      this._allocationTotals(),
    ]);

    const allocatedBytes = (allocation.overriddenQuotaMb * MB)
      + (allocation.inheritingShops * settings.defaultQuotaMb * MB);

    const overcommitPercent = pool.usableCapacityBytes > 0
      ? (allocatedBytes / pool.usableCapacityBytes) * 100
      : 0;

    return {
      pool,
      allocation: {
        enabledShops: allocation.enabledShops,
        inheritingShops: allocation.inheritingShops,
        overriddenShops: allocation.overriddenShops,
        allocatedBytes,
        defaultQuotaMb: settings.defaultQuotaMb,
        overcommitPercent: Math.round(overcommitPercent * 10) / 10,
        // Thresholds live here, not in the component, so the API and the UI
        // cannot drift apart about what counts as alarming.
        overcommitLevel: overcommitPercent >= 300 ? 'danger'
          : overcommitPercent >= 150 ? 'warn'
            : 'ok',
      },
      media: await this._mediaHealth(),
      strategy: await storageService.getStrategy(),
    };
  }

  /** Enabled-shop quota totals, split by whether the shop overrides the default. */
  async _allocationTotals() {
    const [row] = await Shop.aggregate([
      { $match: { 'storage.enabled': true } },
      {
        $group: {
          _id: null,
          enabledShops: { $sum: 1 },
          overriddenShops: {
            $sum: { $cond: [{ $ne: [{ $ifNull: ['$storage.quotaMb', null] }, null] }, 1, 0] },
          },
          overriddenQuotaMb: { $sum: { $ifNull: ['$storage.quotaMb', 0] } },
        },
      },
    ]);

    const base = row || { enabledShops: 0, overriddenShops: 0, overriddenQuotaMb: 0 };
    return { ...base, inheritingShops: base.enabledShops - base.overriddenShops };
  }

  /** Counts the reclamation job cares about, surfaced so they cannot rot unseen. */
  async _mediaHealth() {
    const staleCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const [staged, orphaned, broken, total] = await Promise.all([
      ShopMedia.countDocuments({ status: 'staged', createdAt: { $lt: staleCutoff } }),
      ShopMedia.countDocuments({ refCount: 0, orphanedAt: { $ne: null } }),
      ShopMedia.countDocuments({ status: 'broken' }),
      ShopMedia.countDocuments({}),
    ]);
    return { totalMedia: total, stagedStale: staged, orphaned, broken };
  }

  // ══ PER-SHOP ALLOCATION ══════════════════════════════════════════════════

  /**
   * The shop-by-shop table: who has been given what, and what they are using.
   *
   * @param {Object} query
   * @param {string} [query.search]  shop name or phone
   * @param {string} [query.filter]  enabled | disabled | over | warning | unused
   * @param {string} [query.sort]    used | percent | quota | name
   */
  async listShopStorage(query = {}) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 25));
    const settings = await platformStorageSettings();

    const match = {};
    if (query.search) {
      const rx = new RegExp(String(query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      match.$or = [{ name: rx }, { phone: rx }, { ownerName: rx }];
    }
    if (query.filter === 'enabled') match['storage.enabled'] = true;
    if (query.filter === 'disabled') match['storage.enabled'] = { $ne: true };
    if (query.filter === 'unused') {
      match['storage.enabled'] = true;
      match['storage.fileCount'] = { $lte: 0 };
    }

    const [rows, total] = await Promise.all([
      Shop.find(match)
        .select('name phone ownerName isActive storage')
        .sort({ 'storage.usedBytes': -1, name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Shop.countDocuments(match),
    ]);

    let shops = rows.map((shop) => ({
      _id: shop._id,
      name: shop.name,
      phone: shop.phone,
      isActive: shop.isActive,
      ...storageState(shop, settings),
    }));

    // Percentage filters are applied after resolution, because the effective
    // quota is not a stored field — a shop inheriting the default has no number
    // to compare against in the query.
    if (query.filter === 'over') shops = shops.filter((s) => s.isOverQuota);
    if (query.filter === 'warning') shops = shops.filter((s) => s.isWarning);

    if (query.sort === 'percent') shops.sort((a, b) => b.percent - a.percent);
    if (query.sort === 'quota') shops.sort((a, b) => b.quotaMb - a.quotaMb);
    if (query.sort === 'name') shops.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    return { shops, pagination: { page, limit, total } };
  }

  /** One shop's storage position, plus what is actually taking up the room. */
  async getShopStorage(shopId) {
    const shop = await Shop.findById(shopId).select('name storage features').lean();
    if (!shop) throw new AppError('Shop not found', 'দোকান পাওয়া যায়নি', 404);

    const settings = await platformStorageSettings();
    const state = storageState(shop, settings);

    const [topConsumers, history] = await Promise.all([
      ShopMedia.find({ shop: shopId })
        .select('originalName totalBytes url thumbUrl createdAt refCount')
        .sort({ totalBytes: -1 })
        .limit(5)
        .lean(),
      // The "who gave them what, and when" trail. 20 is enough to cover a
      // negotiation without turning this into a log viewer.
      AuditLog.find({
        shop: shopId,
        action: { $in: ['storage_enabled', 'storage_disabled', 'storage_quota_changed'] },
      })
        .select('action description createdAt changes admin')
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
    ]);

    return {
      shopId: shop._id,
      shopName: shop.name,
      ...state,
      defaultQuotaMb: settings.defaultQuotaMb,
      // So the panel can warn before an admin disables storage under a shop
      // that is actively using the features.
      imageFeatures: STORAGE_BACKED_FEATURES.reduce((acc, key) => {
        acc[key] = shop.features?.[key] === true;
        return acc;
      }, {}),
      topConsumers,
      history,
    };
  }

  /**
   * Enable/disable storage for a shop, and set its allowance.
   *
   * ── THE CASCADE ────────────────────────────────────────────────────────────
   * Turning storage OFF also turns off every storage-backed capability. Without
   * that, the shop keeps an upload button wired to a 403 — which reads as a bug
   * to them and generates a support ticket for us. The inverse guard lives in
   * `admin.service.setShopFeature`, which refuses to enable those capabilities
   * while storage is off. Between the two, the impossible combination cannot be
   * reached from either direction.
   *
   * Nothing is deleted. Existing photos stay in R2 and keep counting against
   * usage, so re-enabling restores exactly the previous state.
   */
  async setShopStorage(shopId, adminId, { enabled, quotaMb } = {}) {
    const shop = await Shop.findById(shopId);
    if (!shop) throw new AppError('Shop not found', 'দোকান পাওয়া যায়নি', 404);

    if (!shop.storage) shop.storage = {};
    const before = {
      enabled: shop.storage.enabled === true,
      quotaMb: shop.storage.quotaMb ?? null,
    };

    const events = [];
    let cascadedFeatures = [];

    // ── quota ────────────────────────────────────────────────────────────
    if (quotaMb !== undefined) {
      const next = this._parseQuotaMb(quotaMb);
      if (next !== before.quotaMb) {
        shop.storage.quotaMb = next;
        events.push({
          action: 'storage_quota_changed',
          description: `"${shop.name}" দোকানের স্টোরেজ কোটা ${this._quotaLabel(before.quotaMb)} → ${this._quotaLabel(next)}`,
          changes: { before: { quotaMb: before.quotaMb }, after: { quotaMb: next } },
        });
      }
    }

    // ── master switch ────────────────────────────────────────────────────
    if (enabled !== undefined && (enabled === true) !== before.enabled) {
      const value = enabled === true;
      shop.storage.enabled = value;

      if (value) {
        shop.storage.enabledAt = new Date();
        shop.storage.enabledBy = adminId;
      } else {
        // Cascade off. Only touch flags that are actually on, so the audit
        // entry lists what really changed.
        //
        // `storageCascadeKeys()` rather than STORAGE_BACKED_FEATURES: the list
        // is the storage-backed capabilities PLUS everything that transitively
        // depends on one. `storefront` requires `productImages`, so cascading
        // only the direct list would leave a shop with a live public website
        // and no photos on it — a worse outcome than the upload-button-wired-
        // to-a-403 this cascade was written to prevent. See the `requires`
        // header in utils/features.util.js.
        cascadedFeatures = storageCascadeKeys().filter((key) => shop.features?.[key] === true);
        if (cascadedFeatures.length) {
          if (!shop.features) shop.features = {};
          cascadedFeatures.forEach((key) => { shop.features[key] = false; });
          // `features` is a plain nested object — Mongoose does not always see
          // a sub-path mutation, and a missed change here returns 200 while
          // saving nothing. Same trap `setShopFeature` documents.
          shop.markModified('features');
        }
      }

      events.push({
        action: value ? 'storage_enabled' : 'storage_disabled',
        description: value
          ? `"${shop.name}" দোকানে ছবি সংরক্ষণ চালু করা হয়েছে`
          : `"${shop.name}" দোকানে ছবি সংরক্ষণ বন্ধ করা হয়েছে`
          + (cascadedFeatures.length
            ? ` (সাথে বন্ধ হয়েছে: ${cascadedFeatures.map((k) => FEATURES[k].bn).join(', ')})`
            : ''),
        changes: {
          before: { enabled: before.enabled },
          after: { enabled: value, disabledFeatures: cascadedFeatures },
        },
      });
    }

    if (events.length === 0) {
      return this.getShopStorage(shopId);
    }

    shop.markModified('storage');
    await shop.save();

    for (const event of events) {
      await AuditLog.log({
        shop: shopId,
        admin: adminId,
        action: event.action,
        description: event.description,
        entity: { type: 'shop', id: shop._id, name: shop.name },
        changes: event.changes,
      });
    }

    // The flags and the quota both ride in the cached shop payload, so every
    // session for this shop has to be retired or the change lands on the next
    // login instead of the next request.
    await invalidateShopAuthCache(shopId);
    await cacheService.bumpShopCacheVersion(shopId, 0);

    return this.getShopStorage(shopId);
  }

  /**
   * Recompute a shop's usage from the media rows.
   *
   * The counters are incremental, so a bad refCount or a crashed delete leaves
   * them slightly wrong forever. This is the button that fixes it, and it is
   * also what makes the incremental path safe to keep: drift is recoverable.
   */
  async recalculateShopStorage(shopId) {
    const shop = await Shop.findById(shopId);
    if (!shop) throw new AppError('Shop not found', 'দোকান পাওয়া যায়নি', 404);

    const [row] = await ShopMedia.aggregate([
      { $match: { shop: new mongoose.Types.ObjectId(String(shopId)), status: { $ne: 'broken' } } },
      { $group: { _id: null, usedBytes: { $sum: '$totalBytes' }, fileCount: { $sum: 1 } } },
    ]);

    const usedBytes = row?.usedBytes || 0;
    const fileCount = row?.fileCount || 0;
    const previous = { usedBytes: shop.storage?.usedBytes || 0, fileCount: shop.storage?.fileCount || 0 };

    if (!shop.storage) shop.storage = {};
    shop.storage.usedBytes = usedBytes;
    shop.storage.fileCount = fileCount;
    shop.storage.peakUsedBytes = Math.max(shop.storage.peakUsedBytes || 0, usedBytes);
    shop.storage.lastRecalculatedAt = new Date();
    shop.markModified('storage');
    await shop.save();

    const drift = usedBytes - previous.usedBytes;
    if (drift !== 0) {
      logger.warn(
        `Storage drift corrected for shop ${shopId}: ${formatBytes(previous.usedBytes)} → ${formatBytes(usedBytes)}`
      );
    }

    await cacheService.bumpShopCacheVersion(shopId, 0);
    return { ...(await this.getShopStorage(shopId)), drift };
  }

  // ══ INTERNALS ════════════════════════════════════════════════════════════

  _assertEncryptionReady() {
    if (!crypto.isConfigured()) {
      throw new AppError(
        'STORAGE_ENC_KEY is not configured — refusing to store a credential in plaintext',
        'স্টোরেজ এনক্রিপশন কী সেট করা নেই — সার্ভার কনফিগারেশন ঠিক করুন',
        503
      );
    }
  }

  _parseCapacity(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 10 * 1024 * MB; // 10GB free tier
    return Math.floor(n);
  }

  /**
   * `null` (inherit), or a non-negative integer. Note that `0` survives: it is
   * a real allowance of nothing, not a missing value. Anything unparseable
   * becomes `null` rather than 0 — guessing "no space" from a typo would take a
   * shop's uploads offline.
   */
  _parseQuotaMb(value) {
    if (value === null || value === '' || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
  }

  _quotaLabel(quotaMb) {
    return quotaMb === null ? 'প্ল্যাটফর্ম ডিফল্ট' : `${quotaMb}MB`;
  }
}

module.exports = new AdminStorageService();
