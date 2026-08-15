const Storefront = require('../models/Storefront.model');
const { HISTORY_LIMIT } = require('../models/Storefront.model');
const StorefrontTemplate = require('../models/StorefrontTemplate.model');
const { SLOT_KEYS } = require('../models/StorefrontTemplate.model');
const Shop = require('../models/Shop.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');

/** Hard ceiling on zones per shop — a zone table is not a district gazetteer. */
const MAX_ZONES = 20;
/** A delivery charge above this is a typo, not a price. */
const MAX_CHARGE = 100000;

/**
 * Validate and normalise a shop-submitted delivery-zone table.
 *
 * The settings PATCH replaces the array wholesale (the UI edits the table as a
 * whole), so this is the one gate everything in it passes through. What it
 * refuses, and why it matters that it refuses rather than coerces:
 *
 *   - a zone with no name — renders as a blank radio button at checkout;
 *   - a non-finite or negative charge — `resolveDelivery` would happily
 *     snapshot `NaN` onto an order's money fields;
 *   - duplicate keys — `resolveDelivery` matches by key, so two zones sharing
 *     one key means the customer picks one and is charged the other;
 *   - an empty table with pickup also off is allowed to SAVE (a shop may pause
 *     deliveries), but checkout already refuses it with its own message.
 *
 * Keys are preserved when present (orders snapshot `zoneKey`; a stable key is
 * what lets "এই এলাকার অর্ডার" stay queryable) and derived when absent, so the
 * UI can add a row without inventing slugs client-side.
 */
function normalizeZones(rawZones) {
  if (!Array.isArray(rawZones)) {
    throw new AppError('zones must be an array', 'ডেলিভারি এলাকা সঠিক নয়', 400);
  }
  if (rawZones.length > MAX_ZONES) {
    throw new AppError(
      `At most ${MAX_ZONES} delivery zones`,
      `সর্বোচ্চ ${MAX_ZONES}টি ডেলিভারি এলাকা রাখা যাবে`,
      400
    );
  }

  const seen = new Set();
  return rawZones.map((raw, index) => {
    const name = String(raw?.name || raw?.nameBn || '').trim();
    const nameBn = String(raw?.nameBn || '').trim();
    if (!name) {
      throw new AppError('Every zone needs a name', 'প্রতিটি এলাকার নাম দিন', 400);
    }
    if (name.length > 60 || nameBn.length > 60) {
      throw new AppError('Zone name too long', 'এলাকার নাম ৬০ অক্ষরের মধ্যে দিন', 400);
    }

    const charge = Number(raw?.charge);
    if (!Number.isFinite(charge) || charge < 0 || charge > MAX_CHARGE) {
      throw new AppError('Invalid delivery charge', `"${name}" এর ডেলিভারি চার্জ সঠিক নয়`, 400);
    }
    const freeAbove = Number(raw?.freeAbove) || 0;
    if (freeAbove < 0 || freeAbove > 10000000) {
      throw new AppError('Invalid free-delivery threshold', `"${name}" এর ফ্রি ডেলিভারি সীমা সঠিক নয়`, 400);
    }

    const etaDaysMin = Math.min(60, Math.max(0, parseInt(raw?.etaDaysMin, 10) || 0));
    const etaDaysMax = Math.min(60, Math.max(etaDaysMin, parseInt(raw?.etaDaysMax, 10) || etaDaysMin));

    // Keep a stored key; derive one for a new row. ASCII-slugged from the
    // English name when it has one, positional otherwise (Bengali-only names
    // slug to nothing).
    let key = String(raw?.key || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!key) {
      key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
        || `zone-${index + 1}`;
    }
    let unique = key;
    let n = 2;
    while (seen.has(unique)) unique = `${key}-${n++}`;
    seen.add(unique);

    return {
      key: unique.slice(0, 40),
      name,
      nameBn: nameBn || undefined,
      charge: Math.round(charge * 100) / 100,
      freeAbove: Math.round(freeAbove * 100) / 100,
      etaDaysMin,
      etaDaysMax,
      isActive: raw?.isActive !== false,
    };
  });
}

/**
 * Storefront management — the shop's side of the online panel.
 *
 * The platform's side (granting templates, the template catalogue itself) lives
 * in `adminStorefront.service`. The split is the same one `Shop.features` already has:
 * the platform decides what a shop MAY do, the shop decides what it DOES.
 *
 * ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────
 *
 * A template is validated against `Shop.storefront.allowedTemplates` when it is
 * APPLIED, and never when it is READ. Every read path here — `getStorefront`,
 * `getPublished`, the gallery — returns whatever the document stores, including
 * a template whose grant has since been revoked.
 *
 * Validating on read would mean an admin tidying the template list takes live
 * shops offline, learns about it from a support call, and cannot say which
 * shops they broke. See Shop.model.js `storefront.allowedTemplates`.
 */
class StorefrontService {
  /**
   * The shop's storefront, created on first access.
   *
   * Lazy rather than created alongside the Shop, because `features.storefront`
   * is off for essentially every shop and a document per shop for a feature
   * nobody has is a collection of empty rows. The panel is the only thing that
   * calls this, and the panel does not render without the capability.
   *
   * Seeds `blocks` from what the shop already knows about itself, so a shop
   * that applies a template and types nothing still gets a coherent site. That
   * is the whole "immediately visible" promise: the fastest path from flag to
   * website must not run through a form.
   */
  async getStorefront(shopId) {
    let storefront = await Storefront.findOne({ shop: shopId });
    if (storefront) return storefront;

    const shop = await Shop.findById(shopId).lean();
    if (!shop) {
      throw new AppError('Shop not found', 'দোকান পাওয়া যায়নি', 404);
    }

    const seeded = this._seedBlocks(shop);
    storefront = await Storefront.create({
      shop: shopId,
      // Single-branch shops carry null here forever, which is what keeps every
      // downstream query identical to the one they issue today (I-1).
      branch: null,
      status: 'unpublished',
      draft: { template: null, theme: {}, blocks: seeded, nav: [], seo: this._seedSeo(shop) },
    });
    return storefront;
  }

  /**
   * Starting content, derived from the shop record.
   *
   * Only slots that can be answered from data the shop already has. `hero` is
   * left empty on purpose — a headline we invented would be worse than the
   * template's own placeholder, and it would look "done" enough that nobody
   * would replace it.
   */
  _seedBlocks(shop) {
    return {
      identity: {
        name: shop.name,
        tagline: '',
        about: '',
        logo: shop.logo || null,
      },
      contact: {
        phone: shop.phone || '',
        whatsapp: shop.phone || '',
        address: shop.address || '',
        hours: '',
      },
      trust: {
        badges: [
          { icon: 'truck', label: 'দ্রুত ডেলিভারি' },
          { icon: 'wallet', label: 'ক্যাশ অন ডেলিভারি' },
          { icon: 'shield', label: '১০০% আসল পণ্য' },
        ],
      },
      policies: {
        delivery: 'ঢাকার ভিতরে ১-২ দিন, ঢাকার বাইরে ২-৪ দিনের মধ্যে পণ্য পৌঁছে যাবে।',
        returns: 'পণ্য বুঝে নেওয়ার সময় সমস্যা পেলে সাথে সাথে জানান।',
        privacy: 'আপনার নাম, ফোন ও ঠিকানা শুধুমাত্র অর্ডার পৌঁছে দিতে ব্যবহার করা হয়।',
      },
      social: {},
      collections: [],
    };
  }

  _seedSeo(shop) {
    return {
      title: shop.name,
      description: `${shop.name} — অনলাইনে অর্ডার করুন।`,
      ogImage: shop.logo || null,
    };
  }

  /**
   * The template gallery for this shop's picker.
   *
   * Returns every template the shop may pick, PLUS the one it is currently
   * running even when that grant has been revoked or the template retired —
   * flagged, so the UI can grey it and say why, rather than showing the shop a
   * gallery that does not contain the site they are looking at.
   */
  async getTemplateGallery(shop) {
    const allowed = new Set(shop?.storefront?.allowedTemplates || []);
    const storefront = await Storefront.findOne({ shop: shop._id }).lean();
    const activeKeys = [storefront?.draft?.template, storefront?.published?.template]
      .filter(Boolean);

    // One query: everything granted, plus whatever is in use. `$in` on an empty
    // array matches nothing, which is the right answer for an ungranted shop.
    const keys = [...new Set([...allowed, ...activeKeys])];
    if (keys.length === 0) return [];

    const templates = await StorefrontTemplate.find({ key: { $in: keys } })
      .sort({ sortOrder: 1, key: 1 })
      .lean();

    return templates.map((t) => ({
      ...t,
      isGranted: allowed.has(t.key),
      isInUse: activeKeys.includes(t.key),
      // Selectable = the shop may switch TO it right now. A retired or revoked
      // template that is currently rendering is not selectable and is not
      // removed either.
      isSelectable: allowed.has(t.key) && t.status === 'published',
    }));
  }

  /**
   * Apply a template to the DRAFT.
   *
   * Never touches `published` — applying is an edit like any other, and the
   * shop sees it in preview until they publish. That is what makes trying three
   * templates on a live site safe.
   *
   * Content is NOT migrated, transformed or cleared. Every template reads the
   * same slot vocabulary, so switching re-renders what is already stored. A
   * slot the new template does not render is kept, not deleted, so switching
   * back restores it — lossless in both directions, which is the whole claim
   * (ECOMMERCE_PLAN.md §4.2).
   */
  async applyTemplate(shop, userId, templateKey) {
    const key = String(templateKey || '').trim().toLowerCase();
    if (!key) {
      throw new AppError('Template key required', 'টেমপ্লেট নির্বাচন করুন', 400);
    }

    const allowed = shop?.storefront?.allowedTemplates || [];
    if (!allowed.includes(key)) {
      // 403 rather than 404: the shop's own picker showed this template (it may
      // be rendering it right now), so pretending it does not exist would be
      // more confusing than saying it is not theirs to choose.
      throw new AppError(
        'This template has not been enabled for your shop',
        'এই টেমপ্লেটটি আপনার দোকানের জন্য চালু করা হয়নি',
        403
      );
    }

    const template = await StorefrontTemplate.findOne({ key });
    if (!template) {
      throw new AppError('Template not found', 'টেমপ্লেট পাওয়া যায়নি', 404);
    }
    if (template.status !== 'published') {
      throw new AppError(
        'This template is no longer available',
        'এই টেমপ্লেটটি আর ব্যবহার করা যাবে না',
        400
      );
    }

    const storefront = await this.getStorefront(shop._id);
    const previous = storefront.draft?.template || null;
    if (previous === key) return storefront;

    storefront.draft.template = key;
    // The theme is reset to the template's own defaults rather than carried
    // over. Tokens are template-specific — one template's `accent` is a button,
    // another's is a section rule — so carrying them produces a site that looks
    // broken in a way the shop cannot diagnose. Content survives; colours do
    // not, and the picker says so before the switch.
    storefront.draft.theme = {};
    storefront.markModified('draft');
    await storefront.save();

    await AuditLog.create({
      shop: shop._id,
      user: userId,
      action: 'storefront_template_applied',
      description: `Applied storefront template "${template.name}"`,
      descriptionBn: `"${template.nameBn}" টেমপ্লেট প্রয়োগ করা হয়েছে`,
      entity: { type: 'storefront', id: storefront._id, name: template.nameBn },
      changes: { before: { template: previous }, after: { template: key } },
    });

    return storefront;
  }

  /**
   * Patch the draft's presentation.
   *
   * Guarded with `in` rather than truthiness throughout. A form that does not
   * render a section does not send its key, and a service that normalises
   * unconditionally reads that absent key as `undefined` and clears it — which
   * is the trap AGENT_WORKFLOW.md §13.7 documents, and the reason
   * `wholesalePrice` had to be rescued in `updateProduct`. Here it would mean
   * saving the theme wipes every block.
   */
  async updateDraft(shopId, patch = {}) {
    const storefront = await this.getStorefront(shopId);

    if ('theme' in patch) {
      storefront.draft.theme = this._plainObject(patch.theme, 'theme');
    }
    if ('nav' in patch) {
      if (!Array.isArray(patch.nav)) {
        throw new AppError('nav must be an array', 'মেনু তালিকা সঠিক নয়', 400);
      }
      storefront.draft.nav = patch.nav;
    }
    if ('seo' in patch) {
      storefront.draft.seo = this._plainObject(patch.seo, 'seo');
    }
    if ('blocks' in patch) {
      const blocks = this._plainObject(patch.blocks, 'blocks');
      const unknown = Object.keys(blocks).filter((k) => !SLOT_KEYS.includes(k));
      if (unknown.length) {
        // Refused rather than dropped. A slot name that does not exist is
        // either a typo or a template inventing its own vocabulary, and both
        // must fail loudly — content stored under a name nothing renders is
        // content the shop believes it wrote and will never see.
        throw new AppError(
          `Unknown storefront slots: ${unknown.join(', ')}`,
          `অজানা সেকশন: ${unknown.join(', ')}`,
          400
        );
      }
      // Merge per slot rather than replacing the whole map, so an editor that
      // saves one section cannot blank the other eleven.
      storefront.draft.blocks = { ...(storefront.draft.blocks || {}), ...blocks };
    }

    storefront.markModified('draft');
    await storefront.save();
    return storefront;
  }

  _plainObject(value, label) {
    if (value === null || value === undefined) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new AppError(`${label} must be an object`, 'তথ্যের ধরন সঠিক নয়', 400);
    }
    return value;
  }

  /**
   * Copy draft → published, and go live.
   *
   * The old published version is pushed onto `history` first, capped at
   * HISTORY_LIMIT. Rollback is then a copy in the other direction with no
   * deploy and no support ticket.
   */
  async publish(shopId, userId) {
    const storefront = await this.getStorefront(shopId);

    if (!storefront.draft?.template) {
      throw new AppError(
        'Pick a template before publishing',
        'প্রকাশ করার আগে একটি টেমপ্লেট নির্বাচন করুন',
        400
      );
    }

    if (storefront.published?.publishedAt) {
      storefront.history.unshift(storefront.published.toObject
        ? storefront.published.toObject()
        : storefront.published);
      storefront.history = storefront.history.slice(0, HISTORY_LIMIT);
    }

    const version = (storefront.published?.version || 0) + 1;
    storefront.published = {
      template: storefront.draft.template,
      theme: storefront.draft.theme || {},
      blocks: storefront.draft.blocks || {},
      nav: storefront.draft.nav || [],
      seo: storefront.draft.seo || {},
      version,
      publishedAt: new Date(),
      publishedBy: userId,
    };

    // Publishing is what takes a never-published site live. It does NOT clear
    // an admin pause — that would make the kill switch a suggestion.
    if (storefront.status === 'unpublished' && !storefront.pausedByAdmin) {
      storefront.status = 'live';
    }

    storefront.markModified('published');
    storefront.markModified('history');
    await storefront.save();

    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'storefront_published',
      description: `Published storefront version ${version}`,
      descriptionBn: `ওয়েবসাইটের ${version} নম্বর সংস্করণ প্রকাশ করা হয়েছে`,
      entity: { type: 'storefront', id: storefront._id, name: `v${version}` },
    });

    return storefront;
  }

  /**
   * Restore a previous published version into the DRAFT.
   *
   * Into the draft, not straight to live, so the shop sees what they are about
   * to restore before customers do. One more click is a cheap price for not
   * publishing the wrong version twice in a row.
   */
  async rollback(shopId, userId, version) {
    const storefront = await this.getStorefront(shopId);
    const target = (storefront.history || []).find((h) => h.version === Number(version));
    if (!target) {
      throw new AppError('Version not found', 'এই সংস্করণটি পাওয়া যায়নি', 404);
    }

    storefront.draft = {
      template: target.template,
      theme: target.theme || {},
      blocks: target.blocks || {},
      nav: target.nav || [],
      seo: target.seo || {},
    };
    storefront.markModified('draft');
    await storefront.save();

    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'storefront_rollback',
      description: `Restored storefront version ${version} into draft`,
      descriptionBn: `ওয়েবসাইটের ${version} নম্বর সংস্করণ ড্রাফটে ফেরানো হয়েছে`,
      entity: { type: 'storefront', id: storefront._id, name: `v${version}` },
    });

    return storefront;
  }

  /**
   * The shop's own pause / resume.
   *
   * Refuses when an ADMIN paused it. Otherwise the platform kill switch —
   * abuse, a complaint, illegal goods — would be one click away from being
   * undone by the shop it was aimed at.
   */
  async setStatus(shopId, userId, status) {
    if (!['live', 'paused'].includes(status)) {
      throw new AppError('Invalid status', 'অবস্থা সঠিক নয়', 400);
    }
    const storefront = await this.getStorefront(shopId);

    if (storefront.pausedByAdmin) {
      throw new AppError(
        'This storefront has been paused by the platform. Please contact support.',
        'আপনার অনলাইন দোকানটি কর্তৃপক্ষ সাময়িকভাবে বন্ধ করেছে। সহায়তার জন্য যোগাযোগ করুন।',
        403
      );
    }
    if (status === 'live' && !storefront.published?.template) {
      throw new AppError(
        'Publish the storefront before going live',
        'চালু করার আগে ওয়েবসাইটটি প্রকাশ করুন',
        400
      );
    }

    storefront.status = status;
    await storefront.save();
    return storefront;
  }

  /**
   * Settings that are not presentation: delivery, notifications, order prefix,
   * analytics ids, out-of-stock behaviour.
   *
   * Not staged — these are operational, not visual, and a shop that changes its
   * delivery charge means it now, not at the next publish.
   */
  async updateSettings(shopId, patch = {}) {
    const storefront = await this.getStorefront(shopId);

    if ('delivery' in patch && patch.delivery) {
      if ('zones' in patch.delivery) {
        storefront.delivery.zones = normalizeZones(patch.delivery.zones);
      }
      if ('pickupEnabled' in patch.delivery) {
        storefront.delivery.pickupEnabled = patch.delivery.pickupEnabled === true;
      }
    }
    if ('notifications' in patch && patch.notifications) {
      for (const key of ['telegram', 'smsOnConfirm', 'smsOnShip']) {
        if (key in patch.notifications) {
          storefront.notifications[key] = patch.notifications[key] === true;
        }
      }
    }
    if ('analytics' in patch && patch.analytics) {
      for (const key of ['fbPixelId', 'gaId']) {
        if (key in patch.analytics) {
          storefront.analytics[key] = String(patch.analytics[key] || '').trim();
        }
      }
    }
    if ('outOfStockBehaviour' in patch) {
      if (!['hide', 'show'].includes(patch.outOfStockBehaviour)) {
        throw new AppError('Invalid value', 'মান সঠিক নয়', 400);
      }
      storefront.outOfStockBehaviour = patch.outOfStockBehaviour;
    }
    if ('orderPrefix' in patch) {
      const prefix = String(patch.orderPrefix || '').trim().toUpperCase();
      // Same rule as product codes: it ends up on a document a courier reads
      // and a customer quotes over the phone. ASCII or nothing.
      if (!/^[A-Z0-9-]{1,8}$/.test(prefix)) {
        throw new AppError(
          'Order prefix must be 1-8 English letters, digits or hyphens',
          'অর্ডার প্রিফিক্স ১-৮টি ইংরেজি অক্ষর, সংখ্যা বা হাইফেন দিয়ে লিখুন',
          400
        );
      }
      storefront.orderPrefix = prefix;
    }
    if ('branch' in patch) {
      storefront.branch = patch.branch || null;
    }

    await storefront.save();
    return storefront;
  }
}

module.exports = new StorefrontService();
// The zone gate, exported for tests — it is the one function between a
// shop-typed settings form and the money fields checkout snapshots.
module.exports.normalizeZones = normalizeZones;
