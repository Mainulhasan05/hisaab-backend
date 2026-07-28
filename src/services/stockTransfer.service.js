const StockTransfer = require('../models/StockTransfer.model');
const BranchStock = require('../models/BranchStock.model');
const StockTransaction = require('../models/StockTransaction.model');
const Product = require('../models/Product.model');
const Branch = require('../models/Branch.model');
const { runInTransaction } = require('../utils/transaction.util');
const { STOCK_TRANSACTION_TYPES } = require('../config/constants');

// Helper to create errors with statusCode (no AppError class in this project)
const createError = (message, statusCode = 400) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.messageBn = message;
  return err;
};

/**
 * Create a new stock transfer request
 */
exports.createTransfer = async (data, userId) => {
  const { shop, fromBranch, toBranch, items, notes } = data;

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

  // Validate stock availability at source branch
  for (const item of items) {
    const branchStock = await BranchStock.findOne({
      shop, branch: fromBranch, product: item.product, variantId: item.variantId || null,
    });
    const available = branchStock?.stock || 0;
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
exports.approveTransfer = async (transferId, shopId, userId) => {
  return runInTransaction(async (session) => {
    const transfer = await StockTransfer.findOne({ _id: transferId, shop: shopId }).session(session);
    if (!transfer) throw createError('ট্রান্সফার পাওয়া যায়নি', 404);
    if (transfer.status !== 'pending') throw createError('শুধুমাত্র পেন্ডিং ট্রান্সফার অনুমোদন করা যায়', 400);

    // Deduct stock from source branch
    for (const item of transfer.items) {
      const branchStock = await BranchStock.findOne({
        shop: shopId, branch: transfer.fromBranch, product: item.product, variantId: item.variantId || null,
      }).session(session);

      if (!branchStock || branchStock.stock < item.quantity) {
        throw createError(`${item.productName || 'পণ্য'} এর স্টক অপর্যাপ্ত`, 400);
      }

      const previousStock = branchStock.stock;
      branchStock.stock -= item.quantity;
      await branchStock.save({ session });

      // Log stock transaction for source branch
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
        newStock: branchStock.stock,
        reference: transfer._id,
        referenceModel: 'StockTransfer',
        performedBy: userId,
        note: `ট্রান্সফার #${transfer.transferNo} — শাখা থেকে পাঠানো`,
      }], { session });

      // Also update main product stock
      const product = await Product.findById(item.product).session(session);
      if (product) {
        if (item.variantId) {
          const variant = product.variants?.id(item.variantId);
          if (variant) {
            variant.stock = Math.max(0, (variant.stock || 0) - item.quantity);
          }
        } else {
          product.stock = Math.max(0, (product.stock || 0) - item.quantity);
        }
        await product.save({ session });
      }
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
exports.receiveTransfer = async (transferId, shopId, userId, receivedItems) => {
  return runInTransaction(async (session) => {
    const transfer = await StockTransfer.findOne({ _id: transferId, shop: shopId }).session(session);
    if (!transfer) throw createError('ট্রান্সফার পাওয়া যায়নি', 404);
    if (transfer.status !== 'in_transit') throw createError('শুধুমাত্র ট্রানজিটে থাকা ট্রান্সফার গ্রহণ করা যায়', 400);

    for (const item of transfer.items) {
      // Find matching received quantity (default to full quantity)
      const receivedQty = receivedItems
        ? (receivedItems.find(r => String(r.itemId) === String(item._id))?.received ?? item.quantity)
        : item.quantity;

      item.received = receivedQty;

      // Add stock to destination branch
      const branchStock = await BranchStock.getOrCreate(shopId, transfer.toBranch, item.product, item.variantId || null);
      if (session) {
        // Re-fetch within session
        const bs = await BranchStock.findById(branchStock._id).session(session);
        const previousStock = bs.stock;
        bs.stock += receivedQty;
        await bs.save({ session });

        // Log stock transaction for destination branch
        await StockTransaction.create([{
          shop: shopId,
          branch: transfer.toBranch,
          product: item.product,
          productName: item.productName,
          productCode: item.productCode,
          variantId: item.variantId,
          variantSku: item.variantSku,
          variantAttributes: item.variantAttributes,
          type: STOCK_TRANSACTION_TYPES.TRANSFER_IN,
          quantity: receivedQty,
          previousStock,
          newStock: bs.stock,
          reference: transfer._id,
          referenceModel: 'StockTransfer',
          performedBy: userId,
          note: `ট্রান্সফার #${transfer.transferNo} — শাখায় গৃহীত`,
        }], { session });

        // Also update main product stock
        const product = await Product.findById(item.product).session(session);
        if (product) {
          if (item.variantId) {
            const variant = product.variants?.id(item.variantId);
            if (variant) {
              variant.stock = (variant.stock || 0) + receivedQty;
            }
          } else {
            product.stock = (product.stock || 0) + receivedQty;
          }
          await product.save({ session });
        }
      } else {
        const previousStock = branchStock.stock;
        branchStock.stock += receivedQty;
        await branchStock.save();

        await StockTransaction.create({
          shop: shopId,
          branch: transfer.toBranch,
          product: item.product,
          productName: item.productName,
          productCode: item.productCode,
          variantId: item.variantId,
          variantSku: item.variantSku,
          type: STOCK_TRANSACTION_TYPES.TRANSFER_IN,
          quantity: receivedQty,
          previousStock,
          newStock: branchStock.stock,
          reference: transfer._id,
          referenceModel: 'StockTransfer',
          performedBy: userId,
          note: `ট্রান্সফার #${transfer.transferNo} — শাখায় গৃহীত`,
        });

        const product = await Product.findById(item.product);
        if (product) {
          if (item.variantId) {
            const variant = product.variants?.id(item.variantId);
            if (variant) variant.stock = (variant.stock || 0) + receivedQty;
          } else {
            product.stock = (product.stock || 0) + receivedQty;
          }
          await product.save();
        }
      }
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
exports.rejectTransfer = async (transferId, shopId, userId, reason) => {
  return runInTransaction(async (session) => {
    const transfer = await StockTransfer.findOne({ _id: transferId, shop: shopId }).session(session);
    if (!transfer) throw createError('ট্রান্সফার পাওয়া যায়নি', 404);
    if (!['pending', 'in_transit'].includes(transfer.status)) {
      throw createError('শুধুমাত্র পেন্ডিং বা ট্রানজিট ট্রান্সফার বাতিল করা যায়', 400);
    }

    // If in_transit, reverse the source deduction
    if (transfer.status === 'in_transit') {
      for (const item of transfer.items) {
        const branchStock = await BranchStock.findOne({
          shop: shopId, branch: transfer.fromBranch, product: item.product, variantId: item.variantId || null,
        }).session(session);

        if (branchStock) {
          const previousStock = branchStock.stock;
          branchStock.stock += item.quantity;
          await branchStock.save({ session });

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
            newStock: branchStock.stock,
            reference: transfer._id,
            referenceModel: 'StockTransfer',
            performedBy: userId,
            note: `ট্রান্সফার #${transfer.transferNo} বাতিল — স্টক ফেরত`,
          }], { session });
        }

        // Reverse main product stock
        const product = await Product.findById(item.product).session(session);
        if (product) {
          if (item.variantId) {
            const variant = product.variants?.id(item.variantId);
            if (variant) variant.stock = (variant.stock || 0) + item.quantity;
          } else {
            product.stock = (product.stock || 0) + item.quantity;
          }
          await product.save({ session });
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
exports.getTransfers = async (shopId, query = {}) => {
  const { status, fromBranch, toBranch, page = 1, limit = 20 } = query;
  const filter = { shop: shopId };
  if (status) filter.status = status;
  if (fromBranch) filter.fromBranch = fromBranch;
  if (toBranch) filter.toBranch = toBranch;

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
exports.getTransferById = async (transferId, shopId) => {
  const transfer = await StockTransfer.findOne({ _id: transferId, shop: shopId })
    .populate('fromBranch', 'name code')
    .populate('toBranch', 'name code')
    .populate('requestedBy', 'name')
    .populate('approvedBy', 'name')
    .populate('receivedBy', 'name')
    .populate('items.product', 'name code')
    .lean();

  if (!transfer) throw new AppError('ট্রান্সফার পাওয়া যায়নি', 404);
  return transfer;
};
