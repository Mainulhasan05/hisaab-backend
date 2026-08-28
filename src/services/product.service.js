const Product = require('../models/Product.model');
const Category = require('../models/Category.model');
const Brand = require('../models/Brand.model');
const StockTransaction = require('../models/StockTransaction.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const mongoose = require('mongoose');
const { branchFilter, branchMatch, requireBranch } = require('../utils/branchScope.util');
const logger = require('../utils/logger.util');
const {
  parseQuantity,
  quantityUnit,
  storageUnit,
  quantize,
  quantizeMoney,
} = require('../utils/quantity.util');
const { unitsForShop, DEFAULT_UNIT } = require('../config/units');
const { normalizePackaging } = require('../utils/packaging.util');
const { hasFeature } = require('../utils/features.util');
const { normalizeWholesalePrice } = require('../utils/pricing.util');
const cacheService = require('./cache.service');
/**
 * The shop's variant vocabulary is DERIVED from these products, so every write
 * here can change it — see that file's header. The cache it keeps has to be
 * dropped on each of the four paths below, or a size a shopkeeper just typed
 * does not come back as a chip on their next product, which reads as the
 * feature not working.
 */
const variantCatalogService = require('./variantCatalog.service');
const mediaService = require('./media.service');
// Safe to require directly: `category.service` reaches for the Product MODEL,
// never this service, so there is no cycle between the two.
const categoryService = require('./category.service');
const { KEYS, getTTL } = require('../config/cacheKeys');
const { auditSnapshot, auditDiff, AUDIT_FIELDS } = require('../utils/auditDiff.util');
const { capBatchesToStock } = require('../utils/batch.util');
const {
  isCombo, assertNotCombo, findComponentVariant, computeComboAvailability,
  isChooseSlot, eligibleVariants,
} = require('../utils/combo.util');

// Escape user input before embedding it in a $regex (prevents regex injection/ReDoS)
const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Query-string booleans arrive as the STRINGS 'true'/'false', and `'false'` is
// truthy. Every existing flag in this file spells that comparison out inline;
// this is the same test, named once, for the flags added since.
const isTrue = (v) => v === true || v === 'true';

// Client-controllable sort fields must be whitelisted — arbitrary fields force
// unindexed in-memory sorts that hard-fail at 32MB on large collections
// `totalSold` is a stored counter incremented on each sale (see Product model),
// so sorting by it costs no extra query — it rides the {shop, isDeleted,
// totalSold} index the same way createdAt does.
const PRODUCT_SORT_FIELDS = new Set(['createdAt', 'name', 'code', 'stock', 'sellingPrice', 'buyingPrice', 'updatedAt', 'totalSold']);

// Catalogue photos per product, counted over images in OUR pool only. The real
// ceiling on a shop's storage is its quota; this one is about the product page
// staying legible and about a runaway client loop not turning into 200 uploads.
const MAX_CATALOG_MEDIA = 5;

// ── What a LIST row does not need ───────────────────────────────────────────
//
// Stated as an exclusion, not an allowlist, and deliberately so: `getProducts`
// feeds eleven different screens, and an allowlist that misses one field is a
// blank column somewhere nobody looks until a shopkeeper reports it. What CAN
// be asserted with confidence is that no paginated list renders any of these.
//
// These five are the whole reason a product document is large:
//   description    up to 2000 chars, schema-capped
//   batches[]      one subdocument per purchase batch, grows forever
//   serials[]      one string per tracked unit
//   images[]       Mixed — unbounded shape
//   catalogImages[] subdocuments
//
// Everything else on the model is a scalar. Detail reads (`getProductById`,
// `getProductByCode`) are deliberately NOT filtered — the edit form reads
// `description`, and the batch manager reads `batches`.
const LIST_EXCLUDE = '-description -batches -serials -images -catalogImages';

/**
 * The same list, but keeping `catalogImages`.
 *
 * ── WHY THIS EXISTS RATHER THAN JUST WIDENING LIST_EXCLUDE ──────────────────
 *
 * One screen genuinely needs a thumbnail per row: the online catalogue
 * (`/online/catalog`), which shows which products appear on the website and
 * refuses to put a photo-less one online. Without the field it cannot tell a
 * product with three photos from one with none, so it disables every switch
 * and tells a fully-photographed shop that nothing is ready — which is exactly
 * what it did before this projection existed.
 *
 * Widening `LIST_EXCLUDE` instead would put a subdocument array on every row of
 * the POS grid, the product list, the import preview and eight other screens
 * that never render it — on the endpoint fired hardest in the whole app. The
 * cost is paid by the one screen that asks.
 *
 * `images` (the legacy ImgBB Mixed array) stays excluded even here: it is
 * unbounded in shape, and the online catalogue only needs to know whether a
 * photo exists. The service reports that separately — see `hasPhoto` on the
 * client, which treats either array as a photo, and the `$nor` in
 * `bulkSetOnlineStatus`, which is the authority.
 */
const LIST_EXCLUDE_WITH_IMAGES = '-description -batches -serials -images';

// ── Why this is a Symbol and not the string 'fields' ────────────────────────
//
// `getProducts` is called as `productService.getProducts(shopId, req.query, req)`
// (product.controller.js:8). Its options object IS the client's query string.
// A plain `options.fields` key would therefore let anyone pass
// `?fields=-shop` and strip the tenant field off every row, or `?fields=_id`
// and blank the list — a projection the caller was never meant to control.
//
// A Symbol key cannot be produced by a query string, an HTTP header, or JSON,
// so this channel is reachable only from inside this module.
const PROJECTION = Symbol('projection');

// The POS picker CAN be an allowlist, because the exact field set is visible
// twenty lines below in `searchProductsForSale`'s mapper — it already discards
// everything else in JavaScript, after paying to fetch and deserialise it, on
// an endpoint that fires per keystroke.
const POS_FIELDS = [
  'name', 'code', 'barcode', 'hasVariants', 'buyingPrice', 'sellingPrice',
  'wholesalePrice', 'stock', 'minStock', 'unit', 'packaging', 'category',
  'totalSold', 'variants', 'type', 'comboItems',
].join(' ');

class ProductService {
  // Get all products with filtering, searching, pagination
  async getProducts(shopId, options = {}, req = null) {
    const {
      page,
      limit,
      search,
      category,
      brand,
      status,
      lowStock,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      // Should a search term also be matched against BRAND NAMES? See the block
      // that reads it. Only `searchProductsForSale` turns this off, and it does
      // so with the boolean `false` — a query string can only ever produce the
      // STRING 'false', which is not `!== false`, so this cannot be switched off
      // from outside the way `PROJECTION` above cannot be switched on.
      brandNameSearch,
    } = options;

    // Ensure valid integers with proper defaults (handles 'null', undefined, NaN)
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;

    // Soft-deleted products are hidden from every listing ($ne covers older
    // documents created before the isDeleted field existed)
    // Per-branch catalogue: each branch owns its own product documents, so the
    // ordinary branch filter is all the scoping stock needs — there is no
    // separate per-branch stock collection to overlay any more.
    const query = branchFilter(req, { shop: shopId, isDeleted: { $ne: true } });

    // Search by name, code or barcode. Input is regex-escaped; each field
    // carries a {shop, field} compound index so the $or branches run as
    // shop-bounded index scans instead of full document scans.
    const searchRegex = search ? escapeRegex(search.trim()) : null;
    const searchOr = searchRegex ? [
      { name: { $regex: searchRegex, $options: 'i' } },
      { code: { $regex: searchRegex, $options: 'i' } },
      // Top-level barcode too — the POS search box promises "নাম বা বারকোড",
      // and a scanner typing into it must find the product the same way the
      // dedicated /products/barcode/:code lookup would.
      { barcode: { $regex: searchRegex, $options: 'i' } },
      { 'variants.sku': { $regex: searchRegex, $options: 'i' } },
      { 'variants.barcode': { $regex: searchRegex, $options: 'i' } },
    ] : null;

    // ── Brand ────────────────────────────────────────────────────────────────
    //
    // Both halves of "find it by its brand": the explicit picker below, and the
    // search box a few lines down. Both behind `features.brands`, matching
    // `_resolveBrand` on the write side — a shop without the capability stores
    // `brand: null` on every product, so an ungated filter would return an empty
    // list and an ungated name search would buy a Brand query to find nothing.
    const brandsOn = hasFeature(req, 'brands');

    // Filter by brand. Left as a raw id for Mongoose to cast, exactly as
    // `category` is: a malformed one surfaces as the same CastError → 400.
    if (brandsOn && brand) {
      query.brand = brand;
    }

    // Typing a brand name into the search box finds that brand's products.
    //
    // `brand` is a REF, so it cannot join a `$regex` branch the way `name` and
    // `code` do — the names live in another collection and have to be resolved
    // to ids first. Same shape as `staffReport._resolveScope` turning a role
    // filter into a staff-id list.
    //
    // Costs one indexed read, and only on a request that carries a search term
    // and belongs to a brands shop. A brand list is a few dozen rows, so the id
    // set stays small. No match simply adds no branch — the name, code and
    // barcode branches still answer, which is what makes this additive.
    //
    // ── NOT on the POS ────────────────────────────────────────────────────────
    //
    // `searchProductsForSale` passes `brandNameSearch: false`, for two reasons
    // and the second is the real one:
    //
    //   · it is the hottest search path in the app, one request per keystroke,
    //     and this would put a second round trip on every one of them;
    //   · `POS_FIELDS` does not carry `brand`, so the till would show rows that
    //     match a word appearing nowhere on them. A cashier typing "Square" and
    //     getting eight products with no "Square" visible reads as a bug, not a
    //     feature. This list renders the brand under the category, which is what
    //     earns the behaviour here.
    if (searchOr && brandsOn && brandNameSearch !== false) {
      const matchedBrands = await Brand.find({
        shop: shopId,
        isActive: true,
        name: { $regex: searchRegex, $options: 'i' },
      }).select('_id').lean();

      if (matchedBrands.length) {
        searchOr.push({ brand: { $in: matchedBrands.map((b) => b._id) } });
      }
    }

    // Filter by category
    if (category) {
      query.category = category;
    }

    // Filter by status
    if (status === 'active') {
      query.isActive = true;
    } else if (status === 'inactive') {
      query.isActive = false;
    }

    // Filter by online availability
    if (options.isAvailableOnline === 'true' || options.isAvailableOnline === true) {
      query.isAvailableOnline = true;
    } else if (options.isAvailableOnline === 'false' || options.isAvailableOnline === false) {
      query.isAvailableOnline = false;
    }


    // Filter low stock items (works for both non-variant and variant products)
    let lowStockOr = null;
    const branchId = req?.branchId;
    if (lowStock === 'true' || lowStock === true) {
      lowStockOr = [
        { hasVariants: { $ne: true }, $expr: { $lt: ['$stock', '$minStock'] } },
        { hasVariants: true, 'variants.stock': { $lt: 5 } },
      ];
    }

    // Combine search and lowStock filters — use $and when both are active to avoid $or overwrite
    if (searchOr && lowStockOr) {
      query.$and = [{ $or: searchOr }, { $or: lowStockOr }];
    } else if (searchOr) {
      query.$or = searchOr;
    } else if (lowStockOr) {
      query.$or = lowStockOr;
    }

    const skip = (pageNum - 1) * limitNum;
    const sortField = PRODUCT_SORT_FIELDS.has(sortBy) ? sortBy : 'createdAt';
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

    // Calculate total stock and stock values.
    // These are shop-wide (independent of search/pagination), so: skip entirely
    // for search requests (fired per keystroke from the POS picker) and cache
    // for 60s otherwise — previously this aggregate ran on every request.
    let inventoryStats = { totalStock: 0, totalBuyingValue: 0, totalSellingValue: 0 };
    const wantStats = !search;
    // ── The cache key must be scoped by EXACTLY what the query is scoped by ──
    //
    // This used to read
    //
    //     `...invstats:${(branchId && req?.shop?.multiBranchEnabled) ? branchId : 'all'}`
    //
    // but the aggregation below is scoped by `branchMatch`, which keys off
    // `req.branchId` ALONE and never consults `multiBranchEnabled`. The two
    // disagreed whenever `branchId` was set and the flag was not — including the
    // ordinary case of a shop object rehydrated from Redis before that field
    // existed, which is the exact hazard `utils/features.util.js` warns about.
    //
    // When they disagreed, every branch shared the key `all` while the numbers
    // underneath were per-branch. So the first branch to be viewed wrote its
    // totals under `all`, and for the next 60 seconds every other branch was
    // served them — most visibly as ০টি / ৳০ on a branch whose product list was
    // right there on screen showing stock.
    //
    // Keying off `branchId` directly is not a tightening, it is the correction:
    // the cache now partitions the same way the data does. If you change
    // `branchMatch`, change this line in the same commit.
    const statsCacheKey = `shop:${shopId}:invstats:${branchId || 'all'}`;
    let statsCached = null;
    if (wantStats) {
      statsCached = await cacheService.get(statsCacheKey);
      if (statsCached) inventoryStats = statsCached;
    }
    try {
      if (!wantStats || statsCached) {
        // skip aggregation
      } else {
        const statsResult = await Product.aggregate([
          // `isActive: true` used to be here, and it is why the totals could
          // read ০টি / ৳০ on a branch whose product list was on screen showing
          // stock: the listing only filters on `isActive` when a `status` is
          // explicitly requested, so a deactivated product was COUNTED by
          // "মোট পণ্য ধরন" (which comes from `pagination.total`) and its stock
          // and value were SILENTLY DROPPED from the three cards beside it.
          //
          // The cards are answering "how much stock and money is sitting in
          // this branch". A deactivated product is still on the shelf and its
          // stock is still money — deactivating hides it from the POS, it does
          // not make it vanish from the inventory. So the stats now match the
          // listing exactly: everything in the branch that has not been deleted.
          { $match: branchMatch(req, { shop: new mongoose.Types.ObjectId(shopId), isDeleted: { $ne: true } }) },
          {
            $group: {
              _id: null,
              totalStock: {
                $sum: {
                  $cond: [
                    { $eq: ['$hasVariants', true] },
                    { $reduce: { input: '$variants', initialValue: 0, in: { $add: ['$$value', { $ifNull: ['$$this.stock', 0] }] } } },
                    { $ifNull: ['$stock', 0] }
                  ]
                }
              },
              totalBuyingValue: {
                $sum: {
                  $cond: [
                    { $eq: ['$hasVariants', true] },
                    {
                      $reduce: {
                        input: '$variants',
                        initialValue: 0,
                        in: {
                          $add: [
                            '$$value',
                            { $multiply: [{ $ifNull: ['$$this.stock', 0] }, { $ifNull: ['$$this.buyingPrice', 0] }] }
                          ]
                        }
                      }
                    },
                    { $multiply: [{ $ifNull: ['$stock', 0] }, { $ifNull: ['$buyingPrice', 0] }] }
                  ]
                }
              },
              totalSellingValue: {
                $sum: {
                  $cond: [
                    { $eq: ['$hasVariants', true] },
                    {
                      $reduce: {
                        input: '$variants',
                        initialValue: 0,
                        in: {
                          $add: [
                            '$$value',
                            { $multiply: [{ $ifNull: ['$$this.stock', 0] }, { $ifNull: ['$$this.sellingPrice', 0] }] }
                          ]
                        }
                      }
                    },
                    { $multiply: [{ $ifNull: ['$stock', 0] }, { $ifNull: ['$sellingPrice', 0] }] }
                  ]
                }
              }
            }
          }
        ]);
        if (statsResult.length > 0) {
          inventoryStats = {
            totalStock: statsResult[0].totalStock || 0,
            totalBuyingValue: statsResult[0].totalBuyingValue || 0,
            totalSellingValue: statsResult[0].totalSellingValue || 0,
          };
        }
      }
      if (wantStats && !statsCached) {
        cacheService.set(statsCacheKey, inventoryStats, 60).catch(() => {});
      }
    } catch (err) {
      logger.warn('Failed to calculate inventory stats:', err.message);
    }

    const [products, total] = await Promise.all([
      Product.find(query)
        // Projection, not post-filtering. Without it every row carried its
        // description, batch array, serial array and both image arrays across
        // the wire to be deserialised, re-serialised and then never rendered.
        // The POS asks for its own narrower set via the PROJECTION symbol —
        // see LIST_EXCLUDE / POS_FIELDS / PROJECTION at the top of this file.
        // `withImages` is a BOOLEAN the caller may set, not a projection —
        // the Symbol channel above stays the only way to name fields, so a
        // query string still cannot strip `shop` off every row. The widest
        // this flag can reach is "also send catalogImages".
        .select(
          options[PROJECTION]
          || (isTrue(options.withImages) ? LIST_EXCLUDE_WITH_IMAGES : LIST_EXCLUDE)
        )
        .populate('category', 'name')
        // Populated unconditionally rather than behind `hasFeature`. The field
        // is null for every product in a shop without the capability, so this
        // resolves nothing and costs nothing there — and gating it would mean
        // the list renders a bare id for the shops that DO have it whenever the
        // flag is read from a stale cached shop.
        .populate('brand', 'name')
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Product.countDocuments(query),
    ]);

    // Combo rows get their derived availability/cost — one batched read for
    // the union of components, nothing for a page with no combos on it.
    await this._decorateCombos(products);

    return {
      data: products.map(p => this._transformProduct(p)),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
      inventoryStats,
    };
  }

  // Search products for POS/sale item picker.
  async searchProductsForSale(shopId, options = {}, req = null) {
    const result = await this.getProducts(shopId, {
      ...options,
      status: 'active',
      page: options.page || 1,
      limit: options.limit || 30,
      // The mapper below reduces every row to exactly these fields anyway. Ask
      // the database for them instead of fetching whole documents per keystroke
      // and throwing four fifths of each away in JS.
      [PROJECTION]: POS_FIELDS,
      // A real boolean, and AFTER the spread so a query string cannot put a
      // truthy `'false'` here. See the block in `getProducts` that reads it.
      brandNameSearch: false,
    }, req);

    // Sent ONLY to shops that have the capability. A flag-off shop's POS
    // payload is byte-identical to what it was before this feature existed —
    // I-6 — and its till has no wholesale number to accidentally render.
    const wholesaleEnabled = hasFeature(req, 'wholesale');

    return {
      data: result.data.map((product) => ({
        _id: product._id,
        name: product.name,
        code: product.code,
        barcode: product.barcode,
        hasVariants: product.hasVariants,
        buyingPrice: product.buyingPrice,
        sellingPrice: product.sellingPrice,
        // The till needs this to SHOW the পাইকারি rate the moment a wholesale
        // customer is picked. It does not need it to charge — `createSale`
        // re-derives every price server-side from the customer document, so a
        // tampered payload changes the screen and nothing else.
        ...(wholesaleEnabled ? { wholesalePrice: product.wholesalePrice } : {}),
        stock: product.stock,
        minStock: product.minStock,
        unit: product.unit,
        // The POS needs the pack size to render a "কার্টন" button and to
        // convert before it posts. Sent on this payload rather than fetched
        // per-line: the cashier taps a product and must see both prices at
        // once, and a second round-trip at the till is a second failure point.
        packaging: product.packaging || undefined,
        category: product.category,
        // Already on the document — surfaced so the POS grid can flag best
        // sellers without a second request.
        totalSold: product.totalSold || 0,
        // Combo rows: the till renders the derived availability instead of
        // `stock`, and the component list under the line. Advisory only —
        // `createSale` re-checks each component under its own atomic guard.
        ...(product.type === 'combo' ? {
          type: 'combo',
          comboItems: product.comboItems || [],
          comboAvailability: product.comboAvailability ?? 0,
          comboCost: product.comboCost,
          comboCostMin: product.comboCostMin,
          comboBroken: product.comboBroken || null,
        } : {}),
        variants: (product.variants || [])
          .filter((variant) => variant.isActive !== false)
          .map((variant) => ({
            _id: variant._id,
            sku: variant.sku,
            barcode: variant.barcode,
            attributes: variant.attributes,
            size: variant.size,
            color: variant.color,
            buyingPrice: variant.buyingPrice,
            sellingPrice: variant.sellingPrice,
            ...(wholesaleEnabled ? { wholesalePrice: variant.wholesalePrice } : {}),
            stock: variant.stock,
            isActive: variant.isActive,
          })),
      })),
      pagination: result.pagination,
    };
  }

  // Get single product by ID
  async getProductById(shopId, productId, req = null) {
    const product = await Product.findOne(
      branchFilter(req, { _id: productId, shop: shopId, isDeleted: { $ne: true } })
    )
      .populate('category', 'name')
      .populate('brand', 'name')
      .populate('createdBy', 'name phone');

    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }

    const transformed = this._transformProduct(product);
    if (isCombo(transformed)) await this._decorateCombos([transformed]);
    return transformed;
  }

  // Get product by barcode/code
  async getProductByCode(shopId, code, req = null) {
    // ── Normalise what the scanner handed us ─────────────────────────────────
    //
    // Barcode scanners behave like keyboards, and most append a carriage return
    // or newline as the "enter" that submits the field. Phone camera scanners
    // add stray whitespace of their own. An exact match against the raw string
    // then fails on a value the shopkeeper can plainly read on screen — which
    // is precisely the "the code is right there but it says not found" report.
    const raw = String(code ?? '').trim();
    // `Product.code` is stored `uppercase: true`, so a lowercase scan or a typed
    // lookup could never match it. `barcode` and `sku` are stored verbatim and
    // are matched as-is.
    const upper = raw.toUpperCase();

    // Branch-scoped: scanning a barcode in Branch B must not return Branch A's
    // product — they are separate documents with their own price and stock.
    const product = await Product.findOne(branchFilter(req, {
      shop: shopId,
      isDeleted: { $ne: true },
      $or: [
        { code: upper },
        // The product's OWN barcode was missing from this list, which is the
        // bug: `barcode` is the field the product form fills in and the field
        // the label sheet prints, so every scan of a printed label fell through
        // to a 404 unless the product happened to have a matching variant.
        { barcode: raw },
        { 'variants.sku': raw },
        { 'variants.barcode': raw },
      ],
    })).populate('category', 'name');

    if (!product) {
      // A miss here has two very different causes and they need different
      // answers.
      //
      // Branch scoping is deliberate: a product document belongs to exactly one
      // branch and carries that branch's own price and stock, so scanning
      // Nayagola's item while switched to Branch 2 MUST fail. But it failed
      // with the same "পণ্যটি পাওয়া যায়নি" as a genuinely unknown barcode, and
      // a cashier reading that blames the scanner — rescans, wipes the label,
      // retypes the code — and never thinks to look at the branch switcher.
      //
      // One extra shop-wide lookup, ONLY on the miss path, turns a dead end
      // into an instruction. It costs nothing when the scan succeeds.
      const elsewhere = await Product.findOne({
        shop: shopId,
        isDeleted: { $ne: true },
        $or: [
          { code: upper },
          { barcode: raw },
          { 'variants.sku': raw },
          { 'variants.barcode': raw },
        ],
      }).select('name branch').populate('branch', 'name');

      if (elsewhere) {
        const where = elsewhere.branch?.name;
        throw new AppError(
          `Product "${elsewhere.name}" exists in another branch`,
          where
            ? `"${elsewhere.name}" এই ব্রাঞ্চে নেই — আছে ${where} ব্রাঞ্চে। উপরে ব্রাঞ্চ বদলে নিন।`
            : `"${elsewhere.name}" এই ব্রাঞ্চে নেই, অন্য ব্রাঞ্চে আছে। উপরে ব্রাঞ্চ বদলে নিন।`,
          404
        );
      }

      throw new AppError('Product not found', `"${raw}" দিয়ে কোনো পণ্য পাওয়া যায়নি`, 404);
    }

    const transformed = this._transformProduct(product);
    if (isCombo(transformed)) await this._decorateCombos([transformed]);
    return transformed;
  }

  // Create new product
  /**
   * Reject a unit this shop is not entitled to choose.
   *
   * The Product schema's enum deliberately accepts the FULL registry (an
   * existing product must stay saveable if an admin turns packaging back off),
   * so entitlement has to be enforced here, on the write path, where the
   * request's flag is known.
   *
   * Without the flag the answer is the original 13 units — the same list the
   * dropdown offers — so a hand-crafted POST cannot smuggle in `maund` and
   * leave the shop with a quantity the rest of their UI cannot interpret.
   *
   * @param {Object|null} req
   * @param {string|undefined} unit  absent/empty is fine; the schema defaults it
   */
  _assertUnitAllowed(req, unit) {
    if (!unit) return;
    const allowed = unitsForShop(hasFeature(req, 'packaging'));
    if (!allowed.includes(unit)) {
      throw new AppError(
        `Unit "${unit}" is not available for this shop`,
        'এই এককটি আপনার দোকানের জন্য চালু নেই',
        400
      );
    }
  }

  /**
   * Refuse a barcode already in use by another product in this branch.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * WHY PER-BRANCH AND NOT GLOBAL
   * ───────────────────────────────────────────────────────────────────────────
   *
   * A barcode identifies a MANUFACTURED ITEM, not a shop's copy of it. Every
   * shop in the country stocking the same bottle of Coca-Cola prints the same
   * EAN on the shelf, so global uniqueness would be flatly wrong — the second
   * shop to add it could never do so. Shop isolation (I-5) already makes a
   * scan unambiguous across shops, because no query ever leaves the shop.
   *
   * WITHIN a branch it is a different story. Two products sharing a barcode
   * makes `getProductByCode`'s `findOne` return whichever document Mongo hands
   * back first — so the cashier scans a bottle and rings up a different item,
   * at the correct-looking price of the wrong product, with no error anywhere.
   * That is the failure this prevents.
   *
   * Branch, not shop, for the same reason `code` is per-branch: two branches
   * legitimately stock the same item as two separate documents with their own
   * price and stock.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * WHY THIS IS NOT A UNIQUE INDEX
   * ───────────────────────────────────────────────────────────────────────────
   *
   * A partial unique index on {shop, branch, barcode} is the textbook answer
   * and would be better. It cannot be added blind: any shop that already has a
   * duplicate would fail the index build, and on this codebase indexes are
   * built at startup — so one shop's existing bad data would stop the whole
   * server from booting. Enforce on the write path now; add the index once a
   * migration has proven the collection clean.
   *
   * @param {string} shopId
   * @param {string|undefined} barcode  absent/empty is always fine — most
   *                                    products have no barcode at all
   * @param {Object|null} req
   * @param {string|null} excludeId     the product being updated
   */
  async _assertBarcodeUnique(shopId, barcode, req = null, excludeId = null) {
    const value = String(barcode || '').trim();
    if (!value) return;

    const filter = branchFilter(req, {
      shop: shopId,
      isDeleted: { $ne: true },
      barcode: value,
    });
    if (excludeId) filter._id = { $ne: excludeId };

    const clash = await Product.findOne(filter).select('name code');
    if (clash) {
      throw new AppError(
        `Barcode "${value}" is already used by ${clash.code}`,
        `এই বারকোডটি ইতিমধ্যে "${clash.name}" (${clash.code}) এ ব্যবহার হচ্ছে`,
        400
      );
    }
  }

  /**
   * The brand to store, or null.
   *
   * Fails closed on the capability: a shop without `features.brands` stores no
   * brand at all, whatever a client sends. The ownership check is the other half
   * — without it a caller could point one shop's product at another shop's
   * brand id, and the picker would then render a name from a shop they cannot
   * see. Inactive brands are refused too, so a deleted brand cannot be
   * resurrected onto a product through a stale form.
   *
   * @returns {mongoose.Types.ObjectId|null}
   */
  async _resolveBrand(shopId, brandId, req) {
    if (!hasFeature(req, 'brands')) return null;
    if (brandId === undefined || brandId === null || brandId === '') return null;

    const brand = await Brand.findOne({ _id: brandId, shop: shopId, isActive: true })
      .select('_id')
      .lean();

    if (!brand) {
      throw new AppError('Brand not found', 'ব্র্যান্ড পাওয়া যায়নি', 404);
    }
    return brand._id;
  }

  /**
   * The `batches` array a newly created product starts life with.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * WHY A VARIANT PRODUCT CANNOT USE THE TOP-LEVEL `batches` ARRAY
   * ───────────────────────────────────────────────────────────────────────────
   *
   * Because the client has no variant ids to point at. `_formatVariants` mints
   * them (`new mongoose.Types.ObjectId()`), so a request body composed before
   * that call can only identify a variant by its POSITION. Hence
   * `variants[i].openingBatch`, zipped against `formattedVariants[i]` here —
   * both arrays are produced by a 1:1 `map` over the same input, so the indexes
   * cannot drift.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * WHAT THIS REPLACES
   * ───────────────────────────────────────────────────────────────────────────
   *
   * The create form used to post ONE product-level batch whatever the product
   * was, with `quantity: parseStock(formData.stock)`. On a variant product the
   * stock box is not even rendered — variant stock lives on the rows — so that
   * read an empty string and stored a batch of quantity 0. The expiry-alerts
   * screen filters on `quantity > 0`, so the row never appeared: the shopkeeper
   * set an expiry date, saw it save, and was never warned about it. A feature
   * that silently does nothing is worse than one that is visibly absent.
   *
   * Quantity is the variant's own stock and cost is its own buying price, by
   * definition — see the note in the validation schema for why a client is not
   * allowed to send a third number that could disagree with them.
   *
   * @param {Array} formattedVariants  output of `_formatVariants` (has _id)
   * @param {Array} rawVariants        the request's variant rows (has openingBatch)
   * @param {Array} productBatches     top-level `batches`, non-variant products only
   * @param {string} code              product code, for generated batch numbers
   */
  _buildOpeningBatches(formattedVariants, rawVariants, productBatches, code) {
    const stamp = (batch, variantId, quantity, costPrice, index) => {
      const qty = Number(quantity) || 0;
      const expiryDate = batch?.expiryDate ? new Date(batch.expiryDate) : null;
      const batchNumber = String(batch?.batchNumber || '').trim();

      // Nothing to track. Not an error: the batch card is a single toggle for
      // the whole product, so a shop that tracks expiry on its milk still has
      // rows it has not dated yet.
      if (!batchNumber && !expiryDate) return null;
      // No stock means nothing on the shelf to go off. A zero-quantity batch is
      // exactly the phantom row this function exists to stop producing.
      if (qty <= 0) return null;

      return {
        variantId: variantId || null,
        // An expiry date with no batch number is the common case in a small
        // shop — the date is printed on the packet, the batch code often is not
        // legible or is simply not worth typing. Generating one keeps the field
        // required at the model (so nothing is ever unidentifiable in the
        // ledger) without making the shopkeeper invent a code.
        batchNumber: batchNumber || `B-${code || 'PRD'}-${index + 1}`,
        expiryDate,
        quantity: qty,
        costPrice: Number(costPrice) || 0,
      };
    };

    if (formattedVariants.length > 0) {
      return formattedVariants
        .map((fv, i) => stamp(
          rawVariants?.[i]?.openingBatch,
          fv._id,
          fv.stock,
          fv.buyingPrice,
          i
        ))
        .filter(Boolean);
    }

    // Non-variant: the product-level array, with `variantId` forced to null.
    // A client cannot smuggle a variant id onto a product that has no variants.
    return (Array.isArray(productBatches) ? productBatches : [])
      .map((b, i) => stamp(b, null, b?.quantity, b?.costPrice, i))
      .filter(Boolean);
  }

  /**
   * Validate a combo's component list and return the rows to store.
   *
   * Everything Joi cannot see is decided here, with the component documents in
   * hand: existence in THIS shop and branch, not deleted, not deactivated, not
   * itself a combo (no nesting — a chain of combos makes availability and
   * deduction order undecidable and buys the shopkeeper nothing), the variant
   * mode legal for the component (see `variantMode` on `comboItemSchema`),
   * quantity legal for the component's unit, and no duplicate FIXED
   * (product, variant) pair — 'choose' rows are slots and may repeat.
   *
   * The returned rows carry DISPLAY snapshots (name/code/sku/unit) refreshed
   * from the live component — the sale path freezes its own copy at checkout.
   *
   * @param {string} shopId
   * @param {Array}  rawItems  the request's comboItems
   * @param {Object} req
   * @param {string} [excludeId]  the combo's own id, on update — a combo
   *   containing itself is the one-level form of nesting
   * @returns {Promise<Array>} rows shaped for `Product.comboItems`
   */
  async _validateComboItems(shopId, rawItems, req, excludeId = null) {
    const items = Array.isArray(rawItems) ? rawItems : [];
    if (!items.length) {
      throw new AppError('A combo needs at least one component', 'কম্বোতে অন্তত একটি পণ্য যোগ করুন', 400);
    }

    const ids = [...new Set(items.map((i) => String(i.product)))];
    if (excludeId && ids.includes(String(excludeId))) {
      throw new AppError('A combo cannot contain itself', 'কম্বো নিজেকে উপাদান হিসেবে রাখতে পারে না', 400);
    }

    // Same-branch, same-shop, alive. Branch matters: products are per-branch
    // documents, so a component from another branch would deduct stock a
    // different till is counting.
    const components = await Product.find(
      branchFilter(req, { _id: { $in: ids }, shop: shopId, isDeleted: { $ne: true } })
    );
    const compMap = new Map(components.map((c) => [String(c._id), c]));

    const seen = new Set();
    const rows = [];

    for (const item of items) {
      const comp = compMap.get(String(item.product));
      if (!comp) {
        throw new AppError(
          `Combo component not found in this branch: ${item.product}`,
          'কম্বোর উপাদান পণ্যটি এই শাখায় পাওয়া যায়নি', 404
        );
      }
      if (isCombo(comp)) {
        throw new AppError(
          `"${comp.name}" is itself a combo — combos cannot contain combos`,
          `"${comp.name}" নিজেই একটি কম্বো — কম্বোর ভিতরে কম্বো রাখা যাবে না`, 400
        );
      }
      if (comp.isActive === false) {
        throw new AppError(
          `"${comp.name}" is inactive and cannot be sold`,
          `"${comp.name}" নিষ্ক্রিয় — নিষ্ক্রিয় পণ্য কম্বোতে রাখা যাবে না`, 400
        );
      }

      // Which sellable thing this slot draws from. A component WITHOUT variants
      // is always 'fixed' on the product itself — 'choose' there would mean
      // "pick one of nothing" — so the mode is forced rather than trusted.
      const rawVariantId = item.variantId || null;
      const wantsChoose = item.variantMode === 'choose';
      let variantMode = 'fixed';
      let variant = null;

      if (comp.hasVariants) {
        if (wantsChoose) {
          // Every active variant is eligible; the till picks. Refusing a
          // variantId here rather than ignoring it keeps the stored row honest
          // about what it means.
          if (rawVariantId) {
            throw new AppError(
              `"${comp.name}": a slot cannot both fix a variant and leave it to the till`,
              `"${comp.name}": একই সাথে ভ্যারিয়েন্ট বেঁধে দেওয়া আর বিলের সময় বাছাই — দুটো একসাথে হয় না`, 400
            );
          }
          if (!(comp.variants || []).some((v) => v.isActive !== false)) {
            throw new AppError(
              `"${comp.name}" has no active variant to choose from`,
              `"${comp.name}" এর কোনো সচল ভ্যারিয়েন্ট নেই — বিলের সময় বাছার কিছু থাকবে না`, 400
            );
          }
          variantMode = 'choose';
        } else {
          if (!rawVariantId) {
            throw new AppError(
              `"${comp.name}" has variants — pick one, or let the till choose`,
              `"${comp.name}" এর ভ্যারিয়েন্ট আছে — একটি বেছে দিন, অথবা বিলের সময় বাছাই করতে দিন`, 400
            );
          }
          variant = findComponentVariant(comp, rawVariantId);
          if (!variant || variant.isActive === false) {
            throw new AppError(
              `Variant not found on "${comp.name}"`,
              `"${comp.name}" এর ভ্যারিয়েন্টটি পাওয়া যায়নি`, 404
            );
          }
        }
      }

      // Quantity legality is the COMPONENT's business: 0.5 kg of a kg product
      // is a real combo line, 0.5 piece is not. Same helper the sale path uses.
      const quantity = parseQuantity(item.quantity, quantityUnit(req, comp), {
        label: comp.name,
      });

      // Two rows naming the SAME fixed thing are a data-entry slip — the
      // quantities belong on one row. Two 'choose' rows of one product are not:
      // they are independent SLOTS, which is how "১টা কিনলে ১টা ফ্রি, কাস্টমার
      // দুইটা আলাদা রঙ নিতে পারবে" is expressed. Each slot gets its own pick at
      // the till, so they are deliberately exempt from the duplicate rule.
      //
      // The alternative — one row of quantity 2 split across two variants —
      // is not on offer, and the reason is arithmetic: `salesReturn.service`
      // restores `quantityPerCombo × returnedQty`, so a split row makes
      // `quantityPerCombo` fractional and returning one combo would try to put
      // back half a shirt.
      if (variantMode === 'fixed') {
        const key = `${comp._id}:${variant ? variant._id : ''}`;
        if (seen.has(key)) {
          throw new AppError(
            `"${comp.name}" appears twice in the combo — merge the quantities into one row`,
            `"${comp.name}" কম্বোতে দুইবার আছে — পরিমাণ এক লাইনে লিখুন`, 400
          );
        }
        seen.add(key);
      }

      rows.push({
        product: comp._id,
        variantMode,
        variantId: variant ? variant._id : null,
        productName: comp.name,
        productCode: comp.code,
        variantSku: variant ? variant.sku : undefined,
        variantAttributes: variant ? variant.attributes : undefined,
        unit: comp.unit,
        quantity,
      });
    }

    return rows;
  }

  /**
   * Attach `comboAvailability` / `comboCost` / `comboBroken` to combo rows.
   *
   * One batched read for the union of every combo's components, projected to
   * the stock and cost columns only. Mutates the (lean) rows in place and
   * returns them. Advisory numbers — the sale path re-checks under its own
   * atomic $gte guard, so a stale figure here can never oversell.
   */
  async _decorateCombos(products) {
    const combos = (products || []).filter(
      (p) => p && isCombo(p) && Array.isArray(p.comboItems) && p.comboItems.length
    );
    if (!combos.length) return products;

    const compIds = [...new Set(
      combos.flatMap((c) => c.comboItems.map((ci) => String(ci.product)))
    )];
    const components = await Product.find({ _id: { $in: compIds } })
      .select('stock hasVariants variants._id variants.sku variants.attributes variants.stock variants.buyingPrice variants.sellingPrice variants.isActive buyingPrice sellingPrice isActive isDeleted')
      .lean();
    const compMap = new Map(components.map((c) => [String(c._id), c]));

    for (const combo of combos) {
      const { available, cost, costMin, broken } = computeComboAvailability(combo, compMap);
      combo.comboAvailability = available;
      combo.comboCost = cost;
      combo.comboCostMin = costMin;
      combo.comboBroken = broken;

      // Per-row LIVE display figures for the builder and the POS breakdown —
      // the stored row keeps only identity + quantity, so prices and stock are
      // read fresh rather than trusted from a snapshot that goes stale.
      for (const ci of combo.comboItems) {
        const comp = compMap.get(String(ci.product));
        if (!comp) continue;

        if (isChooseSlot(ci)) {
          // The till has not picked yet, so there is no single price to show.
          // The headline figures are the WORST case for the shop (priciest to
          // buy, dearest to give away) — see the cost note in combo.util.js —
          // and `variants` is what the POS picker renders.
          const variants = eligibleVariants(comp);
          const buyings = variants.map((v) => v.buyingPrice ?? comp.buyingPrice ?? 0);
          const sellings = variants.map((v) => v.sellingPrice || 0);
          ci.sellingPrice = sellings.length ? Math.max(...sellings) : 0;
          ci.buyingPrice = buyings.length ? Math.max(...buyings) : 0;
          ci.buyingPriceMin = buyings.length ? Math.min(...buyings) : 0;
          ci.stock = variants.reduce((sum, v) => sum + (v.stock || 0), 0);
          ci.variantCount = variants.length;
          ci.variants = variants.map((v) => ({
            _id: v._id,
            sku: v.sku,
            attributes: v.attributes,
            sellingPrice: v.sellingPrice || 0,
            stock: v.stock || 0,
          }));
          continue;
        }

        const variant = ci.variantId ? findComponentVariant(comp, ci.variantId) : null;
        ci.sellingPrice = variant ? (variant.sellingPrice || 0) : (comp.sellingPrice || 0);
        ci.buyingPrice = variant
          ? (variant.buyingPrice ?? comp.buyingPrice ?? 0)
          : (comp.buyingPrice || 0);
        ci.stock = variant ? (variant.stock || 0) : (comp.stock || 0);
        // A pinned row still ships the component's other variants, so the
        // builder can offer "সব ভ্যারিয়েন্ট চলবে" on a combo that was built
        // back when pinning was the only option.
        if (comp.hasVariants) {
          ci.variants = eligibleVariants(comp).map((v) => ({
            _id: v._id,
            sku: v.sku,
            attributes: v.attributes,
            sellingPrice: v.sellingPrice || 0,
            stock: v.stock || 0,
          }));
        }
      }
    }
    return products;
  }

  async createProduct(shopId, userId, productData, req = null) {
    const { code, name, category, variants, packaging, ...rest } = productData;

    // ── Combo create ─────────────────────────────────────────────────────────
    //
    // A combo is structurally a PLAIN product: no variants, no stock (derived
    // from components), no batches, serials or pack. Forced here rather than
    // trusted from the client, for the same reason `isAvailableOnline` is.
    const creatingCombo = rest.type === 'combo';
    if (creatingCombo) {
      if (!hasFeature(req, 'combos')) {
        // 404, not 403 — to a shop without the capability the combo kind does
        // not exist. Same shape as `requireFeature`.
        const err = new AppError('Not found', 'এই সুবিধাটি আপনার দোকানে চালু নেই', 404);
        err.code = 'FEATURE_DISABLED';
        err.feature = 'combos';
        throw err;
      }
      if (Array.isArray(variants) && variants.length) {
        throw new AppError('A combo cannot have variants of its own', 'কম্বোর নিজস্ব ভ্যারিয়েন্ট থাকতে পারে না', 400);
      }
      rest.comboItems = await this._validateComboItems(shopId, rest.comboItems, req);
      rest.stock = 0;
      rest.trackBatches = false;
      rest.batches = [];
      rest.trackSerials = false;
      rest.serials = [];
      // Cost is derived from components at sale time; the stored figure is a
      // placeholder the schema requires nothing of.
      rest.buyingPrice = rest.buyingPrice || 0;
    } else {
      // `type` defaults to 'standard'; Joi's `otherwise` branch only admits an
      // empty array here, and storing it on every ordinary product would defeat
      // the schema's `default: undefined`.
      delete rest.comboItems;
    }

    this._assertUnitAllowed(req, rest.unit);
    await this._assertBarcodeUnique(shopId, rest.barcode, req);
    // Validated against the product's OWN unit, so `outerUnitsFor` can refuse a
    // pack that cannot physically hold it. Returns undefined when packaging is
    // off, which is what leaves the subdocument absent rather than half-filled.
    rest.packaging = normalizePackaging(
      creatingCombo ? undefined : packaging,
      rest.unit || DEFAULT_UNIT,
      hasFeature(req, 'packaging')
    );
    // Absent for every shop without the capability, and for every product whose
    // owner left the box empty — which is most of them even in a shop that has
    // it. See utils/pricing.util.js for why absent means "charge retail".
    const wholesaleEnabled = hasFeature(req, 'wholesale');
    rest.wholesalePrice = normalizeWholesalePrice(rest.wholesalePrice, wholesaleEnabled, {
      label: name,
    });

    // Null for a shop without the capability, so a flag-off shop's products are
    // stored exactly as they were before brands existed. Nothing to preserve on
    // a create, which is why this assigns rather than deleting the key the way
    // the update path below has to.
    rest.brand = await this._resolveBrand(shopId, rest.brand, req);

    // Forced, not merely defaulted. The schema default already says `false`, but
    // a default only applies to a key the client omitted — and the client is not
    // the authority on whether this shop may sell online. A stale or hand-rolled
    // request sending `isAvailableOnline: true` to a shop without the capability
    // would otherwise put a product on a surface the shop was never given.
    this._applyOnlineFields(rest, req, { create: true });

    // Code uniqueness is per branch — the same code in another branch is a
    // different product, which is the whole point of per-branch catalogues.
    const existingProduct = await Product.findOne(branchFilter(req, { shop: shopId, code }));
    if (existingProduct) {
      throw new AppError('এই কোড দিয়ে ইতিমধ্যে পণ্য আছে', 'Product with this code already exists', 400);
    }

    // Validate category if provided
    if (category) {
      const categoryExists = await Category.findOne({ _id: category, $or: [{ shop: shopId }, { shop: null }] });
      if (!categoryExists) {
        throw new AppError('ক্যাটাগরি পাওয়া যায়নি', 'Category not found', 404);
      }
    }

    // Ownership-checks every `mediaId` in the payload and rewrites the URLs from
    // the ShopMedia documents. Runs before `_formatVariants` so the variant rows
    // it reads already carry resolved ids. Drops the image keys entirely when
    // the shop does not have the capability.
    const imagePayload = { catalogImages: rest.catalogImages, variants };
    await this._applyImageRefs(shopId, imagePayload, req);
    if ('catalogImages' in imagePayload) {
      rest.catalogImages = imagePayload.catalogImages;
    } else {
      delete rest.catalogImages;
    }

    const formattedVariants = this._formatVariants(variants, wholesaleEnabled);
    // Assigned rather than left to `...rest` so the top-level `batches` a client
    // sent can never reach the document unmapped — on a variant product it
    // would be a batch belonging to no variant, which FEFO could not find and
    // the alerts screen could not name.
    rest.batches = rest.trackBatches
      ? this._buildOpeningBatches(formattedVariants, variants, rest.batches, code)
      : [];

    const product = await Product.create({
      shop: shopId,
      branch: requireBranch(req),
      code,
      name,
      category,
      variants: formattedVariants,
      hasVariants: formattedVariants.length > 0,
      createdBy: userId,
      ...rest,
    });

    // Create audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'product_create',
      actionBn: 'নতুন পণ্য যোগ',
      description: `Created product: ${name}`,
      descriptionBn: `নতুন পণ্য যোগ করা হয়েছে: ${name}`,
      entity: {
        type: 'product',
        id: product._id,
        name: name,
      },
      changes: {
        // Whitelisted, not the whole document — see utils/auditDiff.util.js.
        after: auditSnapshot(product, AUDIT_FIELDS.product),
      },
    });

    // The images this product now claims stop being `staged` and become
    // referenced. Done after the write, never before: a create that failed
    // validation must not leave a reference to a product that does not exist.
    await mediaService.reconcileRefs(shopId, [], mediaService.mediaIdsOfProduct(product));

    // A new attribute value may have entered the shop's vocabulary. Never
    // awaited: a stale option list is cosmetic and self-corrects within the
    // cache TTL, while failing a product write over it would not be.
    variantCatalogService.invalidate(shopId).catch(() => {});

    return this._transformProduct(product);
  }

  // Update product
  async updateProduct(shopId, userId, productId, updateData, req = null) {
    const product = await Product.findOne(
      branchFilter(req, { _id: productId, shop: shopId, isDeleted: { $ne: true } })
    );
    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }

    const beforeData = product.toObject();
    // Captured before anything is assigned onto the document, because that is
    // the only moment the OLD reference set still exists. The diff against the
    // saved result is what moves every refCount.
    const previousMediaIds = mediaService.mediaIdsOfProduct(product);

    // ── Combo update rules ───────────────────────────────────────────────────
    //
    // The KIND is immutable: a standard product with stock becoming a combo
    // would orphan that stock, and a combo becoming standard would mint stock
    // from nowhere. Everything meaningless on a combo (own stock, variants,
    // pack, batches, serials) is dropped rather than refused, matching how the
    // flag-off guards above treat fields a form should not have sent.
    if ('type' in updateData && updateData.type !== (product.type || 'standard')) {
      throw new AppError(
        'A product cannot change kind (standard/combo) after creation',
        'পণ্যের ধরন (সাধারণ/কম্বো) তৈরির পরে বদলানো যায় না', 400
      );
    }
    if (isCombo(product)) {
      if (Array.isArray(updateData.variants) && updateData.variants.length) {
        throw new AppError('A combo cannot have variants of its own', 'কম্বোর নিজস্ব ভ্যারিয়েন্ট থাকতে পারে না', 400);
      }
      delete updateData.variants;
      delete updateData.stock;
      delete updateData.packaging;
      delete updateData.trackBatches;
      delete updateData.trackSerials;
      delete updateData.serials;
      if ('comboItems' in updateData) {
        updateData.comboItems = await this._validateComboItems(shopId, updateData.comboItems, req, productId);
      }
    } else if ('comboItems' in updateData) {
      // Joi only admits an empty array on a non-combo; do not store it.
      delete updateData.comboItems;
    }

    this._assertUnitAllowed(req, updateData.unit);
    if ('barcode' in updateData) {
      await this._assertBarcodeUnique(shopId, updateData.barcode, req, productId);
    }

    // The pack has to be re-checked against whichever base unit the product
    // will END UP with, not the one it has now: changing পিস -> কেজি in the same
    // request as keeping a কার্টন pack is legal, changing it to a ডজন pack over
    // a কেজি base is not. `updateData.unit` may be absent (a name-only edit),
    // in which case the stored unit is still the right thing to check against.
    if ('packaging' in updateData) {
      updateData.packaging = normalizePackaging(
        updateData.packaging,
        updateData.unit || product.unit || DEFAULT_UNIT,
        hasFeature(req, 'packaging')
      );
    }

    // Guarded by `in`, deliberately. A flag-off shop's product form does not
    // render the field and therefore does not send the key, so the stored rate
    // SURVIVES an admin turning the capability off and a shopkeeper editing the
    // product afterwards. Normalising unconditionally would read the absent key
    // as `undefined`, clear it, and quietly destroy every wholesale price in
    // the shop the first time each product was touched — an unrecoverable loss
    // from a switch that is supposed to be reversible.
    const wholesaleEnabled = hasFeature(req, 'wholesale');
    if ('wholesalePrice' in updateData) {
      updateData.wholesalePrice = normalizeWholesalePrice(
        updateData.wholesalePrice,
        wholesaleEnabled,
        { label: updateData.name || product.name }
      );
    }

    // Guarded by `in` for the same reason as `wholesalePrice` above, and the key
    // is DROPPED rather than nulled when the capability is off. An admin who
    // turns brands off must be able to turn them back on and find the products
    // still pointing at their brands; clearing the field on the next unrelated
    // edit would make that switch one-way.
    if ('brand' in updateData) {
      if (!hasFeature(req, 'brands')) {
        delete updateData.brand;
      } else {
        updateData.brand = await this._resolveBrand(shopId, updateData.brand, req);
      }
    }

    // Same `in`-guard reasoning as `brand` and `wholesalePrice` above: with the
    // capability off the keys are DROPPED, so a shop that once sold online keeps
    // its stored settings and gets them back if the flag is switched on again.
    // With it on, whatever the form sent is honoured — including `false`.
    this._applyOnlineFields(updateData, req);

    // Ownership-checks the payload's media ids and takes the URLs from the
    // ShopMedia documents rather than from the client. With the capability off
    // this DELETES `catalogImages` from the payload, so `Object.assign` below
    // never touches the stored array — the photos survive the flag being turned
    // off, exactly as the brand and wholesale fields above do.
    await this._applyImageRefs(shopId, updateData, req);

    // Changing the unit does NOT convert the stored stock — 100 (kg) becoming
    // 100 (gram) is a data-entry correction, not a x1000 conversion, and
    // guessing wrong silently revalues the whole inventory. The UI warns and
    // asks for a recount instead. If you are tempted to add a conversion here,
    // read AGENT_WORKFLOW.md §13 first.

    // Separate stock from other update data so we can handle it via updateStock
    const { stock, variants: variantsWithStock, ...safeUpdateData } = updateData;

    // The product document already belongs to exactly one branch; this is only
    // carried into the StockTransaction ledger below.
    const targetBranchId = product.branch || null;

    // Process variant updates and handle variant stock changes
    if (variantsWithStock && Array.isArray(variantsWithStock)) {
      const formattedInputVariants = this._formatVariants(variantsWithStock, wholesaleEnabled);
      const updatedVariants = [];

      for (const variant of formattedInputVariants) {
        const existingVariant = product.variants?.find(v =>
          v._id?.toString() === variant._id?.toString() || v.sku === variant.sku
        );

        let inputStock = variant.stock ?? 0;
        let currentStock = 0;
        let variantId = variant._id;

        if (existingVariant) {
          // Keep existing variant's ID
          variantId = existingVariant._id;
          variant._id = existingVariant._id;
          currentStock = existingVariant.stock || 0;

          // A flag-off shop's variant rows carry no wholesale box, so the form
          // sends no rate and the rebuilt row above holds `undefined`. Since
          // this array REPLACES the stored one wholesale, that would erase every
          // variant's wholesale price the first time the product was edited
          // after an admin turned the capability off — the toggle is meant to
          // be reversible, and this is the only path that could make it not be.
          //
          // Only carried forward when the shop cannot see the field. With the
          // flag ON an empty box is a deliberate "remove the wholesale rate",
          // and honouring that is the whole point of the box.
          if (!wholesaleEnabled) {
            variant.wholesalePrice = existingVariant.wholesalePrice;
          }

          // Identical hazard, higher stakes. A flag-off shop's variant rows have
          // no image control, so the rebuilt row holds no photo and this array
          // replaces the stored one wholesale — which would not merely blank the
          // picture but DROP the reference, sending a still-wanted image into the
          // orphan grace period to be deleted a week later. Losing a wholesale
          // price is recoverable by retyping it; losing the bytes is not.
          if (!hasFeature(req, 'productImages')) {
            variant.image = existingVariant.image;
            variant.imageMediaId = existingVariant.imageMediaId || null;
          }
        }

        // If the stock is different, we must update it
        if (inputStock !== currentStock) {
          variant.stock = inputStock;

          // Create stock transaction for this variant stock adjustment
          await StockTransaction.create({
            shop: shopId,
            branch: req?.shop?.multiBranchEnabled ? targetBranchId : null,
            product: product._id,
            productName: product.name,
            productCode: product.code,
            variantId: variantId,
            type: 'adjustment',
            quantity: inputStock - currentStock,
            previousStock: currentStock,
            newStock: inputStock,
            reference: { type: 'manual' },
            notes: 'পণ্য সম্পাদনা থেকে ভ্যারিয়েন্ট স্টক আপডেট',
            createdBy: userId,
          });
        }

        updatedVariants.push({ ...variant, stock: inputStock });
      }

      safeUpdateData.variants = updatedVariants;
    }

    // Check if code is being changed and if it conflicts
    if (safeUpdateData.code && safeUpdateData.code !== product.code) {
      const existingProduct = await Product.findOne({ shop: shopId, branch: product.branch || null, code: safeUpdateData.code, _id: { $ne: productId } });
      if (existingProduct) {
        throw new AppError('এই কোড দিয়ে ইতিমধ্যে পণ্য আছে', 'Product with this code already exists', 400);
      }
    }

    // Update product with safe data
    Object.assign(product, safeUpdateData);
    // `Object.assign` copies an explicit `undefined` as a key with no value,
    // which Mongoose treats as "leave it alone" for a single nested path — the
    // old pack would survive a request that turned packaging off. `$unset` is
    // the only thing that actually removes it.
    if ('packaging' in safeUpdateData && safeUpdateData.packaging === undefined) {
      product.set('packaging', undefined);
      product.markModified('packaging');
    }
    if (safeUpdateData.variants) {
      product.hasVariants = safeUpdateData.variants.length > 0;
    }
    await product.save();

    // Create audit log for general product update
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'product_update',
      actionBn: 'পণ্য আপডেট',
      description: `Updated product: ${product.name}`,
      descriptionBn: `পণ্য আপডেট করা হয়েছে: ${product.name}`,
      entity: {
        type: 'product',
        id: product._id,
        name: product.name,
      },
      // Field-level diff rather than two full documents: a price edit stored
      // the whole variants array, batch history and image list twice over.
      changes: auditDiff(beforeData, product, AUDIT_FIELDS.product),
    });

    // Whatever the edit did to the photo set, settle up: newly referenced images
    // graduate from `staged`, dropped ones lose a reference and start their
    // orphan clock. A no-op when the payload carried no image keys at all, which
    // is most edits.
    await mediaService.reconcileRefs(
      shopId,
      previousMediaIds,
      mediaService.mediaIdsOfProduct(product)
    );

    // If stock was provided and this is a non-variant product, update stock through
    // the proper channel so it's tracked in StockTransaction
    // Before the early return below, so BOTH exits from this method drop it.
    // A new attribute value may have entered the shop's vocabulary. Never
    // awaited: a stale option list is cosmetic and self-corrects within the
    // cache TTL, while failing a product write over it would not be.
    variantCatalogService.invalidate(shopId).catch(() => {});

    if (stock !== undefined && stock !== null && !product.hasVariants) {
      const updatedProduct = await this.updateStock(shopId, userId, productId, {
        quantity: parseInt(stock) || 0,
        type: 'set',
        notes: 'পণ্য সম্পাদনা থেকে স্টক আপডেট',
      }, req);
      return this._transformProduct(updatedProduct);
    }

    return this._transformProduct(product);
  }

  // Delete product (soft delete). The document is kept so past sales,
  // purchases and stock transactions still resolve — only new activity is
  // blocked and the product disappears from all listings.
  async deleteProduct(shopId, userId, productId, req = null) {
    if (req?.shop?.multiBranchEnabled) {
      requireBranch(req);
    }

    const product = await Product.findOne({ _id: productId, shop: shopId, isDeleted: { $ne: true } });
    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }

    // ── Is this product a component of a live combo? ─────────────────────────
    //
    // Deleting it would leave those combos silently unsellable with no record
    // of why. So: refuse by default, naming the combos; with `?force=true`
    // deactivate them instead — visible on the product list, reversible, and
    // written to the audit trail with its cause. Old sales are untouched either
    // way — they froze their own component snapshots at checkout.
    if (!isCombo(product)) {
      const containingCombos = await Product.find({
        shop: shopId,
        isDeleted: { $ne: true },
        type: 'combo',
        'comboItems.product': product._id,
      }).select('name code isActive');

      const activeCombos = containingCombos.filter((c) => c.isActive !== false);
      if (activeCombos.length) {
        const force = req?.query?.force === 'true' || req?.query?.force === true;
        const names = activeCombos.map((c) => c.name).join(', ');
        if (!force) {
          const err = new AppError(
            `This product is used by active combos: ${names}. Deactivate them first, or retry with force=true to deactivate them automatically.`,
            `পণ্যটি চালু কম্বোতে ব্যবহৃত হচ্ছে: ${names}। আগে কম্বোগুলো বন্ধ করুন, অথবা force দিয়ে মুছলে কম্বোগুলো স্বয়ংক্রিয়ভাবে বন্ধ হয়ে যাবে।`,
            400
          );
          err.code = 'PRODUCT_IN_COMBO';
          err.combos = activeCombos.map((c) => ({ id: c._id, name: c.name, code: c.code }));
          throw err;
        }

        await Product.updateMany(
          { _id: { $in: activeCombos.map((c) => c._id) }, shop: shopId },
          { $set: { isActive: false } }
        );
        AuditLog.create({
          shop: shopId,
          user: userId,
          action: 'product_deactivate',
          actionBn: 'পণ্য নিষ্ক্রিয় করা',
          description: `Deactivated combos [${names}] because component "${product.name}" was deleted`,
          descriptionBn: `উপাদান পণ্য "${product.name}" মুছে ফেলায় কম্বো [${names}] বন্ধ করা হয়েছে`,
          entity: { type: 'product', id: product._id, name: product.name },
        }).catch((err2) => logger.error(`Audit log (combo cascade) failed: ${err2.message}`));
      }
    }

    const originalCode = product.code;
    // Read while the document still carries them — after the save below there is
    // no other record of what this product pointed at.
    const previousMediaIds = mediaService.mediaIdsOfProduct(product);

    product.isDeleted = true;
    product.deletedAt = new Date();
    product.deletedBy = userId;
    // Also flip the visibility flags so every existing isActive/online-filtered
    // query (reports, barcode lookup, online store) stays consistent
    product.isActive = false;
    product.isAvailableOnline = false;
    // Free the code for reuse — {shop, code} carries a unique index, so keeping
    // it would block re-creating a product with the same code later. Invoices
    // and stock history store their own productCode snapshot, so they are
    // unaffected by this rename.
    product.code = `${originalCode}~DEL~${Date.now().toString(36)}`;
    await product.save();

    // The photos stop being referenced the moment the product leaves every
    // listing. Without this the count never falls to zero, `orphanedAt` is never
    // stamped, and the reclamation sweep can never see them — a deleted
    // product's images would occupy the shop's quota permanently.
    //
    // Safe to do on a SOFT delete because there is no restore path: a deleted
    // product is only ever purged (admin.service.purgeProducts), never revived.
    // If one is ever added it must re-attach, or it will resurrect a product
    // whose images were reclaimed during the grace period.
    //
    // The `mediaId`s stay on the document on purpose. `purgeProducts` repeats
    // this detach, which is a no-op for anything deleted after this change but
    // is the only thing that ever releases the images of products soft-deleted
    // BEFORE it — their refCount was never decremented. The `refCount > 0` guard
    // in `reconcileRefs` makes running it twice harmless.
    await mediaService.reconcileRefs(shopId, previousMediaIds, []);

    // Invalidate the cached inventory stats so totals reflect the deletion
    const statsKeyBase = `shop:${shopId}:invstats:`;
    cacheService.delete(`${statsKeyBase}all`).catch(() => {});
    if (req?.branchId) {
      cacheService.delete(`${statsKeyBase}${req.branchId}`).catch(() => {});
    }

    // Create audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'product_delete',
      actionBn: 'পণ্য মুছে ফেলা',
      description: `Deleted product: ${product.name} (${originalCode})`,
      descriptionBn: `পণ্য মুছে ফেলা হয়েছে: ${product.name} (${originalCode})`,
      entity: {
        type: 'product',
        id: product._id,
        name: product.name,
      },
      changes: {
        before: { code: originalCode, isDeleted: false },
        after: { code: product.code, isDeleted: true },
      },
    });

    // A new attribute value may have entered the shop's vocabulary. Never
    // awaited: a stale option list is cosmetic and self-corrects within the
    // cache TTL, while failing a product write over it would not be.
    variantCatalogService.invalidate(shopId).catch(() => {});

    return { success: true };
  }

  // Toggle product active status
  async toggleProductStatus(shopId, userId, productId, isActive) {
    const product = await Product.findOne({ _id: productId, shop: shopId, isDeleted: { $ne: true } });
    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }

    const previousStatus = product.isActive;
    product.isActive = isActive;
    await product.save();

    // Create audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: isActive ? 'product_activate' : 'product_deactivate',
      actionBn: isActive ? 'পণ্য সক্রিয় করা' : 'পণ্য নিষ্ক্রিয় করা',
      description: `${isActive ? 'Activated' : 'Deactivated'} product: ${product.name}`,
      descriptionBn: `পণ্য ${isActive ? 'সক্রিয়' : 'নিষ্ক্রিয়'} করা হয়েছে: ${product.name}`,
      entity: {
        type: 'product',
        id: product._id,
        name: product.name,
      },
      changes: {
        before: { isActive: previousStatus },
        after: { isActive },
      },
    });

    return product;
  }

  // Update stock
  async updateStock(shopId, userId, productId, stockData, req = null) {
    const { quantity, type, variantId, notes } = stockData;

    const product = await Product.findOne(
      branchFilter(req, { _id: productId, shop: shopId, isDeleted: { $ne: true } })
    );
    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }
    // A combo has no stock to adjust — its availability is its components'.
    assertNotCombo(product, 'স্টক সমন্বয়');

    let previousStock, newStock;
    // Writing to a product implies its branch. requireBranch still runs so an
    // owner in "All Branches" is told to pick one rather than editing an
    // arbitrary branch's copy of the item.
    if (req) requireBranch(req);
    const branchId = product.branch || null;

    // Manual adjustment is the one path where a shopkeeper types a stock figure
    // directly ("recount: 12.5 kg"), so it is also the one where an unvalidated
    // fraction would land in the database unrounded. `allowZero` because
    // `type: 'set'` legitimately zeroes a product out.
    const qty = parseQuantity(quantity, quantityUnit(req, product), {
      label: product.name,
      allowZero: true,
    });
    const stkUnit = storageUnit(product);

    {
      if (variantId) {
        // Update variant stock
        const variant = (product.variants && typeof product.variants.id === 'function')
          ? product.variants.id(variantId)
          : product.variants?.find(v => (v._id || v.id)?.toString() === variantId?.toString());
        if (!variant) {
          throw new AppError('ভেরিয়েন্ট পাওয়া যায়নি', 'Variant not found', 404);
        }
        previousStock = variant.stock;
        if (type === 'set') {
          variant.stock = qty;
        } else if (type === 'subtract') {
          variant.stock = quantize(variant.stock - qty, stkUnit);
        } else {
          variant.stock = quantize(variant.stock + qty, stkUnit);
        }
        newStock = variant.stock;
      } else {
        // Update main product stock
        previousStock = product.stock;
        if (type === 'set') {
          product.stock = qty;
        } else if (type === 'subtract') {
          product.stock = quantize(product.stock - qty, stkUnit);
        } else {
          product.stock = quantize(product.stock + qty, stkUnit);
        }
        newStock = product.stock;
      }

      // ── Keep batches from out-running stock ──────────────────────────────
      //
      // A recount is the one place a shopkeeper overrides the system's count
      // with their own, and this path did not touch `batches` at all. So
      // recounting 30 down to 8 left 30 batched — and the expiry screen went on
      // warning about 22 packets that were not on the shelf. Warnings about
      // goods that are not there are how a shopkeeper learns to ignore the
      // screen entirely.
      //
      // Only ever trims, never grows: a recount UP means stock arrived without
      // a delivery being recorded, and there is no honest expiry date to invent
      // for it. That surplus shows on the batch panel as `untracked`, which is
      // the truth — the shopkeeper can date it themselves.
      //
      // Soonest-expiry-first, because if packets are missing at a recount the
      // expired ones are far and away the likeliest to have been thrown out.
      if (capBatchesToStock(product, variantId || null, newStock)) {
        product.markModified('batches');
      }

      await product.save();
    }

    // Create stock transaction
    await StockTransaction.create({
      shop: shopId,
      branch: branchId,
      product: productId,
      productName: product.name,
      productCode: product.code,
      variantId: variantId || null,
      /**
       * Always `adjustment`, and always the SIGNED delta. Both halves of this
       * line were wrong, in ways that pulled against each other.
       *
       * ── `type` ────────────────────────────────────────────────────────────
       *
       * It read `qty > 0 ? 'purchase' : 'adjustment'`, so a shopkeeper adding
       * stock by hand produced a movement labelled a PURCHASE. There is no
       * supplier, no bill, no cost and no `Purchase` document behind it —
       * `reference.type` on the very next line says `'manual'`, which is the
       * truth the label contradicted. The stock ledger claimed goods had been
       * bought that nobody ever billed the shop for.
       *
       * ── `quantity` ────────────────────────────────────────────────────────
       *
       * Direction used to be carried by the label: `'purchase'` meant up,
       * `'adjustment'` meant down, and the figure itself was unsigned. Every
       * other writer in the codebase stores a signed quantity — `sale` writes
       * `-item.quantity`, and the schema says so ("Can be negative for stock
       * out"). So a manual subtract of 5 stored `+5` while a sale of 5 stored
       * `-5`, and the ledger's own arithmetic
       *
       *     previousStock + quantity === newStock
       *
       * held for every movement in the system except this one.
       *
       * Fixing `type` alone would have made it worse, not better: with both
       * directions labelled `adjustment` and the figure still unsigned, a
       * recount up and a recount down would be indistinguishable. The two
       * changes are one change.
       */
      type: 'adjustment',
      quantity: quantize(newStock - previousStock, stkUnit),
      previousStock,
      newStock,
      reference: {
        type: 'manual',
      },
      notes,
      createdBy: userId,
    });

    // Create audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'stock_update',
      actionBn: 'স্টক আপডেট',
      description: `Updated stock for ${product.name}: ${previousStock} → ${newStock}${branchId ? ` (Branch: ${branchId})` : ''}`,
      descriptionBn: `${product.name} এর স্টক আপডেট: ${previousStock} → ${newStock}${branchId ? ` (শাখা: ${branchId})` : ''}`,
      entity: {
        type: 'product',
        id: product._id,
        name: product.name,
      },
      changes: {
        before: { stock: previousStock },
        after: { stock: newStock },
      },
    });

    return this._transformProduct(product);
  }

  /**
   * ক্ষতি — write goods off the shelf as a LOSS.
   *
   * ── Why this is not `updateStock` with a reason attached ──────────────────
   *
   * The two look like the same operation and are not, in the way that matters
   * to the P&L:
   *
   *   · A recount says "my count was wrong." Nothing was gained or lost by
   *     saying so — the shelf and the screen are being made to agree, and the
   *     shop is exactly as rich afterwards as it was before.
   *   · A write-off says "these goods are gone." Value left the business.
   *
   * Before this method existed there was only the first, so every packet that
   * expired, broke, or walked out of the door left inventory through
   * `updateStock` — which records no cost and reaches no report. `getProfitLoss`
   * derives COGS as `merchandiseRevenue − Sale.profit`, so by construction it
   * can only ever contain the cost of goods that were SOLD. Shrinkage had
   * nowhere to land, and net profit was overstated by every taka of it.
   *
   * At the 2–4% shrinkage a grocery or pharmacy actually runs, that is roughly
   * a full month of net profit a year, reported in the direction that makes an
   * owner over-draw and under-price.
   *
   * ── Why the value is taken HERE and not derived later ────────────────────
   *
   * `totalCost` is snapshotted onto the row at write-off time from the product's
   * current `buyingPrice` — the moving weighted average `costing.util` maintains.
   * Deriving it at report time from today's `buyingPrice` would revalue last
   * March's loss every time a supplier changed their price, so a closed month's
   * profit would move on its own. Same rule `Sale.items.buyingPrice` follows,
   * for the same reason.
   *
   * ── Not backdatable, deliberately ────────────────────────────────────────
   *
   * `StockTransaction` has no `date` separate from `createdAt`, and a write-off
   * is discovered on the day it is discovered — a shopkeeper finding a spoiled
   * carton does not know which day it spoiled. Giving this a backdate field
   * would invite a precision nobody has. If that changes, it has to change for
   * the whole stock ledger at once, not for this one row type.
   *
   * @param {object} data `{ quantity, variantId, reason, notes }`. `quantity` is
   *   always POSITIVE — how much was lost. Direction is implied by the
   *   operation, the same way `AccountEntry.directionFor` implies it from type.
   */
  async writeOffStock(shopId, userId, productId, data, req = null) {
    const { quantity, variantId, reason, notes } = data;

    const product = await Product.findOne(
      branchFilter(req, { _id: productId, shop: shopId, isDeleted: { $ne: true } })
    );
    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }
    // A combo holds no stock of its own — its availability is its components'.
    // Writing one off would destroy nothing and record a cost for it.
    assertNotCombo(product, 'ক্ষতি');

    // Writing to a product implies its branch. `requireBranch` still runs so an
    // owner in "All Branches" is told to pick one rather than writing stock off
    // an arbitrary branch's copy of the item.
    if (req) requireBranch(req);
    const branchId = product.branch || null;

    // `allowZero: false` — a zero-quantity write-off is a row that says a loss
    // happened and values it at nothing. Refused rather than stored.
    const qty = parseQuantity(quantity, quantityUnit(req, product), {
      label: product.name,
    });
    const stkUnit = storageUnit(product);

    let previousStock, newStock, unitCost;
    let variant = null;

    if (variantId) {
      variant = (product.variants && typeof product.variants.id === 'function')
        ? product.variants.id(variantId)
        : product.variants?.find(v => String(v._id || v.id) === String(variantId));
      if (!variant) {
        throw new AppError('ভেরিয়েন্ট পাওয়া যায়নি', 'Variant not found', 404);
      }
      previousStock = variant.stock || 0;
      unitCost = variant.buyingPrice ?? product.buyingPrice ?? 0;
    } else {
      previousStock = product.stock || 0;
      unitCost = product.buyingPrice || 0;
    }

    /**
     * You cannot lose what you do not have.
     *
     * Writing off 30 when 8 are on the shelf drives stock negative AND books
     * ৳22-worth of cost for goods the shop never held — a loss that did not
     * happen, in a figure the owner reads as one that did. A recount is the
     * right tool for a count that is wrong, and it is one screen away.
     */
    if (qty > previousStock) {
      throw new AppError(
        `"${product.name}" এর স্টকে আছে ${previousStock}, ক্ষতি লেখা যাবে না ${qty}। গণনা ভুল হলে স্টক সমন্বয় করুন।`,
        `Cannot write off ${qty} of "${product.name}" — only ${previousStock} in stock. Use a stock adjustment if the count is wrong.`,
        400
      );
    }

    newStock = quantize(previousStock - qty, stkUnit);
    if (variant) {
      variant.stock = newStock;
    } else {
      product.stock = newStock;
    }

    // Goods written off are goods off the shelf, so the batches that described
    // them go too — soonest-expiry-first, which for the commonest reason
    // (`expired`) is not a heuristic but the exact right rows. Same helper and
    // same ordering a recount-down uses; see `updateStock`.
    if (capBatchesToStock(product, variantId || null, newStock)) {
      product.markModified('batches');
    }

    await product.save();

    const totalCost = quantizeMoney(unitCost * qty);

    await StockTransaction.create({
      shop: shopId,
      branch: branchId,
      product: productId,
      productName: product.name,
      productCode: product.code,
      variantId: variantId || null,
      variantSku: variant?.sku,
      variantAttributes: variant?.attributes,
      type: 'damage',
      // Signed, like every other writer in this collection — a sale of 5 stores
      // `-5` and so does a write-off of 5. The ledger's own arithmetic
      // (`previousStock + quantity === newStock`) has to hold for this row too.
      quantity: quantize(-qty, stkUnit),
      previousStock,
      newStock,
      unitCost,
      totalCost,
      writeOffReason: reason,
      reference: {
        type: 'damage',
      },
      notes,
      createdBy: userId,
    });

    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'stock_write_off',
      actionBn: 'ক্ষতি লেখা',
      description: `Wrote off ${qty} of ${product.name} (${reason}) — cost ৳${totalCost}. Stock: ${previousStock} → ${newStock}${branchId ? ` (Branch: ${branchId})` : ''}`,
      descriptionBn: `${product.name} এর ${qty} ক্ষতি লেখা হয়েছে (${reason}) — মূল্য ৳${totalCost}। স্টক: ${previousStock} → ${newStock}${branchId ? ` (শাখা: ${branchId})` : ''}`,
      entity: {
        type: 'product',
        id: product._id,
        name: product.name,
      },
      changes: {
        before: { stock: previousStock },
        after: { stock: newStock, writeOffReason: reason, totalCost },
      },
    });

    /**
     * Retire the shop's cached report generation IMMEDIATELY (`0`, not the
     * default 30s debounce).
     *
     * A write-off moves `netProfit`, and unlike a sale it is a deliberate,
     * one-off act the owner performs and then goes to look at. Serving them the
     * P&L they had before, for up to five minutes, reads as the feature not
     * working — and the natural response is to do it again, which writes the
     * loss off twice. The debounce is right for a stream of sales and wrong
     * here, for the same reason `bulkUpdateOnlineSettings` passes `0`.
     */
    await cacheService.bumpShopCacheVersion(shopId, 0).catch(() => {});

    return this._transformProduct(product);
  }

  // ══ Batch / expiry management ═══════════════════════════════════════════════
  //
  // Batches are edited HERE and not through the product form. `updateProduct`
  // takes a whole-document body from a form that has never displayed a batch,
  // so letting it write `batches` means every save is an unconditional
  // overwrite — which is precisely how the array used to be destroyed on an
  // unrelated price edit (see `updateProduct`'s `batches: Joi.forbidden()`).
  //
  // ── THE INVARIANT THESE METHODS EXIST TO KEEP ────────────────────────────────
  //
  //     For each sellable thing (a variant, or the product when it has none):
  //     sum(batch quantities) <= that thing's stock.
  //
  // Batches DESCRIBE stock; they do not create it. Stock arrives through a
  // purchase or a manual adjustment, and a batch says "of the 30 packets I
  // have, these 12 expire in June". So adding a batch never moves `stock`, and
  // a batch that would claim more than is on the shelf is refused rather than
  // silently accepted — an over-claimed batch makes FEFO deduct stock that was
  // never there and the alerts screen warn about goods the shop does not hold.
  //
  // The sum may legitimately be LESS than stock: a shop that turns expiry
  // tracking on mid-life has stock it has not dated yet, and the shopkeeper
  // fills those in as the old boxes sell through. That gap is reported as
  // `untracked` rather than treated as an error.

  /**
   * Stock of one sellable thing. `variantId` null = the product itself.
   * Throws if the variant does not exist, so a mistyped id cannot silently
   * validate a batch against the wrong pool.
   */
  _stockForOwner(product, variantId) {
    if (!variantId) return product.stock || 0;

    const variant = (product.variants && typeof product.variants.id === 'function')
      ? product.variants.id(variantId)
      : product.variants?.find(v => String(v._id || v.id) === String(variantId));

    if (!variant) {
      throw new AppError('Variant not found', 'ভেরিয়েন্ট পাওয়া যায়নি', 404);
    }
    return variant.stock || 0;
  }

  /**
   * How much of one owner's stock is already claimed by batches.
   * `excludeBatchId` drops the row being edited, so raising a batch from 10 to
   * 12 is checked against the other batches rather than against itself.
   */
  _batchedQtyFor(product, variantId, excludeBatchId = null) {
    return (product.batches || [])
      .filter(b => Product.sameBatchOwner(b.variantId, variantId))
      .filter(b => !excludeBatchId || String(b._id) !== String(excludeBatchId))
      .reduce((sum, b) => sum + (Number(b.quantity) || 0), 0);
  }

  /**
   * Refuse a batch that claims more stock than the owner actually holds.
   * The Bengali message names the shortfall, because "৩০টির মধ্যে ২৫টি ইতিমধ্যে
   * ব্যাচে আছে, তাই সর্বোচ্চ ৫টি দিতে পারবেন" is actionable and "invalid
   * quantity" is not.
   */
  _assertBatchFits(product, variantId, quantity, excludeBatchId = null) {
    const stock = this._stockForOwner(product, variantId);
    const claimed = this._batchedQtyFor(product, variantId, excludeBatchId);
    const room = stock - claimed;

    if (quantity > room) {
      throw new AppError(
        `Batch quantity ${quantity} exceeds untracked stock ${room} (stock ${stock}, already batched ${claimed})`,
        `স্টকে আছে ${stock}টি, তার মধ্যে ${claimed}টি ইতিমধ্যে ব্যাচে আছে — এই ব্যাচে সর্বোচ্চ ${room}টি দিতে পারবেন`,
        400
      );
    }
  }

  /** The product, scoped to shop + branch, or a 404. */
  async _loadProductForBatches(shopId, productId, req) {
    const product = await Product.findOne(
      branchFilter(req, { _id: productId, shop: shopId, isDeleted: { $ne: true } })
    );
    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }
    return product;
  }

  async _logBatchAudit(shopId, userId, product, action, actionBn, description, changes) {
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action,
      actionBn,
      description,
      descriptionBn: description,
      entity: { type: 'product', id: product._id, name: product.name },
      changes,
    });
  }

  /**
   * Every batch on a product, grouped by the thing it belongs to, with the
   * untracked remainder spelled out per owner.
   *
   * Returns owners with NO batches too. A variant the shopkeeper has not dated
   * yet is the row they most need to see — omitting it would make the panel
   * look complete while half the shelf is unaccounted for.
   */
  async getProductBatches(shopId, productId, req = null) {
    const product = await this._loadProductForBatches(shopId, productId, req);

    const hasVariants = Boolean(product.hasVariants && product.variants?.length);

    /**
     * ── THE ORPHAN ROW ───────────────────────────────────────────────────────
     *
     * A product that gains variants LATER keeps whatever batches it was given
     * while it was a plain product, and those batches belong to `variantId:
     * null` — the product itself, a thing that is no longer sellable.
     *
     * This list used to be built from `product.variants` alone, so the moment
     * the conversion was saved those batches stopped being rendered anywhere.
     * They were not deleted; they were unreachable. Nothing could edit them,
     * nothing could delete them, and FEFO at the till skipped them forever
     * because a sale of ১০০ মিলি never matches an owner of null. Meanwhile the
     * expiry screen went on warning about them every day, with no variant name
     * beside the date and no way to act on it. A real shop hit this with 137
     * dated units against variants that summed to 40.
     *
     * So the orphans get a row of their own, named as what they are and marked
     * `unassigned` for the client to treat differently. Its `stock` is the
     * quantity actually sitting in those batches rather than any variant's
     * count — there is no pool behind them any more, which is the problem the
     * row exists to show.
     */
    const orphans = hasVariants ? product.batchesFor(null) : [];

    const owners = hasVariants
      ? product.variants.map(v => ({
          variantId: String(v._id),
          label: v.sku,
          attributes: v.attributes,
          isActive: v.isActive,
          stock: v.stock || 0,
        }))
      : [{ variantId: null, label: product.name, attributes: null, isActive: true, stock: product.stock || 0 }];

    if (orphans.length) {
      owners.unshift({
        variantId: null,
        label: product.name,
        attributes: null,
        isActive: true,
        unassigned: true,
        stock: orphans.reduce((sum, b) => sum + (Number(b.quantity) || 0), 0),
      });
    }

    return {
      productId: String(product._id),
      name: product.name,
      code: product.code,
      unit: product.unit,
      trackBatches: Boolean(product.trackBatches),
      hasVariants: Boolean(product.hasVariants),
      owners: owners.map(o => {
        const batches = product.batchesFor(o.variantId).map(b => ({
          _id: String(b._id),
          batchNumber: b.batchNumber,
          expiryDate: b.expiryDate,
          quantity: b.quantity,
          costPrice: b.costPrice,
          receivedDate: b.receivedDate,
        }));
        const tracked = batches.reduce((s, b) => s + (b.quantity || 0), 0);
        // An unassigned row has no untracked remainder to offer — its stock IS
        // its batches, and the only sensible action on it is to move them onto
        // a variant. Reporting a remainder there would invite the shopkeeper to
        // add a second undated batch to a pool that does not exist.
        if (o.unassigned) return { ...o, batches, tracked, untracked: 0 };
        return { ...o, batches, tracked, untracked: Math.max(0, o.stock - tracked) };
      }),
    };
  }

  /**
   * Add a batch to a product, or to one of its variants.
   *
   * Turning `trackBatches` on is implicit: a shopkeeper who has just typed an
   * expiry date has answered the question the toggle asks, and making them go
   * back to the product form to flip a switch before the date will save is a
   * step that exists only because of how the data is stored.
   */
  async addProductBatch(shopId, userId, productId, batchData, req = null) {
    if (req) requireBranch(req);
    const product = await this._loadProductForBatches(shopId, productId, req);

    const variantId = batchData.variantId || null;
    if (variantId && !product.hasVariants) {
      throw new AppError(
        'Product has no variants',
        'এই পণ্যের কোনো ভ্যারিয়েন্ট নেই',
        400
      );
    }
    // Validates the variant exists (throws 404) as well as the arithmetic.
    const quantity = parseQuantity(batchData.quantity, quantityUnit(req, product), {
      label: product.name,
    });
    this._assertBatchFits(product, variantId, quantity);

    product.batches.push({
      variantId,
      batchNumber: String(batchData.batchNumber).trim(),
      expiryDate: batchData.expiryDate ? new Date(batchData.expiryDate) : null,
      quantity,
      costPrice: batchData.costPrice === '' || batchData.costPrice == null
        ? undefined
        : Number(batchData.costPrice),
    });
    if (!product.trackBatches) product.trackBatches = true;
    await product.save();

    await this._logBatchAudit(
      shopId, userId, product, 'product_update', 'ব্যাচ যোগ',
      `Added batch ${batchData.batchNumber} to ${product.name}`,
      { after: { batchNumber: batchData.batchNumber, expiryDate: batchData.expiryDate, quantity, variantId } }
    );

    return this.getProductBatches(shopId, productId, req);
  }

  /**
   * Move some or all of a batch onto a variant.
   *
   * ── WHY THIS IS ITS OWN OPERATION ────────────────────────────────────────
   *
   * This is the way out of the orphan row that `getProductBatches` documents:
   * a product that grew variants has dated stock belonging to nothing, and the
   * shopkeeper needs to say which variant it was.
   *
   * It is not a field on `updateProductBatch` because it is not an edit of one
   * row. The 137 units dated ৫ মে ২০২৮ were one batch when the product was one
   * thing; against two variants they are usually two batches, and any endpoint
   * that could only move the whole row would force the shopkeeper to delete
   * their real expiry date and retype it twice. So a partial move SPLITS: the
   * moved quantity becomes a batch on the variant, the remainder stays where it
   * was, and the date and batch number travel to both halves.
   *
   * And it is one operation rather than the client running a delete and two
   * adds, because the half-applied middle state of that sequence is stock that
   * has lost its expiry date. One `save()` either moves it or does not.
   */
  async assignBatchToVariant(shopId, userId, productId, batchId, payload, req = null) {
    if (req) requireBranch(req);
    const product = await this._loadProductForBatches(shopId, productId, req);

    const batch = product.batches?.id(batchId);
    if (!batch) {
      throw new AppError('Batch not found', 'ব্যাচটি পাওয়া যায়নি', 404);
    }
    if (!product.hasVariants || !product.variants?.length) {
      throw new AppError(
        'Product has no variants',
        'এই পণ্যের কোনো ভ্যারিয়েন্ট নেই',
        400
      );
    }

    const variantId = payload.variantId;
    // Throws 404 if the variant does not exist, before anything is moved.
    const variantStock = this._stockForOwner(product, variantId);

    const unit = quantityUnit(req, product);
    // Absent quantity means the whole row — the common case, and the one a
    // shopkeeper means when they tap a variant against a single batch.
    const moving = payload.quantity === undefined || payload.quantity === null || payload.quantity === ''
      ? Number(batch.quantity) || 0
      : parseQuantity(payload.quantity, unit, { label: product.name });

    if (moving <= 0) {
      throw new AppError('Nothing to move', 'কত পরিমাণ সরাবেন সেটা দিন', 400);
    }
    if (moving > (Number(batch.quantity) || 0)) {
      throw new AppError(
        `Batch holds only ${batch.quantity}`,
        `এই ব্যাচে আছে ${batch.quantity}টি — তার বেশি সরানো যাবে না`,
        400
      );
    }

    // The destination has to have room for it, exactly as a new batch would.
    // Without this a shopkeeper could pile 137 dated units onto a variant
    // holding 17, and every screen downstream would then be reporting stock
    // the shop does not have.
    const claimed = this._batchedQtyFor(product, variantId);
    const room = variantStock - claimed;
    if (moving > room) {
      throw new AppError(
        `Assign ${moving} exceeds untracked stock ${room}`,
        `এই ভ্যারিয়েন্টে আছে ${variantStock}টি, তার মধ্যে ${claimed}টি ইতিমধ্যে ব্যাচে আছে — সর্বোচ্চ ${room}টি এখানে সরাতে পারবেন`,
        400
      );
    }

    const remainder = (Number(batch.quantity) || 0) - moving;
    const carried = {
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      costPrice: batch.costPrice,
      receivedDate: batch.receivedDate,
      purchaseRef: batch.purchaseRef,
    };

    if (remainder > 0) {
      // A split. The original row keeps the remainder and a new row carries the
      // moved units, so the date survives on both sides.
      batch.quantity = remainder;
      product.batches.push({ ...carried, variantId, quantity: moving });
    } else {
      // The whole row moves. Reassigning in place keeps the batch's own `_id`,
      // so anything already pointing at it still resolves.
      batch.variantId = variantId;
    }

    product.markModified('batches');
    await product.save();

    await this._logBatchAudit(
      shopId, userId, product, 'product_update', 'ব্যাচ ভ্যারিয়েন্টে সরানো',
      `Assigned ${moving} of batch ${carried.batchNumber} to variant ${variantId} on ${product.name}`,
      { after: { batchNumber: carried.batchNumber, expiryDate: carried.expiryDate, quantity: moving, variantId } }
    );

    return this.getProductBatches(shopId, productId, req);
  }

  /**
   * Correct a batch. The whole reason this endpoint exists: an expiry date
   * typed wrong at creation was previously uncorrectable, because the product
   * form does not render batches and nothing else could write them.
   *
   * `variantId` is deliberately NOT editable here. Moving a batch between
   * owners re-checks two stock pools and can split a row, which is a different
   * operation with a different shape — see `assignBatchToVariant` above.
   */
  async updateProductBatch(shopId, userId, productId, batchId, updates, req = null) {
    if (req) requireBranch(req);
    const product = await this._loadProductForBatches(shopId, productId, req);

    const batch = product.batches?.id(batchId);
    if (!batch) {
      throw new AppError('Batch not found', 'ব্যাচটি পাওয়া যায়নি', 404);
    }

    const before = {
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      quantity: batch.quantity,
    };

    if (updates.quantity !== undefined) {
      const quantity = parseQuantity(updates.quantity, quantityUnit(req, product), {
        label: product.name,
        allowZero: true,
      });
      this._assertBatchFits(product, batch.variantId || null, quantity, batchId);
      batch.quantity = quantity;
    }
    if (updates.batchNumber !== undefined) batch.batchNumber = String(updates.batchNumber).trim();
    if ('expiryDate' in updates) {
      batch.expiryDate = updates.expiryDate ? new Date(updates.expiryDate) : null;
    }
    if ('costPrice' in updates) {
      batch.costPrice = updates.costPrice === '' || updates.costPrice == null
        ? undefined
        : Number(updates.costPrice);
    }

    await product.save();

    await this._logBatchAudit(
      shopId, userId, product, 'product_update', 'ব্যাচ সংশোধন',
      `Updated batch ${batch.batchNumber} on ${product.name}`,
      { before, after: { batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, quantity: batch.quantity } }
    );

    return this.getProductBatches(shopId, productId, req);
  }

  /**
   * Remove a batch. Stock is NOT reduced — the goods are still on the shelf,
   * they are simply no longer dated. Deducting here would let a shopkeeper
   * destroy inventory by tidying up a mistyped batch row.
   */
  async deleteProductBatch(shopId, userId, productId, batchId, req = null) {
    if (req) requireBranch(req);
    const product = await this._loadProductForBatches(shopId, productId, req);

    const batch = product.batches?.id(batchId);
    if (!batch) {
      throw new AppError('Batch not found', 'ব্যাচটি পাওয়া যায়নি', 404);
    }

    const removed = {
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      quantity: batch.quantity,
    };
    batch.deleteOne();
    await product.save();

    await this._logBatchAudit(
      shopId, userId, product, 'product_update', 'ব্যাচ মুছে ফেলা',
      `Removed batch ${removed.batchNumber} from ${product.name}`,
      { before: removed, after: null }
    );

    return this.getProductBatches(shopId, productId, req);
  }

  /**
   * Batches expiring within `days`, soonest first — ONE ROW PER BATCH.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * WHY THIS IS A SERVER QUERY NOW
   * ───────────────────────────────────────────────────────────────────────────
   *
   * The expiry-alerts screen used to call `GET /products?limit=200` and do the
   * whole job in the browser: filter to `trackBatches`, walk every batch, work
   * out the days remaining, sort. Three things were wrong with that, in
   * increasing order of severity:
   *
   *   - it shipped 200 full product documents (variants, images, batch history)
   *     to render at most a handful of rows;
   *   - `trackBatches=true` was passed as a query parameter that `getProducts`
   *     has never read, so it did nothing;
   *   - and the 200 were the 200 most RECENTLY CREATED products. A shop with
   *     201 products could not see the expiry of the oldest one. Silently: the
   *     screen said "সব ঠিক আছে!" with expired stock on the shelf.
   *
   * A screen a shopkeeper is meant to trust cannot be wrong in the quiet
   * direction. So the filtering happens where the data is, against the
   * {shop, trackBatches, batches.expiryDate} index, and pagination is real.
   *
   * ── One row per BATCH, not per product ──────────────────────────────────────
   *
   * Two variants of the same milk powder expire on different dates and are two
   * separate things to act on — you pull the ৫০০ গ্রাম packets off the shelf and
   * leave the ১ কেজি ones. Grouping them under one product row would force the
   * screen to re-flatten what the database just grouped, which is the shape
   * that made the old client-side version awkward.
   */
  async getExpiringBatches(shopId, options = {}, req = null) {
    const days = Number.isFinite(Number(options.days)) ? Number(options.days) : 30;
    const page = Math.max(1, parseInt(options.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(options.limit) || 50));
    const includeExpired = options.includeExpired !== false && options.includeExpired !== 'false';

    const now = new Date();
    const threshold = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    // I-3: `$match` does not cast. `shop` must be a real ObjectId here or this
    // matches nothing at all — silently, which on this screen reads as "no
    // product is expiring".
    const match = branchMatch(req, {
      shop: new mongoose.Types.ObjectId(shopId),
      isDeleted: { $ne: true },
      trackBatches: true,
    });

    const batchMatch = {
      'batches.quantity': { $gt: 0 },
      // An undated batch is not "expiring" — it is unrecorded, and listing it
      // here would bury the dated rows this screen exists for.
      'batches.expiryDate': includeExpired
        ? { $ne: null, $lte: threshold }
        : { $ne: null, $gte: now, $lte: threshold },
    };

    // The variant a batch belongs to, resolved inside the pipeline so the
    // screen can say "৫০০ গ্রাম" rather than an ObjectId. `$filter` over the
    // product's own variants — no lookup, they are in the same document.
    const variantExpr = {
      $first: {
        $filter: {
          input: { $ifNull: ['$variants', []] },
          as: 'v',
          cond: { $eq: ['$$v._id', '$batches.variantId'] },
        },
      },
    };

    const [result] = await Product.aggregate([
      { $match: match },
      { $unwind: '$batches' },
      { $match: batchMatch },
      {
        $facet: {
          rows: [
            { $sort: { 'batches.expiryDate': 1, _id: 1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                _id: 0,
                productId: '$_id',
                name: 1,
                code: 1,
                unit: 1,
                hasVariants: 1,
                batchId: '$batches._id',
                batchNumber: '$batches.batchNumber',
                expiryDate: '$batches.expiryDate',
                quantity: '$batches.quantity',
                costPrice: '$batches.costPrice',
                variantId: '$batches.variantId',
                variantSku: { $ifNull: [{ $let: { vars: { v: variantExpr }, in: '$$v.sku' } }, null] },
                variantAttributes: { $ifNull: [{ $let: { vars: { v: variantExpr }, in: '$$v.attributes' } }, null] },
              },
            },
          ],
          summary: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                expired: { $sum: { $cond: [{ $lt: ['$batches.expiryDate', now] }, 1, 0] } },
                critical: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ['$batches.expiryDate', now] },
                          { $lte: ['$batches.expiryDate', new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                totalQuantity: { $sum: '$batches.quantity' },
              },
            },
          ],
        },
      },
    ]);

    const summary = result?.summary?.[0] || { total: 0, expired: 0, critical: 0, totalQuantity: 0 };
    const rows = (result?.rows || []).map(r => {
      const expiry = new Date(r.expiryDate);
      // Computed here rather than in the browser so every consumer — the
      // screen, the daily digest, a future SMS alert — agrees on what "৩ দিন
      // বাকি" means. `Math.ceil` so anything still in the future reads as at
      // least 1 day rather than rounding down to "0 days" while it is saleable.
      const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
      return {
        ...r,
        productId: String(r.productId),
        batchId: String(r.batchId),
        variantId: r.variantId ? String(r.variantId) : null,
        daysLeft,
        isExpired: expiry < now,
        urgency: expiry < now ? 'expired' : daysLeft <= 7 ? 'critical' : 'warning',
      };
    });

    return {
      data: rows,
      summary: {
        total: summary.total || 0,
        expired: summary.expired || 0,
        critical: summary.critical || 0,
        totalQuantity: summary.totalQuantity || 0,
      },
      pagination: {
        page,
        limit,
        total: summary.total || 0,
        pages: Math.ceil((summary.total || 0) / limit),
      },
    };
  }

  // Get low stock products
  //
  // `$expr` compares two fields of the same document, which no index can serve,
  // so this is a collection scan of the shop's catalogue — measured at 189ms
  // against 5k products (PERFORMANCE_BASELINE.md §N-1). Cached for 60s, the
  // same TTL and for the same reason as report.service._lowStockCount; a
  // reorder alert tolerates a minute of staleness comfortably.
  //
  // Keyed by branch AND limit: both change the result, and a key that ignored
  // either would serve one caller's rows to another.
  async getLowStockProducts(shopId, limit = 10, req = null) {
    const branchId = req?.branchId || null;
    const cacheKey = `${KEYS.LOW_STOCK(shopId)}:list:${branchId || 'all'}:${limit}`;

    // `!= null` not truthiness — an empty array is a valid, cacheable answer,
    // and it is the answer a well-stocked shop gets every time.
    const cached = await cacheService.get(cacheKey);
    if (cached != null) return cached;

    const products = await Product.find(branchFilter(req, {
      shop: shopId,
      isActive: true,
      isDeleted: { $ne: true },
      $expr: { $lt: ['$stock', '$minStock'] },
    }))
      .sort({ stock: 1 })
      .limit(limit)
      .lean();

    await cacheService.set(cacheKey, products, getTTL.lowStock);
    return products;
  }

  // Get stock transactions
  async getStockTransactions(shopId, productId, options = {}, req = null) {
    const { page = 1, limit = 20 } = options;

    const query = req ? branchFilter(req, { shop: shopId }) : { shop: shopId };
    if (productId) {
      query.product = productId;
    }

    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      StockTransaction.find(query)
        .populate('product', 'name code')
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      StockTransaction.countDocuments(query),
    ]);

    return {
      data: transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Bulk update products
  async bulkUpdateStock(shopId, userId, updates, req = null) {
    const results = [];

    for (const update of updates) {
      try {
        const result = await this.updateStock(shopId, userId, update.productId, {
          quantity: update.quantity,
          type: update.type || 'add',
          variantId: update.variantId,
          notes: update.notes,
        }, req);
        results.push({ productId: update.productId, success: true });
      } catch (error) {
        results.push({ productId: update.productId, success: false, error: error.message });
      }
    }

    return results;
  }

  /**
   * Decide what a payload may say about selling this product online.
   *
   * The four online fields move together — being listed online, the price
   * charged there, the description shown there and whether it is featured — so
   * they are gated together. Splitting them would let a shop without the
   * capability still store an online price, which is a number that means nothing
   * and that somebody would eventually render.
   *
   * ── CREATE vs UPDATE ────────────────────────────────────────────────────────
   * The difference is deliberate and is the same one `brand` makes:
   *
   *   create  →  FORCE `isAvailableOnline: false` and drop the rest. There is
   *              nothing stored to preserve, and the client must not be able to
   *              opt a new product into a surface the shop was not given.
   *   update  →  DELETE the keys. Absent means "leave it alone", so a shop that
   *              had the capability, listed products online, and then had it
   *              switched off keeps every stored setting — and gets them back
   *              intact if an admin switches it on again. Clearing them here
   *              would make the toggle one-way.
   *
   * With the capability ON this does nothing at all: the form is the authority,
   * and an unticked box is a real "do not sell this online".
   *
   * Mutates `data` in place.
   *
   * @param {Object} data  create payload (`rest`) or update payload
   * @param {Object} req   for the feature flag
   * @param {Object} [options] `{ create: true }` to force rather than drop
   */
  _applyOnlineFields(data, req, { create = false } = {}) {
    if (hasFeature(req, 'onlineSelling')) return;

    delete data.onlinePrice;
    delete data.onlineDescription;
    delete data.isFeaturedOnline;

    if (create) {
      data.isAvailableOnline = false;
    } else {
      delete data.isAvailableOnline;
    }
  }

  /**
   * Resolve and authorise every image reference in a product payload.
   *
   * Two jobs, and the first is a security boundary:
   *
   *   1. OWNERSHIP. `mediaId` arrives from the client. Without checking it
   *      against `{shop}`, one shop could reference another's image — and would
   *      then hold a reference the owning shop's reclamation job cannot see, so
   *      that shop's cleanup would silently blank this one's catalogue.
   *      `mediaService.resolveOwned` 400s on anything foreign or unknown.
   *
   *   2. AUTHORITY OVER URLs. When a row carries a `mediaId`, the URLs are taken
   *      from the `ShopMedia` document and the client's are discarded. A client
   *      that could pair our media id with an arbitrary URL could point a
   *      product at anything at all while the row still looked like ours.
   *
   * Rows WITHOUT a `mediaId` pass through with their URL intact — that is the
   * legacy ImgBB shape, and it is how the old endpoint's rows survive a round
   * trip through the edit form. See the header of services/media.service.js.
   *
   * ── WHEN THE CAPABILITY IS OFF ──────────────────────────────────────────────
   * The payload's image keys are dropped, not applied — same treatment as
   * `brand` and `wholesalePrice` above, and for the same reason: a flag an admin
   * can turn back on must not destroy data while it is off. `catalogImages`
   * simply never reaches `Object.assign`, so the stored array survives. Variants
   * are the harder half, because that array is REPLACED wholesale on update, so
   * the stored values are carried forward explicitly by the caller.
   *
   * Mutates `data` in place and returns nothing.
   *
   * @param {ObjectId} shopId
   * @param {Object} data  create/update payload; `catalogImages` and `variants`
   * @param {Object} req   for the feature flag
   */
  async _applyImageRefs(shopId, data, req) {
    if (!hasFeature(req, 'productImages')) {
      delete data.catalogImages;
      if (Array.isArray(data.variants)) {
        data.variants.forEach((v) => { if (v) delete v.imageMediaId; });
      }
      return;
    }

    const rows = Array.isArray(data.catalogImages) ? data.catalogImages : [];
    const variants = Array.isArray(data.variants) ? data.variants : [];

    // One round trip for every id in the payload, catalogue and variants alike.
    const owned = await mediaService.resolveOwned(shopId, [
      ...rows.map((r) => r?.mediaId),
      ...variants.map((v) => v?.imageMediaId),
    ]);

    if ('catalogImages' in data) {
      const resolved = rows.map((row) => {
        const media = row?.mediaId ? owned.get(String(row.mediaId)) : null;
        if (!media) {
          // An external URL — ImgBB or hand-entered. Not our bytes, so no
          // mediaId is invented for it.
          return {
            mediaId: null,
            url: row?.url,
            thumbnail: row?.thumbnail,
            isPrimary: row?.isPrimary === true,
          };
        }
        return {
          mediaId: media._id,
          // The medium rendition, not the original: this URL is what the product
          // detail screen renders, and the full-size image is worth fetching
          // only on an explicit zoom.
          url: media.mediumUrl || media.url,
          thumbnail: media.thumbUrl || media.url,
          isPrimary: row?.isPrimary === true,
        };
      });

      // The plan's per-product ceiling, counted over OUR images only. Legacy
      // ImgBB rows are exempt: a product that already carries seven of them must
      // stay editable, and refusing the save would make an old photo the reason
      // a price cannot be corrected.
      const ours = resolved.filter((r) => r.mediaId);
      if (ours.length > MAX_CATALOG_MEDIA) {
        throw new AppError(
          `A product may have at most ${MAX_CATALOG_MEDIA} photos`,
          `একটি পণ্যে সর্বোচ্চ ${MAX_CATALOG_MEDIA}টি ছবি দেওয়া যাবে`,
          400
        );
      }

      // Exactly one primary, and only if there is anything to be primary of.
      // The grid reads `catalogImages[0]` when none is flagged, so a row set
      // with two primaries renders differently in two places on the same screen.
      const primaryIndex = resolved.findIndex((r) => r.isPrimary);
      resolved.forEach((r, i) => {
        r.isPrimary = i === (primaryIndex >= 0 ? primaryIndex : 0);
      });

      data.catalogImages = resolved;
    }

    for (const variant of variants) {
      if (!variant?.imageMediaId) continue;
      const media = owned.get(String(variant.imageMediaId));
      if (!media) continue;
      variant.imageMediaId = media._id;
      variant.image = media.mediumUrl || media.url;
    }
  }

  /**
   * Helper to format variant arrays from client flat structure to DB nested attributes structure.
   *
   * @param {Array} variants
   * @param {boolean} wholesaleEnabled  the shop's `features.wholesale` flag.
   *   Defaults to FALSE so a caller that forgets it cannot accidentally let a
   *   wholesale rate through — the same fail-closed rule `hasFeature` follows.
   */
  _formatVariants(variants, wholesaleEnabled = false) {
    if (!variants || !Array.isArray(variants)) return [];

    return variants.map(v => {
      const attributes = {};
      const knownKeys = ['size', 'color', 'weight', 'material', 'style'];
      
      if (v.attributes) {
        Object.assign(attributes, v.attributes);
      }

      knownKeys.forEach(key => {
        if (v[key] !== undefined && v[key] !== null) {
          attributes[key] = v[key];
        }
      });

      // Anything not a recognised column becomes a custom ATTRIBUTE. So every
      // real field added to a variant must be listed here as well as in the
      // return below — miss it and `wholesalePrice: 8` is stored as a made-up
      // attribute named "wholesalePrice" that renders on the invoice next to
      // size and colour, while the price column stays empty.
      const customKeys = Object.keys(v).filter(k =>
        // `openingBatch` is consumed by `_buildOpeningBatches` and stored on the
        // product's `batches` array, NOT on the variant. Without it in this
        // list it would be swept into `attributes.custom` and rendered on the
        // invoice as an attribute called "openingBatch" beside size and colour.
        !['id', '_id', 'sku', 'barcode', 'buyingPrice', 'sellingPrice', 'wholesalePrice', 'stock', 'image', 'imageMediaId', 'isActive', 'attributes', 'openingBatch'].includes(k) &&
        !knownKeys.includes(k)
      );

      if (customKeys.length > 0) {
        if (!attributes.custom) attributes.custom = {};
        customKeys.forEach(k => {
          attributes.custom[k] = v[k];
        });
      }

      const idVal = v._id || v.id;
      const isValidId = idVal && mongoose.Types.ObjectId.isValid(idVal);
      const variantId = isValidId ? new mongoose.Types.ObjectId(idVal) : new mongoose.Types.ObjectId();

      return {
        _id: variantId,
        sku: v.sku,
        barcode: v.barcode,
        buyingPrice: v.buyingPrice,
        sellingPrice: v.sellingPrice,
        // `undefined` when cleared or when the shop has no wholesale feature,
        // which leaves the path absent rather than storing a ৳0 rate that would
        // bill the next পাইকারি customer nothing. Named per variant so a 403
        // says WHICH row was wrong on a form with a dozen of them.
        wholesalePrice: normalizeWholesalePrice(v.wholesalePrice, wholesaleEnabled, {
          label: v.sku ? `variant ${v.sku}` : 'variant',
        }),
        stock: v.stock || 0,
        image: v.image,
        // Null unless the photo is one of ours in the R2 pool. `image` stays the
        // URL either way — this is only the answer to "are these our bytes?",
        // which is what refCounting and reclamation key off. Resolved and
        // ownership-checked in `_applyImageRefs` before it ever reaches here.
        imageMediaId: v.imageMediaId
          ? new mongoose.Types.ObjectId(v.imageMediaId)
          : null,
        isActive: v.isActive !== false,
        attributes
      };
    });
  }

  /**
   * Helper to transform product variants from DB nested attributes structure to client flat structure.
   */
  _transformProduct(product) {
    if (!product) return null;
    const p = typeof product.toObject === 'function' ? product.toObject() : product;

    if (p.hasVariants && p.variants && Array.isArray(p.variants)) {
      p.variants = p.variants.map(v => {
        const transformed = { ...v };
        if (v.attributes) {
          Object.entries(v.attributes).forEach(([key, val]) => {
            if (key === 'custom' && val && typeof val === 'object') {
              Object.entries(val).forEach(([ckey, cval]) => {
                transformed[ckey] = cval;
              });
            } else {
              transformed[key] = val;
            }
          });
        }
        return transformed;
      });
    }

    return p;
  }

  // Bulk import products from array (e.g. CSV/Excel upload)
  async bulkImportProducts(shopId, userId, productsArray, req = null) {
    const results = {
      total: productsArray.length,
      importedCount: 0,
      skippedCount: 0,
      errors: [],
      importedProducts: [],
    };

    // Pre-fetch categories for this shop or global
    const categories = await Category.find({ $or: [{ shop: shopId }, { shop: null }] });
    const categoryMap = new Map();
    categories.forEach(c => {
      if (c.name) categoryMap.set(c.name.toLowerCase().trim(), c._id);
    });

    // Fetch existing product codes & barcodes for this shop to prevent duplicates
    // Import targets one branch; duplicate-code detection is scoped to it,
    // since the same code in another branch is a different product.
    const importBranchId = requireBranch(req);
    const existingProducts = await Product.find(
      branchFilter(req, { shop: shopId, isDeleted: { $ne: true } }),
      { code: 1, barcode: 1 }
    );
    const existingCodes = new Set();
    existingProducts.forEach(p => {
      if (p.code) existingCodes.add(p.code.toUpperCase().trim());
      if (p.barcode) existingCodes.add(p.barcode.trim());
    });

    for (let i = 0; i < productsArray.length; i++) {
      const item = productsArray[i];
      const rowNumber = i + 1;

      try {
        const name = item.name ? String(item.name).trim() : '';
        if (!name) {
          results.skippedCount++;
          results.errors.push({ row: rowNumber, reason: 'পণ্য নাম (Name) আবশ্যক' });
          continue;
        }

        let code = item.code ? String(item.code).trim().toUpperCase() : '';
        const barcode = item.barcode ? String(item.barcode).trim() : (item.code ? String(item.code).trim() : '');

        if (code && existingCodes.has(code)) {
          results.skippedCount++;
          results.errors.push({ row: rowNumber, code, name, reason: 'কোড ইতিমধ্যে বিদ্যমান' });
          continue;
        }

        if (!code) {
          code = `PRD-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;
        }

        /**
         * Categories named in the CSV, created on demand.
         *
         * The find-or-create itself now lives in `category.service`, which is
         * also what the product form's inline picker calls. This used to be its
         * own copy and the two had already drifted: this one wrote a
         * hand-rolled `slug` that stripped every Bengali character (leaving
         * `''`, then a `cat-<timestamp>` fallback) while the model's own
         * pre-save hook builds one properly, and it never noticed a category
         * that differed only in case, so a sheet listing "Shirt" and "shirt"
         * tried to create both and the second threw E11000 mid-import.
         *
         * `categoryMap` stays as a per-run memo — one round trip per distinct
         * name rather than per row.
         */
        let categoryId = null;
        if (item.categoryName && String(item.categoryName).trim()) {
          const catNameClean = String(item.categoryName).trim();
          const catLower = catNameClean.toLowerCase();
          if (categoryMap.has(catLower)) {
            categoryId = categoryMap.get(catLower);
          } else {
            const { category: resolved } = await categoryService.findOrCreateByName(
              shopId,
              catNameClean
            );
            categoryId = resolved._id;
            categoryMap.set(catLower, resolved._id);
          }
        }

        const buyingPrice = Number(item.buyingPrice ?? item.costPrice ?? 0);
        const sellingPrice = Number(item.sellingPrice ?? 0);
        const stock = Number(item.stock ?? 0);
        const minStock = Number(item.minStock ?? 5);
        const unit = item.unit ? String(item.unit).trim() : 'piece';
        const trackBatches = Boolean(item.trackBatches);

        // Routed through `_buildOpeningBatches` rather than assembled here, so
        // the CSV path and the create form cannot disagree about what an
        // opening batch is. They did: this block required `item.batchNumber`,
        // so a row carrying `expiryDate` and no batch code imported the product
        // and DROPPED the date — no error, no skipped-row entry, and the
        // expiry-alerts screen simply never mentioned it. Same rule, one place:
        // a row needs a number or a date plus stock on the shelf, and a missing
        // number is generated from the product code.
        const batches = trackBatches
          ? this._buildOpeningBatches([], [], [{
              batchNumber: item.batchNumber,
              expiryDate: item.expiryDate,
              quantity: stock,
              costPrice: buyingPrice,
            }], code)
          : [];

        const product = await Product.create({
          shop: shopId,
          branch: importBranchId,
          code,
          barcode,
          name,
          category: categoryId,
          buyingPrice,
          sellingPrice,
          stock,
          minStock,
          unit,
          description: item.description || '',
          trackBatches,
          batches,
          createdBy: userId,
        });


        existingCodes.add(code);
        if (barcode) existingCodes.add(barcode);

        results.importedCount++;
        results.importedProducts.push({ _id: product._id, name: product.name, code: product.code });
      } catch (err) {
        results.skippedCount++;
        results.errors.push({ row: rowNumber, name: item.name, reason: err.message });
      }
    }

    if (results.importedCount > 0) {
      // An import is the single biggest source of new vocabulary: a shop that
      // uploads two thousand products arrives with its whole option list
      // already populated, and it must be visible on the very next product.
      variantCatalogService.invalidate(shopId).catch(() => {});

      await AuditLog.log({
        shop: shopId,
        user: userId,
        action: 'product_bulk_import',
        description: `Bulk imported ${results.importedCount} products (${results.skippedCount} skipped)`,
        entity: { type: 'product', id: null, name: 'Bulk Product Import' },
        req,
      });
    }

    return results;
  }

  /**
   * Put products online, or take them off, in one call.
   *
   * ── WHY THIS EXISTS AS ITS OWN METHOD ───────────────────────────────────────
   *
   * A shop switched on for the storefront has a catalogue that already exists —
   * often over a thousand rows — and every one of them is `isAvailableOnline:
   * false`, because that is the default the field was fixed to after the
   * uiFlags bug (Product.model.js:515). Asking the shopkeeper to open a
   * thousand product forms is asking them not to use the feature.
   *
   * So this is the one screen where bulk is not a convenience, it is the
   * difference between the capability being adopted and abandoned.
   *
   * ── WHAT IT DELIBERATELY WILL NOT DO ────────────────────────────────────────
   *
   * It does not touch price, name, stock, or anything a customer pays. It sets
   * two booleans and nothing else. A bulk endpoint that can rewrite prices is
   * one mis-click from re-pricing a shop's entire catalogue, and no audit entry
   * makes that recoverable.
   *
   * ── PHOTOS ──────────────────────────────────────────────────────────────────
   *
   * A product with no photo is SKIPPED rather than refused, and the count comes
   * back in the summary. Refusing the whole call would make "put my grocery
   * category online" fail because one of eighty items lacks a picture, and the
   * shopkeeper would have no idea which. Silently including them would fill the
   * storefront with grey placeholders, which STOREFRONT_DESIGN_REF.md Ref 1 §1.4
   * names as the fastest way to lose a shop. Skipping and reporting is the only
   * option that leaves them able to act.
   *
   * Turning products OFF has no photo requirement — an unphotographed product
   * that somehow got online must always be removable.
   *
   * @param {string} shopId
   * @param {string} userId
   * @param {Object} req      for branch scope and the feature flag
   * @param {Object} payload  `{ productIds?, categoryId?, isAvailableOnline?, isFeaturedOnline? }`
   */
  async bulkSetOnlineStatus(shopId, userId, req, payload = {}) {
    const { productIds, categoryId, isAvailableOnline, isFeaturedOnline } = payload;

    if (isAvailableOnline === undefined && isFeaturedOnline === undefined) {
      throw new AppError(
        'Nothing to change',
        'কী পরিবর্তন করতে চান তা নির্বাচন করুন',
        400
      );
    }

    // Products are branch-scoped, so the selection is too (I-2). `branchFilter`
    // adds nothing when no branch is active, which is what keeps a
    // single-branch shop's query identical to what it has always been (I-1).
    const filter = branchFilter(req, { shop: shopId, isDeleted: { $ne: true } });

    if (Array.isArray(productIds) && productIds.length) {
      const valid = productIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
      if (!valid.length) {
        throw new AppError('No valid products selected', 'কোনো পণ্য নির্বাচন করা হয়নি', 400);
      }
      // Capped rather than unbounded. A selection larger than this is a
      // "select all in category" in disguise, which has its own branch below
      // and does not have to ship ten thousand ids over a 3G connection.
      if (valid.length > 500) {
        throw new AppError(
          'Select at most 500 products at a time, or filter by category instead',
          'একবারে সর্বোচ্চ ৫০০টি পণ্য নির্বাচন করুন, অথবা ক্যাটাগরি ধরে করুন',
          400
        );
      }
      filter._id = { $in: valid };
    } else if (categoryId && mongoose.Types.ObjectId.isValid(categoryId)) {
      // Subcategory too — a shopkeeper picking "মসলা" means the whole branch of
      // the tree, not the parent row on its own.
      filter.$or = [{ category: categoryId }, { subcategory: categoryId }];
    } else {
      throw new AppError(
        'Select products or a category',
        'পণ্য অথবা ক্যাটাগরি নির্বাচন করুন',
        400
      );
    }

    const update = {};
    if (isAvailableOnline !== undefined) update.isAvailableOnline = isAvailableOnline === true;
    if (isFeaturedOnline !== undefined) update.isFeaturedOnline = isFeaturedOnline === true;

    // Turning a product ON requires a photo. `catalogImages` is the R2 pipeline;
    // `images` is the older ImgBB path and still counts — a photo is a photo,
    // whoever is hosting it.
    let skippedNoPhoto = 0;
    if (update.isAvailableOnline === true) {
      const withoutPhoto = await Product.countDocuments({
        ...filter,
        $and: [
          { $or: [{ catalogImages: { $size: 0 } }, { catalogImages: { $exists: false } }] },
          { $or: [{ images: { $size: 0 } }, { images: { $exists: false } }] },
        ],
      });
      skippedNoPhoto = withoutPhoto;

      // `$nor` rather than mutating `filter.$or`, which the category branch
      // above may already be using — two `$or` keys on one object silently
      // discard the first.
      filter.$nor = [{
        $and: [
          { $or: [{ catalogImages: { $size: 0 } }, { catalogImages: { $exists: false } }] },
          { $or: [{ images: { $size: 0 } }, { images: { $exists: false } }] },
        ],
      }];
    }

    const result = await Product.updateMany(filter, { $set: update });

    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'online_catalog_bulk_update',
      description:
        `Bulk online update: ${result.modifiedCount} products changed ` +
        `(${JSON.stringify(update)})${skippedNoPhoto ? `, ${skippedNoPhoto} skipped for having no photo` : ''}`,
      descriptionBn:
        `${result.modifiedCount}টি পণ্যের অনলাইন সেটিংস পরিবর্তন করা হয়েছে` +
        (skippedNoPhoto ? `, ${skippedNoPhoto}টি পণ্যে ছবি না থাকায় বাদ পড়েছে` : ''),
      entity: { type: 'product', id: null, name: 'bulk' },
      changes: { after: update },
    });

    // The product listing is cached per shop and this changed a field the
    // online listing reads. Retire the generation rather than serve stale rows.
    await cacheService.bumpShopCacheVersion(shopId, 0).catch(() => {});

    return {
      matched: result.matchedCount,
      modified: result.modifiedCount,
      skippedNoPhoto,
    };
  }
}

module.exports = new ProductService();
