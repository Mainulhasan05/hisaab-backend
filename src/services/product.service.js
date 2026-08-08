const Product = require('../models/Product.model');
const Category = require('../models/Category.model');
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
const cacheService = require('./cache.service');

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

    return {
      data: result.data.map((product) => ({
        _id: product._id,
        name: product.name,
        code: product.code,
        barcode: product.barcode,
        hasVariants: product.hasVariants,
        buyingPrice: product.buyingPrice,
        sellingPrice: product.sellingPrice,
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

    const formattedVariants = this._formatVariants(variants);
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
        after: product.toObject(),
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
      const formattedInputVariants = this._formatVariants(variantsWithStock);
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
      changes: {
        before: beforeData,
        after: product.toObject(),
      },
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

  // Get low stock products
  async getLowStockProducts(shopId, limit = 10, req = null) {
    const products = await Product.find(branchFilter(req, {
      shop: shopId,
      isActive: true,
      isDeleted: { $ne: true },
      $expr: { $lt: ['$stock', '$minStock'] },
    }))
      .sort({ stock: 1 })
      .limit(limit)
      .lean();

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
   */
  _formatVariants(variants) {
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

      const customKeys = Object.keys(v).filter(k => 
        !['id', '_id', 'sku', 'barcode', 'buyingPrice', 'sellingPrice', 'stock', 'image', 'isActive', 'attributes'].includes(k) &&
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

        const batches = [];
        if (trackBatches && item.batchNumber && stock > 0) {
          batches.push({
            batchNumber: String(item.batchNumber).trim(),
            expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
            quantity: stock,
            costPrice: buyingPrice,
          });
        }

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
