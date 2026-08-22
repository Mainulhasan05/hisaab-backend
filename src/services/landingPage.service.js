/**
 * Landing pages — authoring, publishing, expiry.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS MODULE MUST NEVER TOUCH THE SHOP'S BOOKS (I-17)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * There is no `require` here of `Customer`, `CustomerBalance`, `Sale`,
 * `StockTransaction`, `Payment`, `InvoiceCounter` or `Order`, and there must
 * never be one. A landing order is not a sale, does not create a customer, and
 * does not move stock — see LANDING_PAGE_PLAN.md §2.2 for the decision and what
 * it cost. An import of any of those models in this file or its siblings is the
 * violation, visible in review without running anything.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SAVE PIPELINE, IN ORDER, AND WHY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   1. prepare    — the document is stored as pasted, minus `<base>`, and the
 *                   hosts it reaches for are inventoried. It is NOT stripped of
 *                   scripts: the public render path frames it in an opaque
 *                   origin, which is what makes that safe. See
 *                   `landingDocument.util` for the whole argument.
 *   2. parse      — derive the manifest the editor renders, and collect every
 *                   media URL the document points at.
 *   3. sync refs  — I-18. An admin can paste an R2 URL where no picker ever ran;
 *                   without this pass nothing holds a reference and the
 *                   reclamation sweep eventually deletes the hero image off a
 *                   live page.
 *   4. validate   — reported on save, ENFORCED on publish. Saving a broken draft
 *                   has to stay possible or an author cannot work incrementally.
 */

const mongoose = require('mongoose');

const LandingPage = require('../models/LandingPage.model');
const LandingOrder = require('../models/LandingOrder.model');
const R2Account = require('../models/R2Account.model');
const PlatformMedia = require('../models/PlatformMedia.model');
const platformMediaService = require('./platformMedia.service');
const { prepareLandingDocument, describeExternalHosts } = require('../utils/landingDocument.util');
const { parseContract, validateContract, hasBlockingIssues } = require('../utils/landingContract.util');
const { resolveLandingPage, STATES } = require('../utils/landingPageState.util');
const { endOfBangladeshDay } = require('../utils/bdTime.util');
const { AppError } = require('../middleware/error.middleware');
const logger = require('../utils/logger.util');

const { HTML_HISTORY_LIMIT } = LandingPage;

/** The name this feature registers under in the media library's consumer registry. */
const OWNER_TYPE = 'landingPage';

/** Media library URL fields a document might legitimately point at. */
const URL_FIELDS = Object.freeze(['url', 'thumbUrl', 'mediumUrl']);

/** What `statsForPage` returns when there is nothing to count. */
const EMPTY_STATS = Object.freeze({
  received: 0,
  pending: 0,
  confirmed: 0,
  delivered: 0,
  cancelled: 0,
  confirmedValue: 0,
  deliveredValue: 0,
  confirmationRate: 0,
});

function toObjectId(value) {
  const str = String(value || '');
  if (!mongoose.Types.ObjectId.isValid(str)) return null;
  return new mongoose.Types.ObjectId(str);
}

class LandingPageService {
  // ── Media library integration ─────────────────────────────────────────────

  /**
   * Register with the media library.
   *
   * Called once at startup. The library imports nothing from here — the arrow
   * points one way (MEDIA_GALLERY_PLAN.md §4.3), which is why this is a call we
   * make rather than an entry in a list the library keeps.
   */
  registerAsMediaConsumer() {
    platformMediaService.registerConsumer({
      ownerType: OWNER_TYPE,
      label: 'সিজন পেজ',

      /** Turn page ids into the label and link the file-detail panel shows. */
      resolve: async (ownerIds) => {
        const pages = await LandingPage.find({ _id: { $in: ownerIds } })
          .select('title slug status expiresAt graceDays startsAt pausedByAdmin')
          .lean();

        return pages.map((p) => ({
          id: String(p._id),
          label: p.title,
          href: `/p/${p.slug}`,
          // Shown as a "live" pill, so an admin can see at a glance that
          // deleting this file would break something currently being advertised.
          isLive: resolveLandingPage(p).canAcceptOrders,
        }));
      },

      /**
       * The I-18 backstop. Asked before any file is deleted.
       *
       * Deliberately broader than `refs`: it re-derives the answer from the HTML
       * itself rather than trusting the bookkeeping that the sweep is checking.
       * If the scanner in `_syncMediaRefs` ever has a bug, this is what stops it
       * costing a live page its images.
       */
      confirmInUse: async (mediaIds) => {
        const ids = mediaIds.map(String);
        const media = await PlatformMedia.find({ _id: { $in: ids } })
          .select('url thumbUrl mediumUrl')
          .lean();
        if (media.length === 0) return [];

        // Only pages that could still be serving matter. An expired page's
        // images are genuinely reclaimable — that is what makes the grace
        // period useful rather than a permanent hold on every byte.
        const pages = await LandingPage.find({ status: { $in: ['live', 'draft', 'paused'] } })
          .select('html assets offers seo status expiresAt graceDays startsAt pausedByAdmin')
          .lean();

        const inUse = new Set();
        for (const item of media) {
          const urls = URL_FIELDS.map((f) => item[f]).filter(Boolean);
          const idStr = String(item._id);

          for (const page of pages) {
            if (this._pageReferences(page, idStr, urls)) {
              inUse.add(idStr);
              break;
            }
          }
        }

        return [...inUse];
      },
    });
  }

  /** Does this page point at this media, by attachment or by raw URL? */
  _pageReferences(page, mediaId, urls) {
    const assetIds = Object.values(page.assets || {}).map(String);
    if (assetIds.includes(mediaId)) return true;

    if ((page.offers || []).some((o) => o.image && String(o.image) === mediaId)) return true;
    if (page.seo?.ogImage && String(page.seo.ogImage) === mediaId) return true;

    const html = String(page.html || '');
    return urls.some((u) => u && html.includes(u));
  }

  /**
   * Reconcile this page's media references — I-18, mechanism 1.
   *
   * Two origins, kept apart on purpose. `explicit` is what a picker attached;
   * `scanned` is what was found in the HTML. A scan pass replaces only the
   * scanned set, so it can never wipe an attachment the admin made deliberately.
   */
  async _syncMediaRefs(page, parsed) {
    const explicit = [];

    for (const [key, mediaId] of Object.entries(page.assets || {})) {
      if (mediaId) explicit.push({ mediaId, key });
    }
    for (const offer of page.offers || []) {
      if (offer.image) explicit.push({ mediaId: offer.image, key: `offer:${offer.key}` });
    }
    if (page.seo?.ogImage) explicit.push({ mediaId: page.seo.ogImage, key: 'seo:ogImage' });

    // Resolve the URLs the document points at back to library documents. A URL
    // that matches nothing is somebody else's image and is not our problem.
    const urls = (parsed?.mediaUrls || []).filter(Boolean);
    let scanned = [];
    if (urls.length > 0) {
      const found = await PlatformMedia.find({
        $or: URL_FIELDS.map((f) => ({ [f]: { $in: urls } })),
      }).select('_id').lean();
      scanned = found.map((m) => ({ mediaId: m._id, key: null }));
    }

    try {
      await platformMediaService.setOwnerRefs(OWNER_TYPE, page._id, explicit, { origin: 'explicit' });
      await platformMediaService.setOwnerRefs(OWNER_TYPE, page._id, scanned, { origin: 'scanned' });
    } catch (err) {
      // A reference that failed to move is a reclamation problem the sweep's
      // `confirmInUse` backstop already covers. A page save that 500s because of
      // it is an admin who cannot save their work.
      logger.error(`Landing page ${page._id}: media ref sync failed: ${err.message}`);
    }

    return { explicit: explicit.length, scanned: scanned.length };
  }

  // ── Authoring ─────────────────────────────────────────────────────────────

  /**
   * The public hostnames of our own buckets.
   *
   * Read at call time rather than hard-coded: the bucket's public hostname
   * changes when the custom domain lands (R2_STORAGE_PLAN.md §৭.৩), and a
   * constant here would silently start rewriting every image the day it does.
   */
  async _ownHosts() {
    const accounts = await R2Account.find().select('publicBaseUrl').lean();
    return accounts
      .map((a) => {
        try {
          return new URL(String(a.publicBaseUrl)).hostname.toLowerCase();
        } catch (err) {
          return null;
        }
      })
      .filter(Boolean);
  }

  async create({ shop, title, slug, ...rest }, adminId) {
    if (!shop) throw new AppError('A shop is required', 'দোকান নির্বাচন করুন', 400);

    try {
      return await LandingPage.create({
        shop,
        title,
        slug: String(slug || '').toLowerCase().trim(),
        ...rest,
        status: 'draft',
        createdBy: adminId,
      });
    } catch (err) {
      if (err?.code === 11000) {
        throw new AppError(
          `The link "${slug}" is already taken`,
          `"${slug}" লিংকটি আগে থেকেই ব্যবহৃত হচ্ছে — অন্য একটি দিন`,
          409
        );
      }
      throw err;
    }
  }

  async getById(pageId) {
    const page = await LandingPage.findById(pageId);
    if (!page) throw new AppError('Landing page not found', 'পেজটি পাওয়া যায়নি', 404);
    return page;
  }

  /**
   * Admin save. Runs the whole pipeline and reports what it found.
   *
   * Validation issues are REPORTED, not thrown: an author working through
   * generated HTML has to be able to save a page that is not finished yet.
   * `publish` is where the same issues become a refusal.
   */
  async saveContent(pageId, adminId, {
    html, offers, delivery, seo, orderPrefix, notifications, analytics, editableKeys,
    payment, coupons,
  }) {
    const page = await this.getById(pageId);

    let sanitizeNotes = null;
    let parsed = null;

    if (html !== undefined) {
      const ownHosts = await this._ownHosts();
      const result = prepareLandingDocument(html, { ownHosts });
      sanitizeNotes = result.notes;

      // Keep the previous revision before overwriting. Not a publish workflow —
      // an undo, for the case where a paste goes wrong.
      if (page.html && page.html !== result.html) {
        page.htmlHistory = [
          { html: page.html, savedAt: new Date(), savedBy: adminId },
          ...(page.htmlHistory || []),
        ].slice(0, HTML_HISTORY_LIMIT);
      }

      page.html = result.html;
      parsed = parseContract(result.html);
      page.manifest = parsed.manifest;
    }

    if (offers !== undefined) page.offers = offers;
    if (delivery !== undefined) page.delivery = delivery;
    if (payment !== undefined) page.payment = payment;

    /**
     * Coupons are MERGED rather than replaced, and this is the one field on
     * this method where that matters.
     *
     * `usedCount` is live counter state written by `_reserveCoupon` on the
     * public path. An admin who opens the editor, changes a headline and saves
     * would post the coupon rows as their screen loaded them — with whatever
     * redemption count was current five minutes ago — and a straight assignment
     * would roll every code's usage back to that number. The shop's "limit 100"
     * code would then run to 130 and nobody would ever see why.
     *
     * So the incoming rows carry the RULES and the stored rows keep the COUNT.
     * A code that is genuinely new starts at zero; a code that was removed from
     * the list is gone, count and all, which is what removing it means.
     */
    if (coupons !== undefined) {
      const previous = new Map((page.coupons || []).map((c) => [c.code, c.usedCount || 0]));
      page.coupons = (coupons || []).map((c) => {
        const code = String(c.code || '').trim().toUpperCase();
        return { ...c, code, usedCount: previous.get(code) || 0 };
      });
    }

    if (seo !== undefined) page.seo = seo;
    if (orderPrefix !== undefined) page.orderPrefix = orderPrefix;
    if (notifications !== undefined) page.notifications = notifications;
    if (analytics !== undefined) page.analytics = analytics;

    if (editableKeys !== undefined) {
      // Only keys that actually exist may be marked editable — a whitelist
      // entry for a key no marker produces is a control the shop would see and
      // that would change nothing.
      const known = new Set((page.manifest || []).map((m) => m.key));
      page.editableKeys = (editableKeys || []).filter((k) => known.has(k));
    }

    page.updatedBy = adminId;
    await page.save();

    // Re-parse when only the offers changed, so the validation below is against
    // the current document rather than a stale read.
    if (!parsed) parsed = parseContract(page.html || '');
    await this._syncMediaRefs(page, parsed);

    const issues = this.publishIssues(page, parsed);

    return { page, issues, canPublish: !hasBlockingIssues(issues), sanitizeNotes };
  }

  /**
   * Everything standing between this page and a public URL.
   *
   * The contract's issues PLUS the ones the HTML cannot express. Today that is
   * the expiry date, and it lives here rather than in `landingContract.util`
   * because that module reads markup and a date is not markup.
   *
   * ONE list, used by the report and by the gate. They were two: the report
   * said "ready to publish" while `publish` refused for a missing expiry the
   * report never mentioned, and the only way to discover the real reason was
   * the network tab.
   *
   * @param {Object} page    a LandingPage document
   * @param {Object} [parsed]  from `parseContract`; re-parsed from the page if omitted
   */
  publishIssues(page, parsed = null) {
    const contract = parsed || parseContract(page.html || '');
    const issues = validateContract(contract, page);

    if (!page.expiresAt) {
      issues.push({
        severity: 'error',
        code: 'NO_EXPIRY',
        message: 'A live page needs an expiry date',
        // Names the tab. "Set an expiry date" with no map is how an admin ends
        // up pressing publish a second time to see whether it took.
        messageBn: 'পেজ চালু করার আগে "মেয়াদ" ট্যাবে মেয়াদ শেষের তারিখ দিন',
      });
    }

    /**
     * The document's off-origin hosts, as warnings — never as a refusal.
     *
     * A pasted design legitimately loads Tailwind, a font, an embedded video.
     * Those hosts are now KEPT and executed inside the sandboxed frame, so the
     * admin's only defence against an exfiltration snippet riding along in
     * generated HTML is seeing the list before they publish. A host they do not
     * recognise is the signal; refusing the page over `cdn.tailwindcss.com`
     * would train them to ignore it.
     */
    const hosts = describeExternalHosts(page.html || '');
    const warn = (code, en, bn) => issues.push({ severity: 'warn', code, message: en, messageBn: bn });

    if (hosts.scripts.length) {
      warn('EXTERNAL_SCRIPTS',
        `This page runs code from: ${hosts.scripts.join(', ')}`,
        `পেজটি এই সার্ভারগুলো থেকে কোড চালাবে: ${hosts.scripts.join(', ')}`);
    }
    if (hosts.styles.length) {
      warn('EXTERNAL_STYLES',
        `Stylesheets load from: ${hosts.styles.join(', ')}`,
        `ডিজাইন আসছে: ${hosts.styles.join(', ')}`);
    }
    if (hosts.frames.length) {
      warn('EXTERNAL_FRAMES',
        `Embedded frames from: ${hosts.frames.join(', ')}`,
        `এমবেড করা ফ্রেম: ${hosts.frames.join(', ')}`);
    }
    if (hosts.images.length) {
      // Not about safety — about the day that other server goes down and takes
      // the hero image of an ad-funded page with it.
      warn('EXTERNAL_IMAGES',
        `Images load from someone else's server: ${hosts.images.join(', ')}`,
        `ছবি আসছে অন্যের সার্ভার থেকে: ${hosts.images.join(', ')} — মিডিয়া লাইব্রেরিতে তুলে নিন`);
    }

    return issues;
  }

  /**
   * Take the page live.
   *
   * Three gates, and each one exists because failing it produces a page that
   * looks fine and cannot do its job:
   *
   *   · the contract — a form that cannot submit, on a URL an ad points at.
   *   · an expiry date — the seasonal fee IS the expiry (D3). A live page
   *     without one never stops, and nobody notices until renewal season.
   *   · video servability — a 20MB file on `r2.dev` gets throttled at exactly
   *     the hours the shop is paying for clicks (MEDIA_GALLERY_PLAN.md §6.4).
   */
  async publish(pageId, adminId) {
    const page = await this.getById(pageId);
    const { parsed, issues } = await this._assertPublishable(page);

    page.status = 'live';
    page.publishedAt = page.publishedAt || new Date();
    page.updatedBy = adminId;
    await page.save();

    await this._syncMediaRefs(page, parsed);
    return { page, issues };
  }

  /**
   * The gates that stand between a page and `status: 'live'`.
   *
   * Extracted because `renew` sets `status: 'live'` too, and it used to do so
   * WITHOUT running any of these. That was a real hole: a draft that had never
   * been publishable — no order form, no offers — could be made live by renewing
   * it, landing a page on a public URL that cannot take an order. Every path to
   * `live` goes through here now.
   *
   * @returns {Promise<{parsed: Object, issues: Array}>}
   */
  async _assertPublishable(page) {
    const parsed = parseContract(page.html || '');
    const issues = this.publishIssues(page, parsed);

    if (hasBlockingIssues(issues)) {
      // Every blocker at once, including the missing expiry — the refusal and
      // the report the author has been reading are now the same list.
      const blockers = issues.filter((i) => i.severity === 'error');
      const error = new AppError(
        blockers.length === 1 ? blockers[0].message : 'This page cannot take an order yet',
        blockers.length === 1
          ? blockers[0].messageBn
          : 'এই পেজটি এখনো অর্ডার নিতে পারবে না — নিচের সমস্যাগুলো ঠিক করুন',
        422
      );
      error.code = 'CONTRACT_INVALID';
      error.issues = issues;
      throw error;
    }

    await this._assertVideoServable(page);
    return { parsed, issues };
  }

  /** Refuse to publish a page whose video cannot be served yet. */
  async _assertVideoServable(page) {
    const ids = [
      ...Object.values(page.assets || {}),
      ...(page.offers || []).map((o) => o.image),
    ].filter(Boolean);
    if (ids.length === 0) return;

    const videos = await PlatformMedia.countDocuments({ _id: { $in: ids }, kind: 'video' });
    if (videos === 0) return;

    if (!(await platformMediaService.isVideoServable())) {
      throw new AppError(
        'Video cannot be served to public traffic until the storage bucket has a custom domain',
        'কাস্টম ডোমেইন যুক্ত না হওয়া পর্যন্ত ভিডিওসহ পেজ চালু করা যাবে না',
        422
      );
    }
  }

  /**
   * Assign or re-date a page.
   *
   * `expiresAt` is stored as the END of a Bangladesh day, so "paid through the
   * 31st" means the page takes orders all day on the 31st — the same convention
   * `Shop.subscription.expiresAt` uses. Storing the raw date would silently cost
   * the trader their busiest evening.
   */
  async setSchedule(pageId, adminId, { startsAt, expiresAt, graceDays }) {
    const page = await this.getById(pageId);

    if (startsAt !== undefined) page.startsAt = startsAt ? new Date(startsAt) : null;
    if (expiresAt !== undefined) {
      page.expiresAt = expiresAt ? endOfBangladeshDay(expiresAt) : null;
    }
    if (graceDays !== undefined) page.graceDays = Math.max(0, Number(graceDays) || 0);

    page.updatedBy = adminId;
    await page.save();
    return page;
  }

  /**
   * Next season. One field, not a rebuild.
   *
   * The same document is reused deliberately: an ad, a Facebook post and a
   * printed sticker may all carry the old URL, and a new document would mean a
   * new slug and a dead link on every one of them.
   */
  async renew(pageId, adminId, { expiresAt, graceDays }) {
    const page = await this.getById(pageId);
    if (!expiresAt) {
      throw new AppError('A renewal needs a new expiry date', 'নবায়নের জন্য নতুন মেয়াদ দিন', 400);
    }

    page.expiresAt = endOfBangladeshDay(expiresAt);
    if (graceDays !== undefined) page.graceDays = Math.max(0, Number(graceDays) || 0);

    // The same gates as `publish`. A renewal puts a page back on a public URL,
    // so it has to clear exactly what a first publication does — the offers may
    // have been edited while the page sat expired, and the HTML is only ever as
    // good as its last save.
    await this._assertPublishable(page);

    page.status = 'live';
    page.renewedAt = new Date();
    page.renewCount = (page.renewCount || 0) + 1;
    page.updatedBy = adminId;

    await page.save();
    return page;
  }

  /** The platform kill switch. The shop cannot clear this one. */
  async setAdminPause(pageId, adminId, { paused, reason }) {
    const page = await this.getById(pageId);
    page.pausedByAdmin = paused ? adminId : null;
    page.pauseReason = paused ? String(reason || '').slice(0, 500) : undefined;
    await page.save();
    return page;
  }

  // ── The shop's side ───────────────────────────────────────────────────────

  /** Every page assigned to one shop, with its resolved state. */
  async listForShop(shopId) {
    // `html` and `htmlHistory` are excluded and the reason is not tidiness: a
    // page's document is up to half a megabyte of markup, and a shop running
    // six campaigns would otherwise ship three megabytes to render a list of
    // six titles. `manifest` and `content` go too — the list shows neither.
    const pages = await LandingPage.find({ shop: shopId })
      .select('-html -htmlHistory -manifest -content -assets -analytics.fbCapiToken')
      .sort({ createdAt: -1 })
      .lean();

    return pages.map((page) => ({
      ...page,
      // Resolved on read, so a page is correct the instant the clock passes its
      // expiry whether or not the nightly job has run.
      state: resolveLandingPage(page),
    }));
  }

  /**
   * One page, as the SHOP is allowed to see it.
   *
   * Scoped by shop with a 404 rather than a 403 for someone else's page: a shop
   * must not be able to discover that a page id exists by the shape of the
   * error. Same rule `landingOrder.getForShop` follows.
   *
   * The manifest is filtered down to the entries the admin marked editable, and
   * that filtering happens HERE rather than in the panel. The panel decides what
   * to draw; this decides what exists. A shop that opens devtools on the response
   * learns the keys it was given and nothing about the ones it was not (I-16).
   */
  async getForShop(pageId, shopId) {
    const page = await LandingPage.findOne({ _id: toObjectId(pageId) || null, shop: shopId })
      .select('-htmlHistory -analytics.fbCapiToken');

    if (!page) {
      throw new AppError('Landing page not found', 'পেজটি পাওয়া যায়নি', 404);
    }

    const editable = new Set(page.editableKeys || []);
    const media = await this.resolvePublicMedia(page);

    return {
      page,
      state: resolveLandingPage(page),
      // Only the editable slots, each already carrying its current value so the
      // panel can render a form without a second request.
      fields: (page.manifest || [])
        .filter((entry) => entry && editable.has(entry.key))
        .map((entry) => ({
          ...entry,
          /**
           * The SAVED value only — empty when the shop has never touched this
           * slot, and deliberately NOT pre-filled with `entry.preview`.
           *
           * `preview` is a truncated snippet of what the HTML currently says.
           * Seeding a `rich` field's editor with it would look helpful and
           * would, on the next save, replace a paragraph of authored markup
           * with its own truncated plain text. The panel shows `preview` beside
           * the box as "পেজে এখন: …" instead, and an empty value leaves the
           * authored content untouched — the runtime only writes a slot it has
           * something to write.
           */
          value: page.content?.[entry.key] ?? '',
          image: media.assets[entry.key] || null,
        })),
    };
  }

  /**
   * A shop's edit. Enforced against the whitelist SERVER-SIDE (I-16).
   *
   * Hiding a control in the UI is not enforcement — the request is a plain HTTP
   * call, and the shop owns the browser making it. A key outside `editableKeys`
   * is dropped silently rather than refused: the admin decides what is editable,
   * and a shop that hand-crafts a request for a key it was not given is not owed
   * an explanation of what else exists.
   */
  async patchShopContent(pageId, shopId, patch) {
    const page = await this.getById(pageId);

    if (String(page.shop) !== String(shopId)) {
      // Not a 403 — a shop must not be able to discover that a page id exists.
      throw new AppError('Landing page not found', 'পেজটি পাওয়া যায়নি', 404);
    }

    const state = resolveLandingPage(page);
    if (!state.canEdit) {
      throw new AppError(
        `This page cannot be edited while it is ${state.state}`,
        'এই অবস্থায় পেজটি সম্পাদনা করা যাবে না',
        409
      );
    }

    const allowed = new Set(page.editableKeys || []);
    const content = { ...(page.content || {}) };
    const applied = [];

    for (const [key, value] of Object.entries(patch?.content || {})) {
      if (!allowed.has(key)) continue;
      content[key] = value;
      applied.push(key);
    }

    page.content = content;
    await page.save();

    return { page, applied };
  }

  // ── Public read ───────────────────────────────────────────────────────────

  /**
   * Resolve a slug for the public route.
   *
   * Returns the page and its state rather than throwing on an expired one: the
   * expired page still renders, as the closed notice. A 404 there would be worse
   * than useless — the advertisement may still be running (I-14).
   */
  async getPublicBySlug(slug) {
    const page = await LandingPage.findOne({ slug: String(slug || '').toLowerCase() });
    if (!page) return null;

    const state = resolveLandingPage(page);
    if (!state.isServable) return null;

    return { page, state, media: await this.resolvePublicMedia(page) };
  }

  /**
   * Turn every PlatformMedia id the page references into a URL the browser can
   * load — the manifest's `data-hisaab-img` slots, the offer thumbnails and the
   * OG image, in ONE query.
   *
   * Done here rather than by populating the document because the ids are spread
   * across three unrelated shapes (a Mixed map, an array of subdocuments, and a
   * single field) and `populate` would need three passes. It is also the reason
   * the public payload can carry URLs without ever carrying a media id: an id is
   * an internal handle and a landing page is read by strangers.
   *
   * A missing or deleted media id resolves to nothing rather than throwing. The
   * page renders with one image short, which is survivable; a 500 on a campaign
   * the shop is paying for traffic to is not.
   */
  async resolvePublicMedia(page) {
    const ids = new Set();
    const add = (id) => { if (id) ids.add(String(id)); };

    for (const id of Object.values(page.assets || {})) add(id);
    for (const offer of page.offers || []) add(offer.image);
    add(page.seo?.ogImage);

    if (ids.size === 0) return { assets: {}, offers: {}, ogImage: null };

    const docs = await PlatformMedia.find({ _id: { $in: [...ids] } })
      .select('url thumbUrl mediumUrl altText width height')
      .lean();

    const byId = new Map(docs.map((d) => [String(d._id), d]));
    const shape = (doc) => (doc ? {
      url: doc.url,
      thumbUrl: doc.thumbUrl || doc.url,
      mediumUrl: doc.mediumUrl || doc.url,
      alt: doc.altText || '',
      width: doc.width || null,
      height: doc.height || null,
    } : null);

    const assets = {};
    for (const [key, id] of Object.entries(page.assets || {})) {
      const found = shape(byId.get(String(id)));
      if (found) assets[key] = found;
    }

    const offers = {};
    for (const offer of page.offers || []) {
      const found = offer.image && shape(byId.get(String(offer.image)));
      if (found) offers[offer.key] = found;
    }

    return { assets, offers, ogImage: shape(byId.get(String(page.seo?.ogImage))) };
  }

  // ── Reporting ─────────────────────────────────────────────────────────────

  /**
   * One page's numbers.
   *
   * Confirmation rate is included because it is what a trader buying ads
   * actually judges a campaign by — forty orders at 40% is a worse campaign than
   * twenty at 90%, and the fake-order problem is exactly why.
   */
  async statsForPage(pageId, { from = null, to = null } = {}) {
    const page = toObjectId(pageId);
    // A malformed id reaching here comes from a route parameter. Returning
    // zeroes rather than letting the ObjectId cast throw turns a 500 into an
    // empty report, which is what the caller's 404 handling expects.
    if (!page) return EMPTY_STATS;

    const match = { page };
    if (from || to) {
      match.createdAt = {};
      if (from) match.createdAt.$gte = new Date(from);
      if (to) match.createdAt.$lte = new Date(to);
    }

    const rows = await LandingOrder.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$total' } } },
    ]);

    const byStatus = Object.fromEntries(rows.map((r) => [r._id, { count: r.count, value: r.value }]));
    const get = (s) => byStatus[s] || { count: 0, value: 0 };

    const received = rows.reduce((sum, r) => sum + r.count, 0);
    // Everything past `pending` counted as confirmed — an order that shipped was
    // confirmed, and counting only the ones sitting AT `confirmed` would make the
    // rate fall as the shop works through its queue.
    const confirmed = ['confirmed', 'packed', 'shipped', 'delivered']
      .reduce((sum, s) => sum + get(s).count, 0);
    const confirmedValue = ['confirmed', 'packed', 'shipped', 'delivered']
      .reduce((sum, s) => sum + get(s).value, 0);

    return {
      received,
      pending: get('pending').count,
      confirmed,
      delivered: get('delivered').count,
      cancelled: get('cancelled').count,
      confirmedValue,
      deliveredValue: get('delivered').value,
      confirmationRate: received > 0 ? Math.round((confirmed / received) * 1000) / 10 : 0,
    };
  }

  /**
   * Distinct buyers of one page — a VIEW, not a collection.
   *
   * Aggregated over the customer snapshots on the orders themselves. Nothing
   * here reads or writes `Customer`; that is the whole of I-17 expressed as a
   * query.
   */
  async customersForPage(pageId, { limit = 100 } = {}) {
    const page = toObjectId(pageId);
    if (!page) return [];

    return LandingOrder.aggregate([
      { $match: { page } },
      // REQUIRED before the `$group` below. `$last` has no defined meaning
      // without an explicit sort — it is whichever document the engine happened
      // to process last, which can change between runs and between index
      // choices. Sorting oldest-first makes `$last` mean "the most recent name
      // this person gave", which is the one to show when someone corrects a
      // spelling on a later order.
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: '$customer.phone',
          name: { $last: '$customer.name' },
          orders: { $sum: 1 },
          value: { $sum: '$total' },
          lastOrderAt: { $max: '$createdAt' },
        },
      },
      { $sort: { lastOrderAt: -1 } },
      { $limit: Math.min(Math.max(Number(limit) || 100, 1), 500) },
      { $project: { _id: 0, phone: '$_id', name: 1, orders: 1, value: 1, lastOrderAt: 1 } },
    ]);
  }

  // ── Maintenance ───────────────────────────────────────────────────────────

  /**
   * Mark pages whose window has closed.
   *
   * Bookkeeping for the admin's renewal worklist, NOT the mechanism — expiry
   * takes effect on read (see `landingPageState.util`). If this job never ran,
   * every page would still stop selling on time; the admin's "expired" filter
   * would just be empty.
   */
  async sweepExpired(now = new Date()) {
    const live = await LandingPage.find({ status: 'live' })
      .select('expiresAt graceDays startsAt status pausedByAdmin')
      .lean();

    const stale = live.filter((p) => resolveLandingPage(p, now).state === STATES.EXPIRED);
    if (stale.length === 0) return { expired: 0 };

    await LandingPage.updateMany(
      { _id: { $in: stale.map((p) => p._id) } },
      { $set: { status: 'expired' } }
    );

    logger.info(`Landing pages: marked ${stale.length} page(s) expired`);
    return { expired: stale.length };
  }
}

module.exports = new LandingPageService();
module.exports.OWNER_TYPE = OWNER_TYPE;
module.exports.URL_FIELDS = URL_FIELDS;
