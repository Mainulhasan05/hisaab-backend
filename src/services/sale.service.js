const Sale = require('../models/Sale.model');
const Product = require('../models/Product.model');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Payment = require('../models/Payment.model');
const User = require('../models/User.model');
const StockTransaction = require('../models/StockTransaction.model');
const Shop = require('../models/Shop.model');
const AuditLog = require('../models/AuditLog.model');
const InvoiceCounter = require('../models/InvoiceCounter.model');
const { AppError } = require('../middleware/error.middleware');
const cacheService = require('./cache.service');
const logger = require('../utils/logger.util');
const { branchFilter, requireBranch, getBranchCode, wrongBranchError } = require('../utils/branchScope.util');
const mongoose = require('mongoose');
const { runInTransaction } = require('../utils/transaction.util');
const {
  // `parseQuantity` is no longer called directly here — `resolveLineQuantity`
  // owns it, so the pack branch and the loose branch can never validate a
  // quantity two different ways.
  quantityUnit,
  storageUnit,
  quantize,
  quantizeMoney,
  buildStockUpdate,
  buildVariantStockUpdate,
} = require('../utils/quantity.util');
const { resolveLineQuantity, unitPriceFor } = require('../utils/packaging.util');
const { priceTierFor, sellingPriceFor, hasWholesalePrice } = require('../utils/pricing.util');

// Bangladesh is UTC+6
const BD_OFFSET_MS = 6 * 60 * 60 * 1000;
function getBangladeshTodayRange() {
  const bdNow = new Date(Date.now() + BD_OFFSET_MS);
  const dateStr = bdNow.toISOString().split('T')[0];
  const [year, month, day] = dateStr.split('-').map(Number);
  const startOfDay = new Date(Date.UTC(year, month - 1, day) - BD_OFFSET_MS);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { startOfDay, endOfDay, dateStr };
}

function netSaleAmountExpr() {
  return {
    $max: [
      { $subtract: ['$total', { $ifNull: ['$returnedAmount', 0] }] },
      0,
    ],
  };
}

class SaleService {
  // Invalidate related caches when sales data changes.
  // Bumps the shop's cache version (O(1), debounced to once per 30s) instead of
  // SCAN-deleting patterns — report readers embed the version in their keys and
  // superseded entries age out via TTL. Admin stats are left to their own short
  // TTL (60s) rather than being deleted on every sale platform-wide.
  async invalidateCache(shopId) {
    await cacheService.bumpShopCacheVersion(shopId);
  }

  // Generate invoice number (with optional branch code)
  //
  // Backed by an atomic per-(shop, branch, day) counter — see
  // models/InvoiceCounter.model.js for why, and for how it seeds itself so a
  // shop switching over mid-day continues its sequence rather than restarting.
  //
  // Two behaviour changes, both deliberate and both fixes:
  //   - the number is handed out atomically, so two concurrent cashiers can no
  //     longer generate the same one;
  //   - the sequence is per BRANCH, matching the prefix. It used to be
  //     shop-wide while the prefix was branch-specific, which coupled the
  //     branches' numbering to each other.
  async generateInvoiceNumber(shopId, branchCode = null, branchId = null) {
    const { startOfDay, endOfDay, dateStr } = getBangladeshTodayRange();
    // Date prefix from Bangladesh local date
    const datePrefix = dateStr.replace(/-/g, '');

    // Only consulted the first time a given (shop, branch) checks out on a
    // given day. Scoped by branch to match the counter's key — the pre-existing
    // sales it is resuming from carry the same branch.
    const countExisting = () => Sale.countDocuments({
      shop: shopId,
      ...(branchId ? { branch: branchId } : {}),
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    });

    const seq = await InvoiceCounter.nextSeq(shopId, branchId, dateStr, countExisting);

    const prefix = branchCode
      ? `INV-${branchCode}-${datePrefix}`
      : `INV-${datePrefix}`;

    return `${prefix}-${String(seq).padStart(4, '0')}`;
  }

  // Build query from filters (shared by getSales and getSalesSummary)
  //
  // Every id predicate is cast up front because this one object feeds BOTH
  // `Sale.find()` (getSales) and `Sale.aggregate([{ $match }])`
  // (getSalesSummary). `find` casts strings to ObjectId for you; `$match` does
  // not — it compares the raw BSON type, so a string id silently matches zero
  // documents. Uncast, the list showed the invoices and the stat cards above
  // them read ৳0. Ids that are not valid ObjectIds are left untouched so
  // Mongoose still raises its own CastError on the find path, exactly as before.
  _buildQuery(shopId, options = {}) {
    const { search, status, customerId, startDate, endDate, paymentMethod, branchId, isOnline, channel, staffId } = options;

    const toObjectId = (val) =>
      (val && mongoose.Types.ObjectId.isValid(val)) ? new mongoose.Types.ObjectId(val) : val;

    const query = { shop: toObjectId(shopId) };

    // Branch scoping
    if (branchId) {
      query.branch = toObjectId(branchId);
    }

    // Staff attribution filter ("sales by this staff member")
    if (staffId) {
      query.createdBy = toObjectId(staffId);
    }

    if (isOnline !== undefined && isOnline !== '') {
      query.isOnline = isOnline === 'true' || isOnline === true;
    }

    if (channel) {
      query.channel = channel;
    }

    if (search) {
      // Escape regex metacharacters — raw user input in $regex is a ReDoS vector
      const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { invoiceNo: { $regex: escaped, $options: 'i' } },
        { customerName: { $regex: escaped, $options: 'i' } },
        { customerPhone: { $regex: escaped, $options: 'i' } },
      ];
    }

    if (status) {
      if (status === 'dues' || status === 'baki' || status === 'due') {
        query.due = { $gt: 0 };
        query.status = { $ne: 'cancelled' };
      } else {
        query.status = status;
      }
    }

    if (customerId) {
      query.customer = toObjectId(customerId);
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    if (paymentMethod) {
      query.paymentMethod = paymentMethod;
    }

    return query;
  }

  // Get all sales with filtering, searching, pagination
  async getSales(shopId, options = {}) {
    const {
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;

    const query = this._buildQuery(shopId, options);

    const skip = (page - 1) * limit;

    // Whitelisted sort fields only — arbitrary client-supplied fields force
    // unindexed in-memory sorts that abort at 32MB on large shops
    let sortField = 'createdAt';
    if (sortBy === 'due' || sortBy === 'dueAmount') sortField = 'due';
    else if (sortBy === 'total' || sortBy === 'totalAmount' || sortBy === 'amount') sortField = 'total';

    const sort = { [sortField]: sortOrder === 'asc' || sortOrder === '1' ? 1 : -1 };


    const [sales, total] = await Promise.all([
      Sale.find(query)
        .populate('customer', 'name phone')
        .populate('createdBy', 'name')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Sale.countDocuments(query),
    ]);

    return {
      data: sales,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Get aggregated summary for filtered sales
  async getSalesSummary(shopId, options = {}) {
    const query = this._buildQuery(shopId, options);
    // Exclude cancelled from summary unless specifically filtering for cancelled
    if (!options.status) {
      query.status = { $ne: 'cancelled' };
    }

    const result = await Sale.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalSales: { $sum: netSaleAmountExpr() },
          totalPaid: { $sum: '$paid' },
          totalDue: { $sum: '$due' },
          totalProfit: { $sum: '$profit' },
          count: { $sum: 1 },
        },
      },
    ]);

    return result[0] || { totalSales: 0, totalPaid: 0, totalDue: 0, totalProfit: 0, count: 0 };
  }

  // Get single sale by ID
  async getSaleById(shopId, saleId, branchId = null, req = null) {
    const query = { _id: saleId, shop: shopId };
    if (branchId) query.branch = branchId;

    const sale = await Sale.findOne(query)
      .populate('customer', 'name phone address totalDue')
      .populate('createdBy', 'name phone')
      .populate('items.product', 'name code unit barcode');

    if (!sale) {
      // A deep link to another branch's sale used to 404 with no explanation.
      // For the owner, say which branch it belongs to so the UI can offer a
      // switch. For staff this lookup is skipped entirely — they must not learn
      // that the record exists at all (FEATURE_AUDIT.md M-19).
      if (branchId && req?.user?.isOwner) {
        const elsewhere = await Sale.findOne({ _id: saleId, shop: shopId })
          .select('branch')
          .populate('branch', 'name code')
          .lean();
        const err = elsewhere?.branch && wrongBranchError(req, elsewhere.branch);
        if (err) throw err;
      }
      throw new AppError('Sale not found', 'বিক্রয় পাওয়া যায়নি', 404);
    }

    return sale;
  }

  // Create new sale
  async createSale(shopId, userId, saleData, req) {
    return await runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};
      const {
      items,
      customerId: rawCustomerId,
      customer: rawCustomer,
      customerName,
      customerPhone,
      discount = 0,
      discountType = 'fixed',
      tax = 0,
      paid: rawPaid = 0,
      paymentMethod: rawPaymentMethod = 'cash',
      payments: rawPayments,
      notes,
      isOnline = false,
      channel = 'pos',
      deliveryCharge = 0,
      advancePaid = 0,
      courierName,
      shippingAddress
    } = saleData;
    const customerId = rawCustomerId || rawCustomer;

    // --- Split Payment Support ---
    // If payments[] array is provided, calculate paid and primary paymentMethod from it
    let paid = rawPaid;
    let paymentMethod = rawPaymentMethod;
    let payments = rawPayments || [];
    if (payments.length > 0) {
      paid = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
      // Primary method = the one with the largest amount
      paymentMethod = payments.reduce((max, p) => (p.amount > max.amount ? p : max), payments[0]).method;
    } else if (paid > 0) {
      // Legacy single-method: auto-create payments array for consistency
      payments = [{ method: paymentMethod, amount: paid }];
    }

    // Helper to safely extract a string ObjectId from item.productId or item.product (string, ObjectId, or object)
    const extractProductId = (item) => {
      if (!item) return null;
      let id = item.productId || item.product;
      if (!id) return null;
      while (typeof id === 'object' && id !== null) {
        if (id._id) id = id._id;
        else if (id.id) id = id.id;
        else break;
      }
      return id ? id.toString() : null;
    };

    // ── Resolve the customer BEFORE anything is priced ────────────────────────
    //
    // This block used to sit AFTER the item loop and after the stock bulkWrite,
    // which was fine while every line was priced from `product.sellingPrice`
    // alone. It is not fine now: `features.wholesale` makes the price a
    // function of WHO is buying, and a customer resolved 300 lines below the
    // loop cannot inform a price computed inside it.
    //
    // Only the LOOKUP moved. Creating a customer from a typed phone stays where
    // it was, further down — a brand-new customer is retail by definition, so
    // it has nothing to tell the pricing, and moving a write above the stock
    // guard would create a customer for a sale that then fails on stock.
    //
    // The lookup is deliberately shop-wide (`shop` + id/phone, no branch
    // predicate): `Customer` has no `branch` field, and adding one would match
    // zero rows in silence. Same trap as H-7.
    let customer = null;
    if (customerId) {
      customer = await Customer.findOne({ _id: customerId, shop: shopId }).session(session || null);
    } else if (customerPhone) {
      customer = await Customer.findOne({ shop: shopId, phone: customerPhone }).session(session || null);
    }

    // Which price list this whole invoice is rung up against. Resolved from the
    // stored customer document, never from anything the client sent — see the
    // note in utils/pricing.util.js. Reads 'retail' for every shop without the
    // feature, which is what keeps I-6 true for them.
    const priceTier = priceTierFor(req, customer);

    // Validate items and calculate totals
    let subtotal = 0;
    const processedItems = [];

    // --- BATCH: Fetch all products in a single query ---
    const productIds = [...new Set(items.map(extractProductId).filter(Boolean))];
    // Branch-scoped: a product document belongs to exactly one branch and
    // carries that branch's own stock, so there is nothing to overlay.
    const branchId = req ? requireBranch(req) : null;
    const products = await Product.find(
      branchFilter(req, { _id: { $in: productIds }, shop: shopId })
    ).session(session || null);
    const productMap = new Map(products.map(p => [p._id.toString(), p]));

    // Prepare bulk operations
    const bulkStockOps = [];
    // FEFO batch rewrites, executed AFTER the stock guard passes — see the long
    // note at the deduction site below.
    const bulkBatchOps = [];
    const stockTransactions = [];
    let expectedStockOps = 0;

    for (const item of items) {
      const cleanProductId = extractProductId(item);
      const product = cleanProductId ? productMap.get(cleanProductId) : null;
      if (!product) {
        const displayId = cleanProductId || (typeof item.productId === 'object' || typeof item.product === 'object'
          ? JSON.stringify(item.productId || item.product)
          : (item.productId || item.product));
        throw new AppError(`Product not found: ${displayId}`, `পণ্য পাওয়া যায়নি: ${item.productName || displayId}`, 404);
      }

      // Deleted products can still arrive via held carts or offline-synced
      // sales — block them so a removed product can never be sold again
      if (product.isDeleted) {
        throw new AppError(`Product has been deleted: ${product.name}`, `পণ্যটি মুছে ফেলা হয়েছে, বিক্রি করা যাবে না: ${product.name}`, 400);
      }

      // Normalise the quantity against the product's own unit BEFORE anything
      // reads it. Mutating `item` is deliberate: `item.quantity` is read in a
      // dozen places below (stock guard, batch FEFO, line total, the stored
      // sale item), and normalising at each of them is how one gets missed.
      //
      // Without the packaging flag this is a pure integer round-trip — the
      // product's unit is one of the legacy 13, all of which are `decimals: 0`
      // except the weight/length ones, and a shop that never enabled the
      // feature has only ever been able to store integers in them anyway. So
      // the value passes through unchanged. See AGENT_WORKFLOW.md I-6.
      //
      // `quantize` is idempotent, so an idempotency-key replay that re-enters
      // this loop with the same payload produces the same numbers.
      // `qtyUnit` gates what the CLIENT may send (flag-dependent).
      // `stkUnit` gates how the STORED number is rounded (data-dependent).
      // They are not interchangeable — see the block comment in quantity.util.js.
      const qtyUnit = quantityUnit(req, product);
      const stkUnit = storageUnit(product);
      // A line may arrive as "100 pieces" or as "5 cartons". `resolveLineQuantity`
      // is the ONE place the second becomes the first — it validates the pack
      // against the flag and the product, multiplies, and hands back a plain
      // base-unit quantity plus the snapshot to store on the line.
      //
      // `item.quantity` is still overwritten in place, because a dozen reads
      // below (the stock guard, FEFO, the line total, the stored item) depend
      // on it and normalising at each of them is how one gets missed.
      const line = resolveLineQuantity(item, product, req, { qtyUnit });
      item.quantity = line.quantity;

      let unitPrice, buyingPrice, variantInfo = {};
      // Did THIS line actually get a wholesale rate? Not the same question as
      // `priceTier === 'wholesale'` — a wholesale invoice falls back to retail
      // on any product that has no wholesale price, and the pack branch below
      // has to know which of the two happened.
      let lineWholesale = false;

      if (item.variantId) {
        const variant = (product.variants && typeof product.variants.id === 'function')
          ? product.variants.id(item.variantId)
          : product.variants?.find(v => (v._id || v.id)?.toString() === item.variantId?.toString());
        if (!variant) {
          throw new AppError('Variant not found', 'ভেরিয়েন্ট পাওয়া যায়নি', 404);
        }

        // Check stock
        if (variant.stock < item.quantity) {
          throw new AppError(
            `Insufficient stock for ${product.name}. Available: ${variant.stock}`,
            `${product.name} এর পর্যাপ্ত স্টক নেই। আছে: ${variant.stock}টি, চাই: ${item.quantity}টি`,
            400
          );
        }

        // Retail unless this invoice is on the wholesale list AND this variant
        // carries a wholesale rate. A variant without one falls back to its own
        // retail price — never to the parent product's. See pricing.util.
        unitPrice = sellingPriceFor(variant, priceTier);
        lineWholesale = priceTier === 'wholesale' && hasWholesalePrice(variant);
        buyingPrice = variant.buyingPrice || product.buyingPrice || 0;
        variantInfo = {
          variantId: variant._id,
          variantSku: variant.sku,
          variantAttributes: variant.attributes,
        };

        const previousStock = variant.stock;
        // Track stock change in memory for validation of subsequent items of the
        // same product. Quantized for the same reason the DB write is: a cart
        // with the same fractional item on several lines would otherwise drift
        // in memory and mis-report `newStock` on the stock transaction.
        variant.stock = quantize(variant.stock - item.quantity, stkUnit);

        {
          // Queue bulkWrite operation for variant stock with atomic $gte guard.
          //
          // The FILTER is unchanged and must stay that way — the `$gte` inside
          // `$elemMatch` is what makes two concurrent cashiers safe, and the
          // `modifiedCount < expectedStockOps` check below is what turns a lost
          // race into a 409 instead of oversold stock.
          //
          // Only the UPDATE varies: integer units keep the positional `$inc`
          // byte for byte; fractional units get a `$map` pipeline that re-rounds
          // in the same atomic operation (a pipeline update has no positional
          // `$`). See utils/quantity.util.js.
          bulkStockOps.push({
            updateOne: {
              filter: { _id: product._id, variants: { $elemMatch: { _id: variant._id, stock: { $gte: item.quantity } } } },
              update: buildVariantStockUpdate(variant._id, -item.quantity, stkUnit),
            },
          });
          expectedStockOps++;
        }

        // Queue stock transaction
        stockTransactions.push({
          shop: shopId,
          branch: branchId,
          product: product._id,
          productName: product.name,
          productCode: product.code,
          variantId: variant._id,
          variantSku: variant.sku,
          variantAttributes: variant.attributes,
          type: 'sale',
          quantity: -item.quantity,
          previousStock,
          newStock: variant.stock,
          unitCost: buyingPrice,
          totalCost: buyingPrice * item.quantity,
          unitPrice,
          totalPrice: 0, // will be set below
          notes: 'Sale item',
          createdBy: userId,
        });
      } else {
        // Check stock
        if (product.stock < item.quantity) {
          throw new AppError(
            `Insufficient stock for ${product.name}. Available: ${product.stock}`,
            `${product.name} এর পর্যাপ্ত স্টক নেই। আছে: ${product.stock}টি, চাই: ${item.quantity}টি`,
            400
          );
        }

        unitPrice = sellingPriceFor(product, priceTier);
        lineWholesale = priceTier === 'wholesale' && hasWholesalePrice(product);
        buyingPrice = product.buyingPrice || 0;

        const previousStock = product.stock;
        // Track stock change in memory for validation of subsequent items of the
        // same product — quantized, see the variant branch above.
        product.stock = quantize(product.stock - item.quantity, stkUnit);

        {
          // Queue bulkWrite operation for product stock with atomic $gte guard.
          // Filter unchanged (see the variant branch above); only the update
          // shape varies by unit precision.
          bulkStockOps.push({
            updateOne: {
              filter: { _id: product._id, stock: { $gte: item.quantity } },
              update: buildStockUpdate(-item.quantity, stkUnit),
            },
          });
          expectedStockOps++;
        }

        // Queue stock transaction
        stockTransactions.push({
          shop: shopId,
          branch: branchId,
          product: product._id,
          productName: product.name,
          productCode: product.code,
          variantId: null,
          variantSku: null,
          variantAttributes: null,
          type: 'sale',
          quantity: -item.quantity,
          previousStock,
          newStock: product.stock,
          unitCost: buyingPrice,
          totalCost: buyingPrice * item.quantity,
          unitPrice,
          totalPrice: 0, // will be set below
          notes: 'Sale item',
          createdBy: userId,
        });

        // ── FEFO batch deduction ───────────────────────────────────────────
        //
        // First-Expiry-First-Out: the batch that goes off soonest leaves the
        // shelf first, so a shop selling medicine or food is never left holding
        // the short-dated stock.
        //
        // ─────────────────────────────────────────────────────────────────────
        // THIS USED TO MUTATE THE DOCUMENT AND THROW THE RESULT AWAY
        // ─────────────────────────────────────────────────────────────────────
        //
        // The arithmetic below has always been here, and it has always run on
        // the in-memory `product` — which is never `.save()`d on this path,
        // because stock goes out through the atomic `bulkWrite` above and not
        // through the document. So batch quantities only ever went UP: purchases
        // pushed new batches, sales silently deducted nothing, and after a few
        // months `sum(batches.quantity)` bore no relation to `stock`.
        //
        // The visible symptom was the expiry-alerts screen warning about stock
        // that had been sold long ago — which trains a shopkeeper to ignore it,
        // which is worse than not having the screen.
        //
        // So the deduction is now queued as a real update (`bulkBatchOps`) and
        // written after the stock guard passes. It is a SEPARATE bulkWrite, not
        // another op in the stock one: `modifiedCount < expectedStockOps` is the
        // oversell guard, and adding unrelated ops to the batch it counts would
        // let a lost stock race hide behind a successful batch write.
        if (product.trackBatches && product.batches?.length > 0) {
          let remaining = item.quantity;
          // Sort batches by expiryDate ascending (FEFO), null expiry last
          const sorted = product.batches
            .filter(b => b.quantity > 0)
            .sort((a, b) => {
              if (!a.expiryDate) return 1;
              if (!b.expiryDate) return -1;
              return new Date(a.expiryDate) - new Date(b.expiryDate);
            });
          for (const batch of sorted) {
            if (remaining <= 0) break;
            const deduct = Math.min(remaining, batch.quantity);
            batch.quantity -= deduct;
            remaining -= deduct;
          }
          // Remove empty batches
          product.batches = product.batches.filter(b => b.quantity > 0);

          // The whole array is rewritten rather than patched per element: the
          // deduction may empty several batches at once, and the in-memory copy
          // is already the exact desired end state. `toObject` strips the
          // Mongoose subdocument wrappers that bulkWrite cannot serialise.
          bulkBatchOps.push({
            updateOne: {
              filter: { _id: product._id },
              update: {
                $set: {
                  batches: product.batches.map(b =>
                    (typeof b.toObject === 'function' ? b.toObject() : b)
                  ),
                },
              },
            },
          });
        }
      }

      // ── Pack pricing ────────────────────────────────────────────────────────
      //
      // A whole carton is not always `20 x the piece price`. Shops routinely
      // give a wholesale rate on full packs, so `packaging.packSellingPrice`
      // wins when it is set; otherwise the pack is simply the base price times
      // the pack size, which is what leaving that field empty means.
      //
      // `unitPrice` then comes back DOWN to a per-base-unit figure by division,
      // deliberately unrounded — see `unitPriceFor`. Rounding it to paisa here
      // and multiplying back would bill ৳৯৯৯.৯৯ for a carton quoted at ৳১০০০.
      //
      // ── When the two features meet ─────────────────────────────────────────
      //
      // `packSellingPrice` is itself a wholesale-ish rate — "cheaper if you take
      // the whole carton". `wholesalePrice` is a different axis — "cheaper
      // because of who you are". A পাইকারি customer buying a carton is entitled
      // to the second, and stacking both would compound two discounts the
      // shopkeeper only meant to give once.
      //
      // So a line that actually got a wholesale rate prices its pack as
      // `wholesale unit price x pack size` and ignores `packSellingPrice`. A
      // line that fell back to retail — no wholesale price on the product —
      // keeps the existing pack logic byte for byte, which is also every line
      // in every shop that does not have `features.wholesale`.
      let packUnitPrice = null;
      if (line.mode === 'pack') {
        const explicitPack = Number(product.packaging?.packSellingPrice);
        packUnitPrice = (!lineWholesale && Number.isFinite(explicitPack) && explicitPack > 0)
          ? quantizeMoney(explicitPack)
          : quantizeMoney(unitPrice * line.packSize);
        unitPrice = unitPriceFor(line, unitPrice, packUnitPrice);

        // The ledger records what the stock actually went out at, so it has to
        // follow the wholesale rate too — otherwise a carton sold below retail
        // reports a profit the shop never made.
        stockTransactions[stockTransactions.length - 1].unitPrice = unitPrice;
      }

      const itemDiscount = item.discount || 0;
      // Rounded to paisa: with a fractional quantity `unitPrice x quantity` no
      // longer lands on a whole taka (70 x 0.333 = 23.310000000000002), and an
      // unrounded line total propagates into subtotal, profit and the invoice.
      const itemTotal = quantizeMoney((unitPrice * item.quantity) - itemDiscount);

      // Update totalPrice in the last queued stock transaction
      stockTransactions[stockTransactions.length - 1].totalPrice = itemTotal;

      processedItems.push({
        product: product._id,
        productName: product.name,
        ...variantInfo,
        quantity: item.quantity,
        // The unit snapshot — see the block comment on `saleItemSchema`. Stored
        // even for a plain base-unit line, because "this invoice was priced in
        // পিস" is exactly the fact that goes stale when a product is edited.
        unit: line.unit,
        saleUnit: line.mode,
        packUnit: line.packUnit || undefined,
        packSize: line.packSize || undefined,
        packQuantity: line.packQuantity || undefined,
        unitPrice,
        packUnitPrice: packUnitPrice || undefined,
        buyingPrice,
        discount: itemDiscount,
        total: itemTotal,
      });

      subtotal += itemTotal;
    }

    // --- BATCH: Execute all stock updates in one bulkWrite with race-condition guard ---
    {
      if (bulkStockOps.length > 0) {
        const stockResult = await Product.bulkWrite(bulkStockOps, sessionOpt);
        if (stockResult.modifiedCount < expectedStockOps) {
          throw new AppError(
            'Insufficient stock — another sale may have just reduced inventory. Please retry.',
            'পর্যাপ্ত স্টক নেই — অন্য একটি বিক্রয় ইতোমধ্যে স্টক কমিয়ে ফেলেছে। পুনরায় চেষ্টা করুন।',
            409
          );
        }
      }
    }

    // --- Persist the FEFO batch deductions ---
    //
    // Deliberately AFTER the stock guard: if that threw a 409 we must not have
    // consumed batch quantity for a sale that did not happen.
    //
    // Deliberately its OWN bulkWrite: `modifiedCount < expectedStockOps` above
    // is the oversell check, and mixing unrelated ops into the batch it counts
    // would let a lost stock race hide behind a successful batch write.
    if (bulkBatchOps.length > 0) {
      await Product.bulkWrite(bulkBatchOps, sessionOpt);
    }

    // --- BATCH: Insert all stock transactions in one call ---
    if (stockTransactions.length > 0) {
      await StockTransaction.insertMany(stockTransactions, sessionOpt);
    }

    let discountAmount = discount;
    if (discountType === 'percentage') {
      discountAmount = (subtotal * discount) / 100;
    }

    const numDeliveryCharge = Number(deliveryCharge) || 0;
    const numAdvancePaid = Number(advancePaid) || 0;
    const total = subtotal - discountAmount + tax + numDeliveryCharge;
    const due = Math.max(0, total - paid);
    const status = due <= 0 ? 'completed' : (paid > 0 ? 'partial' : 'unpaid');

    // Handle customer.
    //
    // The LOOKUP for both branches happened before the item loop — it has to,
    // because `priceTier` depends on it. What is left here is the half that
    // must not run before the stock guard: creating a customer from a phone the
    // shop has never seen. A sale that fails on stock must not leave a customer
    // record behind for a transaction that never happened.
    //
    // A customer created here is new, so `isWholesale` is false and the tier
    // already computed above ('retail') is still the right one. There is
    // nothing to recompute, and recomputing would be wrong: the price the
    // cashier was quoted is the price on the invoice.
    let finalCustomerName = customerName;
    let finalCustomerPhone = customerPhone;

    if (customer) {
      finalCustomerName = customer.name;
      finalCustomerPhone = customer.phone;
    } else if (!customerId && customerPhone && customerName) {
      const [newCustomer] = await Customer.create([{
        shop: shopId,
        phone: customerPhone,
        name: customerName,
        createdBy: userId,
      }], sessionOpt);
      customer = newCustomer;
    }

    // The invoice records the name THIS branch knows the customer by.
    //
    // `customerName` is a snapshot — it is what gets printed, texted and shown
    // in every report, and it must not change under the shop later. Taking the
    // shop-wide name here would hand a Dhaka customer an invoice in the name
    // Chittagong chose for them, which is the confusion this whole feature
    // exists to end. Only ever a rename of the same person, so nothing about
    // the money or the customer link changes.
    if (customer && branchId) {
      const localRow = await CustomerBalance.findOne(
        { shop: shopId, customer: customer._id, branch: branchId },
        'localName',
        sessionOpt
      );
      if (localRow?.localName) finalCustomerName = localRow.localName;
    }

    // Create sale with retry for invoice number collision
    let sale;
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const branchCode = req ? getBranchCode(req) : null;
        const invoiceNo = await this.generateInvoiceNumber(shopId, branchCode, branchId);
        const [newSale] = await Sale.create([{
          shop: shopId,
          branch: branchId,
          invoiceNo,
          customer: customer?._id,
          customerName: finalCustomerName,
          customerPhone: finalCustomerPhone,
          // Snapshot, not a lookup: promoting this customer to wholesale next
          // month must not restate what this invoice was charged at.
          priceTier,
          items: processedItems,
          subtotal,
          discount,
          discountType,
          tax,
          total,
          paid,
          due,
          paymentMethod,
          payments,
          status,
          notes,
          isOnline: Boolean(isOnline),
          channel: channel || 'pos',
          deliveryCharge: numDeliveryCharge,
          advancePaid: numAdvancePaid,
          courierName,
          shippingAddress,
          createdBy: userId,
        }], sessionOpt);
        sale = newSale;
        break; // Success — exit retry loop
      } catch (err) {
        if (err.code === 11000 && attempt < maxRetries - 1) {
          // Duplicate invoiceNo — retry with new number
          continue;
        }
        throw err; // Not a duplicate or last attempt — rethrow
      }
    }

    // Update customer statistics if customer exists
    if (customer) {
      const purchasedAt = new Date();
      customer.totalPurchases += total;
      customer.totalPaid += paid;
      customer.totalDue += due;
      customer.purchaseCount += 1;
      customer.lastPurchase = purchasedAt;
      await customer.save(sessionOpt);

      // Same arithmetic, split per branch (Phase 7). Written whatever
      // `customerScope` says — only reads consult the flag — and a no-op for
      // single-branch shops, where branchId is null.
      await CustomerBalance.applyDelta({
        shop: shopId,
        customer: customer._id,
        branch: branchId,
        purchases: total,
        paid,
        due,
        count: 1,
        lastPurchase: purchasedAt,
      }, session);
    }

    // Create payment record if paid amount > 0
    if (paid > 0) {
      await Payment.create([{
        shop: shopId,
        branch: branchId,
        sale: sale._id,
        customer: customer?._id,
        amount: paid,
        method: paymentMethod,
        type: 'sale_payment',
        receivedBy: userId,
      }], sessionOpt);
    }

    // Update shop statistics
    await Shop.findByIdAndUpdate(shopId, {
      $inc: { 'stats.totalSales': 1 },
    }, sessionOpt);

    // Create audit log.
    //
    // ── Summary, not a second copy of the sale ───────────────────────────────
    //
    // `changes.after` used to be `sale.toObject()` — the ENTIRE document,
    // items array and all. Every checkout therefore wrote its own payload
    // twice, into the two highest-volume collections in the system, and paid
    // for it again in index growth and replication bandwidth.
    //
    // The fields below are the ones an audit trail is actually read for. The
    // full line detail is not lost: `entity.id` points at the sale, which is
    // the authoritative record and outlives this log (AuditLog has a 90-day
    // TTL — the snapshot was never the durable copy anyway).
    //
    // ── Fire-and-forget ──────────────────────────────────────────────────────
    //
    // This was `await`ed, so the cashier waited on it. It is deliberately NOT
    // passed `sessionOpt` and never was, so it is already outside the sale's
    // transaction — making it non-blocking gives up no atomicity that existed.
    // Same treatment as the SMS dispatch and cache invalidation just below.
    AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'sale_create',
      actionBn: 'নতুন বিক্রয়',
      description: `Created sale: ${sale.invoiceNo}, Total: ৳${total}`,
      descriptionBn: `নতুন বিক্রয়: ${sale.invoiceNo}, মোট: ৳${total}`,
      entity: {
        type: 'sale',
        id: sale._id,
        name: sale.invoiceNo,
      },
      changes: {
        after: {
          invoiceNo: sale.invoiceNo,
          total,
          paid,
          due,
          status,
          paymentMethod,
          itemCount: processedItems.length,
          customer: customer?._id || null,
          customerName: finalCustomerName || null,
        },
      },
    }).catch((err) => logger.error(`Audit log (sale_create) failed: ${err.message}`));

    // Send SMS receipt (non-blocking - runs in background)
    // This doesn't wait for SMS to be sent, returns immediately
    const SMSService = require('./sms.service');
    SMSService.sendSaleReceiptAsync(shopId, userId, {
      invoiceNumber: sale.invoiceNo,
      total,
      paid,
      due,
      customerId: customer?._id,
      customerName: finalCustomerName,
      customerPhone: finalCustomerPhone,
      sendSms: saleData.sendSms || false,
    });

    // Invalidate related caches
    this.invalidateCache(shopId).catch(() => {}); // Non-blocking

    return sale;
    });
  }

  // Record payment for existing sale
  async recordPayment(shopId, userId, saleId, paymentData, branchId = null) {
    const { amount, method, transactionId, notes } = paymentData;

    const saleQuery = { _id: saleId, shop: shopId };
    if (branchId) saleQuery.branch = branchId;
    const sale = await Sale.findOne(saleQuery);
    if (!sale) {
      throw new AppError('Sale not found', 'বিক্রয় পাওয়া যায়নি', 404);
    }

    if (sale.status === 'cancelled') {
      throw new AppError('Cannot record payment for cancelled sale', 'বাতিল বিক্রয়ে পেমেন্ট নেওয়া যাবে না', 400);
    }

    if (amount > sale.due) {
      throw new AppError('Payment amount exceeds due balance', 'পেমেন্টের পরিমাণ বাকির চেয়ে বেশি', 400);
    }

    // Update sale
    sale.paid += amount;
    sale.due -= amount;
    sale.status = sale.due <= 0 ? 'completed' : 'partial';
    await sale.save();

    // Create payment record
    const payment = await Payment.create({
      shop: shopId,
      branch: sale.branch || null,
      sale: saleId,
      customer: sale.customer,
      amount,
      method: method || 'cash',
      transactionId,
      type: 'sale_payment',
      notes,
      receivedBy: userId,
    });

    // Update customer balance if applicable
    if (sale.customer) {
      await Customer.findByIdAndUpdate(sale.customer, {
        $inc: { totalPaid: amount, totalDue: -amount },
      });

      // Attributed to the SALE's branch, not the collector's. The due being
      // cleared belongs to whichever branch raised the invoice; crediting it to
      // the branch that happened to take the cash would leave the issuing
      // branch permanently overstated and the collecting one negative. The
      // Payment row above keeps `sale.branch` for the same reason.
      await CustomerBalance.applyDelta({
        shop: shopId,
        customer: sale.customer,
        branch: sale.branch,
        paid: amount,
        due: -amount,
      });
    }

    // Create audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'payment_received',
      actionBn: 'পেমেন্ট গ্রহণ',
      description: `Received ৳${amount} for ${sale.invoiceNo}`,
      descriptionBn: `${sale.invoiceNo} এর জন্য ৳${amount} পেমেন্ট গ্রহণ`,
      entity: {
        type: 'sale',
        id: sale._id,
        name: sale.invoiceNo,
      },
      changes: {
        before: { paid: sale.paid - amount, due: sale.due + amount },
        after: { paid: sale.paid, due: sale.due },
      },
    });

    // Send payment receipt SMS (non-blocking — runs in background)
    if (sale.customer) {
      const SMSService = require('./sms.service');
      SMSService.sendPaymentReceiptAsync(shopId, userId, {
        customerId: sale.customer,
        amount,
      });
    }

    // Invalidate related caches
    this.invalidateCache(shopId).catch(() => {}); // Non-blocking

    return { sale, payment };
  }

  // Cancel sale
  async cancelSale(shopId, userId, saleId, reason, activeBranchId = null) {
    const saleQuery = { _id: saleId, shop: shopId };
    if (activeBranchId) saleQuery.branch = activeBranchId;
    const sale = await Sale.findOne(saleQuery);
    if (!sale) {
      throw new AppError('Sale not found', 'বিক্রয় পাওয়া যায়নি', 404);
    }

    if (sale.status === 'cancelled') {
      throw new AppError('Sale is already cancelled', 'বিক্রয় ইতিমধ্যে বাতিল করা হয়েছে', 400);
    }

    // --- BATCH: Restore stock using bulkWrite ---
    const cancelProductIds = [...new Set(sale.items.map(item => item.product.toString()))];
    // `shop` is part of the filter deliberately. Every other product lookup in
    // this service is tenant-scoped; this one was not, which made it the only
    // query here that could resolve a document belonging to another shop if an
    // id ever leaked into a sale's items. It also lets the query use the
    // shop-prefixed compound indexes instead of falling back to the _id index.
    const cancelProducts = await Product.find({ _id: { $in: cancelProductIds }, shop: shopId });
    const cancelProductMap = new Map(cancelProducts.map(p => [p._id.toString(), p]));

    // Stock is restored onto the sale's own product documents — those already
    // belong to the sale's branch, so there is no separate ledger to reconcile.
    const branchId = sale.branch;

    const restoreOps = [];
    const cancelStockTxns = [];

    for (const item of sale.items) {
      const product = cancelProductMap.get(item.product.toString());
      if (!product) continue;

      let previousStock = 0;
      let newStock = 0;

      // Restore rounds at the PRODUCT's precision, not the request's: this path
      // takes no `req`, and a shop whose packaging flag was switched off after
      // the sale must still put back exactly what was taken out. `storageUnit`
      // is flag-independent for precisely this reason.
      const stkUnit = storageUnit(product);

      if (item.variantId) {
        const variant = (product.variants && typeof product.variants.id === 'function')
          ? product.variants.id(item.variantId)
          : product.variants?.find(v => (v._id || v.id)?.toString() === item.variantId?.toString());
        previousStock = variant?.stock || 0;
        newStock = quantize(previousStock + item.quantity, stkUnit);
        if (variant) variant.stock = newStock;

        restoreOps.push({
          updateOne: {
            filter: { _id: product._id, 'variants._id': item.variantId },
            update: buildVariantStockUpdate(item.variantId, item.quantity, stkUnit),
          },
        });
      } else {
        previousStock = product.stock || 0;
        newStock = quantize(previousStock + item.quantity, stkUnit);
        product.stock = newStock;

        restoreOps.push({
          updateOne: {
            filter: { _id: product._id },
            update: buildStockUpdate(item.quantity, stkUnit),
          },
        });
      }

      cancelStockTxns.push({
        shop: shopId,
        branch: branchId || null,
        product: product._id,
        productName: product.name,
        productCode: product.code,
        variantId: item.variantId || null,
        variantSku: item.variantSku,
        variantAttributes: item.variantAttributes,
        type: 'return',
        quantity: item.quantity,
        previousStock,
        newStock,
        reference: {
          type: 'sale',
          id: sale._id,
          invoiceNo: sale.invoiceNo,
        },
        notes: `Sale cancelled: ${sale.invoiceNo}`,
        createdBy: userId,
      });
    }

    {
      if (restoreOps.length > 0) {
        await Product.bulkWrite(restoreOps);
      }
    }
    if (cancelStockTxns.length > 0) {
      await StockTransaction.insertMany(cancelStockTxns);
    }

    // Update customer balance if applicable
    if (sale.customer) {
      await Customer.findByIdAndUpdate(sale.customer, {
        $inc: {
          totalPurchases: -sale.total,
          totalPaid: -sale.paid,
          totalDue: -sale.due,
          purchaseCount: -1,
        },
      });

      // Unwound at the branch that raised the sale — which is the only branch
      // whose figures the sale ever moved.
      await CustomerBalance.applyDelta({
        shop: shopId,
        customer: sale.customer,
        branch: sale.branch,
        purchases: -sale.total,
        paid: -sale.paid,
        due: -sale.due,
        count: -1,
      });
    }

    // Update sale status
    sale.status = 'cancelled';
    sale.cancelledAt = new Date();
    sale.cancelledBy = userId;
    sale.cancelReason = reason;
    sale.notes = `${sale.notes || ''}\nCancelled: ${reason}`;
    await sale.save();

    // Create audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'sale_cancel',
      actionBn: 'বিক্রয় বাতিল',
      description: `Cancelled sale: ${sale.invoiceNo}. Reason: ${reason}`,
      descriptionBn: `বিক্রয় বাতিল: ${sale.invoiceNo}। কারণ: ${reason}`,
      entity: {
        type: 'sale',
        id: sale._id,
        name: sale.invoiceNo,
      },
    });

    // Invalidate related caches
    this.invalidateCache(shopId).catch(() => {}); // Non-blocking

    return sale;
  }

  // Get today's sales summary
  async getTodaySummary(shopId, branchId = null) {
    const { startOfDay, endOfDay } = getBangladeshTodayRange();
    const match = {
      shop: new mongoose.Types.ObjectId(shopId),
      status: { $ne: 'cancelled' },
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    };
    if (branchId) {
      match.branch = new mongoose.Types.ObjectId(branchId);
    }

    const result = await Sale.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalSales: { $sum: netSaleAmountExpr() },
          totalPaid: { $sum: '$paid' },
          totalDue: { $sum: '$due' },
          count: { $sum: 1 },
        },
      },
    ]);

    return result[0] || { totalSales: 0, totalPaid: 0, totalDue: 0, count: 0 };
  }

  // Get recent sales
  async getRecentSales(shopId, limit = 10, branchId = null) {
    const query = { shop: shopId, status: { $ne: 'cancelled' } };
    if (branchId) query.branch = branchId;
    const sales = await Sale.find(query)
      .populate('customer', 'name phone')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return sales;
  }

  // Get payments for a sale
  async getSalePayments(shopId, saleId, branchId = null) {
    const saleQuery = { _id: saleId, shop: shopId };
    if (branchId) saleQuery.branch = branchId;
    const sale = await Sale.findOne(saleQuery);
    if (!sale) {
      throw new AppError('Sale not found', 'বিক্রয় পাওয়া যায়নি', 404);
    }

    const payments = await Payment.find({ shop: shopId, sale: saleId })
      .populate('receivedBy', 'name')
      .sort({ createdAt: -1 })
      .lean();

    return payments;
  }
}

module.exports = new SaleService();
