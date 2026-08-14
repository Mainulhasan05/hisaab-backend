const Shop = require('../models/Shop.model');
const Product = require('../models/Product.model');
const Category = require('../models/Category.model');
const Storefront = require('../models/Storefront.model');
const StorefrontTemplate = require('../models/StorefrontTemplate.model');
const { AppError } = require('../middleware/error.middleware');
const { resolveSubscription } = require('../utils/subscriptionState.util');
const { shopHasFeature } = require('../utils/features.util');
const logger = require('../utils/logger.util');

/**
 * The public storefront — the first unauthenticated surface in this API.
 *
 * Everything else in this codebase sits behind `protect`. These reads do not,
 * and that is a category change rather than an increment (ECOMMERCE_PLAN.md
 * §13). Three rules hold here and are enforced in this file rather than trusted
 * to callers:
 *
 *   1. NOTHING reads `req`. There is no session, no `req.shop`, no
 *      `req.branchId`. Every function takes a slug and resolves the shop
 *      itself. If you find yourself importing `branchFilter` here, stop — its
 *      whole contract is "the branch on the authenticated request", and there
 *      is no authenticated request.
 *   2. Fields are ALLOWLISTED, never denylisted. See PUBLIC_PRODUCT_FIELDS.
 *   3. A shop that must not be served is indistinguishable from one that does
 *      not exist. See `resolveStorefront`.
 */

/**
 * The only product fields a stranger may see. An ALLOWLIST, deliberately.
 *
 * §13 phrases this as "project away buyingPrice, wholesalePrice, batches,
 * serials, totalSold, profit". Written as an exclusion it is correct exactly
 * once — the seventh cost field somebody adds to `Product` next year is public
 * the moment it is merged, and nothing fails.
 *
 * It is also, as written, already incomplete. `variants[]` carries its OWN
 * `buyingPrice` and `wholesalePrice` (Product.model.js), and a top-level
 * `-buyingPrice` does not touch a nested one. A shop selling three sizes of
 * shirt would have published what it paid for each of them.
 *
 * So the rule is inverted: name what the PAGE renders, and let everything else —
 * present and future — be excluded by default. `publicProductProjection.test.js`
 * asserts the response keys against this list, so widening it is a deliberate
 * act with a failing test in front of it.
 *
 * `totalSold` is absent on purpose and is still USED: it orders the
 * best-sellers rail (a shop's sales volume is its own business, the ordering it
 * produces is not). Sort by a field, return a different set.
 */
const PUBLIC_PRODUCT_FIELDS = [
  '_id',
  'name',
  'code',
  'category',
  'subcategory',
  'brand',
  'unit',
  'packaging',
  'hasVariants',
  'variants',
  'sellingPrice',
  'onlinePrice',
  'onlineDescription',
  'isFeaturedOnline',
  'catalogImages',
  'images',
  'stock',
  'minStock',
  'tags',
  'createdAt',
].join(' ');

/**
 * Variant sub-fields this service is allowed to READ — the same inversion, one
 * level down, and it is needed one level down because `.select()` on the parent
 * brings the entire subdocument along, `buyingPrice` and `wholesalePrice`
 * included.
 *
 * Read is not the same as published. `stock` and `isActive` are on this list
 * and neither is ever emitted: `stock` becomes the `inStock` boolean and
 * `isActive` decides whether the variant appears at all. Anything not named
 * here is neither read nor published.
 */
const PUBLIC_VARIANT_FIELDS = ['sku', 'attributes', 'sellingPrice', 'stock', 'image', 'isActive'];

/** Of those, the ones consumed to derive a signal rather than passed through. */
const VARIANT_INTERNAL_FIELDS = ['stock', 'isActive'];

/**
 * Subscription states whose storefront stays lit.
 *
 * NOTE this is STRICTER than `resolved.canRead`, and the difference is the
 * point. `canRead` is true for an `expired` shop by design — an unpaid shop can
 * still open its own dashboard and get its due list out, which is humane and
 * costs us nothing. Serving its PUBLIC storefront is a different act: it keeps
 * a shop that stopped paying taking orders it may not fulfil, on our
 * infrastructure and under our brand (§13, last paragraph).
 *
 * `grace` is in, because grace is a period the operator explicitly granted.
 */
const SERVABLE_STATES = Object.freeze(['active', 'trial', 'grace', 'expiring']);

class PublicStorefrontService {
  /**
   * Resolve a slug to a servable { shop, storefront, template }, or 404.
   *
   * ── EVERY FAILURE LOOKS THE SAME FROM OUTSIDE ───────────────────────────────
   *
   * Wrong slug, shop deleted, feature off, never published, shop paused for Eid,
   * platform kill switch, subscription lapsed — all of them return the same
   * bare 404 with the same Bengali sentence. The reason goes to the log, where
   * support can read it, and never to the response.
   *
   * That is not paranoia about a small thing. A distinguishable error turns this
   * endpoint into an oracle: a competitor could enumerate slugs to learn which
   * shops exist, and "এই দোকানের সাবস্ক্রিপশন শেষ" published to a shop's own
   * customers is a commercial injury we would be inflicting on the shop for the
   * crime of paying us late.
   */
  async resolveStorefront(slug) {
    const clean = String(slug || '').trim().toLowerCase();
    if (!clean) throw this._dark('empty slug');

    // Not `Shop.findBySlug` — that static filters on `isActive` alone, and the
    // block/expiry decision below needs the document either way so that the
    // reason can be logged.
    const shop = await Shop.findOne({ slug: clean })
      .select('_id name slug logo phone address features storefront subscription access isActive')
      .lean();
    if (!shop) throw this._dark(`no shop for slug "${clean}"`);

    if (!shopHasFeature(shop, 'storefront')) {
      throw this._dark(`shop ${shop._id} has no storefront capability`);
    }

    const resolved = resolveSubscription(shop);
    if (!SERVABLE_STATES.includes(resolved.state)) {
      throw this._dark(`shop ${shop._id} subscription state "${resolved.state}"`);
    }

    const storefront = await Storefront.findOne({ shop: shop._id }).lean();
    if (!storefront) throw this._dark(`shop ${shop._id} has no storefront document`);
    if (storefront.pausedByAdmin) throw this._dark(`shop ${shop._id} paused by admin`);
    if (storefront.status !== 'live') {
      throw this._dark(`shop ${shop._id} storefront status "${storefront.status}"`);
    }

    const key = storefront.published?.template;
    if (!key) throw this._dark(`shop ${shop._id} has never published`);

    /**
     * The template is loaded WITHOUT consulting `Shop.storefront.allowedTemplates`,
     * and without caring that its status may be `retired`. That is invariant
     * I-11 (ECOMMERCE_PLAN.md §4.4) and it is the whole reason this read exists
     * separately from the picker's: a grant is validated when a template is
     * APPLIED, never when one is RENDERED.
     *
     * Validating here would mean an admin tidying the template catalogue on a
     * Tuesday takes live shops offline, finds out from a support call, and
     * cannot say which shops they broke.
     */
    const template = await StorefrontTemplate.findOne({ key }).lean();
    if (!template) throw this._dark(`shop ${shop._id} on unknown template "${key}"`);

    return { shop, storefront, template };
  }

  /**
   * One 404 for every reason a storefront is not servable.
   *
   * The reason is logged at `info`, not `warn` — a mistyped slug is a normal
   * event on a public URL, and a log level that pages someone teaches everyone
   * to ignore the channel.
   */
  _dark(reason) {
    logger.info(`[storefront] not served: ${reason}`);
    return new AppError(
      'Storefront not found',
      'এই ঠিকানায় কোনো দোকান পাওয়া যায়নি।',
      404
    );
  }

  /**
   * The fulfilment branch filter.
   *
   * `Storefront.branch` is null for single-branch shops, which is nearly all of
   * them — and when it is null NO branch clause is added at all, so the query
   * issued is byte-for-byte the query a single-branch shop already issues
   * (I-1). Adding `{ branch: null }` would look equivalent and is not: it would
   * exclude any product written before the field existed.
   *
   * A multi-branch shop that has not chosen a fulfilment branch gets its whole
   * catalogue, which can show the same product twice — one document per branch.
   * That is a misconfiguration rather than a bug here (the settings screen
   * writes this field), and it is the reason §18.2 wants the multi-branch
   * fulfilment question settled before order routing lands.
   */
  _scope(storefront) {
    const base = {
      shop: storefront.shop,
      isAvailableOnline: true,
      isActive: true,
      isDeleted: false,
    };
    if (storefront.branch) base.branch = storefront.branch;
    return base;
  }

  /**
   * Out-of-stock handling, as a query clause.
   *
   * Default is `hide`, because nothing is reserved for an unconfirmed order
   * (§6.3) — so an out-of-stock product left visible is an order the shop will
   * have to ring someone up and cancel. `show` exists for shops that restock
   * predictably and would rather keep the page full.
   *
   * Variant products carry their stock on the variants, so the top-level
   * `stock` is not the whole answer; the `$or` lets a product through if EITHER
   * the simple stock or any active variant has units. Getting this wrong hides
   * every variant product in the shop, which looks like the catalogue is empty.
   */
  _stockClause(storefront) {
    if (storefront.outOfStockBehaviour === 'show') return null;
    return {
      $or: [
        { hasVariants: { $ne: true }, stock: { $gt: 0 } },
        { hasVariants: true, variants: { $elemMatch: { isActive: true, stock: { $gt: 0 } } } },
      ],
    };
  }

  _filter(storefront, extra = null) {
    const clauses = [this._scope(storefront)];
    const stock = this._stockClause(storefront);
    if (stock) clauses.push(stock);
    if (extra) clauses.push(extra);
    return clauses.length === 1 ? clauses[0] : { $and: clauses };
  }

  /**
   * THE pricing rule, and there is only one:
   *
   *     the online price if one is given, otherwise the selling price.
   *
   * It is written once, here, and applied to every priced thing — a plain
   * product and each individual variant. `AGENT_WORKFLOW.md` §15.2 makes the
   * same point about `createSale`: the moment a second place decides what
   * something costs, the two disagree, and the disagreement is discovered by a
   * customer.
   *
   * `inheritedOnline` is how a variant picks up its parent's online price. The
   * variant schema has no `onlinePrice` of its own today, so `own` is always
   * null for a variant and the parent's value flows straight through — and if a
   * per-variant online price is ever added, this function already handles it
   * with the correct precedence and nothing else has to change.
   *
   * `?? ` and never `||`: an online price of ০ is a real price a shop set
   * deliberately (a free sample, a loss-leader), and `||` would quietly restore
   * the shelf price and charge for it. Same rule, and the same reasoning, as
   * the storage quota's `quotaMb: 0` in STORAGE_HANDOFF §4.6.
   *
   * The `Save ৳50` badge needs no new field: compare-at is `sellingPrice`
   * whenever the online price undercuts it (STOREFRONT_DESIGN_REF §1.3). An
   * online price that is HIGHER is honoured as the price and shows no badge — a
   * shop may charge more online to cover delivery, and a strikethrough there
   * would be inventing a discount that does not exist.
   */
  /**
   * An entity's own online price, or null when it has none.
   *
   * `onlinePrice` is optional with no default, so "not set" arrives as
   * `undefined` from a fresh document and as `null` from one where it was
   * cleared. Both mean the same thing and both must fall through to the selling
   * price; only a real, finite number counts as a price.
   */
  _onlinePriceOf(entity) {
    const raw = entity?.onlinePrice;
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  _effective(entity, inheritedOnline = null) {
    const selling = Number(entity.sellingPrice) || 0;
    const online = this._onlinePriceOf(entity) ?? inheritedOnline;
    const price = online ?? selling;
    const compareAt = online !== null && online < selling ? selling : null;

    return {
      price,
      compareAt,
      savings: compareAt ? Math.round((compareAt - price) * 100) / 100 : 0,
    };
  }

  /**
   * The price a product CARD shows, which is not always a single number.
   *
   * A variant product is priced per variant, so the card advertises the
   * cheapest one — "৳৮০০ থেকে". Crucially the compare-at shown next to it is
   * THAT variant's compare-at, not the largest saving in the group: quoting the
   * cheapest price beside the biggest discount would overstate the offer on
   * every product where the two belong to different sizes.
   *
   * A product-level online price on a variant product is applied to every
   * variant rather than ignored. The product form shows one online-price field;
   * a shopkeeper who fills it in on a variant product means it, and silently
   * discarding their input is worse than honouring it — that was the previous
   * behaviour and it made the field do nothing on exactly the products where a
   * shop is most likely to run an online offer.
   */
  _price(p) {
    const active = (p.variants || []).filter((v) => v.isActive !== false);
    const parentOnline = this._onlinePriceOf(p);

    if (p.hasVariants && active.length) {
      const priced = active.map((v) => this._effective(v, parentOnline));
      // Cheapest first; the card quotes this row in full, price and compare-at
      // together, so the two can never come from different variants.
      const lead = priced.reduce((a, b) => (b.price < a.price ? b : a));
      const prices = priced.map((e) => e.price);
      return {
        price: lead.price,
        priceMin: Math.min(...prices),
        priceMax: Math.max(...prices),
        compareAt: lead.compareAt,
        savings: lead.savings,
      };
    }

    const eff = this._effective(p);
    return { ...eff, priceMin: eff.price, priceMax: eff.price };
  }

  /**
   * Stock, as a signal rather than a number.
   *
   * `inStock` is what the page needs and `stock: 47` is what a competitor
   * needs. There is no cart in this phase, so an exact count buys the customer
   * nothing they cannot get from "আছে" — and a count published today cannot be
   * withdrawn tomorrow. Widening this later is one line; narrowing it after it
   * has been public is not.
   *
   * §6.3's requirement is that the storefront reflect stock truthfully, and an
   * accurate in/out signal does that. When P2 adds a quantity picker this will
   * need a real number, and that is the point to decide how much to show.
   */
  _stock(p) {
    if (p.hasVariants) {
      const active = (p.variants || []).filter((v) => v.isActive !== false);
      return { inStock: active.some((v) => (Number(v.stock) || 0) > 0) };
    }
    return { inStock: (Number(p.stock) || 0) > 0 };
  }

  /**
   * Images, stripped to what an <img> needs.
   *
   * `mediaId` is dropped: it is our storage-pool bookkeeping (ShopMedia,
   * refCounts, quota) and means nothing outside this system. Legacy ImgBB rows
   * have no `mediaId` and are carried through unchanged — the rule that
   * `mediaId != null` means "our bytes" is a server-side concern and the public
   * shape must not depend on it.
   */
  _images(p) {
    const rows = Array.isArray(p.catalogImages) ? p.catalogImages : [];
    const mapped = rows
      .filter((img) => img && img.url)
      .map((img) => ({
        url: img.url,
        thumbnail: img.thumbnail || img.url,
        isPrimary: img.isPrimary === true,
      }));
    if (mapped.length) {
      // Primary first, so a template can render `images[0]` without knowing the
      // rule. A product whose shop never picked a primary keeps upload order.
      const primary = mapped.findIndex((i) => i.isPrimary);
      if (primary > 0) mapped.unshift(mapped.splice(primary, 1)[0]);
      return mapped;
    }
    // Pre-R2 products stored bare URL strings in `images[]`.
    return (Array.isArray(p.images) ? p.images : [])
      .filter((u) => typeof u === 'string' && u)
      .map((u) => ({ url: u, thumbnail: u, isPrimary: false }));
  }

  /**
   * Variants, each priced by the same rule as the parent.
   *
   * The resolved `price`/`compareAt` are attached per variant rather than left
   * for the client to derive from `sellingPrice`: picking a size changes the
   * number on screen, and that number is money. A browser that computes it
   * would be a second pricing implementation, in the least trustworthy place we
   * have (I-10 is about writes, but the same reasoning retires the idea here).
   *
   * `sellingPrice` still ships, because it is the compare-at a template
   * strikes through — but it is only ever displayed, never used to work out
   * what something costs.
   */
  _variants(p) {
    if (!p.hasVariants) return [];
    const parentOnline = this._onlinePriceOf(p);

    return (p.variants || [])
      .filter((v) => v.isActive !== false)
      .map((v) => {
        const out = {};
        for (const key of PUBLIC_VARIANT_FIELDS) {
          if (VARIANT_INTERNAL_FIELDS.includes(key)) continue;
          if (v[key] !== undefined) out[key] = v[key];
        }
        // Availability only, never the count — same rule as the parent.
        out.inStock = (Number(v.stock) || 0) > 0;
        return { ...out, ...this._effective(v, parentOnline) };
      });
  }

  /**
   * A product as the public page sees it.
   *
   * Built by NAMING each key rather than by spreading the document and deleting
   * a few. `{...p}` followed by `delete p.buyingPrice` is one forgotten line
   * away from a leak, and the forgotten line is invisible in review.
   */
  toPublicProduct(p, { full = false } = {}) {
    const out = {
      id: String(p._id),
      name: p.name,
      code: p.code,
      brand: p.brand || null,
      unit: p.unit || null,
      category: p.category
        ? (p.category._id
          ? { id: String(p.category._id), name: p.category.name, slug: p.category.slug }
          : String(p.category))
        : null,
      images: this._images(p),
      isFeatured: p.isFeaturedOnline === true,
      tags: Array.isArray(p.tags) ? p.tags : [],
      hasVariants: p.hasVariants === true,
      ...this._price(p),
      ...this._stock(p),
    };

    if (full) {
      // Only the ONLINE description is published. `description` is the shop's
      // internal note on the product and has never been written for a customer
      // — it holds supplier names, purchase reminders and shelf locations.
      out.description = p.onlineDescription || '';
      out.variants = this._variants(p);
    }

    return out;
  }

  toPublicCategory(c) {
    return {
      id: String(c._id),
      name: c.name,
      slug: c.slug,
      icon: c.icon || null,
      image: c.image || null,
      productCount: Number(c.onlineCount) || 0,
    };
  }

  /**
   * Categories that actually have something in them, with ONLINE counts.
   *
   * `Category.productCount` is not used and must not be: it counts the shop's
   * whole catalogue, so a grocer with 40 products in "চাল" and one of them
   * online would advertise চাল (৪০) and open a page with a single bag of rice
   * on it. The count a customer reads has to be the count they will see.
   *
   * Categories with zero online products are dropped entirely rather than shown
   * empty — an empty category is a dead end, and on the reference layout the
   * category strip is the primary navigation on a phone.
   */
  async getCategories(storefront) {
    const rows = await Product.aggregate([
      // `_filter` returns real ObjectIds because they came off a lean document,
      // never strings off a query string — which is the trap in I-3: a string
      // id in `$match` casts to nothing and silently matches zero rows, so the
      // page renders "no categories" with a clean 200.
      { $match: this._filter(storefront) },
      { $group: { _id: '$category', onlineCount: { $sum: 1 } } },
      { $match: { _id: { $ne: null } } },
    ]);
    if (!rows.length) return [];

    const counts = new Map(rows.map((r) => [String(r._id), r.onlineCount]));
    const categories = await Category.find({
      _id: { $in: rows.map((r) => r._id) },
      shop: storefront.shop,
      isActive: true,
    })
      .select('name slug icon image order')
      .sort({ order: 1, name: 1 })
      .lean();

    return categories.map((c) =>
      this.toPublicCategory({ ...c, onlineCount: counts.get(String(c._id)) })
    );
  }

  /**
   * One rail of products. `sort` names an intent, not a field.
   *
   * `popular` sorts on `totalSold`, which is not in PUBLIC_PRODUCT_FIELDS and
   * therefore never reaches the response — the ordering is public, the volume
   * behind it is not. The index `{shop, isDeleted, totalSold: -1}` already
   * exists for the POS grid and covers this.
   */
  async _rail(storefront, { sort = 'newest', extra = null, limit = 12 } = {}) {
    const SORTS = {
      newest: { createdAt: -1 },
      popular: { totalSold: -1 },
      featured: { isFeaturedOnline: -1, createdAt: -1 },
      name: { name: 1 },
    };
    const products = await Product.find(this._filter(storefront, extra))
      .select(PUBLIC_PRODUCT_FIELDS)
      .populate('category', 'name slug')
      .sort(SORTS[sort] || SORTS.newest)
      .limit(Math.min(Number(limit) || 12, 24))
      .lean();
    return products.map((p) => this.toPublicProduct(p));
  }

  /**
   * Everything the home page renders, in one round trip.
   *
   * Rails are fetched ONLY when the active template declares the matching slot.
   * `poshak` does not render `topSelling` and `khabar` renders neither that nor
   * `newArrivals` (see the seed script), so querying all three for every shop
   * would be up to two wasted collection scans per page view on the single
   * hottest read in the system.
   */
  async getHome(slug) {
    const { shop, storefront, template } = await this.resolveStorefront(slug);
    const slots = new Set(template.slots || []);
    const published = storefront.published || {};

    const wants = (slot) => slots.has(slot);

    const [categories, featured, newArrivals, topSelling] = await Promise.all([
      this.getCategories(storefront),
      wants('featured') ? this._rail(storefront, { sort: 'featured', extra: { isFeaturedOnline: true } }) : [],
      wants('newArrivals') ? this._rail(storefront, { sort: 'newest' }) : [],
      wants('topSelling') ? this._rail(storefront, { sort: 'popular' }) : [],
    ]);

    const collections = wants('collections')
      ? await this._collections(storefront, published.blocks?.collections, categories)
      : [];

    return {
      shop: this._publicShop(shop),
      template: { key: template.key, slots: template.slots || [] },
      theme: { ...(template.themeDefaults || {}), ...(published.theme || {}) },
      blocks: published.blocks || {},
      nav: published.nav || [],
      seo: published.seo || {},
      delivery: this._publicDelivery(storefront),
      categories,
      featured,
      newArrivals,
      topSelling,
      collections,
    };
  }

  /**
   * The `collections` slot, resolved to real products.
   *
   * ── WHY AN EMPTY LIST IS NOT AN EMPTY PAGE ──────────────────────────────────
   *
   * A shop that has been granted a storefront, picked a template and pressed
   * publish has authored nothing yet — `_seedBlocks` deliberately leaves
   * `collections: []`, because a hero headline we invented would be worse than
   * a blank one and would look finished enough that nobody replaced it.
   *
   * But "nothing authored" must not mean "empty website". The whole promise is
   * that the path from flag to site does not run through a form (§4.3). So an
   * unconfigured shop falls back to its own biggest categories, which is very
   * close to what it would have picked by hand, and the block editor becomes a
   * refinement rather than a prerequisite.
   *
   * Two collection types are understood. `category` is the ordinary one.
   * `offers` is the Offer Zone from the design reference (§1.4.2) — every
   * product whose online price undercuts its shelf price. It is a VIRTUAL
   * collection: one query, no new field, and crucially no new slot key, since a
   * slot only one template understands is content a shop loses when it switches
   * away (§4.2).
   */
  async _collections(storefront, configured, categories) {
    const MAX = 8;
    let specs = Array.isArray(configured) ? configured.filter(Boolean).slice(0, MAX) : [];

    if (!specs.length) {
      specs = categories
        .slice(0, 6)
        .map((c) => ({ type: 'category', categoryId: c.id, title: c.name }));
    }

    const resolved = await Promise.all(
      specs.map(async (spec) => {
        if (spec.type === 'offers') {
          const products = await this._rail(storefront, {
            sort: 'newest',
            // `$expr` compares two fields on the same document, which a plain
            // filter cannot do. Products with no `onlinePrice` are excluded by
            // the `$lt` against a missing field rather than needing a guard.
            extra: { $expr: { $lt: ['$onlinePrice', '$sellingPrice'] } },
          });
          return products.length
            ? { type: 'offers', title: spec.title || 'অফার', href: 'offers', products }
            : null;
        }

        const categoryId = spec.categoryId || spec.category;
        if (!categoryId) return null;
        const meta = categories.find((c) => c.id === String(categoryId));
        const products = await this._rail(storefront, { extra: { category: categoryId } });
        return products.length
          ? {
            type: 'category',
            title: spec.title || meta?.name || '',
            href: meta?.slug || String(categoryId),
            products,
          }
          : null;
      })
    );

    // A collection that resolved to nothing is dropped rather than rendered as
    // a titled empty row. A category emptied by a stock-out is the common cause,
    // and a heading over blank space reads as a broken page.
    return resolved.filter(Boolean);
  }

  /**
   * The paged catalogue read — category pages, search, the Offer Zone.
   */
  async listProducts(slug, opts = {}) {
    const { storefront } = await this.resolveStorefront(slug);

    const limit = Math.min(Math.max(Number(opts.limit) || 24, 1), 48);
    const page = Math.max(Number(opts.page) || 1, 1);
    const extra = {};

    if (opts.category) {
      const category = await Category.findOne({
        shop: storefront.shop,
        // A category is addressed by slug in a URL and by id from the block
        // editor, so both resolve here rather than in two callers.
        ...(/^[0-9a-fA-F]{24}$/.test(opts.category)
          ? { _id: opts.category }
          : { slug: String(opts.category).toLowerCase() }),
      }).select('_id name slug').lean();
      // An unknown category returns an empty page, not the whole catalogue.
      // Dropping an unmatched filter silently is how a "Rice" link ends up
      // showing shampoo.
      if (!category) return { products: [], pagination: { page, limit, total: 0, pages: 0 }, category: null };
      extra.category = category._id;
      opts._category = category;
    }

    if (opts.offers) extra.$expr = { $lt: ['$onlinePrice', '$sellingPrice'] };
    if (opts.tag) extra.tags = String(opts.tag).trim();

    if (opts.q) {
      // Escaped before it reaches a RegExp: an unescaped `(` from a search box
      // is a 500, and `.*.*.*` is a CPU bill somebody else pays.
      const term = String(opts.q).trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (term) extra.name = { $regex: term, $options: 'i' };
    }

    const filter = this._filter(storefront, Object.keys(extra).length ? extra : null);
    const SORTS = {
      newest: { createdAt: -1 },
      popular: { totalSold: -1 },
      featured: { isFeaturedOnline: -1, createdAt: -1 },
      name: { name: 1 },
    };

    const [products, total] = await Promise.all([
      Product.find(filter)
        .select(PUBLIC_PRODUCT_FIELDS)
        .populate('category', 'name slug')
        .sort(SORTS[opts.sort] || SORTS.newest)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    return {
      products: products.map((p) => this.toPublicProduct(p)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      category: opts._category
        ? { id: String(opts._category._id), name: opts._category.name, slug: opts._category.slug }
        : null,
    };
  }

  /**
   * One product page, addressed by `code`.
   *
   * `code` rather than `_id` because it is the shop's own human identifier, it
   * is already unique per (shop, branch), and it makes a URL a shopkeeper can
   * read out over the phone. It is NOT a secret — every code is listed on the
   * category pages — so there is nothing to protect by using an opaque id.
   *
   * `related` deliberately excludes the product itself and is capped small: it
   * is a rail at the bottom of a page, and on a 3G phone every extra row is
   * paid for before the customer ever scrolls to it.
   */
  async getProduct(slug, code) {
    const { shop, storefront, template } = await this.resolveStorefront(slug);

    const product = await Product.findOne(
      this._filter(storefront, { code: String(code || '').trim() })
    )
      .select(PUBLIC_PRODUCT_FIELDS)
      .populate('category', 'name slug')
      .lean();

    // Same 404 as an unknown shop. A product that is offline, deleted or out of
    // stock under `hide` must not be distinguishable from one that never
    // existed — otherwise the catalogue is enumerable for what a shop has
    // chosen NOT to publish.
    if (!product) throw this._dark(`shop ${shop._id} has no online product "${code}"`);

    const related = product.category
      ? await this._rail(storefront, {
        extra: { category: product.category._id || product.category, _id: { $ne: product._id } },
        limit: 8,
      })
      : [];

    return {
      shop: this._publicShop(shop),
      template: { key: template.key, slots: template.slots || [] },
      theme: { ...(template.themeDefaults || {}), ...(storefront.published?.theme || {}) },
      blocks: storefront.published?.blocks || {},
      nav: storefront.published?.nav || [],
      delivery: this._publicDelivery(storefront),
      product: this.toPublicProduct(product, { full: true }),
      related,
    };
  }

  /**
   * Every public URL this storefront owns, for `sitemap.xml`.
   *
   * Capped at 5,000 products. A sitemap has a hard 50,000-URL / 50MB ceiling in
   * the protocol, but the real reason for a much lower cap is that this endpoint
   * builds its whole answer in memory and no shop on this platform has 5,000
   * products online — the cap is a backstop against a pathological account, not
   * a limit anyone should reach. If one ever does, the answer is a paginated
   * sitemap index, not a bigger number here.
   *
   * `updatedAt` feeds `<lastmod>`, which is the field crawlers actually use to
   * decide whether to re-fetch a page. Omitting it makes every product look
   * equally stale and wastes the crawl budget on a shop that changes one price
   * a week.
   */
  async getSitemap(slug) {
    const { shop, storefront } = await this.resolveStorefront(slug);

    const [products, categories] = await Promise.all([
      Product.find(this._filter(storefront))
        .select('code updatedAt')
        .sort({ updatedAt: -1 })
        .limit(5000)
        .lean(),
      this.getCategories(storefront),
    ]);

    return {
      shop: this._publicShop(shop),
      updatedAt: storefront.published?.publishedAt || storefront.updatedAt || null,
      categories: categories.map((c) => ({ slug: c.slug })),
      products: products.map((p) => ({ code: p.code, updatedAt: p.updatedAt })),
    };
  }

  /**
   * The shop, as a customer may see it.
   *
   * Named keys again, and the list is short on purpose: `features`,
   * `subscription`, `access` and `storefront.allowedTemplates` were all loaded
   * by `resolveStorefront` to make the serve/dark decision, and not one of them
   * is any of a customer's business. Spreading the document here would publish
   * this shop's billing state to the internet.
   */
  _publicShop(shop) {
    return {
      id: String(shop._id),
      name: shop.name,
      slug: shop.slug,
      logo: shop.logo || null,
      phone: shop.phone || null,
      address: shop.address || null,
    };
  }

  /**
   * Delivery zones, flattened for display.
   *
   * There is no cart in this phase, so nothing here is charged to anyone — but
   * "ঢাকায় ৳৬০, সারাদেশে ৳১২০" is one of the two things a Bangladeshi customer
   * wants to know before they pick up the phone, and withholding it until a
   * checkout that does not exist yet would be withholding it for nothing.
   * Inactive zones are dropped so a shop can retire one without deleting it.
   */
  _publicDelivery(storefront) {
    const zones = (storefront.delivery?.zones || [])
      .filter((z) => z.isActive !== false)
      .map((z) => ({
        key: z.key,
        name: z.nameBn || z.name,
        charge: Number(z.charge) || 0,
        freeAbove: Number(z.freeAbove) || 0,
        etaDaysMin: Number(z.etaDaysMin) || 0,
        etaDaysMax: Number(z.etaDaysMax) || 0,
      }));
    return { zones, pickupEnabled: storefront.delivery?.pickupEnabled === true };
  }
}

module.exports = new PublicStorefrontService();
module.exports.PUBLIC_PRODUCT_FIELDS = PUBLIC_PRODUCT_FIELDS;
module.exports.PUBLIC_VARIANT_FIELDS = PUBLIC_VARIANT_FIELDS;
module.exports.SERVABLE_STATES = SERVABLE_STATES;
