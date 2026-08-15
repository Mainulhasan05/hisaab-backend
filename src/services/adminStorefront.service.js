const StorefrontTemplate = require('../models/StorefrontTemplate.model');
const { SLOT_KEYS } = require('../models/StorefrontTemplate.model');
const Storefront = require('../models/Storefront.model');
const Shop = require('../models/Shop.model');
const AuditLog = require('../models/AuditLog.model');
const PlatformMedia = require('../models/PlatformMedia.model');
const cacheService = require('./cache.service');
const platformMediaService = require('./platformMedia.service');
const logger = require('../utils/logger.util');
const { AppError } = require('../middleware/error.middleware');
const { invalidateShopAuthCache } = require('../utils/authCache.util');
const { FEATURE_KEYS } = require("../utils/features.util");

/** This service's name in the media library's consumer registry. */
const OWNER_TYPE = 'storefrontTemplate';

/** The URL columns a library file can be addressed by. */
const URL_FIELDS = Object.freeze(['url', 'mediumUrl', 'thumbUrl']);

/**
 * The PLATFORM's side of the storefront: the template catalogue, which shops
 * may use which templates, and the kill switch.
 *
 * Split out of `admin.service` for the same reason `adminStorage.service` is —
 * that file is already 2,700 lines, and a capability with its own catalogue,
 * its own grants and its own oversight screen is a coherent unit rather than
 * six more methods on a class that does everything.
 *
 * The shop's side lives in `storefront.service`. The boundary is the one
 * `Shop.features` already draws: the platform decides what a shop MAY do, the
 * shop decides what it DOES. Nothing here writes `Storefront.draft` or
 * `Storefront.published`, and nothing there writes `allowedTemplates`.
 */
class AdminStorefrontService {
  // ══ MEDIA LIBRARY ════════════════════════════════════════════════════════

  /**
   * Register with the media library.
   *
   * A template's `thumbnail` may now be picked from the library rather than
   * pasted, and a reference the library does not know about is one the
   * reclamation sweep will delete: the tile in every shop's template gallery
   * would break, with nothing in the console to say why. The arrow points one
   * way (MEDIA_GALLERY_PLAN.md §4.3), so this is a call we make.
   */
  registerAsMediaConsumer() {
    platformMediaService.registerConsumer({
      ownerType: OWNER_TYPE,
      label: 'স্টোরফ্রন্ট টেমপ্লেট',

      resolve: async (ownerIds) => {
        const templates = await StorefrontTemplate.find({ _id: { $in: ownerIds } })
          .select('name nameBn key status')
          .lean();

        return templates.map((t) => ({
          id: String(t._id),
          label: t.nameBn || t.name || t.key,
          href: '/admin-hq-x7k9m2p4/storefront/templates',
          // A published template is on every shop's gallery right now.
          isLive: t.status === 'published',
        }));
      },

      /**
       * The I-18 backstop. Asked before any file is deleted.
       *
       * Re-derived from the stored URLs rather than from `refs`, so a bug in
       * `_syncThumbnailRef` cannot cost the catalogue its images. Retired
       * templates count: they keep rendering for every shop already on one.
       */
      confirmInUse: async (mediaIds) => {
        const media = await PlatformMedia.find({ _id: { $in: mediaIds.map(String) } })
          .select('url thumbUrl mediumUrl')
          .lean();
        if (media.length === 0) return [];

        const templates = await StorefrontTemplate.find()
          .select('thumbnail previewUrl')
          .lean();

        const inUse = [];
        for (const item of media) {
          const urls = URL_FIELDS.map((f) => item[f]).filter(Boolean);
          const used = templates.some((t) =>
            urls.some((u) => u === t.thumbnail || u === t.previewUrl));
          if (used) inUse.push(String(item._id));
        }
        return inUse;
      },
    });
  }

  /**
   * Point the library at whichever file this template's thumbnail names.
   *
   * By URL, because that is what the field stores — the picker hands the admin
   * a URL and a pasted one has to work identically. A URL matching nothing in
   * the library is a bundled wireframe or someone else's image, and is not our
   * reference to hold.
   */
  async _syncThumbnailRef(template) {
    const urls = [template.thumbnail, template.previewUrl].filter(Boolean);

    try {
      const found = urls.length
        ? await PlatformMedia.find({ $or: URL_FIELDS.map((f) => ({ [f]: { $in: urls } })) })
          .select('_id').lean()
        : [];

      await platformMediaService.setOwnerRefs(
        OWNER_TYPE,
        template._id,
        found.map((m) => ({ mediaId: m._id, key: 'thumbnail' })),
        { origin: 'explicit' }
      );
    } catch (err) {
      // The `confirmInUse` backstop above already covers reclamation. A save
      // that 500s over bookkeeping is an admin who cannot save their work.
      logger.error(`Storefront template ${template._id}: media ref sync failed: ${err.message}`);
    }
  }

  // ══ TEMPLATE CATALOGUE ═══════════════════════════════════════════════════

  /** Every template, whatever its status. The admin's list, not the shop's. */
  async listTemplates() {
    const templates = await StorefrontTemplate.find()
      .sort({ status: 1, sortOrder: 1, key: 1 })
      .lean();

    // How many shops hold each grant, and how many are actually rendering it.
    // Both numbers are needed before retiring a template: "granted to 40" is a
    // tidy-up, "rendering on 12" is 12 live websites.
    const [grantCounts, liveCounts] = await Promise.all([
      Shop.aggregate([
        { $unwind: '$storefront.allowedTemplates' },
        { $group: { _id: '$storefront.allowedTemplates', count: { $sum: 1 } } },
      ]),
      Storefront.aggregate([
        { $match: { 'published.template': { $ne: null } } },
        { $group: { _id: '$published.template', count: { $sum: 1 } } },
      ]),
    ]);

    const granted = new Map(grantCounts.map((r) => [r._id, r.count]));
    const live = new Map(liveCounts.map((r) => [r._id, r.count]));

    return templates.map((t) => ({
      ...t,
      grantedToShops: granted.get(t.key) || 0,
      liveOnShops: live.get(t.key) || 0,
    }));
  }

  /** The slot vocabulary, so the admin form renders from it rather than a copy. */
  getSlotVocabulary() {
    return [...SLOT_KEYS];
  }

  async createTemplate(adminId, payload = {}) {
    const key = String(payload.key || '').trim().toLowerCase();
    if (!key) {
      throw new AppError('Template key required', 'টেমপ্লেট কী দিন', 400);
    }

    const existing = await StorefrontTemplate.findOne({ key });
    if (existing) {
      throw new AppError(
        `A template with key "${key}" already exists`,
        `"${key}" কী দিয়ে একটি টেমপ্লেট আগে থেকেই আছে`,
        400
      );
    }

    this._assertFeatureKeys(payload.minFeatures);

    const template = await StorefrontTemplate.create({
      ...this._pickTemplateFields(payload),
      key,
      status: 'draft',
      createdBy: adminId,
      updatedBy: adminId,
    });

    await this._syncThumbnailRef(template);

    await AuditLog.create({
      admin: adminId,
      action: 'storefront_template_created',
      description: `Created storefront template "${template.name}" (${key})`,
      descriptionBn: `"${template.nameBn}" টেমপ্লেট তৈরি করা হয়েছে`,
      entity: { type: 'storefront_template', id: template._id, name: template.nameBn },
    });

    return template.toObject();
  }

  /**
   * Update a template.
   *
   * `key` and `status` are NOT accepted here. `key` is immutable once published
   * (see StorefrontTemplate.model.js — every grant and every live site stores
   * the string, and a rename orphans all of them silently). `status` moves
   * through `publishTemplate` / `retireTemplate`, which have their own
   * consequences worth naming at the call site.
   */
  async updateTemplate(adminId, templateId, payload = {}) {
    const template = await StorefrontTemplate.findById(templateId);
    if (!template) {
      throw new AppError('Template not found', 'টেমপ্লেট পাওয়া যায়নি', 404);
    }

    if (payload.key && payload.key !== template.key) {
      throw new AppError(
        'A template key cannot be changed. Create a new template instead.',
        'টেমপ্লেট কী পরিবর্তন করা যাবে না। নতুন টেমপ্লেট তৈরি করুন।',
        400
      );
    }
    this._assertFeatureKeys(payload.minFeatures);

    Object.assign(template, this._pickTemplateFields(payload));
    template.updatedBy = adminId;
    await template.save();

    // After the save, so a thumbnail swap releases the old file's reference in
    // the same pass that claims the new one.
    await this._syncThumbnailRef(template);

    return template.toObject();
  }

  /** Whitelist. Never `Object.assign(template, payload)` — see BACKLOG.md B.3 §2. */
  _pickTemplateFields(payload) {
    const out = {};
    for (const field of [
      'name', 'nameBn', 'description', 'descriptionBn', 'vertical',
      'thumbnail', 'previewUrl', 'slots', 'themeDefaults', 'palettes',
      'minFeatures', 'sortOrder',
    ]) {
      if (field in payload) out[field] = payload[field];
    }
    return out;
  }

  /**
   * `minFeatures` is validated here rather than on the schema for the same
   * reason `Product.unit`'s enum is the full registry: the model has to keep
   * accepting whatever is already stored, including a key from a capability
   * that was later renamed. Validation belongs where the write happens.
   */
  _assertFeatureKeys(keys) {
    if (keys === undefined) return;
    if (!Array.isArray(keys)) {
      throw new AppError('minFeatures must be an array', 'minFeatures তালিকা হতে হবে', 400);
    }
    const unknown = keys.filter((k) => !FEATURE_KEYS.includes(k));
    if (unknown.length) {
      throw new AppError(
        `Unknown feature keys: ${unknown.join(', ')}. Valid: ${FEATURE_KEYS.join(', ')}`,
        `অজানা ফিচার: ${unknown.join(', ')}`,
        400
      );
    }
  }

  async publishTemplate(adminId, templateId) {
    const template = await StorefrontTemplate.findById(templateId);
    if (!template) {
      throw new AppError('Template not found', 'টেমপ্লেট পাওয়া যায়নি', 404);
    }
    if (!template.thumbnail) {
      // A gallery tile with no image is a template nobody picks. Cheap gate,
      // and it catches the half-finished row before a shop sees it.
      throw new AppError(
        'Add a thumbnail before publishing this template',
        'প্রকাশ করার আগে টেমপ্লেটের থাম্বনেইল যোগ করুন',
        400
      );
    }

    template.status = 'published';
    template.publishedAt = template.publishedAt || new Date();
    template.retiredAt = null;
    template.updatedBy = adminId;
    await template.save();

    await AuditLog.create({
      admin: adminId,
      action: 'storefront_template_published',
      description: `Published storefront template "${template.name}"`,
      descriptionBn: `"${template.nameBn}" টেমপ্লেট প্রকাশ করা হয়েছে`,
      entity: { type: 'storefront_template', id: template._id, name: template.nameBn },
    });

    return template.toObject();
  }

  /**
   * Retire a template.
   *
   * It disappears from the grant picker and can no longer be newly applied. It
   * keeps rendering for every shop already on it, and no grant is revoked.
   * Deleting is not offered at all — see StorefrontTemplate.model.js.
   */
  async retireTemplate(adminId, templateId) {
    const template = await StorefrontTemplate.findById(templateId);
    if (!template) {
      throw new AppError('Template not found', 'টেমপ্লেট পাওয়া যায়নি', 404);
    }

    const liveOn = await Storefront.countDocuments({ 'published.template': template.key });

    template.status = 'retired';
    template.retiredAt = new Date();
    template.updatedBy = adminId;
    await template.save();

    await AuditLog.create({
      admin: adminId,
      action: 'storefront_template_retired',
      description: `Retired storefront template "${template.name}" (still live on ${liveOn} shops)`,
      descriptionBn: `"${template.nameBn}" টেমপ্লেট প্রত্যাহার করা হয়েছে (এখনও ${liveOn}টি দোকানে চালু আছে)`,
      entity: { type: 'storefront_template', id: template._id, name: template.nameBn },
    });

    return { ...template.toObject(), liveOnShops: liveOn };
  }

  // ══ GRANTS ═══════════════════════════════════════════════════════════════

  /**
   * What the grant checklist renders: every offerable template, plus which are
   * granted to this shop and which one it is running.
   *
   * A template that is retired or ungranted but currently in use is included
   * and flagged, so the admin can see what revoking would mean before they do
   * it — the same "warn before the click" principle `cascadesOff` follows in
   * `getShopFeatures`.
   */
  async getShopTemplateGrants(shopId) {
    const shop = await Shop.findById(shopId).select('name slug features storefront').lean();
    if (!shop) {
      throw new AppError('Shop not found', 'দোকান পাওয়া যায়নি', 404);
    }

    const storefront = await Storefront.findOne({ shop: shopId })
      .select('status draft.template published.template published.version stats')
      .lean();

    const allowed = new Set(shop.storefront?.allowedTemplates || []);
    const draftKey = storefront?.draft?.template || null;
    const liveKey = storefront?.published?.template || null;

    const templates = await StorefrontTemplate.find({
      $or: [
        { status: 'published' },
        { key: { $in: [draftKey, liveKey].filter(Boolean) } },
      ],
    }).sort({ sortOrder: 1, key: 1 }).lean();

    return {
      shop: { _id: String(shop._id), name: shop.name, slug: shop.slug },
      storefrontEnabled: shop.features?.storefront === true,
      storefront: storefront
        ? {
          status: storefront.status,
          draftTemplate: draftKey,
          liveTemplate: liveKey,
          version: storefront.published?.version || 0,
          stats: storefront.stats,
        }
        : null,
      templates: templates.map((t) => ({
        key: t.key,
        name: t.name,
        nameBn: t.nameBn,
        vertical: t.vertical,
        thumbnail: t.thumbnail,
        status: t.status,
        granted: allowed.has(t.key),
        isDraft: t.key === draftKey,
        isLive: t.key === liveKey,
        // Revoking a grant for the template a shop is LIVE on does not take the
        // site down (Shop.model.js invariant) — but the admin should be told
        // that is what they are about to do.
        revokeWarning: allowed.has(t.key) && (t.key === liveKey || t.key === draftKey)
          ? 'এই দোকানটি বর্তমানে এই টেমপ্লেটটি ব্যবহার করছে। সরিয়ে দিলে সাইট বন্ধ হবে না, তবে তারা আর এটি নতুন করে বেছে নিতে পারবে না।'
          : null,
      })),
    };
  }

  /**
   * Set the shop's grant list. Whole-list replace, not add/remove.
   *
   * A checklist submits its full state, so a replace is what the UI actually
   * means. Add/remove endpoints would need the client to diff, and a client
   * that diffs against stale data silently revokes a grant somebody else just
   * added.
   */
  async setShopTemplates(shopId, adminId, keys) {
    if (!Array.isArray(keys)) {
      throw new AppError('templates must be an array', 'টেমপ্লেট তালিকা সঠিক নয়', 400);
    }

    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('Shop not found', 'দোকান পাওয়া যায়নি', 404);
    }

    const wanted = [...new Set(keys.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean))];
    const previous = shop.storefront?.allowedTemplates || [];

    if (wanted.length) {
      // Only `published` templates may be newly granted. A draft template is
      // unfinished and a retired one is on its way out; granting either hands a
      // shop a tile it should not be able to pick.
      //
      // Anything ALREADY granted is exempt, so this call cannot fail because a
      // template was retired after the grant was made — the admin would be
      // unable to save an unrelated change to the same checklist.
      const offerable = await StorefrontTemplate.find({
        key: { $in: wanted },
        $or: [{ status: 'published' }, { key: { $in: previous } }],
      }).select('key').lean();

      const valid = new Set(offerable.map((t) => t.key));
      const rejected = wanted.filter((k) => !valid.has(k));
      if (rejected.length) {
        throw new AppError(
          `Not available for granting: ${rejected.join(', ')}`,
          `এই টেমপ্লেটগুলো দেওয়া যাবে না: ${rejected.join(', ')}`,
          400
        );
      }
    }

    const added = wanted.filter((k) => !previous.includes(k));
    const removed = previous.filter((k) => !wanted.includes(k));
    if (!added.length && !removed.length) {
      return { shop: shopId, allowedTemplates: previous, added: [], removed: [] };
    }

    if (!shop.storefront) shop.storefront = {};
    shop.storefront.allowedTemplates = wanted;
    shop.markModified('storefront');
    await shop.save();

    await AuditLog.create({
      shop: shopId,
      admin: adminId,
      action: 'storefront_templates_granted',
      description: `Storefront templates for "${shop.name}": +[${added.join(', ') || '—'}] -[${removed.join(', ') || '—'}]`,
      descriptionBn: `"${shop.name}" দোকানের টেমপ্লেট হালনাগাদ করা হয়েছে`,
      entity: { type: 'shop', id: shop._id, name: shop.name },
      changes: { before: { allowedTemplates: previous }, after: { allowedTemplates: wanted } },
    });

    // The grant list rides in the shop payload of the auth cache, so every
    // session has to be invalidated for the shop's picker to see the change on
    // its next request. Same reason `setShopFeature` does it.
    await invalidateShopAuthCache(shopId);

    return { shop: shopId, allowedTemplates: wanted, added, removed };
  }

  // ══ OVERSIGHT & KILL SWITCH ══════════════════════════════════════════════

  /**
   * Every shop with a storefront document, for the platform-wide list.
   *
   * The first question anyone will ask about this feature is "who is actually
   * using it", and a feature with no answer to that gets rebuilt on vibes.
   */
  async listStorefronts({ page = 1, limit = 20, status } = {}) {
    const filter = {};
    if (status) filter.status = status;

    const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
    const [rows, total] = await Promise.all([
      Storefront.find(filter)
        .populate('shop', 'name slug phone')
        .sort({ 'stats.lastOrderAt': -1, updatedAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Storefront.countDocuments(filter),
    ]);

    return {
      storefronts: rows.map((s) => ({
        _id: s._id,
        shop: s.shop,
        status: s.status,
        pausedByAdmin: Boolean(s.pausedByAdmin),
        template: s.published?.template || s.draft?.template || null,
        version: s.published?.version || 0,
        publishedAt: s.published?.publishedAt || null,
        stats: s.stats,
      })),
      pagination: { page: Number(page), limit: Number(limit), total },
    };
  }

  /**
   * The platform kill switch — take one storefront dark immediately.
   *
   * For illegal goods, abuse or a complaint. It does NOT touch the shop's POS:
   * they keep trading at the counter while their website is down, because the
   * two are different questions and conflating them turns a content complaint
   * into a shop closure.
   *
   * `pausedByAdmin` is what makes it stick — `storefront.service.setStatus`
   * refuses to un-pause while it is set, so the shop cannot undo it.
   */
  async setStorefrontPause(shopId, adminId, { paused, reason } = {}) {
    const storefront = await Storefront.findOne({ shop: shopId });
    if (!storefront) {
      throw new AppError('Storefront not found', 'অনলাইন দোকান পাওয়া যায়নি', 404);
    }

    const shop = await Shop.findById(shopId).select('name').lean();

    if (paused) {
      storefront.status = 'paused';
      storefront.pausedByAdmin = adminId;
      storefront.pauseReason = reason || '';
    } else {
      storefront.pausedByAdmin = null;
      storefront.pauseReason = '';
      // Resuming returns it to `live` only if there is something to serve.
      // A never-published storefront goes back to `unpublished`, not live.
      storefront.status = storefront.published?.template ? 'live' : 'unpublished';
    }
    await storefront.save();

    await AuditLog.create({
      shop: shopId,
      admin: adminId,
      action: paused ? 'storefront_paused_by_admin' : 'storefront_resumed_by_admin',
      description: paused
        ? `Paused storefront for "${shop?.name}". Reason: ${reason || '—'}`
        : `Resumed storefront for "${shop?.name}"`,
      descriptionBn: paused
        ? `"${shop?.name}" দোকানের অনলাইন সাইট বন্ধ করা হয়েছে। কারণ: ${reason || '—'}`
        : `"${shop?.name}" দোকানের অনলাইন সাইট আবার চালু করা হয়েছে`,
      entity: { type: 'storefront', id: storefront._id, name: shop?.name },
    });

    // The public page is cached per shop; retire the generation so a paused
    // storefront goes dark now rather than at the next natural expiry.
    await cacheService.bumpShopCacheVersion(shopId, 0);

    return storefront.toObject();
  }
}

module.exports = new AdminStorefrontService();
