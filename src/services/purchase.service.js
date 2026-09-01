const Purchase = require('../models/Purchase.model');
const Product = require('../models/Product.model');
const Supplier = require('../models/Supplier.model');
const Payment = require('../models/Payment.model');
const SupplierBalance = require('../models/SupplierBalance.model');
const StockTransaction = require('../models/StockTransaction.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { branchFilter, requireBranch } = require('../utils/branchScope.util');
const { endOfBangladeshDay, getBangladeshTodayRange, getBangladeshMonthRange, toBangladeshMonthStr } = require('../utils/bdTime.util');
const mongoose = require('mongoose');
const { runInTransaction } = require('../utils/transaction.util');
const paymentAccountService = require('./paymentAccount.service');
const supplierSettlement = require('./supplierSettlement.service');
const {
  // `parseQuantity` is reached through `resolveLineQuantity` now, so the pack
  // branch and the loose branch cannot validate a quantity two different ways.
  quantityUnit,
  storageUnit,
  quantize,
  quantizeMoney,
  buildStockUpdate,
  buildVariantStockUpdate,
} = require('../utils/quantity.util');
const { assertPeriodOpen } = require('../utils/periodLock.util');
const { resolveLineQuantity } = require('../utils/packaging.util');
const { deductBatches, batchWriteOp, sameOwner } = require('../utils/batch.util');
const { assertNotCombo } = require('../utils/combo.util');
const {
  buildProductCostUpdate,
  buildVariantCostUpdate,
  blendedCost,
} = require('../utils/costing.util');
const {
  parseSellingPrice,
  buildSellingPriceUpdate,
  buildSellingPriceRestore,
  buildWholesalePriceUpdate,
  buildWholesalePriceRestore,
} = require('../utils/purchasePrice.util');
const { toMoney } = require('../utils/invoiceMath.util');
const { LIVE_PAYMENT } = require('../utils/paymentDate.util');
const { computePurchaseTotals } = require('../utils/purchaseMath.util');
const { normalizeWholesalePrice } = require('../utils/pricing.util');
const { hasFeature } = require('../utils/features.util');

class PurchaseService {
  // Get all purchases with filtering and pagination
  async getPurchases(shopId, options = {}) {
    const {
      page = 1,
      limit = 20,
      supplier,
      startDate,
      endDate,
      status,
      dueOnly,
      includeCancelled,
      search,
      sortBy = 'date',
      sortOrder = 'desc',
    } = options;

    // Every filter below is ANDed onto the shop predicate (I-5) — there is no
    // such thing as a purchase query without `shop`.
    const query = { shop: shopId };

    // Cancelled bills are hidden by DEFAULT: a voided purchase is not a
    // payable. But hidden is not erased (F-6) — `?status=cancelled` lists only
    // them, and `?includeCancelled=true` shows them beside the live ones, which
    // is the view a month-end review reads.
    if (status) {
      query.status = status;
    } else if (!(includeCancelled === true || includeCancelled === 'true')) {
      query.status = { $ne: 'cancelled' };
    }

    // Branch scoping
    if (options.branchId) {
      query.branch = options.branchId;
    }

    if (supplier) {
      // Cast explicitly. `find()` would cast a valid string itself (I-3 is an
      // aggregation trap), but this id comes off the query string and an
      // invalid one must be a 400, not a CastError 500.
      if (!mongoose.Types.ObjectId.isValid(String(supplier))) {
        throw new AppError('Invalid supplier id', 'সরবরাহকারী সঠিক নয়', 400);
      }
      query.supplier = new mongoose.Types.ObjectId(String(supplier));
    }

    // "যাদের বাকি আছে" — open payables only. Re-asserts the cancelled
    // exclusion whatever the flags above said: a cancelled purchase keeps its
    // stored `due` figure (the pre-save hook skips cancelled docs), and a
    // voided bill is not owed.
    if (dueOnly === true || dueOnly === 'true') {
      query.due = { $gt: 0 };
      query.status = { $ne: 'cancelled' };
    }

    // Matches OUR number and the supplier's challan number, case-insensitive.
    // Escaped so a pasted "PUR(" cannot 500 the list.
    if (search && String(search).trim()) {
      const rx = new RegExp(
        String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'i'
      );
      query.$or = [{ invoiceNo: rx }, { supplierInvoiceNo: rx }];
    }

    if (startDate || endDate) {
      // Against the backdatable `date` — the day the goods arrived — never
      // `createdAt`, the day someone sat down with the phone.
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      // End of the Bangladesh calendar day — see the same note in
      // expense.service.js for what server-local `setHours` cost here.
      if (endDate) query.date.$lte = endOfBangladeshDay(endDate);
    }

    const skip = (page - 1) * limit;
    const sortField = ['date', 'createdAt', 'total', 'invoiceNo'].includes(sortBy) ? sortBy : 'date';
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

    const [purchases, total] = await Promise.all([
      Purchase.find(query)
        .populate('supplier', 'name phone')
        .populate('createdBy', 'name')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Purchase.countDocuments(query),
    ]);

    return {
      data: purchases,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Get single purchase
  async getPurchaseById(shopId, purchaseId, req = null) {
    const purchase = await Purchase.findOne(branchFilter(req, {
      _id: purchaseId,
      shop: shopId,
    }))
      .populate('supplier', 'name phone address')
      .populate('items.product', 'name code stock')
      .populate('createdBy', 'name')
      // Who voided it, for the detail page's cancelled banner. Null on every
      // live purchase and on purchases cancelled before the F-6 fields existed.
      .populate('cancelledBy', 'name');

    if (!purchase) {
      throw new AppError('ক্রয়টি পাওয়া যায়নি', 'Purchase not found', 404);
    }

    return purchase;
  }

  // Create purchase — the main action that increases stock
  async createPurchase(shopId, userId, purchaseData, req) {
    return await runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};
      const { items, supplier, paid, paymentMethod, date, notes } = purchaseData;
      const rawPayments = Array.isArray(purchaseData.payments) ? purchaseData.payments : [];

      // The পাইকারি column only exists for a shop that bought the capability
      // (I-7). Resolved ONCE here rather than per line: `hasFeature` reads the
      // request's shop document, and asking it twenty times in the item loop
      // would be twenty identical answers.
      const wholesaleEnabled = hasFeature(req, 'wholesale');

    if (!items || items.length === 0) {
      throw new AppError('কমপক্ষে একটি পণ্য যোগ করুন', 'At least one item is required', 400);
    }

    // Validate supplier if provided
    let supplierDoc = null;
    let supplierName = 'সরাসরি কেনা';
    if (supplier) {
      supplierDoc = await Supplier.findOne({
        _id: supplier,
        shop: shopId,
        isActive: true,
      }).session(session || null);
      if (!supplierDoc) {
        throw new AppError('সরবরাহকারী পাওয়া যায়নি', 'Supplier not found', 404);
      }
      supplierName = supplierDoc.name;
    }

    // Validate and prepare items
    const preparedItems = [];
    let totalAmount = 0;

    // Resolve every referenced product in ONE query. This was a
    // `Product.findOne(...)` per line, and the stock loop below then re-read
    // each of the same documents with `findById` — a 20-line delivery paid 40
    // reads for 20 documents (PERFORMANCE_AUDIT.md H-3).
    //
    // The id is normalised the same way as before, because the form may post
    // `product`, `productId`, or a populated object.
    const normalizeProductId = (item) => {
      let raw = item.product || item.productId;
      if (typeof raw === 'object' && raw !== null) raw = raw._id || raw.id;
      return raw;
    };
    const purchaseProductIds = [...new Set(
      items.map(normalizeProductId).filter(Boolean).map(String)
    )];
    const purchaseProducts = await Product.find({
      _id: { $in: purchaseProductIds },
      shop: shopId,
      isActive: true,
    }).session(session || null);
    const purchaseProductMap = new Map(purchaseProducts.map(p => [String(p._id), p]));

    for (const item of items) {
      const rawProdId = normalizeProductId(item);
      const product = rawProdId ? purchaseProductMap.get(String(rawProdId)) : null;

      if (!product) {
        const displayId = typeof rawProdId === 'object' ? JSON.stringify(rawProdId) : rawProdId;
        throw new AppError(
          `পণ্য "${item.productName || displayId}" পাওয়া যায়নি`,
          `Product not found: ${displayId}`,
          404
        );
      }

      // A combo is never bought — buying one would mint stock no shelf holds.
      // The shop purchases the COMPONENT products; the combo's availability
      // follows from theirs.
      assertNotCombo(product, 'ক্রয়');

      // `parseInt` used to live here, which is what made purchases integer-only.
      // `parseQuantity` keeps that behaviour exactly for any shop without the
      // packaging flag — `quantityUnit` hands it 'piece' (decimals: 0), which
      // refuses fractions outright rather than truncating them. It also rejects
      // negatives, non-numbers and values past the safe-precision ceiling, all
      // of which `parseInt` let through (`parseInt('12abc')` is 12).
      //
      // The purchase form may post either shape:
      //
      //     { quantity: 100 }                              100 kg, loose
      //     { purchaseUnit: 'pack', packQuantity: 5 }      5 sacks of the
      //                                                    product's own pack
      //
      // `resolveLineQuantity` collapses both to a base-unit number and hands
      // back the snapshot to store alongside it. Stock is still incremented by
      // `quantity` in the base unit exactly as before — the pack is a record of
      // what was bought, never a second quantity to reconcile.
      const line = resolveLineQuantity(item, product, req, {
        qtyUnit: quantityUnit(req, product),
        // `sellByPack: false` must not block a delivery — see
        // `packPurchaseAllowed`. Loose rice is never sold by the sack and is
        // always bought by it.
        flow: 'purchase',
      });
      const quantity = line.quantity;

      // Suppliers quote per pack ("৳১৮০০ per bag"), so the form may send the
      // pack rate. Cost is stored per BASE unit — the division is what keeps
      // `unitPrice` meaning one thing on every purchase line ever written.
      // Unrounded on purpose: rounding ৳১০০০/৩ to ৳৩৩৩.৩৩ and multiplying back
      // books ৳৯৯৯.৯৯ against a bill that says ৳১০০০.
      let packUnitPrice = null;
      let unitPrice;
      if (line.mode === 'pack' && item.packUnitPrice != null && Number(item.packUnitPrice) > 0) {
        packUnitPrice = quantizeMoney(Number(item.packUnitPrice));
        unitPrice = packUnitPrice / line.packSize;
      } else {
        // Validated, not `parseFloat`-ed and hoped for. `quantity` has always
        // gone through `parseQuantity`; the cost beside it was the one money
        // input on this path with no check at all, so a missing or malformed
        // `unitPrice` became NaN, rode through `quantizeMoney` (which returns 0
        // for non-finite) into a ৳0 line total, and — now that cost feeds the
        // moving average below — would have written the shelf's cost basis to
        // zero. A number this important must fail loudly.
        unitPrice = Number(item.unitPrice);
        if (!Number.isFinite(unitPrice) || unitPrice < 0) {
          throw new AppError(
            `Invalid unit price for ${product.name}`,
            `"${product.name}" এর ক্রয় মূল্য ঠিকভাবে লিখুন`,
            400
          );
        }
        if (line.mode === 'pack') packUnitPrice = quantizeMoney(unitPrice * line.packSize);
      }
      const itemTotal = quantizeMoney(quantity * unitPrice);

      // ── The new retail price, if the shopkeeper set one ──────────────────
      //
      // Optional by design. Empty, null, or 0 all mean "leave the shelf price
      // alone" — a cleared number input posts 0, and writing ৳0 as a price
      // because someone emptied a box would hand the goods away for free. The
      // same reading `packSellingPrice` and `wholesalePrice` already use.
      //
      // Anything NON-empty is validated hard rather than coerced, exactly like
      // `unitPrice` above: a malformed price silently becoming NaN → 0 is how
      // a shop ends up selling at nothing, and this figure is written straight
      // onto the product where every future sale reads it.
      //
      // Quoted per BASE unit even on a pack line. The cost box flips to the
      // supplier's per-pack rate because that is what the bill says; the retail
      // price does not, because that is what the customer pays and what
      // `Product.sellingPrice` has always meant.
      const sellingPrice = parseSellingPrice(item.sellingPrice, product.name);

      // ── The পাইকারি rate, if the shop has the capability ────────────────
      //
      // `normalizeWholesalePrice` owns the whole gate: it 403s a client that
      // posts the key without `features.wholesale`, 400s a malformed figure,
      // and reads 0 and '' as "no rate" rather than as free. Reproducing any of
      // that here would be a second copy of an entitlement check, which is how
      // the two drift.
      //
      // A shop without the flag never sends the key, so this returns undefined
      // and the line stores nothing — which is what keeps a flag-off shop
      // byte-identical (I-7).
      const wholesalePrice = normalizeWholesalePrice(
        item.wholesalePrice,
        wholesaleEnabled,
        { label: product.name }
      );

      // A variant line must name a variant that exists. Without this the id
      // falls through to the stock write, whose `arrayFilters` match nothing,
      // and `bulkWrite` reports success for a delivery that increased no stock
      // at all — goods received, ledger written, shelf count unchanged.
      if (item.variantId) {
        const exists = (product.variants && typeof product.variants.id === 'function')
          ? product.variants.id(item.variantId)
          : product.variants?.find(v => String(v._id || v.id) === String(item.variantId));
        if (!exists) {
          throw new AppError(
            `Variant not found on ${product.name}`,
            `"${product.name}" এর এই ভ্যারিয়েন্টটি পাওয়া যায়নি`,
            404
          );
        }
      }

      preparedItems.push({
        product: product._id,
        productName: product.name,
        productCode: product.code,
        variantId: item.variantId || undefined,
        variantLabel: item.variantLabel || undefined,
        quantity,
        unit: line.unit,
        purchaseUnit: line.mode,
        packUnit: line.packUnit || undefined,
        packSize: line.packSize || undefined,
        packQuantity: line.packQuantity || undefined,
        unitPrice,
        packUnitPrice: packUnitPrice || undefined,
        // Null when the line left the price alone, which keeps the stored
        // document identical to what a shop that never uses this posts.
        sellingPrice: sellingPrice ?? undefined,
        wholesalePrice: wholesalePrice ?? undefined,
        // What the supplier knocked off THIS line, in taka. Clamped to the line
        // by `computePurchaseTotals` below, not here — one place decides what a
        // concession is allowed to be.
        lineDiscount: toMoney(item.lineDiscount),
        total: itemTotal,
        // The delivery's own batch details. These were read straight off the
        // raw `item` at the stock-write below and never stored, so the expiry a
        // shopkeeper typed on a purchase existed only as a side effect on the
        // product — the purchase record itself could not say which batch it
        // brought in, and a cancelled purchase had no way to find it again.
        batchNumber: item.batchNumber ? String(item.batchNumber).trim() : undefined,
        expiryDate: item.expiryDate ? new Date(item.expiryDate) : undefined,
      });

      totalAmount = quantizeMoney(totalAmount + itemTotal);
    }

    /**
     * ── What the delivery actually cost ────────────────────────────────────
     *
     * `totalAmount` above is the sum of the BILLED lines, which is what this
     * method has always computed and is now only the first term. The discount
     * at the foot of the bill and the ভাড়া are spread back over the lines
     * here, and the result is what `costing.util` blends into
     * `Product.buyingPrice` — see `purchaseMath.util.js` for why freight is
     * part of what the stock cost rather than a memo line.
     *
     * A delivery with no concession and no ভাড়া — every purchase on the
     * platform today — comes back with `landedUnitPrice === unitPrice`
     * exactly and `totalAmount` unchanged, so nothing about it moves (I-1).
     */
    const totals = computePurchaseTotals({
      lines: preparedItems,
      discount: purchaseData.discount,
      discountType: purchaseData.discountType,
      freightCharge: purchaseData.freightCharge,
      otherCharge: purchaseData.otherCharge,
    });

    // Written back onto the lines by position — `computePurchaseTotals` maps
    // its input one-for-one and never reorders, which is what makes the index
    // safe to key on.
    totals.lines.forEach((line, i) => {
      preparedItems[i].lineDiscount = line.lineDiscount;
      preparedItems[i].discountShare = line.discountShare;
      preparedItems[i].chargeShare = line.chargeShare;
      preparedItems[i].landedUnitPrice = line.landedUnitPrice;
      // Re-stated from the same source as everything else so the line total and
      // the invoice subtotal cannot be computed two ways and disagree. Equal to
      // `itemTotal` above by construction.
      preparedItems[i].total = line.total;
    });

    totalAmount = totals.totalAmount;

    // Generate invoice number
    const invoiceNo = await Purchase.generateInvoiceNo(shopId);

    /**
     * Split payment on a purchase — ৳1,50,000 by bank and ৳50,000 in cash, in
     * one entry, each leg naming where the money left from and what reference
     * it left behind.
     *
     * ── Derived exactly the way `createSale` derives its own ─────────────────
     *
     * `paid` becomes the sum of the legs and `paymentMethod` becomes the
     * LARGEST leg, so every existing reader keeps working: the purchase list
     * filter, the cash register's `paymentMethod: 'cash'` query, the reports.
     * The pre-save hook that recalculates `due` and `status` reads `paid`, and
     * `paid` still means what it always did.
     *
     * A caller that sends no `payments[]` gets the legacy single-method array
     * built for it, which is what makes every existing client keep working
     * unchanged — again mirroring `createSale`.
     */
    let paidAmount = parseFloat(paid) || 0;
    let primaryMethod = paymentMethod || 'cash';
    let payments = rawPayments;

    if (payments.length > 0) {
      paidAmount = quantizeMoney(payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0));
      primaryMethod = payments.reduce((max, p) => (Number(p.amount) > Number(max.amount) ? p : max), payments[0]).method;
    } else if (paidAmount > 0 && primaryMethod !== 'credit') {
      // `credit` is the absence of a payment, not a place money sits, so it
      // never becomes a leg — and an unpaid purchase must not debit anything.
      payments = [{ method: primaryMethod, amount: paidAmount }];
    }

    /**
     * A purchase cannot be paid more than it is worth.
     *
     * ── Why this is a 400 and not a clamp ─────────────────────────────────────
     *
     * `Purchase.pre('save')` ALREADY clamps: `paid = min(paid, totalAmount)`.
     * The fund-account debit loop twelve lines below does not — it runs off the
     * raw legs. So ৳50,000 entered against a ৳9,000 bill debited the account by
     * ৳50,000, stored `paid: 9000`, moved the supplier's খাতা by ৳9,000, and
     * raised nothing. ৳41,000 left the drawer and landed nowhere: not on the
     * bill, not on the supplier, not in any report.
     *
     * Neither recalc script can find it either — `recalc-supplier-balances.js`
     * sums `purchase.paid`, which is the CLAMPED figure, so the money is
     * invisible to the one tool that exists to catch this class of error, and
     * `recalc-account-balances.js` reports the account short with nothing to
     * explain it.
     *
     * Refusing is the honest answer rather than clamping quietly, because the
     * shopkeeper meant something by the surplus. `recordPayment` has made
     * exactly this call since it was written (see its `primaryDue` guard) and
     * this is the same sentence in the other door.
     *
     * ── What the surplus actually IS, and why it is refused for now ───────────
     *
     * It is almost always old bills being cleared at the same counter — মাল
     * ৯,০০০ টাকার, সাথে পুরোনো বাকির ৫০,০০০. The sale side records that shape
     * as a separate `Payment` row via `dueSettlement`; the purchase side has no
     * equivalent yet (SUPPLIER_DUE_ADVANCE_PLAN.md S-3, Phase F). Until it
     * does, the shop's route is: create the bill, then use the payment modal,
     * whose F-4 overflow already walks the supplier's older bills oldest-first.
     * The error names that maximum so the number in the box can just be fixed.
     */
    if (paidAmount > totalAmount) {
      throw new AppError(
        `Paid amount ৳${paidAmount} exceeds this purchase's total of ৳${totalAmount}`,
        `পরিশোধ ৳${paidAmount} — এই ক্রয়ের মোট ৳${totalAmount} এর বেশি হতে পারবে না`,
        400
      );
    }

    // Resolve each leg to a fund account. Null throughout for a shop without
    // `features.fundAccounts` (I-1); a named account is checked against the
    // caller's branch because visibility is not authority.
    for (const leg of payments) {
      if (leg.account) {
        await paymentAccountService.assertUsableAccount(shopId, leg.account, req, leg.method);
      } else {
        leg.account = await paymentAccountService.resolveAccountForMethod(
          req?.shop || { _id: shopId }, leg.method, req
        );
      }
    }

    // The books may be closed through a date. `Purchase.date` is the
    // backdatable business date every purchase reader filters on — the list,
    // the supplier statement, the P&L's purchase bucket and now the payables
    // aging — so a bill posted behind the line moves a period the owner has
    // already signed off on. Checked before anything is written; a bill with no
    // date is today's and passes (rule 1).
    const purchaseDate = date ? new Date(date) : new Date();
    assertPeriodOpen({
      when: purchaseDate, shop: req?.shop, label: 'purchase', labelBn: 'কেনা',
    });

    // Create purchase
    const branchId = req ? requireBranch(req) : null;

    /**
     * ── What the shop owed this vendor BEFORE this delivery ─────────────────
     *
     * Read once, here, and frozen onto the document. `Sale.previousDue` exists
     * for exactly this reason and its header says why: a slip describes ONE
     * transaction at ONE moment, so deriving the balance at print time would
     * make a reprint of last month's challan show today's figure. Snapshot or
     * do not print it at all (PURCHASE_PLAN F-3).
     *
     * Read BEFORE `Purchase.create` so it cannot include this bill, and
     * server-side rather than trusting the client's copy — the figure on the
     * shopkeeper's screen is for their eyes, never for the books.
     */
    let previousDue = null;
    if (supplierDoc) {
      const before = await supplierSettlement.readPayable(
        { shopId, supplier: supplierDoc, branchId }, session
      );
      previousDue = before.totalDue;
    }

    /**
     * ── পুরোনো বাকি পরিশোধ at the same counter ──────────────────────────────
     *
     * "আজ ৯,০০০ টাকার মাল নিলাম, আর পুরোনো বাকির ৫০,০০০ দিলাম" — one visit, two
     * money events. The sale side has recorded this shape since split payments
     * shipped (`Sale.dueSettled`); the purchase side could only refuse it, and
     * before 2026-08-31 it silently destroyed the surplus (S-1).
     *
     * `paid` stays what it has always meant — money against THIS bill, clamped
     * to its total — because the P&L, the supplier statement and
     * `cancelPurchase`'s reversal all read it that way. The old-due money
     * travels as its own `Payment` rows through the one service that knows how
     * to allocate them.
     *
     * Settled BEFORE the purchase is created, deliberately: run afterwards it
     * would find the new bill in its own oldest-first walk and pay down debt
     * the shopkeeper had not yet incurred when they handed the money over.
     */
    let dueSettlement = null;
    // Which challans this vendor's অগ্রিম ended up sitting on. Filled by the
    // rollup below and handed back so the till can say "৳৩৫,২০০ অগ্রিম থেকে
    // বসেছে" rather than showing a bill that silently settled itself.
    let advanceAllocations = [];
    const settleRequested = toMoney(purchaseData.dueSettlement);
    if (settleRequested > 0) {
      if (!supplierDoc) {
        throw new AppError(
          'Cannot settle old dues without a supplier on the purchase',
          'সরবরাহকারী ছাড়া পুরোনো বাকি পরিশোধ করা যাবে না',
          400
        );
      }
      dueSettlement = await supplierSettlement.settleSupplierDue({
        shopId,
        userId,
        supplierId: supplierDoc._id,
        amount: settleRequested,
        branchId,
        method: purchaseData.dueSettlementMethod || primaryMethod,
        rawAccount: purchaseData.dueSettlementAccount || null,
        reference: purchaseData.dueSettlementReference,
        notes: `ক্রয়ের সাথে পুরোনো বাকি পরিশোধ`,
        req,
      }, session);

      // The document was re-read and re-derived inside that call, so the copy
      // held here is stale by exactly the amount just paid. Refreshed rather
      // than re-fetched: the rollup below adds to these figures.
      supplierDoc.totalPaid = dueSettlement.supplier.totalPaid;
      supplierDoc.totalDue = dueSettlement.supplier.totalDue;
      supplierDoc.advanceBalance = dueSettlement.supplier.advanceBalance;
    }

    const [purchase] = await Purchase.create([{
      shop: shopId,
      branch: branchId,
      invoiceNo,
      // The number on the SUPPLIER's own challan — what a month-end
      // reconciliation against their statement is done with. Ours is
      // `invoiceNo` and they have never heard of it.
      supplierInvoiceNo: purchaseData.supplierInvoiceNo
        ? String(purchaseData.supplierInvoiceNo).trim()
        : undefined,
      supplier: supplierDoc?._id,
      supplierName,
      items: preparedItems,
      // The foot of the bill, every term of it, from the one function that
      // computed them. Zero throughout for a delivery with no concession and no
      // ভাড়া, which stores `subtotal === totalAmount` exactly as before.
      subtotal: totals.subtotal,
      itemDiscount: totals.itemDiscount,
      discount: toMoney(purchaseData.discount),
      discountType: purchaseData.discountType === 'percentage' ? 'percentage' : 'fixed',
      discountAmount: totals.discountAmount,
      freightCharge: totals.freightCharge,
      otherCharge: totals.otherCharge,
      totalAmount,
      paid: paidAmount,
      paymentMethod: primaryMethod,
      payments,
      date: purchaseDate,
      notes: notes?.trim(),
      createdBy: userId,
      /**
       * ABSENT, not zero, when there is no supplier — readers have to be able
       * to tell "no snapshot was taken" from "they were owed nothing", and a
       * default of 0 would make every reprint of an older bill claim the
       * second. Same distinction `Sale.previousDue` draws.
       */
      ...(previousDue === null ? {} : {
        previousDue,
        // What is owed AFTER this delivery and anything settled with it. Stored
        // rather than derived at print time for the same reason as the line
        // above — and computed here rather than in the template so the slip and
        // the খতিয়ান cannot disagree about the arithmetic.
        dueSettled: dueSettlement ? dueSettlement.openingApplied + dueSettlement.billsApplied : 0,
      }),
    }], sessionOpt);

    // Money out, leg by leg — the bank account drops ৳1,50,000 and the cash box
    // drops ৳50,000, from this one entry. Inside the transaction that created
    // the purchase, so a rollback takes the balances with it.
    for (const leg of payments) {
      await paymentAccountService.applyAccountDelta({
        shop: shopId,
        account: leg.account,
        amount: -(Number(leg.amount) || 0),
        session: session || null,
      });
    }

    // Increase stock for each item. Stock lives on the product document, which
    // belongs to exactly one branch — the separate per-branch stock ledger is
    // gone, so this is a single path for every shop.
    // ── Batched: one stock write and one ledger insert for the whole delivery ──
    //
    // This loop used to issue, PER LINE: a `findById`, a `save()`, a SECOND
    // `save()` when the product tracks batches, and a `StockTransaction.create`.
    // Sequentially, inside an open transaction. A 20-line delivery held that
    // transaction open across ~80 round trips (PERFORMANCE_AUDIT.md H-3,
    // measured at 1187ms / 85 trips).
    //
    // The products are already in memory from the validation pass above, so
    // there is nothing left to read. The arithmetic below is untouched —
    // including the JS-side `quantize`, which is load-bearing: without it,
    // receiving 12.5 kg onto 99.9 kg stores 112.39999999999999. `$set` of the
    // computed value reproduces exactly what `save()` persisted.
    const purchaseStockOps = [];
    const purchaseTxns = [];

    const findVariant = (p, vId) => {
      if (!p.variants) return null;
      return typeof p.variants.id === 'function'
        ? p.variants.id(vId)
        : p.variants.find(x => (x._id || x.id)?.toString() === vId?.toString()) || null;
    };
    const getVariantStock = (p, vId) => findVariant(p, vId)?.stock || 0;
    const getVariantCost = (p, vId) => findVariant(p, vId)?.buyingPrice ?? p.buyingPrice ?? 0;

    // Cost-basis snapshots, keyed by position in `preparedItems`. Collected here
    // and written onto the purchase after the loop, because `Purchase.create`
    // above has already copied `preparedItems` into subdocuments — mutating the
    // plain array would persist nothing.
    const costSnapshots = new Map();

    // Same idea for the retail price, kept in its own map because the two move
    // independently: a line can re-blend the cost without touching the price
    // (the usual case) or set a price on a delivery received at zero cost.
    const priceSnapshots = new Map();

    // And again for the পাইকারি rate — see the write below for why the three
    // maps are separate rather than one.
    const wholesaleSnapshots = new Map();

    for (const [itemIndex, item] of preparedItems.entries()) {
      const product = purchaseProductMap.get(String(item.product));
      // Validation above already threw on an unresolvable product; this guard
      // only covers the impossible case rather than silently skipping stock.
      if (!product) continue;

      const previousStock = item.variantId
        ? getVariantStock(product, item.variantId)
        : product.stock;

      const stkUnit = storageUnit(product);
      let newStock;

      // ── Re-blend the cost basis, BEFORE the stock moves ──────────────────
      //
      // Nothing used to maintain `Product.buyingPrice`, and it is the number
      // every profit figure in the app is computed from (see costing.util.js).
      // A delivery at a new rate now blends into it as a weighted average.
      //
      // Ordered first deliberately: the formula wants the stock as it was BEFORE
      // this delivery landed, and `bulkWrite` applies ops in order.
      //
      // `costBefore` / `costAfter` are snapshotted onto the line so
      // `cancelPurchase` can tell whether it still owns the number — see the
      // reversal note there. `blendedCost` mirrors the pipeline arithmetic
      // exactly; it is not a second opinion, it is the same formula in JS.
      const previousCost = item.variantId
        ? getVariantCost(product, item.variantId)
        : (product.buyingPrice || 0);

      // ── The cost basis blends from the LANDED rate, not the billed one ────
      //
      // `landedUnitPrice` carries this line's share of the ভাড়া and the
      // supplier's discount; `unitPrice` is what the bill said. Blending the
      // billed rate is what made every margin report on the platform agree that
      // a consignment whose freight was never recorded had cost less than it
      // did.
      //
      // The fallback is not defensive padding — `computePurchaseTotals` returns
      // `landedUnitPrice === unitPrice` for a delivery with no charges, and a
      // caller that bypassed it (a script, a seeder) must still get the old
      // behaviour rather than a NaN.
      //
      // THE SNAPSHOT BELOW MUST READ THE SAME NUMBER. `cancelPurchase` decides
      // whether it still owns the cost by comparing against `costAfter`; if the
      // two are computed from different prices the comparison stops matching and
      // a cancellation silently stops restoring the cost it moved.
      const costRate = item.landedUnitPrice ?? item.unitPrice;

      const costUpdate = item.variantId && product.hasVariants
        ? buildVariantCostUpdate(item.variantId, item.quantity, costRate)
        : buildProductCostUpdate(item.quantity, costRate);

      if (costUpdate) {
        purchaseStockOps.push({
          updateOne: { filter: { _id: product._id }, update: costUpdate },
        });

        const costAfter = blendedCost(previousStock, previousCost, item.quantity, costRate);
        costSnapshots.set(itemIndex, { costBefore: previousCost, costAfter });

        // Keep the in-memory document in step, so a second line for the same
        // product in this delivery blends against the first line's result rather
        // than against the pre-delivery cost. The server-side pipeline sequences
        // itself correctly regardless (ordered bulkWrite); this is what keeps
        // the SNAPSHOTS honest.
        if (item.variantId && product.hasVariants) {
          const variant = findVariant(product, item.variantId);
          if (variant) variant.buyingPrice = costAfter;
        } else {
          product.buyingPrice = costAfter;
        }
      }

      // ── The new retail price ────────────────────────────────────────────
      //
      // A plain `$set`, not a blend. Cost is an average of what the shop paid
      // over time; a price is a decision, and the shopkeeper just made it. The
      // last one entered is the right one.
      //
      // A variant line prices only its own variant — a ২ কেজি packet and a ৫০০
      // গ্রাম packet do not share a price, and writing the parent's field for a
      // variant product would set a number nothing reads.
      //
      // `sellingPriceBefore` is snapshotted for the same reason `costBefore`
      // is: so `cancelPurchase` can tell whether the price it would restore is
      // still the one this delivery wrote.
      const isVariantLine = Boolean(item.variantId && product.hasVariants);
      const priceOp = buildSellingPriceUpdate({
        productId: product._id,
        variantId: item.variantId,
        hasVariants: product.hasVariants,
        sellingPrice: item.sellingPrice,
      });

      if (priceOp) {
        const previousPrice = isVariantLine
          ? (findVariant(product, item.variantId)?.sellingPrice ?? null)
          : (product.sellingPrice ?? null);

        purchaseStockOps.push(priceOp);
        priceSnapshots.set(itemIndex, { sellingPriceBefore: previousPrice });

        // Keep the in-memory document in step, so a SECOND line for the same
        // product in one delivery snapshots against the first line's result
        // rather than against the pre-delivery price — the same reason the cost
        // blend above writes back onto `product`.
        if (isVariantLine) {
          const variant = findVariant(product, item.variantId);
          if (variant) variant.sellingPrice = item.sellingPrice;
        } else {
          product.sellingPrice = item.sellingPrice;
        }
      }

      // ── The পাইকারি rate, same rules ────────────────────────────────────
      //
      // A `$set` and not a blend, ownership-snapshotted for the reversal, and
      // written onto the variant when the line is a variant line — every
      // sentence above about `sellingPrice` applies here unchanged.
      //
      // Kept in its own snapshot map rather than folded into `priceSnapshots`
      // because the two move independently: a delivery may reprice the shelf
      // without touching the wholesale rate, which is the ordinary case, or set
      // a wholesale rate on goods whose retail price did not change.
      //
      // `item.wholesalePrice` is undefined for every shop without
      // `features.wholesale`, so this whole block is a no-op for them (I-7).
      const wholesaleOp = buildWholesalePriceUpdate({
        productId: product._id,
        variantId: item.variantId,
        hasVariants: product.hasVariants,
        wholesalePrice: item.wholesalePrice,
      });

      if (wholesaleOp) {
        const previousWholesale = isVariantLine
          ? (findVariant(product, item.variantId)?.wholesalePrice ?? null)
          : (product.wholesalePrice ?? null);

        purchaseStockOps.push(wholesaleOp);
        wholesaleSnapshots.set(itemIndex, { wholesalePriceBefore: previousWholesale });

        if (isVariantLine) {
          const variant = findVariant(product, item.variantId);
          if (variant) variant.wholesalePrice = item.wholesalePrice;
        } else {
          product.wholesalePrice = item.wholesalePrice;
        }
      }

      // ── The received batch ──────────────────────────────────────────────
      //
      // Built once, ABOVE the variant / non-variant split, and stamped with the
      // variant it belongs to. It used to sit inside the `else`, which meant a
      // delivery of a variant product created no batch at all — so a shop could
      // have expiry tracking on, receive stock every week, and never accumulate
      // a single dated batch to be warned about. Combined with the same split
      // in the sale path, per-variant expiry was not partially implemented; it
      // was absent while appearing to be present.
      //
      // Rides in the SAME update as the stock change rather than a second
      // `save()` of the whole document, and `$push` avoids rewriting the entire
      // batches array the way that second save did.
      const batchPush = product.trackBatches
        ? {
            batches: {
              variantId: item.variantId || null,
              // Generated when the supplier's bill carries no batch code, which
              // is most of the time in a small shop. The expiry date is the
              // part that matters and it is kept verbatim; the number exists so
              // nothing in the ledger is unidentifiable.
              batchNumber: item.batchNumber || `B-${purchase.invoiceNo}-${Date.now()}`,
              expiryDate: item.expiryDate || null,
              quantity: item.quantity,
              // Landed, like the moving average it sits beside. A batch is a
              // parcel of stock and its cost is what that stock cost — FIFO
              // valuation off a batch that excluded its freight would disagree
              // with `Product.buyingPrice`, which does not.
              costPrice: item.landedUnitPrice ?? item.unitPrice,
              receivedDate: new Date(),
              purchaseRef: purchase._id,
            },
          }
        : null;

      // ── The stock change is a server-side DELTA ──────────────────────────
      //
      // This used to `$set` an absolute figure computed here in JS from the
      // document as it was read at the top of `createPurchase`. That is a
      // read-modify-write with no guard: a sale completing between the read and
      // this write was simply overwritten, and the delivery silently restored
      // stock the till had just sold. The sale path has always used guarded
      // deltas; receiving goods had no reason to be the exception.
      //
      // The batch `$push` rides in its OWN op rather than sharing this one,
      // because a fractional unit needs a pipeline update and a pipeline cannot
      // express `$push`. The bulkWrite is ordered, so the two land in sequence
      // on the same document.
      if (item.variantId && product.hasVariants) {
        const variant = (product.variants && typeof product.variants.id === 'function')
          ? product.variants.id(item.variantId)
          : product.variants?.find(v => (v._id || v.id)?.toString() === item.variantId?.toString());
        if (variant) {
          variant.stock = quantize(variant.stock + item.quantity, stkUnit);
        }
        newStock = getVariantStock(product, item.variantId);
        purchaseStockOps.push({
          updateOne: {
            // `'variants._id'` no longer binds a positional `$` — the helper
            // returns a `$map` pipeline for every unit now, so nothing depends
            // on the filter having matched an element. Kept because a purchase
            // for a variant that has since been deleted should write nothing
            // rather than recompute a rollup over an array it does not appear in.
            filter: { _id: product._id, 'variants._id': item.variantId },
            update: buildVariantStockUpdate(item.variantId, item.quantity, stkUnit),
          },
        });
      } else {
        product.stock = quantize(product.stock + item.quantity, stkUnit);
        newStock = product.stock;
        purchaseStockOps.push({
          updateOne: {
            filter: { _id: product._id },
            update: buildStockUpdate(item.quantity, stkUnit),
          },
        });
      }

      if (batchPush) {
        purchaseStockOps.push({
          updateOne: {
            filter: { _id: product._id },
            update: { $push: batchPush },
          },
        });
      }

      purchaseTxns.push({
        shop: shopId,
        branch: branchId,
        product: item.product,
        productName: item.productName,
        productCode: item.productCode,
        variantId: item.variantId,
        type: 'purchase',
        quantity: item.quantity,
        previousStock,
        newStock,
        // Stock valuation, so LANDED — this ledger is what an inventory value
        // is rebuilt from, and it has to agree with the cost basis it explains.
        // `item.total` is the BILLED figure; it belongs on the invoice, not in
        // the valuation ledger, so `totalCost` is recomputed from the same rate.
        unitCost: item.landedUnitPrice ?? item.unitPrice,
        totalCost: quantizeMoney(item.quantity * (item.landedUnitPrice ?? item.unitPrice)),
        reference: {
          type: 'purchase',
          id: purchase._id,
          invoiceNo: purchase.invoiceNo,
        },
        supplier: supplierName,
        createdBy: userId,
      });
    }

    if (purchaseStockOps.length > 0) {
      await Product.bulkWrite(purchaseStockOps, sessionOpt);
    }
    if (purchaseTxns.length > 0) {
      await StockTransaction.insertMany(purchaseTxns, sessionOpt);
    }

    // Record what this delivery did to each shelf's cost basis. Without it a
    // cancellation has no way to know whether the cost it would be reversing is
    // still the one this purchase set — see `cancelPurchase`.
    if (costSnapshots.size > 0 || priceSnapshots.size > 0 || wholesaleSnapshots.size > 0) {
      for (const [index, snapshot] of costSnapshots) {
        const line = purchase.items[index];
        if (!line) continue;
        line.costBefore = snapshot.costBefore;
        line.costAfter = snapshot.costAfter;
      }
      // A product that had no price at all before (never sold, priced for the
      // first time here) records `null` rather than 0, so the cancellation path
      // can tell "there was no price" from "the price was zero" and restore
      // the absence rather than inventing a free product.
      for (const [index, snapshot] of priceSnapshots) {
        const line = purchase.items[index];
        if (!line) continue;
        line.sellingPriceBefore = snapshot.sellingPriceBefore ?? undefined;
      }
      // Same reading for the পাইকারি rate: `null` records "there was no
      // wholesale rate", which the reversal restores as an ABSENCE rather than
      // as ৳0 — the difference between a product that bills পাইকারি customers
      // at retail and one that bills them nothing.
      for (const [index, snapshot] of wholesaleSnapshots) {
        const line = purchase.items[index];
        if (!line) continue;
        line.wholesalePriceBefore = snapshot.wholesalePriceBefore ?? undefined;
      }
      await purchase.save(sessionOpt);
    }

    // Update supplier stats
    if (supplierDoc) {
      // Seeded before anything moves — see the field's header. A supplier from
      // before the column existed would otherwise derive a payable of
      // everything ever billed.
      Supplier.backfillTotalPaid(supplierDoc);
      supplierDoc.totalPurchases += 1;
      // The components move; the two money halves are DERIVED from them.
      //
      // Identical arithmetic to the `totalDue += purchase.due` this replaces —
      // `due` at creation IS `totalAmount − paid` — but expressed as the three
      // stored components, so a supplier the shop has prepaid resolves to an
      // `advanceBalance` instead of clamping at zero and losing the money.
      supplierDoc.totalAmount = quantizeMoney(supplierDoc.totalAmount + totalAmount);
      supplierDoc.totalPaid = quantizeMoney((supplierDoc.totalPaid || 0) + purchase.paid);
      Supplier.applyBalances(supplierDoc);
      await supplierDoc.save(sessionOpt);

      /**
       * ── অগ্রিম is spent on the goods it was paid for ───────────────────────
       *
       * `Supplier.advanceBalance` falls on its own here, because it is derived
       * from `totalAmount` and `totalAmount` just went up. The BILLS have to
       * learn about it too, or the vendor reads as owing nothing while their
       * challans read as fully due — and the payables ageing, which sums
       * `Purchase.due`, would age debt that is already covered.
       *
       * This used to be a one-shot `min(advanceHeld, purchase.due)` written
       * onto THIS bill and never revisited. Two things were wrong with that and
       * both are the same thing: it read the SHOP-WIDE `advanceBalance` to
       * decide what a BRANCH's bill could take, and it made an allocation no
       * later event could correct. See `reallocateSupplierAdvance`'s header for
       * the ৳55,200 that went missing between the two books.
       *
       * A full recompute instead — which also picks up the case the one-shot
       * could not see at all: a prepayment that has been sitting unspent while
       * OLDER bills went unpaid now lands on the oldest of them, not on
       * whichever one happens to be arriving.
       *
       * Costs one indexed aggregate for a vendor nobody has prepaid, which is
       * very nearly all of them, and returns before touching a bill.
       */
      advanceAllocations = await supplierSettlement.reallocateSupplierAdvance(
        { shopId, supplierId: supplierDoc._id, branchId },
        session
      );

      /**
       * Re-read, because the allocator saved a DIFFERENT instance of this same
       * document — it walks the vendor's bills from the database, and this
       * bill is one of them. Without this the copy held here still carries the
       * pre-advance `due` and `status`, which is what the audit entry records
       * and what the till is handed back: a challan the shopkeeper is told is
       * fully due while the database has it settled.
       *
       * Only when the allocator actually moved this bill, so an ordinary
       * delivery to a vendor nobody has prepaid costs no extra read.
       */
      if (advanceAllocations.some((a) => String(a.purchase) === String(purchase._id))) {
        const fresh = await Purchase.findById(purchase._id).session(session || null);
        if (fresh) {
          purchase.advanceApplied = fresh.advanceApplied;
          purchase.due = fresh.due;
          purchase.status = fresh.status;
        }
      }

      // Same arithmetic, split by the branch the goods were bought for.
      // Written whatever the shop's setup — a no-op for single-branch shops,
      // where `branchId` is null. `paid` is `totalAmount - due`, i.e. whatever
      // was settled at the counter; the rest becomes this branch's payable.
      await SupplierBalance.applyDelta({
        shop: shopId,
        supplier: supplierDoc._id,
        branch: branchId,
        amount: totalAmount,
        paid: purchase.paid,
        due: purchase.due,
        count: 1,
        lastPurchase: purchase.date || new Date(),
      }, session);

      // `applyDelta` can only `$inc`, and an `$inc` cannot tell a payable from
      // a prepayment. Re-derived here so a branch that was holding credit with
      // this vendor spends it on this bill instead of carrying both figures at
      // once. A no-op for single-branch shops, where `branchId` is null and
      // there is no row (I-1).
      await SupplierBalance.recomputeBalances({
        shop: shopId,
        supplier: supplierDoc._id,
        branch: branchId,
      }, session);
    }

    // Audit log
    const itemNames = preparedItems.map(i => i.productName).join(', ');
    await AuditLog.create({
      shop: shopId,
      branch: branchId,
      user: userId,
      action: 'purchase_create',
      actionBn: 'নতুন ক্রয়',
      description: `Purchase #${invoiceNo}: ৳${totalAmount} from ${supplierName} (${preparedItems.length} items)`,
      descriptionBn: `ক্রয় #${invoiceNo}: ৳${totalAmount} — ${supplierName} থেকে (${preparedItems.length}টি পণ্য)`,
      entity: {
        type: 'purchase',
        id: purchase._id,
        name: invoiceNo,
      },
      changes: {
        after: {
          totalAmount,
          paid: purchase.paid,
          due: purchase.due,
          items: itemNames,
          supplier: supplierName,
        },
      },
    });

    // Populate for response
    await purchase.populate('supplier', 'name phone');
    await purchase.populate('createdBy', 'name');

    // The old-due allocation rides along so the till can say "পুরোনো বাকিতে
    // ৳৫০,০০০ বসেছে" without a second fetch — the same shape `recordPayment`
    // returns. Absent when nothing was settled, so an ordinary purchase's
    // response is unchanged (I-1).
    if (advanceAllocations.length > 0) {
      purchase.set('advanceAllocations', advanceAllocations, { strict: false });
    }

    if (dueSettlement) {
      purchase.set('dueSettlementResult', {
        openingApplied: dueSettlement.openingApplied,
        billsApplied: dueSettlement.billsApplied,
        allocations: dueSettlement.allocations,
      }, { strict: false });
    }

    return purchase;
    });
  }

  // Cancel purchase (reverse stock).
  //
  // Runs in a transaction, as `createPurchase` already did. Without one, a
  // failure part-way through left the books split: stock reversed but the
  // supplier still owed, or the supplier balance unwound while the goods stayed
  // on the shelf. Every write below — stock, batches, ledger, supplier, status —
  // now lands together or not at all.
  async cancelPurchase(shopId, userId, purchaseId, req = null, options = {}) {
    const { reason } = options;
    return await runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};

      const purchase = await Purchase.findOne(branchFilter(req, {
        _id: purchaseId,
        shop: shopId,
      })).session(session || null);

    if (!purchase) {
      throw new AppError('ক্রয়টি পাওয়া যায়নি', 'Purchase not found', 404);
    }

    if (purchase.status === 'cancelled') {
      throw new AppError('এই ক্রয়টি আগেই বাতিল করা হয়েছে', 'Purchase already cancelled', 400);
    }

    /**
     * ── A bill with goods already sent back cannot be voided (D-4) ───────────
     *
     * Cancelling reverses the WHOLE delivery: it removes every line's quantity
     * from the shelf, deletes the batches this purchase created, and unwinds
     * the supplier's খাতা by the bill's full `totalAmount`. A কেনা ফেরত has
     * already done part of exactly that — its own slice of the stock is gone,
     * its own slice of the batch is gone, and (for an `adjustment`) its credit
     * is already off the supplier's books through `Purchase.returnedAmount`.
     *
     * Run both and every one of those is reversed twice: stock clamps at zero
     * while the supplier rollup does not, which is precisely the two-books
     * drift `Purchase.pre('save')`'s cancelled-status guard has its own long
     * comment about.
     *
     * There is no partial unwind to write instead, because a `PurchaseReturn`
     * has no cancelled state by design (immutableGuard, no route) — so refusing
     * is not a stopgap, it is the answer. Same call the multi-bill payment
     * refusal below makes, and the same call `cancelDueCollection` makes about
     * foreign payment types: refusing loudly beats an unwind that half works.
     *
     * `countDocuments` and not a `find`: existence IS liveness here. Unlike
     * `Payment`, a return row cannot be voided, so there is no `LIVE_*` guard
     * to apply.
     */
    const PurchaseReturn = require('../models/PurchaseReturn.model');
    const returnCount = await PurchaseReturn.countDocuments({
      shop: shopId,
      purchase: purchase._id,
    }).session(session || null);

    if (returnCount > 0) {
      throw new AppError(
        'This purchase has goods returned against it — it can no longer be cancelled',
        'এই ক্রয়ের মাল ফেরত আছে — ক্রয়টি আর বাতিল করা যাবে না',
        400
      );
    }

    /**
     * ── Supplier payments recorded after the purchase ────────────────────────
     *
     * These are `Payment{type:'purchase_payment'}` rows from `recordPayment` —
     * NOT the checkout legs in `purchase.payments[]`, which the loop further
     * down already credits back. They are voided below so the post-cancel books
     * read "this bill never happened, the money went back to the drawer".
     *
     * ── The multi-bill decision (F-4) ────────────────────────────────────────
     *
     * A payment may have settled SEVERAL bills (`Payment.allocations`). Voiding
     * such a row because ONE of its bills is being cancelled would claw back
     * money that legitimately settled the others; shrinking the row instead
     * would leave `amount` misstating what was actually handed over, and every
     * `$sum: '$amount'` reader with it. Neither is correct, so a purchase
     * entangled in a multi-bill payment — as the payment's named bill OR as one
     * of its allocation targets — REFUSES to cancel until that payment is
     * voided first. Refusing loudly beats an unwind that half works; same call
     * `cancelDueCollection` makes about foreign payment types.
     */
    const laterPayments = await Payment.find({
      shop: shopId,
      purchase: purchase._id,
      type: 'purchase_payment',
      ...LIVE_PAYMENT,
    }).session(session || null);

    const inboundAllocated = await Payment.find({
      shop: shopId,
      type: 'purchase_payment',
      'allocations.purchase': purchase._id,
      purchase: { $ne: purchase._id },
      ...LIVE_PAYMENT,
    }).session(session || null);

    const spansOtherBills = (p) =>
      (p.allocations || []).some((a) => String(a.purchase) !== String(purchase._id));

    if (inboundAllocated.length > 0 || laterPayments.some(spansOtherBills)) {
      throw new AppError(
        'A payment on this purchase also settled other bills — void that payment first',
        'এই ক্রয়ের পেমেন্ট অন্য বিলের সাথে ভাগ হয়ে আছে — আগে পেমেন্টটি বাতিল করুন',
        400
      );
    }

    // Reverse stock for each item.
    // Batched the same way as the receive path above: one read for every
    // referenced product, one bulkWrite, one ledger insert — instead of a
    // findById + save + create per line.
    const cancelIds = [...new Set(purchase.items.map(i => String(i.product)))];
    const cancelProducts = await Product.find({ _id: { $in: cancelIds }, shop: shopId })
      .session(session || null);
    const cancelProductMap = new Map(cancelProducts.map(p => [String(p._id), p]));

    const cancelStockOps = [];
    const cancelTxns = [];

    const findVariant = (p, vId) => {
      if (!p.variants) return null;
      return typeof p.variants.id === 'function'
        ? p.variants.id(vId)
        : p.variants.find(x => (x._id || x.id)?.toString() === vId?.toString()) || null;
    };
    const getVariantStock = (p, vId) => findVariant(p, vId)?.stock || 0;
    const getVariantCost = (p, vId) => findVariant(p, vId)?.buyingPrice ?? p.buyingPrice ?? 0;

    for (const item of purchase.items) {
      const product = cancelProductMap.get(String(item.product));
      // A product deleted since the purchase is skipped, unchanged from before.
      if (!product) continue;

      const previousStock = item.variantId
        ? getVariantStock(product, item.variantId)
        : product.stock;

      // ── Put the cost basis back, but only if it is still ours ─────────────
      //
      // Receiving blended this line's rate into `buyingPrice` (costing.util.js).
      // A moving average has no general inverse — the shelf has been sold from
      // and possibly received into since — so rather than compute a wrong
      // reversal, this restores the exact pre-delivery figure and ONLY when the
      // current cost is still the one this delivery wrote.
      //
      // If a later delivery has moved it on, that delivery owns the number and
      // reversing to a value from before it would silently discard a correct
      // cost basis. Leaving it is the honest answer: the average reflects goods
      // that genuinely passed through the shop.
      //
      // Compared with a paisa tolerance because `costAfter` was rounded at
      // write time on both sides.
      if (item.costAfter != null && item.costBefore != null) {
        const currentCost = item.variantId
          ? getVariantCost(product, item.variantId)
          : (product.buyingPrice || 0);

        if (Math.abs(currentCost - item.costAfter) < 0.005) {
          if (item.variantId && product.hasVariants) {
            const variant = findVariant(product, item.variantId);
            if (variant) variant.buyingPrice = item.costBefore;
            cancelStockOps.push({
              updateOne: {
                filter: { _id: product._id, 'variants._id': item.variantId },
                update: { $set: { 'variants.$.buyingPrice': item.costBefore } },
              },
            });
          } else {
            product.buyingPrice = item.costBefore;
            cancelStockOps.push({
              updateOne: {
                filter: { _id: product._id },
                update: { $set: { buyingPrice: item.costBefore } },
              },
            });
          }
        }
      }

      // ── Put the retail price back, but only if it is still ours ──────────
      //
      // Same ownership test as the cost above, and it matters more here: a
      // price is something a person chose, and silently reverting a choice
      // someone made after this delivery — on the product form, or on a later
      // purchase — would be worse than leaving a price that is merely stale.
      //
      // `sellingPriceBefore` absent means this line never wrote a price, so
      // there is nothing to undo. `null` means the product had no price before
      // it, and the reversal restores that absence with `$unset` rather than
      // writing 0 — a ৳0 price sells the goods for nothing, which is not what
      // "there was no price" meant.
      const cancelIsVariantLine = Boolean(item.variantId && product.hasVariants);
      const restoreOp = buildSellingPriceRestore({
        productId: product._id,
        variantId: item.variantId,
        hasVariants: product.hasVariants,
        sellingPrice: item.sellingPrice,
        sellingPriceBefore: item.sellingPriceBefore,
        currentPrice: cancelIsVariantLine
          ? (findVariant(product, item.variantId)?.sellingPrice ?? null)
          : (product.sellingPrice ?? null),
      });

      if (restoreOp) {
        cancelStockOps.push(restoreOp);
        const before = item.sellingPriceBefore ?? undefined;
        if (cancelIsVariantLine) {
          const variant = findVariant(product, item.variantId);
          if (variant) variant.sellingPrice = before;
        } else {
          product.sellingPrice = before;
        }
      }

      // ── And the পাইকারি rate, on the same terms ─────────────────────────
      //
      // Deliberately NOT gated on `features.wholesale` here. A cancellation
      // must undo what the purchase did regardless of what the shop's
      // entitlements look like today: if the capability was switched off
      // between the delivery and the cancellation, skipping this would leave
      // the rate this delivery wrote standing forever, and switching the
      // capability back on would resurrect it. The write path is where the
      // entitlement is enforced; reversal only has to be faithful.
      const wholesaleRestoreOp = buildWholesalePriceRestore({
        productId: product._id,
        variantId: item.variantId,
        hasVariants: product.hasVariants,
        wholesalePrice: item.wholesalePrice,
        wholesalePriceBefore: item.wholesalePriceBefore,
        currentPrice: cancelIsVariantLine
          ? (findVariant(product, item.variantId)?.wholesalePrice ?? null)
          : (product.wholesalePrice ?? null),
      });

      if (wholesaleRestoreOp) {
        cancelStockOps.push(wholesaleRestoreOp);
        const beforeWholesale = item.wholesalePriceBefore ?? undefined;
        if (cancelIsVariantLine) {
          const variant = findVariant(product, item.variantId);
          if (variant) variant.wholesalePrice = beforeWholesale;
        } else {
          product.wholesalePrice = beforeWholesale;
        }
      }

      // Flag-independent, like every other reversal path: what was received
      // must be removable at the same precision even if packaging was later
      // switched off for this shop.
      const stkUnit = storageUnit(product);
      let newStock;

      if (item.variantId && product.hasVariants) {
        const variant = (product.variants && typeof product.variants.id === 'function')
          ? product.variants.id(item.variantId)
          : product.variants?.find(v => (v._id || v.id)?.toString() === item.variantId?.toString());
        if (variant) {
          variant.stock = quantize(Math.max(0, variant.stock - item.quantity), stkUnit);
        }
        newStock = getVariantStock(product, item.variantId);
        // A server-side delta, not an absolute `$set` of a number computed here
        // from an unguarded read. The sale path has always used guarded deltas;
        // this one recomputed from what it happened to read, so a cancellation
        // overlapping any other stock movement on the same product silently
        // discarded the other one. Clamped at zero to preserve the existing
        // rule that a reversal cannot drive stock negative — goods already sold
        // out of a cancelled delivery are gone, and the shop cannot un-sell them.
        cancelStockOps.push({
          updateOne: {
            filter: { _id: product._id },
            update: buildVariantStockUpdate(item.variantId, -item.quantity, stkUnit, { clampAtZero: true }),
          },
        });
      } else {
        product.stock = quantize(Math.max(0, product.stock - item.quantity), stkUnit);
        newStock = product.stock;
        cancelStockOps.push({
          updateOne: {
            filter: { _id: product._id },
            update: buildStockUpdate(-item.quantity, stkUnit, 'stock', { clampAtZero: true }),
          },
        });
      }

      // ── Reverse the batch this line brought in ──────────────────────────
      //
      // Cancelling a delivery removes the goods; the batch that came with them
      // has to go too, or the expiry screen keeps warning about stock that was
      // sent back to the supplier. Preferred by `purchaseRef` — the exact rows
      // this purchase created — so a cancellation cannot eat a batch that
      // arrived on a different delivery and happens to expire sooner.
      //
      // Anything already sold out of that batch is simply not there to remove;
      // FEFO drained it and `stock` reflects that. Whatever is left over falls
      // back to a plain FEFO deduction, which is the honest approximation: the
      // shop cannot return goods it no longer holds.
      if (product.trackBatches && Array.isArray(product.batches) && product.batches.length) {
        const owner = item.variantId || null;
        let toRemove = item.quantity;

        for (const b of product.batches) {
          if (toRemove <= 0) break;
          if (!sameOwner(b.variantId, owner)) continue;
          if (String(b.purchaseRef || '') !== String(purchase._id)) continue;
          const take = Math.min(toRemove, b.quantity);
          b.quantity -= take;
          toRemove -= take;
        }
        product.batches = product.batches.filter(b => b.quantity > 0);
        if (toRemove > 0) deductBatches(product, owner, toRemove);

        cancelStockOps.push(batchWriteOp(product));
      }

      // Create reversal stock transaction
      cancelTxns.push({
        shop: shopId,
        // `branch` was missing here, and it is not cosmetic: every stock-history
        // read is `branchFilter`-scoped, so an untagged reversal row was
        // invisible in EVERY branch's view forever — the same defect that made
        // due collections vanish from every branch's cash register (H-6). The
        // receive path beside it has always tagged its rows; only the reversal
        // did not, so a cancelled delivery's `purchase` rows showed and its
        // `return` rows did not, and the history read as if the goods had
        // arrived and never left.
        //
        // The PURCHASE's branch, not the caller's: `branchFilter` above already
        // restricts a branch to cancelling its own bills, but an owner in
        // All-Branches has no active branch and the goods belong to whichever
        // branch bought them.
        branch: purchase.branch || null,
        product: item.product,
        productName: item.productName,
        productCode: item.productCode,
        variantId: item.variantId,
        type: 'return',
        quantity: -item.quantity,
        previousStock,
        newStock,
        // The reversal has to carry the same valuation the receipt did, or the
        // two ledger rows do not cancel and the rebuilt inventory value keeps
        // the freight of a purchase that no longer exists.
        unitCost: item.landedUnitPrice ?? item.unitPrice,
        totalCost: quantizeMoney(item.quantity * (item.landedUnitPrice ?? item.unitPrice)),
        reference: {
          type: 'purchase',
          id: purchase._id,
          invoiceNo: purchase.invoiceNo,
        },
        notes: 'ক্রয় বাতিল — স্টক ফেরত',
        createdBy: userId,
      });
    }

    if (cancelStockOps.length > 0) {
      await Product.bulkWrite(cancelStockOps, sessionOpt);
    }
    if (cancelTxns.length > 0) {
      await StockTransaction.insertMany(cancelTxns, sessionOpt);
    }

    // Update supplier stats
    if (purchase.supplier) {
      const supplier = await Supplier.findById(purchase.supplier).session(session || null);
      if (supplier) {
        Supplier.backfillTotalPaid(supplier);
        supplier.totalPurchases = Math.max(0, supplier.totalPurchases - 1);
        supplier.totalAmount = Math.max(0, quantizeMoney(supplier.totalAmount - purchase.totalAmount));
        // Everything this bill was ever paid comes back out, later settlements
        // included — `purchase.paid` carries them, and the void loop below
        // returns the cash to the accounts. Then both halves are re-derived,
        // which is what makes the bill's lifetime contribution net to zero on
        // every column rather than only on `totalDue`.
        supplier.totalPaid = Math.max(0, quantizeMoney(supplier.totalPaid - (purchase.paid || 0)));
        Supplier.applyBalances(supplier);
        await supplier.save(sessionOpt);
      }

      // Unwound at the branch that raised the purchase — the only branch whose
      // figures it ever moved. `recomputeBalances` rather than `$inc`-ing totalDue,
      // because the Supplier rollup above clamps at zero and clamping on only
      // one side is precisely how two books drift apart.
      await SupplierBalance.applyDelta({
        shop: shopId,
        supplier: purchase.supplier,
        branch: purchase.branch,
        amount: -purchase.totalAmount,
        // `purchase.paid` directly, not `totalAmount − due`. The two agree on
        // an ordinary bill and diverge by `returnedAmount` on one that took a
        // কেনা ফেরত — where the old form unwound credit the shop never paid.
        paid: -(purchase.paid || 0),
        count: -1,
      }, session);
      await SupplierBalance.recomputeBalances({
        shop: shopId,
        supplier: purchase.supplier,
        branch: purchase.branch,
      }, session);
    }

    /**
     * Put the money back into the accounts it left.
     *
     * Reads `purchase.payments[]` — the accounts the money ACTUALLY left from —
     * rather than re-resolving the method's default, because a shop can change
     * which account is the default between buying and cancelling, and
     * re-resolving would credit today's account with money that came out of
     * yesterday's.
     *
     * Empty for purchases written before split payments existed and for shops
     * without the capability, in which case this loop does nothing at all.
     */
    for (const leg of (purchase.payments || [])) {
      await paymentAccountService.applyAccountDelta({
        shop: shopId,
        account: leg.account,
        amount: Number(leg.amount) || 0,
        session: session || null,
      });
    }

    /**
     * ── And the payments recorded later, voided and refunded ─────────────────
     *
     * Fetched (and multi-bill-screened) at the top of this method. Each row is
     * marked cancelled — never deleted, `immutableGuard` — so `LIVE_PAYMENT`
     * readers (cash register, reports, the payment history) stop counting it,
     * and its account gets back exactly what that payment debited.
     *
     * The Supplier / SupplierBalance deltas ABOVE already assume this. They
     * subtract the purchase's CURRENT due (post-payment) and its full `paid`
     * (payments included), so with the rows voided the bill's lifetime
     * contribution nets to exactly zero on both books:
     *
     *     Supplier.totalDue:        +D₀  − Σa  − (D₀ − Σa)          = 0
     *     SupplierBalance.totalPaid: +counter + Σa − (counter + Σa) = 0
     *
     * (D₀ = due at creation, Σa = later payments, counter = paid at checkout.)
     * Adding a second term here for the voided money would double-unwind it.
     */
    for (const pay of laterPayments) {
      pay.status = 'cancelled';
      pay.cancelledAt = new Date();
      pay.cancelledBy = userId;
      pay.cancelReason = 'ক্রয় বাতিল — টাকা ফেরত';
      await pay.save(sessionOpt);

      await paymentAccountService.applyAccountDelta({
        shop: shopId,
        account: pay.account,
        amount: Number(pay.amount) || 0,
        session: session || null,
      });
    }

    purchase.status = 'cancelled';
    // The cancellation record (F-6): the list can now SHOW a voided bill with
    // who/when/why on it instead of erasing the trace.
    purchase.cancelledAt = new Date();
    purchase.cancelledBy = userId;
    if (reason) {
      purchase.cancelReason = String(reason).trim().slice(0, 200);
    }
    await purchase.save(sessionOpt);

    /**
     * ── অগ্রিম this bill was consuming is now free ───────────────────────────
     *
     * Cancelling a challan covered by a prepayment hands that money back to the
     * vendor's pool: `Supplier.advanceBalance` rises on its own, because
     * `totalAmount` came down in the rollup above. Nothing moved it onto the
     * NEXT open bill, so the shop read as holding ৳25,000 of credit with a
     * vendor while a live challan from that same vendor sat at ৳10,200 due —
     * and the payables ageing, which sums `Purchase.due`, aged debt the
     * prepayment had already covered.
     *
     * ORDER IS LOAD-BEARING: this runs AFTER `status = 'cancelled'` is saved,
     * not beside the rollups. The allocator walks `status: { $ne: 'cancelled' }`
     * straight from the database, so run any earlier it would find this bill
     * still live and put the freed money straight back onto the document being
     * voided.
     *
     * Guarded on a supplier, because a সরাসরি কেনা has no vendor to hold a
     * prepayment for.
     */
    if (purchase.supplier) {
      await supplierSettlement.reallocateSupplierAdvance(
        { shopId, supplierId: purchase.supplier, branchId: purchase.branch || null },
        session
      );
    }

    // Audit log
    await AuditLog.create([{
      shop: shopId,
      // Tagged, like the reversal ledger rows above and like every other write
      // in this file. An untagged audit row is unfilterable by branch, which is
      // the whole of finding M-8 ("~30 of 33 audit sites untagged").
      branch: purchase.branch || null,
      user: userId,
      action: 'purchase_cancel',
      actionBn: 'ক্রয় বাতিল',
      description: `Cancelled purchase #${purchase.invoiceNo}: ৳${purchase.totalAmount}`
        + (purchase.cancelReason ? ` — ${purchase.cancelReason}` : ''),
      descriptionBn: `ক্রয় বাতিল #${purchase.invoiceNo}: ৳${purchase.totalAmount}`
        + (purchase.cancelReason ? ` — ${purchase.cancelReason}` : ''),
      entity: {
        type: 'purchase',
        id: purchase._id,
        name: purchase.invoiceNo,
      },
    }], sessionOpt);

    return { success: true };
    });
  }

  // Get purchase summary
  async getSummary(shopId, options = {}, req = null) {
    const { startDate, endDate } = options;

    let start, end;
    if (startDate && endDate) {
      start = new Date(startDate);
      end = endOfBangladeshDay(endDate);
    } else {
      // Default to the current BANGLADESH month, not the server's.
      const { startOfMonth, endOfMonth } = getBangladeshMonthRange(toBangladeshMonthStr(new Date()));
      start = startOfMonth;
      end = endOfMonth;
    }

    const { startOfDay: todayStart, endOfDay: todayEnd } = getBangladeshTodayRange();

    // Same defect as the expense summary (H-10): shop-wide totals were shown
    // beside a branch-scoped list.
    const branchId = req?.branchId || null;

    const [monthSummary, todaySummary] = await Promise.all([
      Purchase.getSummary(shopId, start, end, branchId),
      Purchase.getSummary(shopId, todayStart, todayEnd, branchId),
    ]);

    return {
      period: { start, end },
      month: monthSummary,
      today: todaySummary,
    };
  }
  // Record payment for a purchase.
  //
  // F-5: transactional. This was five independent writes — purchase.save,
  // Payment.create, applyAccountDelta, Supplier.$inc, SupplierBalance — and a
  // failure between any two of them split the books with nothing to signal it.
  // Same `runInTransaction` wrapper `createPurchase` and `cancelPurchase` use.
  async recordPayment(shopId, userId, purchaseId, paymentData, req = null) {
    /**
     * `reference` and `transactionId` were dropped on the floor.
     *
     * The `Payment` model has carried both fields since it was written; this
     * method simply never accepted them, so a ৳2,00,000 bank transfer to a
     * supplier was recorded as the word `bank` — no cheque number, no transfer
     * reference, nothing to match against the bank statement when the supplier
     * says the money never arrived. That is the single most consequential
     * payment a shop makes and it was the least traceable.
     */
    const { method = 'cash', notes, reference, transactionId } = paymentData;
    // Coerced before the comparisons below. The `<= 0` guard was already here
    // and correct, but a string amount slipped past it into `purchase.paid +=`,
    // where `0 + '500'` concatenates rather than adds.
    const amount = toMoney(paymentData.amount);

    return await runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};

      const purchase = await Purchase.findOne(branchFilter(req, { _id: purchaseId, shop: shopId }))
        .session(session || null);
      if (!purchase) {
        throw new AppError('Purchase not found', 'ক্রয়টি পাওয়া যায়নি', 404);
      }

      if (purchase.status === 'cancelled') {
        throw new AppError('Cannot record payment for cancelled purchase', 'বাতিল ক্রয়ে পেমেন্ট দেওয়া যাবে না', 400);
      }

      if (amount <= 0) {
        throw new AppError('Payment amount must be greater than 0', 'পেমেন্টের পরিমাণ ০ এর বেশি হতে হবে', 400);
      }

      const primaryDue = quantizeMoney(purchase.due || 0);

      // A purchase with no supplier keeps the old hard cap: there is no ledger
      // for the excess to settle and no vendor to hold an advance against.
      if (amount > primaryDue && !purchase.supplier) {
        throw new AppError('Payment amount exceeds due balance', 'পেমেন্টের পরিমাণ বাকির চেয়ে বেশি', 400);
      }

      /**
       * F-4 — the excess settles the supplier's OLDER bills.
       *
       * In real life the shop hands the supplier ৳50,000 covering this challan
       * AND last month's. The primary bill absorbs up to its own due; whatever
       * is left walks the same shop+supplier+branch's other open bills oldest
       * first (the sale side's `dueSettled`/`ledgerSettled` rule), each taking
       * up to its due.
       *
       * Same BRANCH deliberately: the money reduces this branch's payable, and
       * settling another branch's bill from here would be the cross-branch
       * write-down `settleCustomerDue` refuses on the customer side.
       *
       * Anything beyond the supplier's total open due is refused — a supplier
       * advance is deliberately still not tracked (see supplier.service.js).
       */
      const primaryApplied = quantizeMoney(Math.min(amount, primaryDue));
      let excess = quantizeMoney(amount - primaryApplied);

      const olderAllocations = []; // [{ doc, amount }]
      if (excess > 0) {
        const eligible = await Purchase.find({
          shop: shopId,
          supplier: purchase.supplier,
          branch: purchase.branch || null,
          _id: { $ne: purchase._id },
          status: { $ne: 'cancelled' },
          due: { $gt: 0 },
        })
          .sort({ date: 1, createdAt: 1 })
          .session(session || null);

        for (const bill of eligible) {
          if (excess <= 0) break;
          const take = quantizeMoney(Math.min(excess, bill.due));
          if (take <= 0) continue;
          olderAllocations.push({ doc: bill, amount: take });
          excess = quantizeMoney(excess - take);
        }

        if (excess > 0) {
          const maxPayable = quantizeMoney(amount - excess);
          throw new AppError(
            `Payment exceeds the supplier's total outstanding (maximum ৳${maxPayable})`,
            `সরবরাহকারীর মোট বাকি ৳${maxPayable} — এর বেশি নেওয়া যাবে না`,
            400
          );
        }
      }

      // Create payment record.
      //
      // `branch` was missing here, and it is not cosmetic: `_calculateCashFlows`
      // matches every cash movement by branch, so an untagged supplier payment is
      // invisible to every branch's till. Cash left the drawer and nothing
      // recorded it. Same defect the customer due-collection path fixed (H-6).
      //
      // Attributed to the PURCHASE's branch, not the caller's. `branchFilter`
      // above already restricts a branch to paying its own purchases, so the two
      // are the same in normal use — but an owner in All-Branches has no active
      // branch, and the debt belongs to whichever branch bought the goods.
      // Which fund account the money left. Attributed like `branch` below — to
      // the account the caller names, or the method's default. Null for a shop
      // without `features.fundAccounts` (I-1).
      const account = paymentData.account
        ? (await paymentAccountService.assertUsableAccount(shopId, paymentData.account, req, method))._id
        : await paymentAccountService.resolveAccountForMethod(req?.shop || { _id: shopId }, method, req);

      // Apply each bill's slice. `paid` is set explicitly and never past
      // `totalAmount` (each slice is capped at that bill's due above), so the
      // pre('save') clamp has nothing to fight — the hook only re-derives
      // `due` and lands `status` on completed/partial/unpaid.
      const dueBefore = purchase.due;
      purchase.paid = quantizeMoney(purchase.paid + primaryApplied);
      await purchase.save(sessionOpt);

      for (const alloc of olderAllocations) {
        alloc.doc.paid = quantizeMoney(alloc.doc.paid + alloc.amount);
        await alloc.doc.save(sessionOpt);
      }

      // ONE Payment row for the full amount, its split recorded on
      // `allocations` — the mirror of `branchAllocation` on the customer side.
      // Empty for a plain one-bill payment, so that row stays byte-identical
      // to every row written before F-4 existed.
      const [payment] = await Payment.create([{
        shop: shopId,
        branch: purchase.branch || null,
        purchase: purchaseId,
        amount,
        method,
        account,
        reference,
        transactionId,
        type: 'purchase_payment',
        notes,
        receivedBy: userId,
        allocations: olderAllocations.length > 0
          ? [
              ...(primaryApplied > 0 ? [{ purchase: purchase._id, amount: primaryApplied }] : []),
              ...olderAllocations.map((a) => ({ purchase: a.doc._id, amount: a.amount })),
            ]
          : [],
      }], sessionOpt);

      // Money out. `atCheckout` is false by default on this row, which is what
      // tells `recalc-account-balances.js` to count it here rather than assume it
      // was already counted as a purchase leg.
      await paymentAccountService.applyAccountDelta({
        shop: shopId,
        account,
        amount: -amount,
        session: session || null,
      });

      // Update supplier balance if applicable. ONCE, by the total — every
      // allocated bill belongs to the same supplier and the same branch, so
      // the Supplier mutation and its SupplierBalance mirror carry the same
      // arithmetic in the same transaction (Σ branch due === supplier due).
      if (purchase.supplier) {
        // `$inc: { totalDue: -amount }` no longer says enough: the payable and
        // the prepayment are two halves of one net, and only the components can
        // decide which half this money lands in. Read, move `totalPaid`,
        // re-derive — inside the transaction that wrote the payment.
        const supplierDoc = await Supplier.findById(purchase.supplier).session(session || null);
        if (supplierDoc) {
          Supplier.backfillTotalPaid(supplierDoc);
          supplierDoc.totalPaid = quantizeMoney(supplierDoc.totalPaid + amount);
          Supplier.applyBalances(supplierDoc);
          await supplierDoc.save(sessionOpt);
        }

        // The same movement on the branch that owed it.
        await SupplierBalance.applyDelta({
          shop: shopId,
          supplier: purchase.supplier,
          branch: purchase.branch,
          paid: amount,
          due: -amount,
        }, session);
        await SupplierBalance.recomputeBalances({
          shop: shopId,
          supplier: purchase.supplier,
          branch: purchase.branch,
        }, session);

        /**
         * Paying a bill by hand SHRINKS what it can absorb from the vendor's
         * prepayment, so any অগ্রিম already sitting on it may now overflow.
         *
         * Concretely: a ৳20,000 challan carrying ৳20,000 of অগ্রিম is paid
         * ৳20,000 in cash. Without this the bill would still claim the whole
         * prepayment it no longer has room for, the `due` hook would clamp it
         * away, and that money would stop existing rather than moving to the
         * next open challan. The customer side calls its reallocator from
         * `recordPayment` for exactly this reason.
         */
        await supplierSettlement.reallocateSupplierAdvance(
          { shopId, supplierId: purchase.supplier, branchId: purchase.branch || null },
          session
        );
      }

      // Audit log
      await AuditLog.create([{
        shop: shopId,
        branch: purchase.branch || null,
        user: userId,
        action: 'payment_received',
        actionBn: 'ক্রয়ের পেমেন্ট',
        description: `Paid ৳${amount} for purchase ${purchase.invoiceNo}`
          + (olderAllocations.length > 0
            ? ` (settled ${olderAllocations.length} older bill${olderAllocations.length > 1 ? 's' : ''})`
            : ''),
        descriptionBn: `ক্রয় ${purchase.invoiceNo} এর জন্য ৳${amount} পেমেন্ট`
          + (olderAllocations.length > 0 ? ` (${olderAllocations.length}টি পুরোনো বিলসহ)` : ''),
        entity: {
          type: 'purchase',
          id: purchase._id,
          name: purchase.invoiceNo,
        },
        changes: {
          before: { paid: quantizeMoney(purchase.paid - primaryApplied), due: dueBefore },
          after: { paid: purchase.paid, due: purchase.due },
        },
      }], sessionOpt);

      // Every bill this money touched, invoice numbers included so the UI can
      // toast "পুরোনো বিল PUR… এ ৳X বসেছে" without a second fetch.
      const allocations = [
        ...(primaryApplied > 0
          ? [{ purchase: purchase._id, invoiceNo: purchase.invoiceNo, amount: primaryApplied }]
          : []),
        ...olderAllocations.map((a) => ({
          purchase: a.doc._id,
          invoiceNo: a.doc.invoiceNo,
          amount: a.amount,
        })),
      ];

      return { purchase, payment, allocations, totalApplied: amount };
    });
  }

  // Get payments for a purchase
  async getPurchasePayments(shopId, purchaseId, req = null) {
    const purchase = await Purchase.findOne(branchFilter(req, { _id: purchaseId, shop: shopId }));
    if (!purchase) {
      throw new AppError('Purchase not found', 'ক্রয়টি পাওয়া যায়নি', 404);
    }

    // A voided row (a cancelled purchase's unwound payment) is money the
    // drawer got back — it is not part of what was paid on this bill.
    const payments = await Payment.find({ shop: shopId, purchase: purchaseId, ...LIVE_PAYMENT })
      .populate('receivedBy', 'name')
      .sort({ createdAt: -1 })
      .lean();

    return payments;
  }
}

module.exports = new PurchaseService();
