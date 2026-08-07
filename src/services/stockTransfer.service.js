const StockTransfer = require('../models/StockTransfer.model');
const StockTransaction = require('../models/StockTransaction.model');
const Product = require('../models/Product.model');
const Branch = require('../models/Branch.model');
const { runInTransaction } = require('../utils/transaction.util');
const { STOCK_TRANSACTION_TYPES } = require('../config/constants');
const { isActiveBranch, isAllBranchesView, isMultiBranch } = require('../utils/branchScope.util');
const { storageUnit, quantize } = require('../utils/quantity.util');

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

  // Validate stock availability against the source branch's own products
  for (const item of items) {
    const product = await Product.findOne({
      _id: item.product, shop, branch: fromBranch, isDeleted: { $ne: true },
    });
    if (!product) {
      throw createError(`${item.productName || 'পণ্য'} উৎস শাখায় পাওয়া যায়নি`, 404);
    }
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
    for (const item of transfer.items) {
      const product = await Product.findOne({
        _id: item.product, shop: shopId, branch: transfer.fromBranch,
      }).session(session);

      if (!product) {
        throw createError(`${item.productName || 'পণ্য'} উৎস শাখায় পাওয়া যায়নি`, 404);
      }

      const previousStock = readStock(product, item.variantId || null);
      if (previousStock < item.quantity) {
        throw createError(`${item.productName || 'পণ্য'} এর স্টক অপর্যাপ্ত`, 400);
      }

      const newStock = applyStock(product, item.variantId || null, -item.quantity);
      await product.save({ session });

      await StockTransaction.create([{
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
      }], { session });
    }

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

    for (const item of transfer.items) {
      // Find matching received quantity (default to full quantity)
      const receivedQty = receivedItems
        ? (receivedItems.find(r => String(r.itemId) === String(item._id))?.received ?? item.quantity)
        : item.quantity;

      item.received = receivedQty;

      // Resolve the destination branch's own copy of this product — a
      // different document with its own price and stock — and credit it.
      const sourceProduct = await Product.findById(item.product).session(session || null);
      if (!sourceProduct) {
        throw createError(`${item.productName || 'পণ্য'} পাওয়া যায়নি`, 404);
      }

      const target = await findCounterpart(sourceProduct, shopId, transfer.toBranch, session);
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
      await target.save(sessionOpt);

      await StockTransaction.create([{
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
      }], sessionOpt);
    }

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
      for (const item of transfer.items) {
        const product = await Product.findOne({
          _id: item.product, shop: shopId, branch: transfer.fromBranch,
        }).session(session);

        if (product) {
          const previousStock = readStock(product, item.variantId || null);
          const newStock = applyStock(product, item.variantId || null, item.quantity);
          await product.save({ session });

          await StockTransaction.create([{
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
          }], { session });
        }
      }
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
