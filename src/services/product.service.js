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
} = require('../utils/quantity.util');
const { unitsForShop, DEFAULT_UNIT } = require('../config/units');
const { normalizePackaging } = require('../utils/packaging.util');
const { hasFeature } = require('../utils/features.util');
const { normalizeWholesalePrice } = require('../utils/pricing.util');
const cacheService = require('./cache.service');
const { KEYS, getTTL } = require('../config/cacheKeys');
const { auditSnapshot, auditDiff, AUDIT_FIELDS } = require('../utils/auditDiff.util');
const { capBatchesToStock } = require('../utils/batch.util');

// Escape user input before embedding it in a $regex (prevents regex injection/ReDoS)
const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Client-controllable sort fields must be whitelisted — arbitrary fields force
// unindexed in-memory sorts that hard-fail at 32MB on large collections
// `totalSold` is a stored counter incremented on each sale (see Product model),
// so sorting by it costs no extra query — it rides the {shop, isDeleted,
// totalSold} index the same way createdAt does.
const PRODUCT_SORT_FIELDS = new Set(['createdAt', 'name', 'code', 'stock', 'sellingPrice', 'buyingPrice', 'updatedAt', 'totalSold']);

class ProductService {
  // Get all products with filtering, searching, pagination
  async getProducts(shopId, options = {}, req = null) {
    const {
      page,
      limit,
      search,
      category,
      status,
      lowStock,
      sortBy = 'createdAt',
      sortOrder = 'desc',
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

    // Search by name or code. Input is regex-escaped; each field carries a
    // {shop, field} compound index so the $or branches run as shop-bounded
    // index scans instead of full document scans.
    const searchRegex = search ? escapeRegex(search.trim()) : null;
    const searchOr = searchRegex ? [
      { name: { $regex: searchRegex, $options: 'i' } },
      { code: { $regex: searchRegex, $options: 'i' } },
      { 'variants.sku': { $regex: searchRegex, $options: 'i' } },
      { 'variants.barcode': { $regex: searchRegex, $options: 'i' } },
    ] : null;

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

    return this._transformProduct(product);
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

    return this._transformProduct(product);
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

  async createProduct(shopId, userId, productData, req = null) {
    const { code, name, category, variants, packaging, ...rest } = productData;

    this._assertUnitAllowed(req, rest.unit);
    await this._assertBarcodeUnique(shopId, rest.barcode, req);
    // Validated against the product's OWN unit, so `outerUnitsFor` can refuse a
    // pack that cannot physically hold it. Returns undefined when packaging is
    // off, which is what leaves the subdocument absent rather than half-filled.
    rest.packaging = normalizePackaging(
      packaging,
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

    // If stock was provided and this is a non-variant product, update stock through
    // the proper channel so it's tracked in StockTransaction
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

    const originalCode = product.code;

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
      type: type === 'set' ? 'adjustment' : (qty > 0 ? 'purchase' : 'adjustment'),
      quantity: type === 'set' ? quantize(newStock - previousStock, stkUnit) : qty,
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

    const owners = product.hasVariants && product.variants?.length
      ? product.variants.map(v => ({
          variantId: String(v._id),
          label: v.sku,
          attributes: v.attributes,
          isActive: v.isActive,
          stock: v.stock || 0,
        }))
      : [{ variantId: null, label: product.name, attributes: null, isActive: true, stock: product.stock || 0 }];

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
   * Correct a batch. The whole reason this endpoint exists: an expiry date
   * typed wrong at creation was previously uncorrectable, because the product
   * form does not render batches and nothing else could write them.
   *
   * `variantId` is deliberately NOT editable. Moving a batch between variants
   * moves stock claims between two pools and would need both to be re-checked;
   * delete and re-add says the same thing without a half-applied middle state.
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
        !['id', '_id', 'sku', 'barcode', 'buyingPrice', 'sellingPrice', 'wholesalePrice', 'stock', 'image', 'isActive', 'attributes', 'openingBatch'].includes(k) &&
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

        let categoryId = null;
        if (item.categoryName && String(item.categoryName).trim()) {
          const catNameClean = String(item.categoryName).trim();
          const catLower = catNameClean.toLowerCase();
          if (categoryMap.has(catLower)) {
            categoryId = categoryMap.get(catLower);
          } else {
            const newCat = await Category.create({
              shop: shopId,
              name: catNameClean,
              slug: catNameClean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') || `cat-${Date.now()}`,
              createdBy: userId,
            });
            categoryId = newCat._id;
            categoryMap.set(catLower, newCat._id);
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
}

module.exports = new ProductService();
