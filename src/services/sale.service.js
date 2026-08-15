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
const {
  computeInvoiceTotals,
  clampPaymentLegs,
  statusFor,
  toMoney,
} = require('../utils/invoiceMath.util');
const { priceTierFor, sellingPriceFor, hasWholesalePrice } = require('../utils/pricing.util');
const { deductBatches, restoreBatches, batchWriteOp } = require('../utils/batch.util');
const { hasFeature } = require('../utils/features.util');
const { isCombo, findComponentVariant, isChooseSlot } = require('../utils/combo.util');

// "Today" in Bangladesh, from the shared definition in `bdTime.util`. This was
// a fourth private copy of the same offset arithmetic; the copies are what let
// the cash register drift onto a different day from the sales it counts.
const {
  getBangladeshTodayStr,
  getBangladeshTodayRange: bdTodayRange,
} = require('../utils/bdTime.util');

function getBangladeshTodayRange() {
  const dateStr = getBangladeshTodayStr();
  return { ...bdTodayRange(), dateStr };
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

    // `totalSales` and `totalProfit` are NET of returns (`netSaleAmountExpr`
    // subtracts `returnedAmount`; `Sale.profit` already carries
    // `returnedProfit`). `totalPaid` is GROSS — it is what was collected against
    // these invoices, and a cash refund is a separate movement out of the
    // drawer, not an un-collection.
    //
    // Mixing the two without saying so made the cards unreconcilable on any day
    // with a return: sales fell, paid did not, and nothing on screen explained
    // the gap. `totalReturned` is that explanation, so the four figures tie out
    // as `totalSales = (gross sales) - totalReturned`.
    const result = await Sale.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalSales: { $sum: netSaleAmountExpr() },
          totalPaid: { $sum: '$paid' },
          totalDue: { $sum: '$due' },
          totalProfit: { $sum: '$profit' },
          totalReturned: { $sum: { $ifNull: ['$returnedAmount', 0] } },
          count: { $sum: 1 },
        },
      },
    ]);

    return result[0] || {
      totalSales: 0, totalPaid: 0, totalDue: 0, totalProfit: 0, totalReturned: 0, count: 0,
    };
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
  /**
   * @param {object} internalOptions NOT derived from any request body — only
   *   internal callers may pass it. `unitPriceOverrides` is a Map of
   *   `"<productId>"` or `"<productId>:<variantId>"` → price, used by
   *   `orderService.confirmOrder` so the Sale bills exactly what the online
   *   order QUOTED (the storefront's `onlinePrice ?? sellingPrice`), not what
   *   the POS would charge today. The controllers never forward anything from
   *   `req.body` into this argument; doing so would reopen the client-priced
   *   sale that I-10 / §15.2 exist to prevent.
   */
  async createSale(shopId, userId, saleData, req, internalOptions = {}) {
    const unitPriceOverrides = internalOptions.unitPriceOverrides instanceof Map
      ? internalOptions.unitPriceOverrides
      : null;
    // The quoted price wins over every pricing rule, including wholesale —
    // an online order is billed at what the customer was shown.
    const overrideFor = (productId, variantId = null) => {
      if (!unitPriceOverrides) return null;
      const key = variantId ? `${productId}:${variantId}` : String(productId);
      const value = unitPriceOverrides.get(key);
      return Number.isFinite(value) && value >= 0 ? value : null;
    };
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

    // ── Combo expansion: pull every component into the SAME map ─────────────
    //
    // Components share `productMap` with directly-sold products on purpose: a
    // product sold standalone on one line and inside a combo on another must
    // deduct from ONE in-memory document, or the running stock check between
    // lines lies about what is left. Same branch filter, same session.
    const comboProductsOnSale = products.filter((p) => isCombo(p));
    if (comboProductsOnSale.length) {
      // A held cart or offline payload written before the flag was switched
      // off must not sell through a capability the shop no longer has.
      if (req && !hasFeature(req, 'combos')) {
        throw new AppError(
          'Combo products are not enabled for this shop',
          'কম্বো সুবিধাটি আপনার দোকানে চালু নেই',
          400
        );
      }
      const componentIds = new Set();
      for (const combo of comboProductsOnSale) {
        for (const ci of combo.comboItems || []) {
          const id = String(ci.product);
          if (!productMap.has(id)) componentIds.add(id);
        }
      }
      if (componentIds.size) {
        const componentDocs = await Product.find(
          branchFilter(req, { _id: { $in: [...componentIds] }, shop: shopId })
        ).session(session || null);
        for (const doc of componentDocs) productMap.set(doc._id.toString(), doc);
      }
    }

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

      // ── Combo line ─────────────────────────────────────────────────────────
      //
      // The combo product itself moves NO stock. The line expands into one
      // $gte-guarded op per component — each counted into `expectedStockOps`,
      // so the oversell guard below stays exact for them too — plus one ledger
      // row per component stamped `viaCombo`, and ONE sale item carrying a
      // frozen `comboComponents` snapshot that cancel/return restore from.
      //
      // The line's `buyingPrice` is the LIVE per-combo component cost, which is
      // what keeps the Sale pre('save') profit arithmetic correct untouched.
      if (isCombo(product)) {
        if (item.variantId) {
          throw new AppError('A combo has no variants', 'কম্বোর নিজস্ব ভ্যারিয়েন্ট নেই', 400);
        }
        if (product.isActive === false) {
          throw new AppError(`Combo is inactive: ${product.name}`, `কম্বোটি বন্ধ আছে: ${product.name}`, 400);
        }
        if (!Array.isArray(product.comboItems) || product.comboItems.length === 0) {
          throw new AppError(`Combo has no components: ${product.name}`, `কম্বোতে কোনো পণ্য নেই: ${product.name}`, 400);
        }

        const comboQty = item.quantity;
        const comboUnitPrice = sellingPriceFor(product, priceTier);

        // What the cashier picked for each 'choose' slot, keyed by the slot's
        // own _id — NOT by product id, because two slots may name the same
        // product ("১টা কিনলে ১টা ফ্রি" with two different colours).
        //
        // The price does not move with the pick: the combo is sold for what it
        // was priced at, whichever variant goes out. Only the COST follows the
        // variant, which is what keeps the line's profit honest.
        const selections = new Map();
        for (const sel of (item.comboSelections || [])) {
          if (!sel || !sel.comboItemId) continue;
          selections.set(String(sel.comboItemId), sel);
        }
        // Which selections a slot actually claimed. Anything left over aimed at
        // a PINNED slot or at nothing at all — both are refused below rather
        // than dropped, because a client that thinks it substituted a variant
        // must not be told the sale went through as it asked.
        const usedSelections = new Set();
        // Units of one shelf (product, or product+variant) already claimed by
        // an earlier slot of THIS combo line — see the check in the loop below.
        const pendingPerShelf = new Map();

        // First pass: resolve and validate every component against the
        // IN-MEMORY stock, which already reflects earlier lines of this sale.
        const resolvedComponents = [];
        let retailSum = 0;
        for (const ci of product.comboItems) {
          const comp = productMap.get(String(ci.product));
          if (!comp || comp.isDeleted) {
            throw new AppError(
              `Combo "${product.name}" component no longer exists: ${ci.productName || ci.product}`,
              `"${product.name}" কম্বোর উপাদান পণ্যটি আর নেই: ${ci.productName || ''}`,
              400
            );
          }
          if (comp.isActive === false) {
            throw new AppError(
              `Combo "${product.name}" component is inactive: ${comp.name}`,
              `"${product.name}" কম্বোর উপাদান "${comp.name}" নিষ্ক্রিয়`,
              400
            );
          }

          let variant = null;
          if (isChooseSlot(ci)) {
            // The slot the cashier had to answer. No fallback to "the first
            // variant": guessing here would ring up a colour nobody chose and
            // take it off the wrong shelf.
            const sel = selections.get(String(ci._id));
            usedSelections.add(String(ci._id));
            if (!sel || !sel.variantId) {
              throw new AppError(
                `Combo "${product.name}": choose which "${comp.name}" the customer is taking`,
                `"${product.name}" কম্বোর "${comp.name}" এর কোনটি দিচ্ছেন তা নির্বাচন করুন`,
                400
              );
            }
            variant = findComponentVariant(comp, sel.variantId);
            if (!variant || variant.isActive === false) {
              throw new AppError(
                `Combo "${product.name}": that variant of "${comp.name}" is not available`,
                `"${product.name}" কম্বোর "${comp.name}" এর ওই ভ্যারিয়েন্টটি পাওয়া যায়নি`,
                400
              );
            }
          } else if (ci.variantId) {
            variant = findComponentVariant(comp, ci.variantId);
            if (!variant) {
              throw new AppError(
                `Combo "${product.name}": variant of "${comp.name}" was removed — edit the combo`,
                `"${product.name}" কম্বোর "${comp.name}" এর ভ্যারিয়েন্টটি আর নেই — কম্বোটি সম্পাদনা করুন`,
                400
              );
            }
          } else if (comp.hasVariants) {
            // The component GREW variants after the combo was built; its
            // product-level stock no longer means anything. Refuse loudly
            // rather than deduct from a number nobody maintains.
            throw new AppError(
              `Combo "${product.name}": "${comp.name}" now has variants — edit the combo and pick one`,
              `"${product.name}" কম্বোর "${comp.name}" এ এখন ভ্যারিয়েন্ট আছে — কম্বোটি সম্পাদনা করে একটি নির্বাচন করুন`,
              400
            );
          }

          const compStkUnit = storageUnit(comp);
          const required = quantize(comboQty * ci.quantity, compStkUnit);

          // Two slots of one combo may land on the SAME shelf — either two
          // 'choose' slots the cashier answered with one colour, or a 'choose'
          // slot picking what a 'fixed' slot already pinned. Each slot must be
          // checked against what the EARLIER slots of this line already spoke
          // for, or two 3-unit slots both pass against a stock of 5 and the
          // only thing standing between the shop and a negative shelf is the
          // database's $gte guard — which fires a 409 blaming a phantom
          // concurrent sale instead of telling the cashier what is short.
          //
          // Before 'choose' existed this could not happen: duplicate
          // (product, variant) rows were rejected at build time.
          const stockKey = `${comp._id}:${variant ? variant._id : ''}`;
          const spokenFor = pendingPerShelf.get(stockKey) || 0;
          const onShelf = variant ? (variant.stock || 0) : (comp.stock || 0);
          const availableStock = onShelf - spokenFor;
          if (availableStock < required) {
            const what = variant && variant.sku ? `${comp.name} (${variant.sku})` : comp.name;
            throw new AppError(
              `Insufficient stock for "${what}" in combo "${product.name}". Available: ${availableStock}, needed: ${required}`,
              `"${product.name}" কম্বোর "${what}" এর পর্যাপ্ত স্টক নেই। আছে: ${availableStock}, দরকার: ${required}`,
              400
            );
          }
          pendingPerShelf.set(stockKey, spokenFor + required);

          const compBuying = variant
            ? (variant.buyingPrice ?? comp.buyingPrice ?? 0)
            : (comp.buyingPrice || 0);
          const compRetail = variant ? (variant.sellingPrice || 0) : (comp.sellingPrice || 0);
          retailSum += compRetail * ci.quantity;
          resolvedComponents.push({ ci, comp, variant, required, compStkUnit, compBuying, compRetail });
        }

        // A selection nobody claimed means the client believes it changed
        // something this combo does not let it change — most likely an attempt
        // to substitute a PINNED variant, which is the one thing pinning is
        // for. Refuse rather than ignore: silently selling the pinned variant
        // after being asked for another is how a shop discovers, at stock-take,
        // that the till and the shelf disagree.
        for (const key of selections.keys()) {
          if (!usedSelections.has(key)) {
            throw new AppError(
              `Combo "${product.name}": that component's variant is fixed and cannot be changed at the till`,
              `"${product.name}" কম্বোর ওই পণ্যের ভ্যারিয়েন্ট নির্দিষ্ট করা আছে — বিলের সময় বদলানো যাবে না`,
              400
            );
          }
        }

        // Second pass: deduct in memory, queue the guarded ops and the ledger.
        let comboBuying = 0; // component cost of ONE combo, at today's prices
        const comboComponents = [];

        for (const r of resolvedComponents) {
          const { ci, comp, variant, required, compStkUnit, compBuying, compRetail } = r;
          // The ledger's revenue figure: the combo price allocated across
          // components in proportion to their own retail value, so "what did
          // this stock go out at" still has an honest per-unit answer.
          const perUnitAlloc = retailSum > 0
            ? quantizeMoney(comboUnitPrice * (compRetail / retailSum))
            : 0;

          let previousStock;
          let newStock;
          if (variant) {
            previousStock = variant.stock;
            variant.stock = quantize(variant.stock - required, compStkUnit);
            newStock = variant.stock;
            bulkStockOps.push({
              updateOne: {
                filter: { _id: comp._id, variants: { $elemMatch: { _id: variant._id, stock: { $gte: required } } } },
                update: buildVariantStockUpdate(variant._id, -required, compStkUnit),
              },
            });
          } else {
            previousStock = comp.stock;
            comp.stock = quantize(comp.stock - required, compStkUnit);
            newStock = comp.stock;
            bulkStockOps.push({
              updateOne: {
                filter: { _id: comp._id, stock: { $gte: required } },
                update: buildStockUpdate(-required, compStkUnit),
              },
            });
          }
          expectedStockOps++;

          comboBuying += compBuying * ci.quantity;

          stockTransactions.push({
            shop: shopId,
            branch: branchId,
            product: comp._id,
            productName: comp.name,
            productCode: comp.code,
            variantId: variant ? variant._id : null,
            variantSku: variant ? variant.sku : null,
            variantAttributes: variant ? variant.attributes : null,
            type: 'sale',
            quantity: -required,
            previousStock,
            newStock,
            unitCost: compBuying,
            totalCost: compBuying * required,
            unitPrice: perUnitAlloc,
            totalPrice: quantizeMoney(perUnitAlloc * required),
            notes: `Sold via combo: ${product.name}`,
            viaCombo: {
              product: product._id,
              name: product.name,
              code: product.code,
              comboQuantity: comboQty,
            },
            createdBy: userId,
          });

          // FEFO on the component — same helper, same owner rule as an
          // ordinary line.
          if (deductBatches(comp, ci.variantId || null, required)) {
            bulkBatchOps.push(batchWriteOp(comp));
          }

          comboComponents.push({
            product: comp._id,
            // Which SLOT of the combo definition this row served. Traceability
            // only — cancel and return restore from the frozen quantities
            // below and never look the slot up, which is what keeps them
            // working after the combo is edited or deleted.
            comboItemId: ci._id,
            productName: comp.name,
            productCode: comp.code,
            variantId: variant ? variant._id : null,
            variantSku: variant ? variant.sku : undefined,
            variantAttributes: variant ? variant.attributes : undefined,
            unit: comp.unit,
            quantityPerCombo: ci.quantity,
            totalQuantity: required,
            unitCost: compBuying,
          });
        }

        const comboItemDiscount = item.discount || 0;
        const comboItemTotal = quantizeMoney((comboUnitPrice * comboQty) - comboItemDiscount);

        processedItems.push({
          product: product._id,
          productName: product.name,
          productCode: product.code,
          itemType: 'combo',
          comboComponents,
          quantity: comboQty,
          unit: line.unit,
          saleUnit: 'base',
          unitPrice: comboUnitPrice,
          buyingPrice: quantizeMoney(comboBuying),
          discount: comboItemDiscount,
          total: comboItemTotal,
        });
        // Quantized on every accumulation, not just at the end: summing raw
        // doubles is what puts 0.30000000000000004 into a subtotal and leaves
        // an invoice with a due of 1.4e-14 that no payment can clear.
        subtotal = quantizeMoney(subtotal + comboItemTotal);
        continue;
      }

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
        {
          const quoted = overrideFor(product._id, variant._id);
          if (quoted !== null) {
            unitPrice = quoted;
            lineWholesale = false;
          }
        }
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
        {
          const quoted = overrideFor(product._id);
          if (quoted !== null) {
            unitPrice = quoted;
            lineWholesale = false;
          }
        }
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

      }

      // ── FEFO batch deduction ─────────────────────────────────────────────
      //
      // First-Expiry-First-Out: the batch that goes off soonest leaves the
      // shelf first, so a shop selling medicine or food is never left holding
      // the short-dated stock.
      //
      // ───────────────────────────────────────────────────────────────────────
      // WHY THIS SITS OUTSIDE THE VARIANT / NON-VARIANT SPLIT
      // ───────────────────────────────────────────────────────────────────────
      //
      // It used to live inside the `else`, i.e. non-variant products only.
      // `trackBatches` appeared exactly once in this whole file and it was in
      // there. So a shop could turn expiry tracking on for a product with
      // variants, watch it save, and have it do NOTHING: no deduction on sale,
      // and — because the purchase path had the same split — no batch to deduct
      // from in the first place. The toggle was live and inert at once, which is
      // the worst way for a feature to be missing.
      //
      // `item.variantId || null` is the owner. A batch belongs to one variant,
      // or to the product itself; selling ৫০০ গ্রাম packets must not consume the
      // ১ কেজি batch even though both live in the same array.
      //
      // ───────────────────────────────────────────────────────────────────────
      // THIS USED TO MUTATE THE DOCUMENT AND THROW THE RESULT AWAY
      // ───────────────────────────────────────────────────────────────────────
      //
      // The arithmetic ran on the in-memory `product` — which is never
      // `.save()`d on this path, because stock goes out through the atomic
      // `bulkWrite` above and not through the document. So batch quantities only
      // ever went UP: purchases pushed new batches, sales silently deducted
      // nothing, and after a few months `sum(batches.quantity)` bore no relation
      // to `stock`.
      //
      // So the deduction is queued as a real update (`bulkBatchOps`) and written
      // after the stock guard passes. It is a SEPARATE bulkWrite, not another op
      // in the stock one: `modifiedCount < expectedStockOps` is the oversell
      // guard, and adding unrelated ops to the batch it counts would let a lost
      // stock race hide behind a successful batch write.
      if (deductBatches(product, item.variantId || null, item.quantity)) {
        bulkBatchOps.push(batchWriteOp(product));
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

      // Quantized on every accumulation — see the combo branch above.
      subtotal = quantizeMoney(subtotal + itemTotal);
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

    // ── Every derived money figure, from the ONE shared definition ────────────
    //
    // This block used to do its own arithmetic and hand the results to
    // `Customer` / `CustomerBalance` below, while `Sale.pre('save')` computed
    // the same figures again its own way for the invoice. The two disagreed on
    // every overpayment (the POS paid box is free text, so a cashier keying the
    // tendered ৳500 on a ৳420 bill credited the customer ৳80 they never paid),
    // on any discount larger than the bill, and on a non-numeric `tax` — the
    // sale routes carry no Joi schema, so `tax` arrived unvalidated.
    //
    // Now both call `computeInvoiceTotals` and neither does money arithmetic of
    // its own, so the invoice and the ledger cannot drift apart again. See the
    // header of invoiceMath.util.js.
    const totals = computeInvoiceTotals({
      subtotal,
      discount,
      discountType,
      tax,
      deliveryCharge,
      paid,
    });

    subtotal = totals.subtotal;
    const numDeliveryCharge = totals.deliveryCharge;
    const numAdvancePaid = toMoney(advancePaid);
    const total = totals.total;
    // Clamped to the total. Everything downstream — the customer ledger, the
    // Payment row, the SMS receipt — reads THIS value, so no consumer can see a
    // figure the invoice itself rejected.
    paid = totals.paid;
    const due = totals.due;
    const status = statusFor({ due, paid });

    // The legs have to be trimmed to match, or the cash register (which sums
    // `payments[]` to work out what is in the drawer) counts the change handed
    // back as takings. See `clampPaymentLegs`.
    payments = clampPaymentLegs(payments, paid);

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
          // The NORMALISED figures, not the raw request values. Storing the raw
          // ones left Mongoose to cast them: a non-numeric `tax` that
          // `computeInvoiceTotals` had already read as 0 would then throw a
          // CastError here, so the invoice was rejected over a field the
          // arithmetic had deliberately tolerated.
          //
          // `discount` and `discountType` keep their given meaning — "10" and
          // 'percentage' — because that is what the invoice has to print. The
          // resolved taka figure rides alongside as `discountAmount`, written by
          // the hook; see that field's note for why reports must sum it.
          discount: toMoney(discount),
          discountType,
          tax: totals.tax,
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

    // Create payment record if paid amount > 0.
    //
    // ── `atCheckout` is load-bearing, not metadata ───────────────────────────
    //
    // This row exists so the invoice's payment history is complete. But the
    // money it describes is ALSO in `sale.payments[]`, and the cash register
    // counts both: `cashSales` sums the legs, `cashDueCollections` sums every
    // `Payment{type:'sale_payment'}`. Untagged, this row made the till's
    // expected closing over by the whole day's cash takings — the drawer looked
    // short by exactly what was in it, every single day.
    //
    // The flag is what tells the register "this one is already counted". Money
    // collected LATER against the same invoice (`recordPayment`) leaves the flag
    // false and is counted there, which is the case that bucket exists for.
    if (paid > 0) {
      await Payment.create([{
        shop: shopId,
        branch: branchId,
        sale: sale._id,
        customer: customer?._id,
        amount: paid,
        method: paymentMethod,
        type: 'sale_payment',
        atCheckout: true,
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

  // Record payment for existing sale.
  //
  // ── Transactional, and guarded against a concurrent collection ─────────────
  //
  // This was a plain read-modify-write outside any transaction: read the sale,
  // check `amount > sale.due`, mutate, save. Two collections against the same
  // invoice at once — the counter and the owner's phone, or a double-tapped
  // button — both passed the check against the same stale `due`, and the second
  // `save()` overwrote the first. Both `Payment` rows and both `Customer.$inc`
  // decrements survived, so the customer's ledger went down by twice what the
  // invoice recorded, with nothing to show which was wrong.
  //
  // Two changes fix it: the whole thing runs in a transaction (as `createSale`
  // and `createReturn` already do), and the sale is claimed with a conditional
  // `updateOne` whose filter re-asserts the due. Losing that race is a 409, not
  // a silent overwrite.
  async recordPayment(shopId, userId, saleId, paymentData, branchId = null) {
    return await runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};
      const { method, transactionId, notes } = paymentData;

      // Coerced and bounded before anything reads it. `amount` arrives from a
      // route with no Joi schema, and the only check here used to be
      // `amount > sale.due` — which a NEGATIVE amount passes. That ran the
      // ledger backwards: `paid` down, `due` up, and a negative cash-in row the
      // register subtracted from the drawer. `purchase.recordPayment` has always
      // had the `<= 0` guard; the asymmetry was the bug.
      const amount = toMoney(paymentData.amount);
      if (amount <= 0) {
        throw new AppError(
          'Payment amount must be greater than 0',
          'পেমেন্টের পরিমাণ ০ এর বেশি হতে হবে',
          400
        );
      }

      const saleQuery = { _id: saleId, shop: shopId };
      if (branchId) saleQuery.branch = branchId;
      const sale = await Sale.findOne(saleQuery).session(session || null);
      if (!sale) {
        throw new AppError('Sale not found', 'বিক্রয় পাওয়া যায়নি', 404);
      }

      if (sale.status === 'cancelled') {
        throw new AppError('Cannot record payment for cancelled sale', 'বাতিল বিক্রয়ে পেমেন্ট নেওয়া যাবে না', 400);
      }

      if (amount > sale.due) {
        throw new AppError('Payment amount exceeds due balance', 'পেমেন্টের পরিমাণ বাকির চেয়ে বেশি', 400);
      }

      const beforePaid = sale.paid;
      const beforeDue = sale.due;

      // Claim the payment atomically. `due: { $gte: amount }` is the guard: if a
      // concurrent collection got there first the filter no longer matches and
      // nothing is written, exactly as the stock `$gte` guard works in
      // `createSale`. The derived fields are recomputed by the `save()` below,
      // which is a pure function of the document (see `Sale.pre('save')`), so
      // writing `paid` here and re-deriving there cannot disagree.
      const claim = await Sale.updateOne(
        { _id: sale._id, shop: shopId, status: { $ne: 'cancelled' }, due: { $gte: amount } },
        { $inc: { paid: amount } },
        sessionOpt
      );
      if (claim.modifiedCount !== 1) {
        throw new AppError(
          'This invoice was settled by another payment — please reload and retry.',
          'এই বিলে ইতিমধ্যে অন্য একটি পেমেন্ট জমা হয়েছে — পাতা রিফ্রেশ করে আবার চেষ্টা করুন।',
          409
        );
      }

      // Re-read and save so `due`, `status` and `profit` are re-derived from the
      // returns accumulators rather than patched by hand — the arithmetic that
      // used to live here ignored `returnedAdjustment` entirely.
      const claimed = await Sale.findById(sale._id).session(session || null);
      await claimed.save(sessionOpt);

      // Create payment record. `atCheckout` stays false: this is money arriving
      // AFTER the sale, which is precisely what the cash register's
      // due-collection bucket is for.
      const [payment] = await Payment.create([{
        shop: shopId,
        branch: claimed.branch || null,
        sale: saleId,
        customer: claimed.customer,
        amount,
        method: method || 'cash',
        transactionId,
        type: 'sale_payment',
        notes,
        receivedBy: userId,
      }], sessionOpt);

      // Update customer balance if applicable
      if (claimed.customer) {
        await Customer.findByIdAndUpdate(claimed.customer, {
          $inc: { totalPaid: amount, totalDue: -amount },
        }, sessionOpt);

        // Attributed to the SALE's branch, not the collector's. The due being
        // cleared belongs to whichever branch raised the invoice; crediting it to
        // the branch that happened to take the cash would leave the issuing
        // branch permanently overstated and the collecting one negative. The
        // Payment row above keeps `sale.branch` for the same reason.
        await CustomerBalance.applyDelta({
          shop: shopId,
          customer: claimed.customer,
          branch: claimed.branch,
          paid: amount,
          due: -amount,
        }, session);
      }

      // Create audit log
      await AuditLog.create([{
        shop: shopId,
        user: userId,
        action: 'payment_received',
        actionBn: 'পেমেন্ট গ্রহণ',
        description: `Received ৳${amount} for ${claimed.invoiceNo}`,
        descriptionBn: `${claimed.invoiceNo} এর জন্য ৳${amount} পেমেন্ট গ্রহণ`,
        entity: {
          type: 'sale',
          id: claimed._id,
          name: claimed.invoiceNo,
        },
        changes: {
          before: { paid: beforePaid, due: beforeDue },
          after: { paid: claimed.paid, due: claimed.due },
        },
      }], sessionOpt);

      // Send payment receipt SMS (non-blocking — runs in background)
      if (claimed.customer) {
        const SMSService = require('./sms.service');
        SMSService.sendPaymentReceiptAsync(shopId, userId, {
          customerId: claimed.customer,
          amount,
        });
      }

      // Invalidate related caches
      this.invalidateCache(shopId).catch(() => {}); // Non-blocking

      return { sale: claimed, payment };
    });
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

    // ── A partly-returned invoice cannot be cancelled ─────────────────────────
    //
    // Cancellation restores every line's FULL `item.quantity` and unwinds the
    // whole of `sale.total` / `sale.paid` from the customer's ledger. A return
    // has already put some of that stock back and already reduced
    // `totalPurchases` by the refund. Doing both counts the goods twice on the
    // shelf and credits the customer twice.
    //
    // A FULL return already reaches 'cancelled' via `createReturn` and so was
    // caught by the guard above — only the partial case fell through, which is
    // why this went unnoticed. The remedy is to return the rest, not to cancel:
    // a return is the reversal that knows what has already been reversed.
    if ((sale.returnedAmount || 0) > 0) {
      throw new AppError(
        'This sale has returns against it — return the remaining items instead of cancelling.',
        'এই বিক্রয়ের বিপরীতে মাল ফেরত নেওয়া হয়েছে — বাতিল না করে বাকি পণ্যগুলোও ফেরত নিন।',
        400
      );
    }

    // --- BATCH: Restore stock using bulkWrite ---
    // A combo line's stock lives on its COMPONENTS — fetch those too, so the
    // snapshot loop below finds a document to restore onto.
    const cancelProductIds = [...new Set(sale.items.flatMap(item => {
      const ids = [item.product.toString()];
      if (Array.isArray(item.comboComponents)) {
        ids.push(...item.comboComponents.map(c => String(c.product)));
      }
      return ids;
    }))];
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
    // FEFO rewrites, queued as their OWN ops after the stock restores — same
    // separation the sale path keeps, so the two bookkeepings stay legible.
    const cancelBatchOps = [];

    /**
     * Put a cancelled line's goods back into its batches.
     *
     * ── This was missing entirely ────────────────────────────────────────────
     *
     * `createSale` deducts batches, `salesReturn` restores them, `cancelPurchase`
     * removes them — and this path restored `stock` and `variants[].stock` and
     * never mentioned `batches` at all. So every cancellation widened the gap
     * between `stock` and `sum(batches.quantity)` in the quiet direction: the
     * expiry screen warns about LESS stock than is on the shelf, which is the
     * failure nobody notices until dated goods are sold past their date.
     *
     * That is the same class of bug the long note at the deduction site in
     * `createSale` describes as fixed — it was fixed on the sale path only.
     *
     * Restores newest-expiry-first, the mirror of the FEFO deduction, for the
     * reason `restoreBatches` documents.
     */
    const queueBatchRestore = (product, variantId, quantity) => {
      if (restoreBatches(product, variantId || null, quantity)) {
        cancelBatchOps.push(batchWriteOp(product));
      }
    };

    for (const item of sale.items) {
      // ── Combo line: restore from the sale-time snapshot ───────────────────
      //
      // The combo product moved no stock, so the combo doc is not touched at
      // all — even a combo deleted since the sale cancels cleanly, because
      // everything needed lives in `comboComponents`.
      if (item.itemType === 'combo' && Array.isArray(item.comboComponents)) {
        for (const c of item.comboComponents) {
          const comp = cancelProductMap.get(String(c.product));
          if (!comp) continue;

          const compStkUnit = storageUnit(comp);
          let compPrev = 0;
          let compNew = 0;

          if (c.variantId) {
            const variant = (comp.variants && typeof comp.variants.id === 'function')
              ? comp.variants.id(c.variantId)
              : comp.variants?.find(v => (v._id || v.id)?.toString() === c.variantId?.toString());
            compPrev = variant?.stock || 0;
            compNew = quantize(compPrev + c.totalQuantity, compStkUnit);
            if (variant) variant.stock = compNew;

            restoreOps.push({
              updateOne: {
                filter: { _id: comp._id, 'variants._id': c.variantId },
                update: buildVariantStockUpdate(c.variantId, c.totalQuantity, compStkUnit),
              },
            });
          } else {
            compPrev = comp.stock || 0;
            compNew = quantize(compPrev + c.totalQuantity, compStkUnit);
            comp.stock = compNew;

            restoreOps.push({
              updateOne: {
                filter: { _id: comp._id },
                update: buildStockUpdate(c.totalQuantity, compStkUnit),
              },
            });
          }

          queueBatchRestore(comp, c.variantId, c.totalQuantity);

          cancelStockTxns.push({
            shop: shopId,
            branch: branchId || null,
            product: comp._id,
            productName: c.productName || comp.name,
            productCode: c.productCode || comp.code,
            variantId: c.variantId || null,
            variantSku: c.variantSku,
            variantAttributes: c.variantAttributes,
            type: 'return',
            quantity: c.totalQuantity,
            previousStock: compPrev,
            newStock: compNew,
            reference: {
              type: 'sale',
              id: sale._id,
              invoiceNo: sale.invoiceNo,
            },
            notes: `Sale cancelled: ${sale.invoiceNo} (combo: ${item.productName})`,
            viaCombo: {
              product: item.product,
              name: item.productName,
              code: item.productCode,
              comboQuantity: item.quantity,
            },
            createdBy: userId,
          });
        }
        continue;
      }

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

      queueBatchRestore(product, item.variantId, item.quantity);

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

    if (restoreOps.length > 0) {
      await Product.bulkWrite(restoreOps);
    }
    // After the stock restores, and in its own bulkWrite — see the note on
    // `queueBatchRestore` above and the matching split in `createSale`.
    if (cancelBatchOps.length > 0) {
      await Product.bulkWrite(cancelBatchOps);
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
