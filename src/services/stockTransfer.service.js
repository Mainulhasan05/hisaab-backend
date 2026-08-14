const StockTransfer = require('../models/StockTransfer.model');
const StockTransaction = require('../models/StockTransaction.model');
const Product = require('../models/Product.model');
const Branch = require('../models/Branch.model');
const { runInTransaction } = require('../utils/transaction.util');
const { STOCK_TRANSACTION_TYPES } = require('../config/constants');
const { isActiveBranch, isAllBranchesView, isMultiBranch } = require('../utils/branchScope.util');
const { storageUnit, quantize } = require('../utils/quantity.util');
const { takeBatches, addBatches, batchWriteOp } = require('../utils/batch.util');
const { assertNotCombo } = require('../utils/combo.util');

// Helper to create errors with statusCode (no AppError class in this project)
const createError = (message, statusCode = 400) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.messageBn = message;
  return err;
};

/**
 * Stock transfer is the one place cross-branch access is intentional, so it
 * cannot just be filtered by the active branch — it needs a rule per action
 * (product decision #9):
 *
 *   create / approve / reject → the SOURCE branch acts
 *   receive                   → the DESTINATION branch acts
 *
 * An owner viewing "All Branches" is not acting as any branch, so they must
 * pick one first — same rule as every other write. Single-branch shops never
 * reach this (isMultiBranch is false, so it is a no-op).
 */
const assertActingBranch = (req, branchId, role) => {
  if (!req || !isMultiBranch(req)) return;

  if (isAllBranchesView(req)) {
    throw createError(
      role === 'destination'
        ? 'ট্রান্সফার গ্রহণ করতে গন্তব্য শাখা নির্বাচন করুন'
        : 'ট্রান্সফার পরিচালনা করতে উৎস শাখা নির্বাচন করুন',
      400
    );
  }

  if (!isActiveBranch(req, branchId)) {
    throw createError(
      role === 'destination'
        ? 'শুধুমাত্র গন্তব্য শাখা এই ট্রান্সফার গ্রহণ করতে পারে'
        : 'শুধুমাত্র উৎস শাখা এই ট্রান্সফার পরিচালনা করতে পারে',
      403
    );
  }
};

/**
 * Resolve the destination branch's copy of a product.
 *
 * Each branch owns its own product documents, so "the same item" in another
 * branch is a different document. They are matched by `code` — the clone that
 * seeds a new branch keeps the code identical — with `clonedFrom` lineage as a
 * fallback for products whose code was later edited.
 *
 * Returns null when the destination branch does not stock the item, which the
 * callers surface as a named error rather than silently transferring nothing.
 */
const findCounterpart = async (sourceProduct, shopId, branchId, session = null) => {
  const q = (filter) => Product.findOne(filter).session(session || null);

  return (
    (await q({ shop: shopId, branch: branchId, code: sourceProduct.code, isDeleted: { $ne: true } })) ||
    (await q({ shop: shopId, branch: branchId, clonedFrom: sourceProduct.clonedFrom || sourceProduct._id, isDeleted: { $ne: true } })) ||
    (await q({ shop: shopId, branch: branchId, _id: sourceProduct.clonedFrom, isDeleted: { $ne: true } }))
  );
};

/**
 * Batched twin of `findCounterpart` — resolves every source product's
 * destination-branch copy in ONE query instead of up to three per line.
 *
 * `findCounterpart` is kept above because it is still the clearest statement of
 * the matching RULE, and the precedence here is a faithful copy of it:
 *
 *   1. same `code` in the destination branch   (the clone keeps the code)
 *   2. same `clonedFrom` lineage               (code was edited since)
 *   3. the destination product IS the original the source was cloned from
 *
 * Candidates for all three arms are fetched together, then resolved in memory
 * in that same order. If you change the rule, change both — or delete the
 * single-item version and route its callers here.
 */
const findCounterpartsBatch = async (sourceProducts, shopId, branchId, session = null) => {
  if (sourceProducts.length === 0) return new Map();

  const codes = [...new Set(sourceProducts.map((p) => p.code).filter(Boolean))];
  const lineage = [...new Set(
    sourceProducts.map((p) => String(p.clonedFrom || p._id)).filter(Boolean)
  )];
  const originIds = [...new Set(
    sourceProducts.map((p) => p.clonedFrom).filter(Boolean).map(String)
  )];

  const or = [];
  if (codes.length) or.push({ code: { $in: codes } });
  if (lineage.length) or.push({ clonedFrom: { $in: lineage } });
  if (originIds.length) or.push({ _id: { $in: originIds } });
  if (or.length === 0) return new Map();

  const candidates = await Product.find({
    shop: shopId, branch: branchId, isDeleted: { $ne: true }, $or: or,
  }).session(session || null);

  const byCode = new Map();
  const byClonedFrom = new Map();
  const byId = new Map();
  for (const c of candidates) {
    if (c.code && !byCode.has(c.code)) byCode.set(c.code, c);
    if (c.clonedFrom && !byClonedFrom.has(String(c.clonedFrom))) byClonedFrom.set(String(c.clonedFrom), c);
    byId.set(String(c._id), c);
  }

  const resolved = new Map();
  for (const src of sourceProducts) {
    const match =
      (src.code && byCode.get(src.code)) ||
      byClonedFrom.get(String(src.clonedFrom || src._id)) ||
      (src.clonedFrom && byId.get(String(src.clonedFrom))) ||
      null;
    if (match) resolved.set(String(src._id), match);
  }
  return resolved;
};

/** Read a product's stock for a variant (or the product itself). */
const readStock = (product, variantId) => {
  if (!variantId) return product.stock || 0;
  const v = typeof product.variants?.id === 'function'
    ? product.variants.id(variantId)
    : product.variants?.find((x) => String(x._id) === String(variantId));
  return v?.stock || 0;
};

/**
 * Apply a delta to a product's stock (variant-aware) and return the new value.
 *
 * Quantized at the product's own precision. A transfer is a deduct on one
 * document and an add on another, and the two products are separate documents
 * with separately-drifting stock — without the rounding, moving 1.1 kg back and
 * forth a few hundred times leaves both branches holding a residue and the
 * shop-wide total no longer adding up.
 *
 * `storageUnit` is flag-independent by design: a transfer created while
 * packaging was on must still settle correctly if it is switched off before the
 * receiving branch accepts it.
 */
const applyStock = (product, variantId, delta) => {
  const stkUnit = storageUnit(product);
  if (variantId) {
    const v = typeof product.variants?.id === 'function'
      ? product.variants.id(variantId)
      : product.variants?.find((x) => String(x._id) === String(variantId));
    if (!v) return null;
    v.stock = quantize(Math.max(0, quantize((v.stock || 0) + delta, stkUnit)), stkUnit);
    return v.stock;
  }
  product.stock = quantize(Math.max(0, quantize((product.stock || 0) + delta, stkUnit)), stkUnit);
  return product.stock;
};

/**
 * Load every product referenced by `items` in ONE query, keyed by id string.
 *
 * Replaces the `await Product.findOne(...)` that used to sit inside each of the
 * loops below — one round trip per line item, sequential, inside an open
 * transaction. A 20-line transfer cost 20 reads for information a single `$in`
 * returns (PERFORMANCE_AUDIT.md H-3).
 */
const loadProductsFor = async (items, filter, session = null) => {
  const ids = [...new Set(items.map((i) => String(i.product)))];
  const docs = await Product.find({ ...filter, _id: { $in: ids } }).session(session || null);
  return new Map(docs.map((d) => [String(d._id), d]));
};

/**
 * A bulkWrite op that persists the stock value already computed by `applyStock`.
 *
 * `$set` — not `$inc` — on purpose. `applyStock` quantizes at the product's own
 * precision in JS, and the previous code persisted that result with
 * `product.save()`. Writing the computed value keeps this refactor
 * behaviour-preserving; switching to `$inc` would change the rounding and the
 * concurrency semantics at the same time, which is not what a batching change
 * should do. (The sale path uses `$inc` with a `$gte` guard because it needs
 * atomic oversell protection; transfers guard by explicit pre-validation.)
 */
const stockWriteOp = (product, variantId, newStock) => (
  variantId
    ? {
      updateOne: {
        filter: { _id: product._id },
        update: { $set: { 'variants.$[v].stock': newStock } },
        arrayFilters: [{ 'v._id': variantId }],
      },
    }
    : {
      updateOne: {
        filter: { _id: product._id },
        update: { $set: { stock: newStock } },
      },
    }
);

/** Flush queued stock writes and ledger rows — at most two round trips. */
const flushStockOps = async (stockOps, txns, sessionOpt) => {
  if (stockOps.length > 0) await Product.bulkWrite(stockOps, sessionOpt);
  if (txns.length > 0) await StockTransaction.insertMany(txns, sessionOpt);
};

/**
 * Create a new stock transfer request
 */
exports.createTransfer = async (data, userId, req = null) => {
  const { shop, fromBranch, toBranch, items, notes } = data;

  assertActingBranch(req, fromBranch, 'source');

  if (fromBranch === toBranch || String(fromBranch) === String(toBranch)) {
    throw createError('উৎস ও গন্তব্য শাখা একই হতে পারবে না', 400);
  }

  // Validate branches belong to shop
  const [sourceBranch, destBranch] = await Promise.all([
    Branch.validateBranchOwnership(fromBranch, shop),
    Branch.validateBranchOwnership(toBranch, shop),
  ]);
  if (!sourceBranch) throw createError('উৎস শাখা পাওয়া যায়নি', 404);
  if (!destBranch) throw createError('গন্তব্য শাখা পাওয়া যায়নি', 404);

  // Validate stock availability against the source branch's own products.
  // One read for the whole catalogue; the checks below are then in-memory and
  // fail on the same line, with the same message, as the per-item loop did.
  const productMap = await loadProductsFor(items, {
    shop, branch: fromBranch, isDeleted: { $ne: true },
  });

  for (const item of items) {
    const product = productMap.get(String(item.product));
    if (!product) {
      throw createError(`${item.productName || 'পণ্য'} উৎস শাখায় পাওয়া যায়নি`, 404);
    }
    // A combo has no stock to move between branches — transfer its components.
    assertNotCombo(product, 'শাখা স্থানান্তর');
    const available = readStock(product, item.variantId || null);
    if (available < item.quantity) {
      throw createError(`${item.productName || 'পণ্য'} এর স্টক অপর্যাপ্ত (আছে: ${available}, চাহিদা: ${item.quantity})`, 400);
    }
  }

  const transfer = await StockTransfer.create({
    shop, fromBranch, toBranch, items, notes,
    requestedBy: userId,
    status: 'pending',
  });

  return transfer;
};

/**
 * Approve transfer — deduct stock from source branch, set status to in_transit
 */
exports.approveTransfer = async (transferId, shopId, userId, req = null) => {
  return runInTransaction(async (session) => {
    const transfer = await StockTransfer.findOne({ _id: transferId, shop: shopId }).session(session);
    if (!transfer) throw createError('ট্রান্সফার পাওয়া যায়নি', 404);
    assertActingBranch(req, transfer.fromBranch, 'source');
    if (transfer.status !== 'pending') throw createError('শুধুমাত্র পেন্ডিং ট্রান্সফার অনুমোদন করা যায়', 400);

    // Deduct from the source branch's own product documents.
    //
    // Two passes on purpose. The loop this replaced validated and wrote line by
    // line, so a shortage on line 5 left lines 1-4 already deducted and their
    // ledger rows written. A real transaction rolled that back — but
    // `runInTransaction` hands back a NULL SESSION on a standalone server, and
    // on that topology the partial deduction stuck. Validating everything
    // before writing anything makes the all-or-nothing guarantee hold whether
    // or not the deployment can actually do transactions.
    const sessionOpt = session ? { session } : {};
    const productMap = await loadProductsFor(
      transfer.items, { shop: shopId, branch: transfer.fromBranch }, session
    );

    const stockOps = [];
    const txns = [];

    for (const item of transfer.items) {
      const product = productMap.get(String(item.product));
      if (!product) {
        throw createError(`${item.productName || 'পণ্য'} উৎস শাখায় পাওয়া যায়নি`, 404);
      }

      const previousStock = readStock(product, item.variantId || null);
      if (previousStock < item.quantity) {
        throw createError(`${item.productName || 'পণ্য'} এর স্টক অপর্যাপ্ত`, 400);
      }

      // Mutates the in-memory doc, so two lines against the same product see
      // each other's deduction — exactly as the sequential loop did.
      const newStock = applyStock(product, item.variantId || null, -item.quantity);
      stockOps.push(stockWriteOp(product, item.variantId || null, newStock));

      // ── The dated goods leaving this branch ─────────────────────────────
      //
      // FEFO picks them, and WHICH ones is recorded on the transfer line so the
      // receiving branch can recreate them with their real expiry dates. Before
      // this, `batches` was not mentioned anywhere in this file: dispatch
      // removed stock but not batches (so the source over-reported what it had
      // left), and receipt added plain undated stock (so the expiry vanished at
      // the branch boundary). Short-dated goods could be moved between branches
      // until nobody was warned about them at all.
      const { changed, taken } = takeBatches(product, item.variantId || null, item.quantity);
      if (changed) {
        item.batches = taken;
        stockOps.push(batchWriteOp(product));
      }

      txns.push({
        shop: shopId,
        branch: transfer.fromBranch,
        product: item.product,
        productName: item.productName,
        productCode: item.productCode,
        variantId: item.variantId,
        variantSku: item.variantSku,
        variantAttributes: item.variantAttributes,
        type: STOCK_TRANSACTION_TYPES.TRANSFER_OUT,
        quantity: -item.quantity,
        previousStock,
        newStock,
        reference: transfer._id,
        referenceModel: 'StockTransfer',
        performedBy: userId,
        note: `ট্রান্সফার #${transfer.transferNo} — শাখা থেকে পাঠানো`,
      });
    }

    await flushStockOps(stockOps, txns, sessionOpt);

    transfer.status = 'in_transit';
    transfer.approvedBy = userId;
    transfer.approvedAt = new Date();
    await transfer.save({ session });

    return transfer;
  });
};

/**
 * Receive transfer — add stock to destination branch
 */
exports.receiveTransfer = async (transferId, shopId, userId, receivedItems, req = null) => {
  return runInTransaction(async (session) => {
    // runInTransaction falls back to a null session when the topology can't do
    // transactions, so options are built the same way as in sale/salesReturn.
    const sessionOpt = session ? { session } : {};
    const transfer = await StockTransfer.findOne({ _id: transferId, shop: shopId }).session(session);
    if (!transfer) throw createError('ট্রান্সফার পাওয়া যায়নি', 404);
    assertActingBranch(req, transfer.toBranch, 'destination');
    if (transfer.status !== 'in_transit') throw createError('শুধুমাত্র ট্রানজিটে থাকা ট্রান্সফার গ্রহণ করা যায়', 400);

    // Two batched reads for the whole transfer: the source products, then the
    // destination branch's counterparts for all of them at once. This loop used
    // to cost a findById PLUS up to three findOne calls (findCounterpart tries
    // three matching rules in turn) PLUS a save PLUS a ledger insert — per line.
    const sourceMap = await loadProductsFor(transfer.items, { shop: shopId }, session);
    const counterparts = await findCounterpartsBatch(
      [...sourceMap.values()], shopId, transfer.toBranch, session
    );

    const stockOps = [];
    const txns = [];

    for (const item of transfer.items) {
      // Find matching received quantity (default to full quantity)
      const receivedQty = receivedItems
        ? (receivedItems.find(r => String(r.itemId) === String(item._id))?.received ?? item.quantity)
        : item.quantity;

      item.received = receivedQty;

      // Resolve the destination branch's own copy of this product — a
      // different document with its own price and stock — and credit it.
      const sourceProduct = sourceMap.get(String(item.product));
      if (!sourceProduct) {
        throw createError(`${item.productName || 'পণ্য'} পাওয়া যায়নি`, 404);
      }

      const target = counterparts.get(String(sourceProduct._id));
      if (!target) {
        throw createError(
          `"${item.productName || sourceProduct.name}" গন্তব্য শাখায় নেই। আগে ওই শাখায় পণ্যটি যোগ করুন।`,
          400
        );
      }

      const previousStock = readStock(target, item.variantId || null);
      const newStock = applyStock(target, item.variantId || null, receivedQty);
      if (newStock === null) {
        throw createError(
          `"${item.productName || sourceProduct.name}" এর ভ্যারিয়েন্ট গন্তব্য শাখায় নেই`,
          400
        );
      }
      stockOps.push(stockWriteOp(target, item.variantId || null, newStock));

      // ── Replay the dispatched batches at the destination ────────────────
      //
      // The destination is a DIFFERENT product document with its own batch
      // array, so the dates have to be carried across explicitly — see
      // `item.batches` on the transfer model.
      //
      // A partial receipt takes them soonest-first (the order dispatch stored
      // them in), so if 20 of 30 arrive it is the short-dated 20 that are
      // credited. Crediting the long-dated ones instead would leave the branch
      // holding goods it is not warned about.
      //
      // Only when the DESTINATION product tracks batches. Two branches can
      // legitimately configure the same item differently, and `addBatches`
      // fails closed on that rather than forcing tracking on a branch that has
      // not asked for it.
      if (Array.isArray(item.batches) && item.batches.length) {
        let left = receivedQty;
        const arriving = [];
        for (const b of item.batches) {
          if (left <= 0) break;
          const take = Math.min(left, Number(b.quantity) || 0);
          if (take > 0) arriving.push({ ...(b.toObject ? b.toObject() : b), quantity: take });
          left -= take;
        }
        if (addBatches(target, item.variantId || null, arriving)) {
          stockOps.push(batchWriteOp(target));
        }
      }

      txns.push({
        shop: shopId,
        branch: transfer.toBranch,
        product: target._id,
        productName: item.productName,
        productCode: item.productCode,
        variantId: item.variantId,
        variantSku: item.variantSku,
        variantAttributes: item.variantAttributes,
        type: STOCK_TRANSACTION_TYPES.TRANSFER_IN,
        quantity: receivedQty,
        previousStock,
        newStock,
        reference: transfer._id,
        referenceModel: 'StockTransfer',
        performedBy: userId,
        note: `ট্রান্সফার #${transfer.transferNo} — শাখায় গৃহীত`,
      });
    }

    await flushStockOps(stockOps, txns, sessionOpt);

    transfer.status = 'received';
    transfer.receivedBy = userId;
    transfer.receivedAt = new Date();
    await transfer.save({ session });

    return transfer;
  });
};

/**
 * Reject transfer — reverse source stock if in_transit
 */
exports.rejectTransfer = async (transferId, shopId, userId, reason, req = null) => {
  return runInTransaction(async (session) => {
    const transfer = await StockTransfer.findOne({ _id: transferId, shop: shopId }).session(session);
    if (!transfer) throw createError('ট্রান্সফার পাওয়া যায়নি', 404);
    assertActingBranch(req, transfer.fromBranch, 'source');
    if (!['pending', 'in_transit'].includes(transfer.status)) {
      throw createError('শুধুমাত্র পেন্ডিং বা ট্রানজিট ট্রান্সফার বাতিল করা যায়', 400);
    }

    // If in_transit, reverse the source deduction
    if (transfer.status === 'in_transit') {
      const sessionOpt = session ? { session } : {};
      const productMap = await loadProductsFor(
        transfer.items, { shop: shopId, branch: transfer.fromBranch }, session
      );

      const stockOps = [];
      const txns = [];

      for (const item of transfer.items) {
        const product = productMap.get(String(item.product));
        // A line whose product has since been removed is skipped rather than
        // failing the rejection — unchanged from the per-item loop. A rejection
        // that cannot complete would strand the transfer in_transit forever.
        if (!product) continue;

        const previousStock = readStock(product, item.variantId || null);
        const newStock = applyStock(product, item.variantId || null, item.quantity);
        stockOps.push(stockWriteOp(product, item.variantId || null, newStock));

        // The goods never left, so put their batches back exactly as dispatched
        // rather than as undated stock. `addBatches` merges by batch number and
        // date, so a rejected transfer restores the source to the state it was
        // in before approval instead of leaving a duplicate row beside the
        // original.
        if (Array.isArray(item.batches) && item.batches.length) {
          const restored = item.batches.map(b => (b.toObject ? b.toObject() : b));
          if (addBatches(product, item.variantId || null, restored)) {
            stockOps.push(batchWriteOp(product));
          }
        }

        txns.push({
          shop: shopId,
          branch: transfer.fromBranch,
          product: item.product,
          productName: item.productName,
          productCode: item.productCode,
          variantId: item.variantId,
          type: STOCK_TRANSACTION_TYPES.TRANSFER_IN,
          quantity: item.quantity,
          previousStock,
          newStock,
          reference: transfer._id,
          referenceModel: 'StockTransfer',
          performedBy: userId,
          note: `ট্রান্সফার #${transfer.transferNo} বাতিল — স্টক ফেরত`,
        });
      }

      await flushStockOps(stockOps, txns, sessionOpt);
    }

    transfer.status = 'rejected';
    transfer.rejectionReason = reason || '';
    await transfer.save({ session });

    return transfer;
  });
};

/**
 * Get transfers list with filters
 */
exports.getTransfers = async (shopId, query = {}, req = null) => {
  const { status, fromBranch, toBranch, page = 1, limit = 20 } = query;
  const filter = { shop: shopId };
  if (status) filter.status = status;
  if (fromBranch) filter.fromBranch = fromBranch;
  if (toBranch) filter.toBranch = toBranch;

  // A branch sees transfers it is either end of — incoming and outgoing. The
  // owner in "All Branches" sees all of them. Previously every user saw the
  // whole shop's transfers regardless of branch (FEATURE_AUDIT.md H-8).
  if (req?.branchId) {
    filter.$or = [{ fromBranch: req.branchId }, { toBranch: req.branchId }];
  }

  const [transfers, total] = await Promise.all([
    StockTransfer.find(filter)
      .populate('fromBranch', 'name code')
      .populate('toBranch', 'name code')
      .populate('requestedBy', 'name')
      .populate('approvedBy', 'name')
      .populate('receivedBy', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    StockTransfer.countDocuments(filter),
  ]);

  return { data: transfers, total, page: Number(page), totalPages: Math.ceil(total / limit) };
};

/**
 * Get single transfer by ID
 */
exports.getTransferById = async (transferId, shopId, req = null) => {
  const scope = { _id: transferId, shop: shopId };
  if (req?.branchId) {
    scope.$or = [{ fromBranch: req.branchId }, { toBranch: req.branchId }];
  }

  const transfer = await StockTransfer.findOne(scope)
    .populate('fromBranch', 'name code')
    .populate('toBranch', 'name code')
    .populate('requestedBy', 'name')
    .populate('approvedBy', 'name')
    .populate('receivedBy', 'name')
    .populate('items.product', 'name code')
    .lean();

  // `AppError` is not imported in this file — this threw ReferenceError (500)
  // instead of the intended 404 whenever a transfer was not found.
  if (!transfer) throw createError('ট্রান্সফার পাওয়া যায়নি', 404);
  return transfer;
};
