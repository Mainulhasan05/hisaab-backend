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
} = require('../utils/purchasePrice.util');
const { toMoney } = require('../utils/invoiceMath.util');

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
      sortBy = 'date',
      sortOrder = 'desc',
    } = options;

    const query = { shop: shopId, status: { $ne: 'cancelled' } };

    // Branch scoping
    if (options.branchId) {
      query.branch = options.branchId;
    }

    if (supplier) {
      query.supplier = supplier;
    }

    if (status) {
      query.status = status;
    }

    if (startDate || endDate) {
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
      .populate('createdBy', 'name');

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

    // Generate invoice number
    const invoiceNo = await Purchase.generateInvoiceNo(shopId);

    // Create purchase
    const branchId = req ? requireBranch(req) : null;
    const [purchase] = await Purchase.create([{
      shop: shopId,
      branch: branchId,
      invoiceNo,
      supplier: supplierDoc?._id,
      supplierName,
      items: preparedItems,
      totalAmount,
      paid: parseFloat(paid) || 0,
      paymentMethod: paymentMethod || 'cash',
      date: date ? new Date(date) : new Date(),
      notes: notes?.trim(),
      createdBy: userId,
    }], sessionOpt);

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
      const costUpdate = item.variantId && product.hasVariants
        ? buildVariantCostUpdate(item.variantId, item.quantity, item.unitPrice)
        : buildProductCostUpdate(item.quantity, item.unitPrice);

      if (costUpdate) {
        purchaseStockOps.push({
          updateOne: { filter: { _id: product._id }, update: costUpdate },
        });

        const costAfter = blendedCost(previousStock, previousCost, item.quantity, item.unitPrice);
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
              costPrice: item.unitPrice,
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
        unitCost: item.unitPrice,
        totalCost: item.total,
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
    if (costSnapshots.size > 0 || priceSnapshots.size > 0) {
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
      await purchase.save(sessionOpt);
    }

    // Update supplier stats
    if (supplierDoc) {
      supplierDoc.totalPurchases += 1;
      supplierDoc.totalAmount += totalAmount;
      supplierDoc.totalDue += purchase.due;
      await supplierDoc.save(sessionOpt);

      // Same arithmetic, split by the branch the goods were bought for.
      // Written whatever the shop's setup — a no-op for single-branch shops,
      // where `branchId` is null. `paid` is `totalAmount - due`, i.e. whatever
      // was settled at the counter; the rest becomes this branch's payable.
      await SupplierBalance.applyDelta({
        shop: shopId,
        supplier: supplierDoc._id,
        branch: branchId,
        amount: totalAmount,
        paid: totalAmount - purchase.due,
        due: purchase.due,
        count: 1,
        lastPurchase: purchase.date || new Date(),
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
  async cancelPurchase(shopId, userId, purchaseId, req = null) {
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
        product: item.product,
        productName: item.productName,
        productCode: item.productCode,
        variantId: item.variantId,
        type: 'return',
        quantity: -item.quantity,
        previousStock,
        newStock,
        unitCost: item.unitPrice,
        totalCost: item.total,
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
        supplier.totalPurchases = Math.max(0, supplier.totalPurchases - 1);
        supplier.totalAmount = Math.max(0, supplier.totalAmount - purchase.totalAmount);
        supplier.totalDue = Math.max(0, supplier.totalDue - purchase.due);
        await supplier.save(sessionOpt);
      }

      // Unwound at the branch that raised the purchase — the only branch whose
      // figures it ever moved. `recomputeDue` rather than `$inc`-ing totalDue,
      // because the Supplier rollup above clamps at zero and clamping on only
      // one side is precisely how two books drift apart.
      await SupplierBalance.applyDelta({
        shop: shopId,
        supplier: purchase.supplier,
        branch: purchase.branch,
        amount: -purchase.totalAmount,
        paid: -(purchase.totalAmount - purchase.due),
        count: -1,
      }, session);
      await SupplierBalance.recomputeDue({
        shop: shopId,
        supplier: purchase.supplier,
        branch: purchase.branch,
      }, session);
    }

    purchase.status = 'cancelled';
    await purchase.save(sessionOpt);

    // Audit log
    await AuditLog.create([{
      shop: shopId,
      user: userId,
      action: 'purchase_cancel',
      actionBn: 'ক্রয় বাতিল',
      description: `Cancelled purchase #${purchase.invoiceNo}: ৳${purchase.totalAmount}`,
      descriptionBn: `ক্রয় বাতিল #${purchase.invoiceNo}: ৳${purchase.totalAmount}`,
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
  // Record payment for a purchase
  async recordPayment(shopId, userId, purchaseId, paymentData, req = null) {
    const { method = 'cash', notes } = paymentData;
    // Coerced before the comparisons below. The `<= 0` guard was already here
    // and correct, but a string amount slipped past it into `purchase.paid +=`,
    // where `0 + '500'` concatenates rather than adds.
    const amount = toMoney(paymentData.amount);

    const purchase = await Purchase.findOne(branchFilter(req, { _id: purchaseId, shop: shopId }));
    if (!purchase) {
      throw new AppError('Purchase not found', 'ক্রয়টি পাওয়া যায়নি', 404);
    }

    if (purchase.status === 'cancelled') {
      throw new AppError('Cannot record payment for cancelled purchase', 'বাতিল ক্রয়ে পেমেন্ট দেওয়া যাবে না', 400);
    }

    if (amount <= 0) {
      throw new AppError('Payment amount must be greater than 0', 'পেমেন্টের পরিমাণ ০ এর বেশি হতে হবে', 400);
    }

    if (amount > purchase.due) {
      throw new AppError('Payment amount exceeds due balance', 'পেমেন্টের পরিমাণ বাকির চেয়ে বেশি', 400);
    }

    // Update purchase
    purchase.paid += amount;
    await purchase.save(); // pre-save hook recalculates due and status

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
    const payment = await Payment.create({
      shop: shopId,
      branch: purchase.branch || null,
      purchase: purchaseId,
      amount,
      method,
      type: 'purchase_payment',
      notes,
      receivedBy: userId,
    });

    // Update supplier balance if applicable
    if (purchase.supplier) {
      await Supplier.findByIdAndUpdate(purchase.supplier, {
        $inc: { totalDue: -amount },
      });

      // The same reduction on the branch that owed it.
      await SupplierBalance.applyDelta({
        shop: shopId,
        supplier: purchase.supplier,
        branch: purchase.branch,
        paid: amount,
        due: -amount,
      });
    }

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'payment_received',
      actionBn: 'ক্রয়ের পেমেন্ট',
      description: `Paid ৳${amount} for purchase ${purchase.invoiceNo}`,
      descriptionBn: `ক্রয় ${purchase.invoiceNo} এর জন্য ৳${amount} পেমেন্ট`,
      entity: {
        type: 'purchase',
        id: purchase._id,
        name: purchase.invoiceNo,
      },
      changes: {
        before: { paid: purchase.paid - amount, due: purchase.due + amount },
        after: { paid: purchase.paid, due: purchase.due },
      },
    });

    return { purchase, payment };
  }

  // Get payments for a purchase
  async getPurchasePayments(shopId, purchaseId, req = null) {
    const purchase = await Purchase.findOne(branchFilter(req, { _id: purchaseId, shop: shopId }));
    if (!purchase) {
      throw new AppError('Purchase not found', 'ক্রয়টি পাওয়া যায়নি', 404);
    }

    const payments = await Payment.find({ shop: shopId, purchase: purchaseId })
      .populate('receivedBy', 'name')
      .sort({ createdAt: -1 })
      .lean();

    return payments;
  }
}

module.exports = new PurchaseService();
