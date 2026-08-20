const Sale = require('../models/Sale.model');
const Product = require('../models/Product.model');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Payment = require('../models/Payment.model');
const User = require('../models/User.model');
const StockTransaction = require('../models/StockTransaction.model');
const CashRegister = require('../models/CashRegister.model');
const Shop = require('../models/Shop.model');
const AuditLog = require('../models/AuditLog.model');
const InvoiceCounter = require('../models/InvoiceCounter.model');
const { AppError } = require('../middleware/error.middleware');
const cacheService = require('./cache.service');
const paymentAccountService = require('./paymentAccount.service');
// The shared ledger write for "money reduces a customer's due" — the same one
// the customer page's বাকি আদায় goes through. See its header for why a second
// implementation here was not an option.
const dueSettlementService = require('./dueSettlement.service');
const logger = require('../utils/logger.util');
const {
  branchFilter,
  requireBranch,
  getBranchCode,
  wrongBranchError,
  isBranchCustomerScope,
} = require('../utils/branchScope.util');
const { normalizePhone } = require('../utils/phone.util');
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
  resolveTaxRate,
} = require('../utils/invoiceMath.util');
const { priceTierFor, sellingPriceFor, hasWholesalePrice } = require('../utils/pricing.util');
const { resolveLineRate } = require('../utils/lineDiscount.util');
const { resolveSaleDate } = require('../utils/saleDate.util');
const { resolveCustomInvoiceNo } = require('../utils/invoiceNo.util');
const { deductBatches, restoreBatches, batchWriteOp } = require('../utils/batch.util');
const { hasFeature } = require('../utils/features.util');
const { isCombo, findComponentVariant, isChooseSlot } = require('../utils/combo.util');

// "Today" in Bangladesh, from the shared definition in `bdTime.util`. This was
// a fourth private copy of the same offset arithmetic; the copies are what let
// the cash register drift onto a different day from the sales it counts.
const {
  getBangladeshTodayStr,
  getBangladeshTodayRange: bdTodayRange,
  getBangladeshDayRange,
  toBangladeshDateStr,
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
  //
  // `at` is the instant the sale is dated to. Omitted = now, which is every
  // ordinary checkout. An owner backdating an invoice passes the earlier
  // instant, and the number then comes from THAT day's series — a sale dated
  // the 10th reading `INV-MAIN-20260816-0004` would be a number that contradicts
  // the date printed beside it on the same piece of paper. The counter is keyed
  // on (shop, branch, day), so an older day simply continues where it left off;
  // and because it seeds itself from the sales already recorded on that day, a
  // day that predates the counter entirely resumes rather than restarting at
  // 0001.
  async generateInvoiceNumber(shopId, branchCode = null, branchId = null, at = null) {
    const dateStr = at ? toBangladeshDateStr(at) : getBangladeshTodayStr();
    const { startOfDay, endOfDay } = getBangladeshDayRange(dateStr);
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
      /**
       * The shop's own identity, for the printed invoice header.
       *
       * The invoice used to take this from `state.auth.shop` in the browser —
       * the session copy, fetched at login and cached server-side for 300s. So
       * a shop that renamed itself kept printing its OLD name on every invoice
       * until whoever was at the till happened to reload the app. The name at
       * the top of a document a customer keeps is not a thing to serve from a
       * session cache.
       *
       * Read here instead, on the request that renders the invoice, so it can
       * never be stale. The client still falls back to the session copy when
       * this is absent, which is what keeps older cached responses working.
       */
      .populate('shop', 'name address phone')
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

    /**
     * Whether this invoice may still be revised, decided by the server.
     *
     * Attached here rather than left to the client, because the answer depends
     * on six things the browser cannot see: a return's existence, a payment
     * recorded after checkout, the cash register's status, the Bangladesh
     * trading day, the revision chain and the sale's channel. A client
     * re-deriving them would show a সংশোধন button that the API then refuses —
     * worse than no button, because the seller has already told the customer.
     *
     * Two extra fields on a response the sale page already fetches; the reason
     * rides along so the UI can say WHY instead of just hiding the control.
     */
    const blocked = await this.reviseBlockedReason(shopId, sale);
    const result = sale.toObject();
    result.canRevise = blocked === null;
    result.reviseBlockedReason = blocked
      ? { code: blocked.code, message: blocked.message, messageBn: blocked.messageBn }
      : null;

    return result;
  }

  // Create new sale
  /**
   * @param {object} internalOptions NOT derived from any request body — only
   *   internal callers may pass it. The controllers never forward anything from
   *   `req.body` into this argument; doing so would reopen the client-priced
   *   sale that I-10 / §15.2 exist to prevent.
   *
   *   `unitPriceOverrides` — Map of `"<productId>"` or `"<productId>:<variantId>"`
   *     → price, used by `orderService.confirmOrder` so the Sale bills exactly
   *     what the online order QUOTED (the storefront's `onlinePrice ??
   *     sellingPrice`), not what the POS would charge today.
   *
   *   The rest are `reviseSale`'s, and each exists because a revision must be
   *   the SAME invoice, on the SAME day, inside the SAME transaction:
   *
   *   `session`        — join the caller's transaction rather than opening a
   *     second one. Without it the re-create reads stock from before the cancel
   *     restored it (see utils/transaction.util.js).
   *   `forceInvoiceNo` — reuse the original number instead of drawing a new one
   *     from the counter. The customer is holding paper with it printed on.
   *   `forceCreatedAt` — keep the original's timestamp. Load-bearing: revising
   *     a 9pm sale at 9:05 would otherwise move it across midnight into a day
   *     it did not happen on, taking its invoice number, stock movements,
   *     reports and drawer with it.
   *   `revisedFrom` / `revision` — the chain back to the superseded document.
   *
   *   With none of them passed, every line below behaves exactly as it did
   *   before they existed.
   */
  async createSale(shopId, userId, saleData, req, internalOptions = {}) {
    const unitPriceOverrides = internalOptions.unitPriceOverrides instanceof Map
      ? internalOptions.unitPriceOverrides
      : null;
    const {
      forceInvoiceNo = null,
      forceCreatedAt = null,
      revisedFrom = null,
      revision = 0,
      carryDueSnapshot = null,
      forceTaxRate = null,
    } = internalOptions;
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
      shippingAddress,
      saleDate: rawSaleDate,
      invoiceNo: rawInvoiceNo,
      /**
       * Settle part of the customer's existing খাতা at this checkout.
       *
       * `{ amount, method?, account?, }` — and it is EXPLICIT on purpose. The
       * obvious alternative was to infer it from surplus tendered (paid ৳2,700
       * on a ৳500 bill, so clear ৳2,200 of debt), and that is exactly wrong:
       * a cashier who fat-fingers `2700` for `270` would silently write down
       * a debt nobody paid, with no prompt and no way to notice. The POS asks,
       * and only what the cashier confirmed arrives here.
       *
       * Absent on every ordinary sale, from every older client, and from the
       * offline queue — so this whole feature is inert unless asked for (I-1).
       */
      dueSettlement: rawDueSettlement = null
    } = saleData;
    const customerId = rawCustomerId || rawCustomer;

    /**
     * An owner may say this invoice happened on an earlier day.
     *
     * `null` on every ordinary checkout. When it is set, the sale lands in that
     * day EVERYWHERE — its invoice number, its stock movements, its place in the
     * reports and the drawer — because all of them key off `createdAt`. See
     * utils/saleDate.util.js for why that is the model and what it costs.
     *
     * Resolved here, before anything is written, so a refusal costs nothing:
     * the whole body is inside `runInTransaction` and a throw rolls back, but a
     * gate that runs early never has anything to roll back.
     */
    const backdatedAt = resolveSaleDate({
      raw: rawSaleDate,
      req,
      shop: req?.shop,
    });

    /**
     * The shop may number this invoice itself.
     *
     * `null` on every ordinary checkout, and on every shop without
     * `features.customInvoiceNo` — which is all of them until an admin says
     * otherwise. When it is set, it REPLACES the generated number and the
     * per-(shop, branch, day) counter is never consulted, so the `INV-` series
     * stays exactly where it was and the capability can be switched back off
     * without leaving a gap.
     *
     * The SHOP, not the owner: the capability is the whole gate and there is no
     * per-user permission behind it, so `req` is not passed and not wanted. See
     * the "who may do it" note in utils/invoiceNo.util.js.
     *
     * Resolved here, beside `resolveSaleDate` and for the same reason: the
     * whole body is inside `runInTransaction`, so a gate that runs before
     * anything is written has nothing to roll back.
     *
     * Uniqueness is NOT checked here — see utils/invoiceNo.util.js. The unique
     * index decides, on the insert.
     */
    const customInvoiceNo = resolveCustomInvoiceNo({
      raw: rawInvoiceNo,
      shop: req?.shop,
    });
    // The wall-clock moment this invoice was actually typed. Kept apart from
    // `backdatedAt` because once `createdAt` moves, the Sale itself no longer
    // records it — only the audit entry below does.
    const enteredAt = new Date();

    /**
     * The day this invoice belongs to, whichever way it got there.
     *
     * `backdatedAt` is the owner saying "this happened on Thursday".
     * `forceCreatedAt` is a revision saying "this is still the same sale, on the
     * day it already had" — which is usually today, and is emphatically NOT a
     * backdate: no `sales.backdate` permission is consulted and no
     * `backdatedTo` is written, because nothing about WHEN the sale happened is
     * being claimed. It is being preserved.
     *
     * Collapsed into one name here rather than checked at each of the four
     * sites that date something (stock transactions, the invoice counter, the
     * document's `createdAt`, the customer's `lastPurchase`), so a fifth added
     * later inherits it instead of quietly landing on today.
     */
    const pinnedAt = forceCreatedAt || backdatedAt;
    const occurredAt = pinnedAt || enteredAt;

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

    /**
     * Resolve each leg to a fund account.
     *
     * ── Why this is here and not in the POS payload ─────────────────────────
     *
     * A shop WITHOUT `features.fundAccounts` sends no `account` on any leg, and
     * `resolveAccountForMethod` returns null for it without so much as a query
     * — so every leg below stays null and `applyAccountDelta` is a no-op. I-1
     * holds by construction: the flag-off path is byte-identical to what it was.
     *
     * A shop WITH the capability may still send a bare `method`, because the
     * account picker is opt-in per screen and an older client will not have it.
     * Falling back to that method's default account is what lets the capability
     * be adopted without every form being rewritten first.
     *
     * `assertUsableAccount` on the named ones because visibility is not
     * authority — an owner in All-Branches can SEE every branch's drawer and
     * must not be able to ring a Dhaka sale into the Chittagong one.
     */
    for (const leg of payments) {
      if (leg.account) {
        await paymentAccountService.assertUsableAccount(shopId, leg.account, req);
      } else {
        leg.account = await paymentAccountService.resolveAccountForMethod(
          req?.shop || { _id: shopId },
          leg.method,
          req
        );
      }
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
    // The phone is normalised to the stored form. It was matched raw, so a
    // cashier typing `+8801792449180` — or an offline payload carrying the
    // number as the customer's card prints it — missed an existing customer,
    // fell through to the `Customer.create` below, and blew up on the
    // {shop, phone} unique index. The sale failed at the till with a 500.
    let customer = null;
    if (customerId) {
      customer = await Customer.findOne({ _id: customerId, shop: shopId }).session(session || null);
    } else if (customerPhone) {
      customer = await Customer.findOne({
        shop: shopId,
        phone: normalizePhone(customerPhone),
      }).session(session || null);
    }

    // ── A soft-deleted customer must not take on new debt ──────────────────────
    //
    // Neither lookup filters `isActive`, deliberately: filtering here would send
    // a known phone down the create path and straight into E11000, since a
    // deleted customer still holds their number. So the record is found — and
    // then refused.
    //
    // It used to be found and USED. Every screen in the app hides an inactive
    // customer, but this path bound invoices to them anyway, so due accumulated
    // on a record nobody could open: one shop reached ৳1,06,305 that way, owed
    // by a customer their own due list could not show. The branch dashboard
    // counted it and the All-Branches dashboard did not, and no figure on either
    // page explained the gap (report.service.js carries the full account).
    //
    // Actionable rather than silent, now that `restoreCustomer` exists: the
    // cashier is told what is wrong and what to do about it.
    if (customer && customer.isActive === false) {
      throw new AppError(
        'This customer was deleted — restore them before selling to them again',
        'এই কাস্টমারকে মুছে ফেলা হয়েছে — বিক্রি করার আগে কাস্টমারকে ফিরিয়ে আনুন',
        400
      );
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

        // Coerced, bounded, and open to a negotiated rate — exactly as the
        // standard branch does. See the long block comment there; the only
        // difference here is which figures play the parts.
        //
        // The list rate is the COMBO's own price, and the cost floor is the
        // per-combo component cost that was just summed. A combo bargained
        // below what its components cost is the same loss as a plain line
        // bargained below its buying price, and the same owner-only rule
        // applies.
        //
        // A confirmed online order never reaches here with an override — combos
        // are not sold through checkout — but the guard is written the same way
        // so the two branches cannot drift.
        const comboLineValue = quantizeMoney(comboUnitPrice * comboQty);
        const comboQuoted = overrideFor(product._id) !== null;
        const comboRate = comboQuoted
          ? { agreedUnitPrice: undefined, discount: 0 }
          : resolveLineRate({
            raw: item.agreedUnitPrice,
            listUnitPrice: comboUnitPrice,
            quantity: comboQty,
            buyingPrice: quantizeMoney(comboBuying),
            shop: req?.shop,
            req,
            productName: product.name,
          });
        const comboItemDiscount = comboRate.agreedUnitPrice !== undefined
          ? Math.min(comboRate.discount, comboLineValue)
          : Math.min(toMoney(item.discount), comboLineValue);
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
          agreedUnitPrice: comboRate.agreedUnitPrice,
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

      // ── The line discount, coerced and bounded ──────────────────────────────
      //
      // `item.discount || 0` used to land here straight off the wire. There is
      // no Joi schema on the sale routes, so a client holding `sales.create`
      // could post any number it liked — and a discount larger than the line
      // drove `itemTotal` negative, which dragged `subtotal` down, which
      // understated `total`, `profit` and the customer's ledger together. The
      // schema's `min: 0` catches a negative; it does not catch a ৳50,000
      // discount on a ৳500 line, which is not negative.
      //
      // `toMoney` is the same last-line-of-defence coercion every other money
      // figure on this invoice goes through (`''`, `'abc'`, `NaN`, `Infinity`
      // and negatives all read as 0), and the bound is the line's own value —
      // the per-line equivalent of `discountAmountFor` clamping the invoice
      // discount to the subtotal. A line can be given away; it cannot be given
      // away twice.
      //
      // ── A negotiated rate replaces all of that ────────────────────────────
      //
      // `features.lineDiscount` lets the cashier type a RATE instead: "৳১০০
      // each, but ৳৯০ for you". `resolveLineRate` derives the concession from
      // it and owns every gate — the capability, the `sales.discount`
      // permission, the below-cost floor and the shop's own cap. When it
      // answers, its answer WINS: the client's `discount` is ignored entirely,
      // because a payload that can name both could name a rate of ৳৯০ and a
      // discount of ৳৯০০ and be believed about the second.
      //
      // THE POSITION OF THIS BLOCK IS LOAD-BEARING. It sits after the pack
      // block above so that `unitPrice` is already the final per-base-unit list
      // rate — tier resolved, pack rate applied. A negotiated rate therefore
      // REPLACES the wholesale and pack rates rather than compounding with
      // them, which is the same call the pack block makes about wholesale three
      // comments up: stacking two discounts the shopkeeper meant to give once
      // is how a carton leaves at a price nobody quoted.
      //
      // `unitPriceOverrides` (a confirmed online order) is checked first and
      // skips this entirely — that sale is billed at what the customer was
      // shown on the website, and a till-side negotiation has no meaning there.
      const lineValue = quantizeMoney(unitPrice * item.quantity);
      const quotedLine = overrideFor(product._id, item.variantId || null) !== null;
      const rate = quotedLine
        ? { agreedUnitPrice: undefined, discount: 0 }
        : resolveLineRate({
          raw: item.agreedUnitPrice,
          listUnitPrice: unitPrice,
          quantity: item.quantity,
          buyingPrice,
          shop: req?.shop,
          req,
          productName: product.name,
        });
      const itemDiscount = rate.agreedUnitPrice !== undefined
        ? Math.min(rate.discount, lineValue)
        : Math.min(toMoney(item.discount), lineValue);
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
        // Display-only, and written ONLY from `resolveLineRate` — see the field
        // note on `saleItemSchema`. Absent on every ordinary line.
        agreedUnitPrice: rate.agreedUnitPrice,
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
      /**
       * A backdated sale moved its goods on the backdated day.
       *
       * Stamped here rather than at each of the three `stockTransactions.push`
       * sites (plain line, variant line, combo component) — one place to be
       * right, and a fourth push added later inherits it for free instead of
       * quietly landing on today.
       *
       * If this were left as now, the stock ledger would say the rice left the
       * shelf on Saturday while the invoice that sold it says Thursday, and the
       * two would never reconcile for the day either of them names.
       */
      if (pinnedAt) {
        for (const txn of stockTransactions) txn.createdAt = pinnedAt;
      }
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
    //
    // ── VAT comes from the SHOP, never from the payload ──────────────────────
    //
    // `tax` is still destructured above and still passed, but from here it is
    // only reachable by a shop with no configured rate — `taxAmountFor`
    // discards it the moment one applies. That is deliberate: the amount of VAT
    // on a document a customer keeps must not be something a client can choose,
    // and this route has no Joi bound on the figure.
    //
    // `taxEnabled` is a separate switch from a non-zero `taxRate` because both
    // states are real: a shop that has switched VAT off for now keeps the rate
    // it typed, and must bill nothing until it switches back on.
    const totals = computeInvoiceTotals({
      subtotal,
      discount,
      discountType,
      tax,
      // A revision inherits the ORIGINAL invoice's rate rather than today's.
      // The goods were sold under the rate that was configured then, and a
      // shop that has since moved from 5% to 15% must not re-bill a past
      // purchase at the new one — the customer would be asked for money they
      // were never quoted. Same argument as `forceCreatedAt` beside it: a
      // revision corrects an invoice, it does not re-date or re-price it.
      taxRate: forceTaxRate != null ? forceTaxRate : resolveTaxRate(req?.shop),
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
    // Normalised, because this is a SNAPSHOT written onto the invoice and read
    // back by the SMS receipt, the due-aging report (which groups on it) and
    // every "find the sale by phone" lookup. A walk-in sale typed as
    // `+8801792449180` used to store that literal string on the Sale while the
    // Customer document stored `01792449180`, so the same person's invoices
    // sorted into two groups depending on how the cashier typed the number.
    let finalCustomerPhone = normalizePhone(customerPhone) || customerPhone;

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

    // ── The খাতা as it stands, read BEFORE this sale touches it ─────────────
    //
    // Two things need this figure and both need it from HERE rather than after
    // the rollup: the invoice's "পূর্বের বাকি" line (a snapshot, because
    // deriving it live rewrites every reprint — see `Sale.previousDue`) and the
    // ceiling on how much of that debt this checkout is allowed to settle.
    //
    // Read in whichever book the shop keeps, so the figure the invoice prints
    // and the figure the settlement is validated against are the same number.
    const branchCustomerScope = isBranchCustomerScope(req);
    let previousDue = customer
      ? await dueSettlementService.readCollectableDue(
          {
            shopId,
            customerId: customer._id,
            branchId,
            branchScoped: branchCustomerScope,
            // Already loaded, and read here BEFORE the rollup moves it — which
            // is what makes handing it over safe. Saves a round trip on every
            // checkout for a known customer at a single-branch shop, which is
            // most checkouts on the platform.
            customerDoc: customer,
          },
          session
        )
      : null;

    let dueSettled = 0;
    let settleAmount = 0;
    // Filled by the settlement block far below; see its note. Declared here so
    // the return can reach it whether or not anything was actually settled.
    let dueAllocations = [];

    if (carryDueSnapshot) {
      // A revision is not a new money event. It rewrites the basket of an
      // invoice already rung up, and the collection that rode in with the
      // original is untouched by that — it settled OTHER invoices and lives on
      // as its own immutable `Payment` row, which `cancelSale` deliberately
      // does not sweep. So the replacement inherits both snapshots verbatim
      // rather than re-reading a book that has moved since.
      previousDue = carryDueSnapshot.previousDue;
      dueSettled = carryDueSnapshot.dueSettled || 0;
    } else if (rawDueSettlement && !revisedFrom) {
      // A walk-in has no খাতা to settle, so there is nothing this money could
      // be applied to. Refused rather than ignored: dropping it silently would
      // hand back ৳2,200 the shopkeeper believes they just collected, and the
      // only trace would be a customer who never asks for it again.
      if (!customer) {
        throw new AppError(
          'Cannot settle a due without a customer on the sale',
          'কাস্টমার ছাড়া আগের বাকি জমা নেওয়া যাবে না',
          400
        );
      }

      settleAmount = toMoney(rawDueSettlement.amount);

      // Refused, never silently trimmed. The cashier is standing in front of
      // the customer with the money already counted out: if the খাতা moved
      // between loading the till and pressing sell — another branch collected,
      // a return settled — quietly applying less than was handed over leaves
      // the difference unaccounted for and tells nobody. An error at the till
      // is recoverable; a silent shortfall in the book is not.
      if (settleAmount > (previousDue || 0)) {
        throw new AppError(
          `Due settlement of ${settleAmount} exceeds the outstanding due of ${previousDue || 0}`,
          `আগের বাকি এখন ৳${previousDue || 0} — জমার পরিমাণ ঠিক করে আবার চেষ্টা করুন`,
          400
        );
      }
      dueSettled = settleAmount;
    }

    // Create sale with retry for invoice number collision
    let sale;
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const branchCode = req ? getBranchCode(req) : null;
        // A revision reuses the original number — the customer is holding paper
        // with it printed on, and after a reprint that paper must still be the
        // invoice. `reviseSale` frees the unique key first by renaming the
        // superseded document to `…~r1`.
        //
        // ORDER IS LOAD-BEARING. `forceInvoiceNo` outranks a typed one: a
        // revision resubmits the whole basket, so the POS may well post the
        // number it is showing, and if that won, revising an invoice would
        // rename the original to `…~r1` and then write the replacement under a
        // DIFFERENT number — leaving the customer's paper pointing at a
        // cancelled document. The revision keeps its number whatever is posted.
        const invoiceNo = forceInvoiceNo
          || customInvoiceNo
          || await this.generateInvoiceNumber(shopId, branchCode, branchId, pinnedAt);
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
          // Snapshotted so the receipt can say "ভ্যাট (১৫%)" and go on saying it
          // after the shop changes its rate. See the field's note on `Sale`.
          taxRate: totals.taxRate,
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
          /**
           * Set ONLY when the owner backdated the invoice; `undefined` leaves
           * Mongoose's `timestamps` to stamp now, exactly as before.
           *
           * Mongoose does not overwrite a `createdAt` that the document already
           * carries, which is what makes this work at all — and is also why it
           * must be `undefined` rather than `null` in the ordinary case, since
           * a null would be "already set" and defeat the timestamp.
           *
           * `updatedAt` is deliberately left alone. It is the record's own
           * modification time, not the sale's, and pinning it to the past would
           * make a backdated invoice look like it had never been touched.
           */
          ...(pinnedAt ? { createdAt: pinnedAt } : {}),
          /**
           * The chain back to the document this replaced. Written together and
           * only for a revision, so an ordinary sale carries neither field and
           * `revision` keeps its schema default of 0 — which is what makes this
           * a no-migration change: absent means "never revised", everywhere.
           */
          ...(revisedFrom ? { revisedFrom, revision } : {}),
          /**
           * The খাতা snapshots. Spread rather than assigned so a walk-in with no
           * customer record leaves `previousDue` ABSENT — readers have to tell
           * "owed nothing" (0) apart from "we did not record it" (undefined),
           * and every sale written before this field existed is the latter.
           */
          ...(previousDue === null || previousDue === undefined ? {} : { previousDue }),
          dueSettled,
        }], sessionOpt);
        sale = newSale;
        break; // Success — exit retry loop
      } catch (err) {
        // Retrying is what resolves a race for the NEXT counter value. A forced
        // number has no next value to draw, so a duplicate there is a real
        // conflict — the caller failed to free the unique key — and retrying
        // would just fail twice more and report the wrong reason.
        //
        // A TYPED number is the same case for a different reason: there is no
        // next value because a human chose this one. Retrying would redraw the
        // identical string three times and then report the third failure.
        const chosen = forceInvoiceNo || customInvoiceNo;
        if (err.code === 11000 && !chosen && attempt < maxRetries - 1) {
          // Duplicate invoiceNo — retry with new number
          continue;
        }
        /**
         * Re-raise the one duplicate a human can actually act on.
         *
         * `handleDuplicateFieldsDB` would already turn this into a 409 saying
         * "এই ইনভয়েস নম্বর আগে থেকেই আছে", which is the right message. What it
         * cannot say is whether retrying would help — and the offline queue has
         * to know: `lib/offlineErrors.js` treats 409 as TRANSIENT, because the
         * only 409 a queued sale could previously get was the idempotency
         * middleware saying "same request still in flight", which does resolve
         * on retry. A taken invoice number never will, so without a code to
         * distinguish it a parked sale retries until it hits the attempt cap,
         * silently, and the cashier is never told to pick another number.
         *
         * Raised as a real `AppError` rather than by tagging `err`: a mutated
         * Mongo error still has no `isOperational`, so `sendErrorProd` would
         * take its unknown-error branch, replace this Bengali sentence with the
         * generic one and drop the `code` — the single field this exists to
         * deliver.
         *
         * Sale carries exactly one unique index (`{shop, invoiceNo}`), so an
         * 11000 on this insert is always the invoice number.
         */
        if (err.code === 11000 && customInvoiceNo) {
          const taken = new AppError(
            `Invoice number ${customInvoiceNo} is already used in this shop`,
            `এই ইনভয়েস নম্বর (${customInvoiceNo}) আগে থেকেই ব্যবহার করা হয়েছে — অন্য নম্বর দিন`,
            409
          );
          taken.code = 'INVOICE_NO_TAKEN';
          throw taken;
        }
        throw err; // Not a duplicate or last attempt — rethrow
      }
    }

    // Update customer statistics if customer exists
    if (customer) {
      const purchasedAt = occurredAt;
      customer.totalPurchases += total;
      customer.totalPaid += paid;
      customer.totalDue += due;
      customer.purchaseCount += 1;
      /**
       * "Last purchase" only ever moves FORWARD.
       *
       * The money totals above are running sums and are correct whichever day
       * the sale is dated to. This one is not: entering last Thursday's sale on
       * Saturday, for a customer who also bought on Friday, would otherwise
       * rewrite their last purchase to Thursday — and every "not seen for N
       * days" list and dormant-customer follow-up reads this field.
       */
      if (!customer.lastPurchase || purchasedAt > customer.lastPurchase) {
        customer.lastPurchase = purchasedAt;
      }
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

    /**
     * Settle the old খাতা — as its OWN money event, never as a larger `paid`.
     *
     * ── Why the two are not merged ──────────────────────────────────────────
     *
     * A ৳500 sale and a ৳2,200 debt collection are different kinds of thing: one
     * is revenue, one is a receivable coming off the book. Folding the second
     * into `sale.paid` looks tempting — one number, one row — and breaks four
     * things at once, none of them loudly:
     *
     *   1. The day's SALES read ৳2,700 instead of ৳500. Every report, every
     *      profit percentage and every staff target inherits that.
     *   2. `Customer.totalPaid` gains ৳2,200 with no purchase behind it, so
     *      `Customer.deriveDue` — purchases + opening − paid — can never
     *      reconcile again.
     *   3. A sales return allocates its refund PROPORTIONALLY against the
     *      invoice's own figures, so a return on this ৳500 bill would refund
     *      against ৳2,700.
     *   4. `computeInvoiceTotals` clamps `paid` to the total precisely so an
     *      overpayment cannot become a credit; unclamping it here would restore
     *      the bug that file was written to end.
     *
     * Kept separate, everything already works: the drawer holds ৳500 of sale
     * legs plus a ৳2,200 `due_collection`, and the `atCheckout` discriminator
     * keeps the cash register from counting either twice.
     *
     * Ordered AFTER the rollup above deliberately. The rollup adds this
     * invoice's own due to the customer; the settlement was already bounded
     * against `previousDue`, read before any of it, so the ceiling is the debt
     * the customer walked in with and not one this sale just created.
     */
    if (settleAmount > 0 && customer) {
      const settled = await dueSettlementService.settleCustomerDue({
        shopId,
        userId,
        customer,
        amount: settleAmount,
        branchId,
        branchScoped: branchCustomerScope,
        // The invoice's dominant method unless the cashier named another — a
        // customer can settle the খাতা in cash while paying the bill by bKash.
        method: rawDueSettlement.method || paymentMethod,
        rawAccount: rawDueSettlement.account || null,
        /**
         * Dated to the sale it rode in on, not to now.
         *
         * `paidAt` is what every daily-collection figure and the cash register
         * bucket on, so a backdated invoice must carry a backdated collection
         * — otherwise entering Thursday's sale on Saturday puts the goods in
         * Thursday's books and the money in Saturday's.
         */
        paidAt: occurredAt,
        viaSale: sale._id,
        req,
      }, session);

      /**
       * Only if the two disagree — which they should not, since both figures
       * come from the same `toMoney`. This is the assertion that the number
       * printed on the invoice is the number the `Payment` row actually moved.
       *
       * `updateOne` rather than `sale.save()`: saving re-runs `pre('save')`,
       * which re-derives `paid`, `due`, `status` and `profit` from the items.
       * Idempotent today, but this write exists to record one figure the hook
       * knows nothing about. Same reason `reviseSale` renames by update.
       */
      if (settled.amount !== dueSettled) {
        dueSettled = settled.amount;
        await Sale.updateOne({ _id: sale._id }, { $set: { dueSettled } }, sessionOpt);
        sale.dueSettled = dueSettled;
      }

      /**
       * Which OLD invoices this settlement closed, carried back to the till.
       *
       * Not persisted — it is a fact about the collection, not about this
       * invoice, and `reallocateCustomerInvoices` can re-derive it at any time.
       * But the cashier is standing at the counter with the customer in front
       * of them, and "৳2,200 জমা — HFG202600403 পরিশোধ হয়েছে" is checkable
       * against the paper in the customer's hand in a way that a ledger total
       * silently dropping by ৳2,200 never is.
       */
      dueAllocations = settled.allocations || [];
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
        // The LARGEST leg's account, matching `method` right above it. This row
        // is the invoice's payment history, not the balance mover — the legs
        // below are what actually move money, one account each. Naming the
        // dominant one here keeps the two fields telling the same story rather
        // than one saying `bkash` and the other pointing at the cash box.
        account: payments.find((leg) => leg.method === paymentMethod)?.account || null,
        type: 'sale_payment',
        atCheckout: true,
        receivedBy: userId,
      }], sessionOpt);
    }

    /**
     * Move the money, leg by leg.
     *
     * ── Why the legs and not the `Payment` row above ────────────────────────
     *
     * That row carries ONE method for the whole `paid`, which on a split
     * invoice is only the largest leg — crediting a bKash account with ৳1000
     * when ৳400 of it went into the drawer. The legs are the only place the
     * split truth lives, so they are what moves the balances. This is the same
     * distinction `report.service` got wrong for the method breakdown, and the
     * cash register got right.
     *
     * The checkout flag set on the row above is what keeps
     * `recalc-account-balances.js` from counting this money twice: the script
     * sums these legs and skips every `Payment` row carrying that flag.
     *
     * Inside `sessionOpt`, deliberately. A balance moved outside the transaction
     * that moved the money it describes survives a rollback the money did not —
     * the sale would vanish and the ৳1000 would still be in the drawer.
     */
    for (const leg of payments) {
      await paymentAccountService.applyAccountDelta({
        shop: shopId,
        account: leg.account,
        amount: Number(leg.amount) || 0,
        session: sessionOpt.session || null,
      });
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
          /**
           * The one place the true entry time survives a backdate.
           *
           * `Sale.createdAt` has been moved to the day the owner named, so the
           * sale itself can no longer answer "when was this actually typed" —
           * and that is the question support and the owner ask first when a
           * closed day's total changes. Both instants are recorded here, and
           * only here, so the answer exists.
           *
           * Absent on every ordinary sale, where `createdAt` already is the
           * entry time and a second copy would be noise.
           */
          ...(backdatedAt
            ? { backdatedTo: backdatedAt, enteredAt }
            : {}),
          /**
           * This number was CHOSEN, not generated.
           *
           * Same reasoning as `backdatedTo` above: once it is stored, the Sale
           * itself cannot answer where its number came from — `A-1043` and a
           * generated number are both just strings on the document. Worth
           * recording because it is the question asked when a shop's series has
           * a gap or a repeat in it, and because a permission exists to grant
           * and revoke this, which is only meaningful if its use is visible.
           *
           * Absent on every ordinary sale.
           */
          ...(customInvoiceNo ? { invoiceNoChosen: true } : {}),
        },
      },
    }).catch((err) => logger.error(`Audit log (sale_create) failed: ${err.message}`));

    // ── A separate entry for every negotiated line ────────────────────────────
    //
    // Deliberately NOT folded into the `sale_create` summary above. That entry
    // answers "what was sold"; this one answers "who gave away the shop's
    // margin, on what, and how much" — which is the question the whole
    // capability is switched on to be able to ask, and the reason
    // `sales.discount` is a permission of its own.
    //
    // Written unconditionally rather than above some threshold: these are rare
    // events by construction (a line has to be individually bargained to
    // produce one), and a threshold would hide precisely the pattern worth
    // catching — a cashier taking ৳20 off every third invoice.
    //
    // Fire-and-forget and outside the transaction, exactly like the entry
    // above. An audit write that could roll a sale back would be a checkout
    // that fails because the logging did.
    const negotiatedLines = processedItems.filter((i) => i.agreedUnitPrice !== undefined);
    if (negotiatedLines.length > 0) {
      AuditLog.create({
        shop: shopId,
        user: userId,
        action: 'sale_line_discount',
        actionBn: 'পণ্যভিত্তিক ছাড়',
        description:
          `Line discounts on ${sale.invoiceNo}: ` +
          negotiatedLines
            .map((i) => `${i.productName} ৳${i.unitPrice}→৳${i.agreedUnitPrice} (−৳${i.discount})`)
            .join('; '),
        descriptionBn:
          `${sale.invoiceNo} — পণ্যভিত্তিক ছাড়: ` +
          negotiatedLines
            .map((i) => `${i.productName} ৳${i.unitPrice}→৳${i.agreedUnitPrice} (−৳${i.discount})`)
            .join('; '),
        entity: {
          type: 'sale',
          id: sale._id,
          name: sale.invoiceNo,
        },
        changes: {
          after: {
            invoiceNo: sale.invoiceNo,
            lines: negotiatedLines.map((i) => ({
              product: i.product,
              productName: i.productName,
              listUnitPrice: i.unitPrice,
              agreedUnitPrice: i.agreedUnitPrice,
              quantity: i.quantity,
              discount: i.discount,
            })),
            totalLineDiscount: quantizeMoney(
              negotiatedLines.reduce((sum, i) => sum + (Number(i.discount) || 0), 0)
            ),
          },
        },
      }).catch((err) => logger.error(`Audit log (sale_line_discount) failed: ${err.message}`));
    }

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

    /**
     * Which old invoices the checkout settlement closed, ridden back to the POS
     * on the sale document.
     *
     * Set non-strict so it survives `toJSON` without a schema migration, and
     * simply absent on every sale that settled nothing. Not persisted, because
     * it is not a fact about THIS invoice — see the note where it is filled in.
     */
    if (dueAllocations.length > 0) {
      sale.set('dueAllocations', dueAllocations, { strict: false });
    }

    return sale;
    }, internalOptions.session ? { session: internalOptions.session } : {});
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
  /**
   * `req` is appended LAST and defaulted, so every existing call site keeps
   * working unchanged. It is needed only to resolve a fund account —
   * `assertUsableAccount` and `resolveAccountForMethod` both scope by branch
   * through `accountScope.util`, and neither can be given a bare shop id.
   */
  async recordPayment(shopId, userId, saleId, paymentData, branchId = null, req = null, internalOptions = {}) {
    const { skipReceiptSms = false } = internalOptions;
    return await runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};
      const { method, transactionId, notes, account: rawAccount } = paymentData;

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

      /**
       * Which fund account this money landed in.
       *
       * This path had none. `createSale` names an account per leg,
       * `dueSettlement` names one, `expense` and `purchase` name one — and
       * `recordPayment`, the path a shopkeeper uses to settle an invoice from
       * its own detail page, wrote a `Payment` with `account: null` and moved
       * no balance. So money genuinely arriving in the bank never reached the
       * bank's figure, and FUND_ACCOUNT_PLAN Phase 2's "every money path names
       * an account" was true of every path but this one.
       *
       * It went unnoticed because `recalc-account-balances.js` matches on
       * `account: accountId`, so rows carrying null are not counted and no
       * DRIFT is reported — the checker and the writer were wrong in the same
       * direction.
       *
       * Named by the caller, or resolved from the method's default so an
       * existing client posting a bare `method: 'bkash'` books the money
       * somewhere real. Null throughout for a shop without
       * `features.fundAccounts`, which makes the delta below a no-op (I-1).
       */
      const account = rawAccount
        ? (await paymentAccountService.assertUsableAccount(shopId, rawAccount, req))._id
        : await paymentAccountService.resolveAccountForMethod(
            req?.shop || { _id: shopId },
            method || 'cash',
            req
          );

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
        account,
        transactionId,
        type: 'sale_payment',
        notes,
        receivedBy: userId,
      }], sessionOpt);

      // Money in. Zero-effect when `account` is null.
      await paymentAccountService.applyAccountDelta({
        shop: shopId,
        account,
        amount,
        session: session || null,
      });

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

        // Settling an invoice directly SHRINKS what it can absorb from the
        // khata pool, so any allocation already sitting on it may now overflow.
        // Concretely: a ৳7,000 invoice carrying ৳4,200 of khata money is paid
        // ৳4,200 by hand — without this, the invoice would show ৳4,200 of
        // allocation it no longer has room for, and the pre-save clamp would
        // quietly discard it instead of moving it to the next open invoice.
        await dueSettlementService.reallocateCustomerInvoices({
          shopId,
          customerId: claimed.customer,
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

      // Send payment receipt SMS (non-blocking — runs in background).
      //
      // Suppressed for a courier handover: the customer has NOT paid anything,
      // the parcel has merely left the shop, and "আপনি ৳2,400 পরিশোধ করেছেন" is
      // both untrue and alarming when it arrives days before delivery.
      if (claimed.customer && !skipReceiptSms) {
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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * COD — the money that is with someone else
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A ৳2,400 COD parcel used to be booked as ৳2,400 of CUSTOMER debt, because
   * `order.service.confirmOrder` calls `createSale` with `paid: 0` and the
   * customer is created from the phone number. That is wrong twice over: the
   * customer owes nothing until the parcel reaches them, and the money that is
   * genuinely owed to the shop is owed by the COURIER, who is holding it.
   *
   * Everything downstream inherited it — the বাকি list, `Customer.totalDue`,
   * due-aging and the due-reminder SMS all chased people whose parcel had not
   * arrived.
   *
   * ── The mechanism, and why it needed nothing new ─────────────────────────
   *
   * `PaymentAccount` already defines itself as "a place the shop's money
   * actually sits". A courier holding ৳70,000 of COD is exactly that, so a
   * courier is a `PaymentAccount` of `type: courier` and the handover is an
   * ordinary `Payment` naming it. Settlement later is an `AccountTransfer`
   * whose `charge` — the gap between what the courier owed and what they paid
   * — is the courier fee, and `report.service` ALREADY sums transfer charges
   * into `netProfit` as a genuine cost of trading.
   *
   * Three existing mechanisms, each doing the job it was built for. See
   * COD_PLAN.md.
   */

  /**
   * Hand a parcel to a courier: the COD amount stops being the customer debt
   * and becomes that courier balance.
   *
   * Deliberately a thin wrapper over `recordPayment` rather than a second money
   * path: that method already carries the atomic `due >= amount` claim, the
   * customer-ledger pair that keeps I-4, the khata reallocation and the audit
   * entry. Reimplementing any of it here is how the two would drift.
   */
  async dispatchToCourier(shopId, userId, { saleId, account }, req = null) {
    if (!account) {
      throw new AppError(
        'A courier account is required',
        'কোন কুরিয়ার নিয়েছে তা নির্বাচন করুন',
        400
      );
    }

    const courier = await paymentAccountService.assertUsableAccount(shopId, account, req);
    if (courier.type !== 'courier') {
      // A bank account is a place money sits too, but handing a parcel to it is
      // meaningless. Refusing here keeps every courier balance answerable to
      // "what is in transit" rather than to whatever was picked.
      throw new AppError(
        'That account is not a courier',
        'এই অ্যাকাউন্টটি কুরিয়ার নয়',
        400
      );
    }

    const sale = await Sale.findOne({ _id: saleId, shop: shopId });
    if (!sale) throw new AppError('Sale not found', 'বিক্রয় পাওয়া যায়নি', 404);
    if (sale.courier) {
      throw new AppError(
        'This parcel is already with a courier',
        'এই পার্সেলটি ইতিমধ্যে একটি কুরিয়ারের কাছে আছে',
        409
      );
    }
    if ((sale.due || 0) <= 0) {
      // Nothing to collect — a prepaid parcel. It still ships; it just carries
      // no money for the courier to hold, so there is no leg to write.
      throw new AppError(
        'This invoice has nothing left to collect',
        'এই বিলে আদায়ের মতো কিছু বাকি নেই',
        400
      );
    }

    const { sale: updated, payment } = await this.recordPayment(
      shopId,
      userId,
      saleId,
      {
        amount: sale.due,
        method: 'courier',
        account: courier._id,
        notes: `কুরিয়ারে হস্তান্তর: ${courier.name}`,
      },
      sale.branch || null,
      req,
      // No receipt SMS. Telling a customer they have paid ৳2,400 when their
      // parcel has only just left the shop is both untrue and alarming.
      { skipReceiptSms: true }
    );

    // The ref is what carries the money; `courierName` stays the print
    // snapshot. See the field note on `Sale`.
    await Sale.updateOne(
      { _id: sale._id, shop: shopId },
      { $set: { courier: courier._id, courierName: courier.name } }
    );

    return { sale: updated, payment, courier };
  }

  /**
   * The parcel came back. Take the money back off the courier.
   *
   * RTO runs 15–40% in Bangladeshi e-commerce, so this is a routine event, not
   * an exception path. It is a SEPARATE step from cancelling or returning the
   * sale, deliberately: the parcel physically coming back and the invoice being
   * voided are two different facts, and a shop that gets a parcel back may well
   * re-dispatch it rather than cancel.
   *
   * A counter `Payment{type: refund}` rather than an edit — `Payment` is an
   * immutable ledger (`immutableGuard`), and `recalc-account-balances.js`
   * already counts refunds against an account as money out. So the checker
   * needed no change: the reversal is expressed in rows it already understood.
   */
  async undispatchFromCourier(shopId, userId, { saleId, reason = '' }, req = null) {
    return await runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};

      const sale = await Sale.findOne({ _id: saleId, shop: shopId }).session(session || null);
      if (!sale) throw new AppError('Sale not found', 'বিক্রয় পাওয়া যায়নি', 404);
      if (!sale.courier) {
        throw new AppError(
          'This parcel is not with a courier',
          'এই পার্সেলটি কোনো কুরিয়ারের কাছে নেই',
          400
        );
      }

      const courierId = sale.courier;

      // What the courier is actually holding for THIS parcel: the leg written
      // at dispatch, less anything already reversed. Read from the rows rather
      // than assumed to be `sale.paid`, which also carries money taken at
      // checkout — a part-prepaid COD parcel would otherwise claw back the
      // customer own advance as well.
      const legs = await Payment.find({
        shop: shopId,
        sale: sale._id,
        account: courierId,
        method: 'courier',
      }).select('amount type').session(session || null).lean();

      const held = quantizeMoney(legs.reduce(
        (sum, leg) => sum + (leg.type === 'refund' ? -(leg.amount || 0) : (leg.amount || 0)),
        0
      ));
      if (held <= 0) {
        throw new AppError(
          'Nothing is held against this parcel',
          'এই পার্সেলে কুরিয়ারের কাছে কোনো টাকা নেই',
          400
        );
      }

      // 1. The invoice goes back to owing. `save()` re-derives `due`, `status`
      //    and `profit` from the accumulators — the same reason `recordPayment`
      //    re-reads and saves rather than patching those by hand.
      sale.paid = Math.max(0, quantizeMoney((sale.paid || 0) - held));
      sale.courier = null;
      await sale.save(sessionOpt);

      // 2. The counter-row.
      await Payment.create([{
        shop: shopId,
        branch: sale.branch || null,
        sale: sale._id,
        customer: sale.customer,
        amount: held,
        method: 'courier',
        account: courierId,
        type: 'refund',
        reference: sale.invoiceNo,
        notes: reason ? `পার্সেল ফেরত: ${reason}` : 'পার্সেল ফেরত এসেছে',
        receivedBy: userId,
      }], sessionOpt);

      // 3. The courier is no longer holding it.
      await paymentAccountService.applyAccountDelta({
        shop: shopId,
        account: courierId,
        amount: -held,
        session: session || null,
      });

      // 4. Both customer books, by the same arithmetic, in this transaction.
      //    I-4: quantizing or clamping one and not the other is exactly how the
      //    two drift apart.
      if (sale.customer) {
        const customer = await Customer.findById(sale.customer).session(session || null);
        if (customer) {
          customer.totalPaid = quantizeMoney((customer.totalPaid || 0) - held);
          customer.totalDue = Customer.deriveDue(customer);
          await customer.save(sessionOpt);
        }

        await CustomerBalance.applyDelta({
          shop: shopId,
          customer: sale.customer,
          branch: sale.branch,
          paid: -held,
        }, session);
        await CustomerBalance.recomputeDue({
          shop: shopId,
          customer: sale.customer,
          branch: sale.branch,
        }, session);
      }

      await AuditLog.create([{
        shop: shopId,
        user: userId,
        action: 'courier_undispatch',
        actionBn: 'পার্সেল ফেরত',
        description: `Parcel for ${sale.invoiceNo} returned from courier. Released ৳${held}.`,
        descriptionBn: `${sale.invoiceNo} এর পার্সেল কুরিয়ার থেকে ফেরত। ৳${held} ছাড়া হয়েছে।`,
        entity: { type: 'sale', id: sale._id, name: sale.invoiceNo },
        changes: { before: { courier: String(courierId) }, after: { courier: null } },
      }], sessionOpt);

      this.invalidateCache(shopId).catch(() => {});
      return { sale, released: held };
    });
  }

  // Cancel sale
  /**
   * ── Transactional as of the revision work ─────────────────────────────────
   *
   * This used to run four independent writes with no atomicity: a `bulkWrite`
   * restoring stock, a second one rewriting FEFO batches, an `insertMany` of
   * stock transactions, the customer-ledger unwind, and finally `sale.save()`.
   * An error anywhere between the first and the last left goods back on the
   * shelf with the sale still `completed` — stock the shop thought it had, sold
   * against an invoice that was never cancelled.
   *
   * That was a latent bug on its own merits, independent of revision. It is
   * fixed here because nothing may COMPOSE with a half-atomic cancel: a
   * revision is a cancel followed by a create, and "half of it landed" is the
   * one outcome that must be impossible.
   *
   * `internalOptions.session` joins a caller's transaction rather than opening
   * a second one — see the header of utils/transaction.util.js for why that
   * distinction is load-bearing and not a micro-optimisation.
   *
   * @param {object} internalOptions NOT derived from any request body.
   *   `session` joins an ambient transaction; `revisedTo` records that this
   *   cancellation is a supersession rather than a void.
   */
  async cancelSale(shopId, userId, saleId, reason, activeBranchId = null, internalOptions = {}) {
    return await runInTransaction(async (session) => {
    const sessionOpt = session ? { session } : {};
    const saleQuery = { _id: saleId, shop: shopId };
    if (activeBranchId) saleQuery.branch = activeBranchId;
    const sale = await Sale.findOne(saleQuery, null, sessionOpt);
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
    /**
     * A parcel a courier is still holding cannot be voided behind their back.
     *
     * `cancelSale` reverses `sale.payments[]` — the CHECKOUT legs — and
     * deliberately does not touch post-checkout `Payment` rows, which are
     * reversed on their own paths. A courier leg is one of those, so cancelling
     * here would leave the courier balance holding money for an invoice that no
     * longer exists, and `recalc-account-balances.js` would report the drift
     * with no write path to blame.
     *
     * The right sequence is the one that matches the physical world: the parcel
     * comes back (`undispatchFromCourier`), and THEN the invoice is voided. So
     * this refuses, and says which step is missing rather than failing
     * mysteriously.
     */
    if (sale.courier) {
      throw new AppError(
        'This parcel is still with a courier — record its return first',
        'পার্সেলটি এখনো কুরিয়ারের কাছে আছে — আগে ফেরত এসেছে বলে রেকর্ড করুন',
        409
      );
    }

    if ((sale.returnedAmount || 0) > 0) {
      throw new AppError(
        'This sale has returns against it — return the remaining items instead of cancelling.',
        'এই বিক্রয়ের বিপরীতে মাল ফেরত নেওয়া হয়েছে — বাতিল না করে বাকি পণ্যগুলোও ফেরত নিন।',
        400
      );
    }

    // ── The day's drawer has been counted ─────────────────────────────────────
    //
    // `reviseSale` has refused this since it shipped (`reviseBlockedReason`
    // guard 6) and cancellation did not, which made the weaker operation the way
    // round it: a sale that could not be corrected on a reconciled day could
    // still be voided on one, and voiding moves the same money.
    //
    // A closed register is a statement that the cash on hand was counted against
    // what the system expected. Cancelling a sale inside that window silently
    // restates the expectation after the count — the drawer no longer ties out
    // and nothing on the screen says why. The remedy is the same one revision
    // points at: reopen the day deliberately, or record a sales return, which is
    // dated when it happens rather than backdated into a closed period.
    //
    // Checked before any write, and last among the guards, because it is the
    // only one that costs a query against a collection the sale does not point
    // at. `order.service.cancelOrder` inherits it — an online order whose sale
    // lands in a reconciled day now fails loudly instead of quietly moving the
    // till, which is the same trade every other write in that period makes.
    // `saleDay` can only be null for a document with no `createdAt`, which
    // `timestamps: true` makes impossible for anything that came out of the
    // database. Guarded anyway: there is no day to look up a register for, and
    // throwing a TypeError out of the middle of a reversal — before the stock
    // has gone back but after the caller believes it is cancelling — is a far
    // worse failure than skipping a check that has nothing to check against.
    const saleDay = toBangladeshDateStr(sale.createdAt);
    if (saleDay) {
      const { startOfDay, endOfDay } = getBangladeshDayRange(saleDay);
      const register = await CashRegister.findOne(
        {
          shop: shopId,
          // Single-branch shops carry `branch: null` on both documents, so an
          // unconditional `branch` predicate would match the row it should.
          ...(sale.branch ? { branch: sale.branch } : {}),
          date: { $gte: startOfDay, $lte: endOfDay },
        },
        'status',
        sessionOpt
      ).lean();

      if (register?.status === 'closed') {
        throw new AppError(
          'The cash register for that day is closed — reopen it or record a sales return instead.',
          'ওই দিনের ক্যাশ রেজিস্টার বন্ধ করা হয়েছে — রেজিস্টার আবার খুলুন, অথবা মাল ফেরত হিসেবে লিখুন।',
          409
        );
      }
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
    const cancelProducts = await Product.find(
      { _id: { $in: cancelProductIds }, shop: shopId },
      null,
      sessionOpt
    );
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
      await Product.bulkWrite(restoreOps, sessionOpt);
    }
    // After the stock restores, and in its own bulkWrite — see the note on
    // `queueBatchRestore` above and the matching split in `createSale`.
    if (cancelBatchOps.length > 0) {
      await Product.bulkWrite(cancelBatchOps, sessionOpt);
    }
    if (cancelStockTxns.length > 0) {
      await StockTransaction.insertMany(cancelStockTxns, sessionOpt);
    }

    // Update customer balance if applicable
    if (sale.customer) {
      // ── The due is DERIVED, never `$inc`-ed ────────────────────────────────
      //
      // `totalDue` used to come off with the rest, as `$inc: -sale.due`. That is
      // wrong whenever the stored due and the invoice have stopped agreeing,
      // and it fails in the one direction nobody checks — downward, past zero.
      //
      // The case that bites: an owner writes off a customer's debt with a
      // `DueAdjustment`, which reduces `openingDue` and `totalDue` without ever
      // touching `sale.due`. Cancelling that invoice afterwards then subtracts
      // its due a second time and the customer ends up with a NEGATIVE balance —
      // the shop's book now says it owes the customer money. `deriveDue` cannot
      // do that: it recomputes from `openingDue + totalPurchases − totalPaid`
      // and clamps at zero, so it is self-correcting rather than cumulative.
      //
      // This is the same two-step the returns path already uses (`$inc` the
      // components, then derive the due) — the two reversal paths disagreeing on
      // how the headline figure is produced is what let them drift apart.
      await Customer.findByIdAndUpdate(sale.customer, {
        $inc: {
          totalPurchases: -sale.total,
          totalPaid: -sale.paid,
          purchaseCount: -1,
        },
      }, sessionOpt);

      const cancelCustomer = await Customer.findById(sale.customer).session(session || null);
      if (cancelCustomer) {
        // `deriveDue` carries the `openingDue` term, so a cancellation cannot
        // wipe debt the customer brought in from the shop's paper খাতা.
        cancelCustomer.totalDue = Customer.deriveDue(cancelCustomer);
        await cancelCustomer.save(sessionOpt);
      }

      // Unwound at the branch that raised the sale — which is the only branch
      // whose figures the sale ever moved.
      //
      // `recomputeDue` rather than a `due` delta, mirroring the clamp above.
      // Clamping on one side only is precisely how the shop-wide book and the
      // per-branch rows drift apart while `Σ CustomerBalance.totalDue ===
      // Customer.totalDue` still looks like it should hold.
      await CustomerBalance.applyDelta({
        shop: shopId,
        customer: sale.customer,
        branch: sale.branch,
        purchases: -sale.total,
        paid: -sale.paid,
        count: -1,
      }, session);
      await CustomerBalance.recomputeDue({
        shop: shopId,
        customer: sale.customer,
        branch: sale.branch,
      }, session);

      // ── Khata money that was sitting on this invoice has to go somewhere ────
      //
      // A cancelled invoice is not a receivable, so any `ledgerSettled` it was
      // carrying is now unallocated — and the collection that produced it is
      // untouched, as it must be: the customer really did hand the money over
      // and its `Payment{due_collection}` row is immutable.
      //
      // Left alone, that money would simply stop reducing anything and the
      // shop's invoice book would re-inflate by the cancelled invoice's share.
      // The reallocator is a full recompute, so calling it here moves the freed
      // amount onto the customer's next-oldest open invoice with no reversal
      // arithmetic of its own to get wrong. Cheap and correct beats clever.
      //
      // NOTE for the reader chasing `-sale.paid` above: that unwinds only what
      // was tendered AT this invoice. Khata money is deliberately not in `paid`
      // — see the `ledgerSettled` note on `Sale` — so cancelling cannot claw
      // back a collection the customer actually made.
      // `branchScoped` deliberately omitted — `cancelSale` takes no `req`, so
      // the reallocator resolves the shop's book mode itself. See its note.
      await dueSettlementService.reallocateCustomerInvoices({
        shopId,
        customerId: sale.customer,
      }, session);
    }

    /**
     * Take the money back out of the accounts it went into.
     *
     * ── Why this is leg-by-leg and reads the SALE, not the payload ──────────
     *
     * `createSale` credited one account per leg. The reversal has to debit the
     * same ones, in the same amounts, or the balances keep money the shop no
     * longer has — and it will not show up as an error anywhere. It will show up
     * months later as a bank balance that has never matched the statement, which
     * is exactly how `variants[].stock` drifted from `product.stock`.
     *
     * `sale.payments[]` carries the accounts the money actually went to, which
     * is why the field is stored per leg rather than resolved again here: a
     * default account can be changed between the sale and its cancellation, and
     * re-resolving would credit today's default with money that went into
     * yesterday's.
     *
     * Money collected AFTER checkout is deliberately not touched here. Those are
     * `Payment` rows with `atCheckout: false`, they are reversed on their own
     * paths, and a cancelled invoice with a later collection against it is
     * already refused above by the returns guard.
     *
     * Inside the transaction, like every other reversal in this block.
     */
    for (const leg of (sale.payments || [])) {
      await paymentAccountService.applyAccountDelta({
        shop: shopId,
        account: leg.account,
        amount: -(Number(leg.amount) || 0),
        session: session || null,
      });
    }

    // Update sale status
    sale.status = 'cancelled';
    sale.cancelledAt = new Date();
    sale.cancelledBy = userId;
    sale.cancelReason = reason;
    sale.notes = `${sale.notes || ''}\nCancelled: ${reason}`;
    // Set by `reviseSale` only: this document was superseded, not voided, and
    // this is the invoice that replaced it. Absent on an ordinary cancellation.
    if (internalOptions.revisedTo) sale.revisedTo = internalOptions.revisedTo;
    await sale.save(sessionOpt);

    // ── Give back the counter `createSale` took ───────────────────────────────
    //
    // `createSale` does `$inc: { 'stats.totalSales': 1 }` and nothing gave it
    // back, so the figure counted invoices ever WRITTEN rather than invoices
    // that stand. A shop that voids a mistake and re-rings it was counted twice
    // for one sale, and the operator console's per-shop activity column drifted
    // further from the truth with every cancellation. Found reading 9 on a shop
    // with 4 live invoices.
    //
    // A revision is a cancel plus a create, so this nets to zero across the pair
    // and the count keeps meaning "invoices that stand" through a revision too.
    //
    // The `$gt: 0` on the FILTER, not a clamp after the fact: `$inc` has no
    // floor, and a stat that has already drifted low (or was never incremented,
    // for sales predating the counter) must not be driven negative by a
    // cancellation that is otherwise correct. No match simply means there is
    // nothing to give back.
    await Shop.updateOne(
      { _id: shopId, 'stats.totalSales': { $gt: 0 } },
      { $inc: { 'stats.totalSales': -1 } },
      sessionOpt
    );

    // Create audit log.
    //
    // Deliberately NOT passed `sessionOpt`, exactly as before and for the same
    // reason `createSale`'s entry is not: an audit write that could roll the
    // cancellation back would be a reversal that fails because the logging did.
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
    }, internalOptions.session ? { session: internalOptions.session } : {});
  }

  /**
   * Why this invoice cannot be revised, or null if it can.
   *
   * Split out of `reviseSale` so the sale detail page can ask the SAME question
   * without attempting the write — `getSaleById` attaches the answer as
   * `canRevise` / `reviseBlockedReason`. Re-deriving six guards in the client
   * would give a button that appears when the server would refuse, which is
   * worse than no button.
   *
   * Ordered by how much money each one saves, not by how cheap it is to check.
   *
   * @returns {Promise<{code: string, message: string, messageBn: string,
   *                    statusCode: number}|null>}
   */
  async reviseBlockedReason(shopId, sale) {
    if (!sale) return null;

    // 1. Already cancelled, or already superseded by a later revision. Both are
    //    "this document is not the live invoice" — revising it would fork the
    //    chain and leave two documents claiming the same number.
    if (sale.status === 'cancelled') {
      return {
        code: 'SALE_CANCELLED',
        message: 'This sale is cancelled and cannot be revised.',
        messageBn: 'এই বিক্রয়টি বাতিল করা হয়েছে — সংশোধন করা যাবে না।',
        statusCode: 400,
      };
    }
    if (sale.revisedTo) {
      return {
        code: 'ALREADY_REVISED',
        message: 'This version has already been replaced by a newer revision.',
        messageBn: 'এই সংস্করণটি ইতিমধ্যে সংশোধিত হয়েছে — নতুন সংস্করণটি খুলুন।',
        statusCode: 400,
      };
    }

    // 2. A return exists against it. The return has ALREADY put stock back and
    //    ALREADY credited the customer, and it allocated its refund
    //    proportionally against the original line values. Revising on top counts
    //    both twice — the same reasoning that makes `cancelSale` refuse here.
    //    The remedy is the return, which knows what it has already reversed.
    if ((sale.returnedAmount || 0) > 0) {
      return {
        code: 'HAS_RETURN',
        message: 'This sale has returns against it — use a return instead of revising.',
        messageBn: 'এই বিক্রয়ের বিপরীতে মাল ফেরত নেওয়া হয়েছে — সংশোধন না করে মাল ফেরত ব্যবহার করুন।',
        statusCode: 409,
      };
    }

    // 3. Not the same Bangladesh trading day. Yesterday has been reported on and
    //    its drawer counted. The cliff is deliberate and it is the whole reason
    //    this is affordable: a closed day needs the amendment model, not this.
    const saleDay = toBangladeshDateStr(sale.createdAt);
    if (saleDay !== getBangladeshTodayStr()) {
      return {
        code: 'DIFFERENT_DAY',
        message: 'A sale can only be revised on the day it was made.',
        messageBn: 'যেদিন বিক্রি হয়েছে সেদিনই কেবল সংশোধন করা যায় — এর জন্য মাল ফেরত ব্যবহার করুন।',
        statusCode: 409,
      };
    }

    // 4. The sale came from an online order. That Sale is the settlement of an
    //    `Order` with its own lifecycle; revising it desynchronises the two
    //    silently, and the order screen would keep showing the old basket.
    if (sale.isOnline || (sale.channel && sale.channel !== 'pos')) {
      return {
        code: 'ONLINE_SALE',
        message: 'An online order’s sale cannot be revised — edit the order instead.',
        messageBn: 'অনলাইন অর্ডারের বিক্রয় সংশোধন করা যাবে না — অর্ডারটি সম্পাদনা করুন।',
        statusCode: 400,
      };
    }

    // 5. Money arrived after checkout. `atCheckout` is exactly this distinction:
    //    true means the row is the checkout leg already recorded in
    //    `sale.payments[]`, false means a later, separate money event with its
    //    own history (`recordPayment`, a due collection). A revision rewrites
    //    the invoice those events were settled against.
    const laterPayment = await Payment.exists({
      shop: shopId,
      sale: sale._id,
      atCheckout: { $ne: true },
    });
    if (laterPayment) {
      return {
        code: 'LATER_PAYMENT',
        message: 'A payment was recorded against this sale after checkout.',
        messageBn: 'বিক্রয়ের পরে এই ইনভয়েসে পেমেন্ট নেওয়া হয়েছে — সংশোধন করা যাবে না।',
        statusCode: 409,
      };
    }

    // 6. The drawer for that day and branch has been reconciled. A till whose
    //    sales change underneath it is precisely what reconciliation exists to
    //    prevent. Checked last because it is the only guard that costs a query
    //    against a collection the sale does not point at.
    const { startOfDay, endOfDay } = getBangladeshDayRange(saleDay);
    const register = await CashRegister.findOne({
      shop: shopId,
      // Single-branch shops carry `branch: null` on both documents, so an
      // unconditional `branch` predicate would match the row it should.
      ...(sale.branch ? { branch: sale.branch } : {}),
      date: { $gte: startOfDay, $lte: endOfDay },
    }).select('status closedAt').lean();

    if (register?.status === 'closed') {
      return {
        code: 'REGISTER_CLOSED',
        message: 'The cash register for this day is closed.',
        messageBn: 'এই দিনের ক্যাশ রেজিস্টার বন্ধ করা হয়েছে — সংশোধন করা যাবে না।',
        statusCode: 409,
      };
    }

    return null;
  }

  /**
   * Replace a printed invoice with a corrected one, keeping its number.
   *
   * ── SUPERSEDE, never mutate ───────────────────────────────────────────────
   *
   * The old document is CANCELLED through the path that already knows how to
   * unwind a sale, and a new one is written that inherits its invoice number.
   * Nothing is edited in place, because everything downstream of a sale is
   * append-only or delta-based: `StockTransaction` stores previousStock /
   * newStock snapshots, FEFO consumed specific expiry batches that are not
   * derivable from an edited line, `CustomerBalance.applyDelta` is a running
   * delta rather than a recompute, and the audit trail, the staff report and
   * the line-discount figures have all already counted the original. See
   * SALE_REVISION_PLAN.md §2.1.
   *
   * The seller submits a CART, not a patch: the payload is the same one
   * `POST /api/sales` takes, and the new sale goes through `createSale` in full
   * — same pricing resolution, same stock guard, same combo handling, same
   * `resolveLineRate`, same validation. A line-level patch API would need a
   * parallel copy of all of it.
   *
   * ── STEP ORDER IS LOAD-BEARING ─────────────────────────────────────────────
   *
   *   rename → cancel → create
   *
   * The rename must precede the create or the `{shop, invoiceNo}` unique index
   * rejects the new document. The cancel must precede the create or the stock
   * guard measures against stock that is about to be restored, and a revision
   * that only adds an item would fail on a product that has plenty.
   *
   * All of it in ONE transaction. Half of this landing — stock restored, no
   * replacement invoice — leaves the shop short a sale it has been paid for.
   *
   * @param {object} saleData the full new basket (a `createSale` payload)
   * @returns {Promise<Sale>} the new, live invoice
   */
  async reviseSale(shopId, userId, saleId, saleData, req) {
    return await runInTransaction(async (session) => {
      const sessionOpt = { session };

      const saleQuery = { _id: saleId, shop: shopId };
      if (req?.branchId) saleQuery.branch = req.branchId;
      const original = await Sale.findOne(saleQuery, null, sessionOpt);
      if (!original) {
        throw new AppError('Sale not found', 'বিক্রয় পাওয়া যায়নি', 404);
      }

      const blocked = await this.reviseBlockedReason(shopId, original);
      if (blocked) {
        const error = new AppError(blocked.message, blocked.messageBn, blocked.statusCode);
        error.code = blocked.code;
        throw error;
      }

      const liveInvoiceNo = original.invoiceNo;
      const nextRevision = (original.revision || 0) + 1;
      const previousTotal = original.total;
      const previousItemCount = original.items.length;

      /*
       * Free the unique key.
       *
       * `~` is deliberate and is the whole reason this is safe: it appears in no
       * generated invoice number, so `INV-…-0007~r1` can never collide with a
       * real one, while a PREFIX search for `INV-…-0007` still finds every
       * version. The suffix is internal — visible in history, never printed.
       *
       * `updateOne` rather than `original.save()`: saving the whole document
       * would run `pre('save')`, which re-derives `due` and `profit`. Harmless
       * today, but this write exists only to move a string.
       */
      await Sale.updateOne(
        { _id: original._id },
        { $set: { invoiceNo: `${liveInvoiceNo}~r${nextRevision}` } },
        sessionOpt
      );
      original.invoiceNo = `${liveInvoiceNo}~r${nextRevision}`;

      // Reverses stock, batches, the customer ledger and the shop counters,
      // inside THIS transaction. `revisedTo` is filled in below, once the
      // replacement exists to point at.
      await this.cancelSale(
        shopId,
        userId,
        original._id,
        'revised',
        original.branch || null,
        { session }
      );

      const revised = await this.createSale(shopId, userId, saleData, req, {
        session,
        forceInvoiceNo: liveInvoiceNo,
        // Same day, same invoice. Not a backdate — see the note on `pinnedAt`.
        forceCreatedAt: original.createdAt,
        revisedFrom: original._id,
        revision: nextRevision,
        // See the note at the `taxRate` line in `computeInvoiceTotals`' call.
        forceTaxRate: original.taxRate || 0,
        /**
         * The খাতা snapshots travel with the invoice number.
         *
         * A revision rewrites the BASKET. It does not un-collect money: the
         * ৳2,200 that rode in with the original settled invoices that were
         * already closed, and it survives as its own immutable `Payment` row —
         * `cancelSale` sweeps `Sale.payments[]` and rows keyed on `sale`,
         * and a settlement is neither (see `Payment.viaSale`).
         *
         * So the replacement must inherit both figures rather than re-derive
         * them. Re-deriving would read a book the original has already moved
         * and print "পূর্বের বাকি ৳0 / জমা ৳0" on the reprint of an invoice
         * whose customer is holding paper that says ৳2,200 — the exact
         * rewriting-history failure the snapshots exist to prevent.
         */
        carryDueSnapshot: {
          previousDue: original.previousDue,
          dueSettled: original.dueSettled || 0,
        },
      });

      // Written after the create, because until now there was nothing to point
      // at. `updateOne` for the same reason as the rename above.
      await Sale.updateOne(
        { _id: original._id },
        { $set: { revisedTo: revised._id } },
        sessionOpt
      );

      // Outside the session, like every other audit write in this service: a
      // log failure must never roll back the money.
      AuditLog.create({
        shop: shopId,
        user: userId,
        action: 'sale_revise',
        actionBn: 'বিক্রয় সংশোধন',
        description:
          `Revised ${liveInvoiceNo} (r${nextRevision}): `
          + `৳${previousTotal} → ৳${revised.total}, `
          + `${previousItemCount} → ${revised.items.length} lines`,
        descriptionBn:
          `বিক্রয় সংশোধন ${liveInvoiceNo} (সংস্করণ ${nextRevision}): `
          + `৳${previousTotal} → ৳${revised.total}, `
          + `${previousItemCount} → ${revised.items.length} লাইন`,
        entity: {
          type: 'sale',
          id: revised._id,
          name: liveInvoiceNo,
        },
        changes: {
          before: {
            saleId: original._id,
            invoiceNo: original.invoiceNo,
            total: previousTotal,
            paid: original.paid,
            due: original.due,
            itemCount: previousItemCount,
          },
          after: {
            saleId: revised._id,
            invoiceNo: revised.invoiceNo,
            total: revised.total,
            paid: revised.paid,
            due: revised.due,
            itemCount: revised.items.length,
            revision: nextRevision,
          },
        },
      }).catch((err) => logger.error(`Audit log (sale_revise) failed: ${err.message}`));

      /**
       * ── Put the khata money back where it belongs, now the replacement exists ─
       *
       * A revision is cancel-then-recreate. The cancellation inside it already
       * ran the reallocator — but at that moment the replacement invoice did
       * not exist yet, so any `ledgerSettled` the original was carrying was
       * spread over the customer's OTHER open invoices, or left unallocated
       * because there were none.
       *
       * Either way the replacement is born at `ledgerSettled: 0` while the
       * collection that paid for it is still in the pool, and the invoice book
       * re-inflates by exactly that amount — the original bug, arriving through
       * the one door that closes and reopens an invoice in a single request.
       *
       * The recompute is idempotent, so running it a second time inside the same
       * transaction costs one aggregate and writes only what actually moved.
       */
      if (revised.customer) {
        await dueSettlementService.reallocateCustomerInvoices({
          shopId,
          customerId: revised.customer,
        }, session);
      }

      return revised;
    });
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
