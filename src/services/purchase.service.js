const Purchase = require('../models/Purchase.model');
const Product = require('../models/Product.model');
const Supplier = require('../models/Supplier.model');
const Payment = require('../models/Payment.model');
const StockTransaction = require('../models/StockTransaction.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { getBranchForCreate } = require('../utils/branchScope.util');
const BranchStock = require('../models/BranchStock.model');
const mongoose = require('mongoose');
const { runInTransaction } = require('../utils/transaction.util');

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
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.date.$lte = end;
      }
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
  async getPurchaseById(shopId, purchaseId) {
    const purchase = await Purchase.findOne({
      _id: purchaseId,
      shop: shopId,
    })
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

    for (const item of items) {
      let rawProdId = item.product || item.productId;
      if (typeof rawProdId === 'object' && rawProdId !== null) {
        rawProdId = rawProdId._id || rawProdId.id;
      }

      const product = await Product.findOne({
        _id: rawProdId,
        shop: shopId,
        isActive: true,
      }).session(session || null);

      if (!product) {
        const displayId = typeof rawProdId === 'object' ? JSON.stringify(rawProdId) : rawProdId;
        throw new AppError(
          `পণ্য "${item.productName || displayId}" পাওয়া যায়নি`,
          `Product not found: ${displayId}`,
          404
        );
      }

      const quantity = parseInt(item.quantity);
      const unitPrice = parseFloat(item.unitPrice);
      const itemTotal = quantity * unitPrice;

      if (quantity <= 0) {
        throw new AppError(
          `"${product.name}" এর পরিমাণ কমপক্ষে ১ হতে হবে`,
          'Quantity must be at least 1',
          400
        );
      }

      preparedItems.push({
        product: product._id,
        productName: product.name,
        productCode: product.code,
        variantId: item.variantId || undefined,
        variantLabel: item.variantLabel || undefined,
        quantity,
        unitPrice,
        total: itemTotal,
      });

      totalAmount += itemTotal;
    }

    // Generate invoice number
    const invoiceNo = await Purchase.generateInvoiceNo(shopId);

    // Create purchase
    const branchId = req ? getBranchForCreate(req) : null;
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

    // Increase stock for each item
    const isMultiBranchActive = branchId && req?.shop?.multiBranchEnabled;

    for (const item of preparedItems) {
      const product = await Product.findById(item.product);
      let previousStock, newStock;

      if (isMultiBranchActive) {
        const bsRecord = await BranchStock.getOrCreate(shopId, branchId, item.product, item.variantId || null);
        previousStock = bsRecord.stock;
        bsRecord.stock += item.quantity;
        newStock = bsRecord.stock;
        await bsRecord.save();

        // Recalculate main product stock
        const totalStock = await BranchStock.getTotalStock(shopId, item.product, item.variantId || null);
        if (item.variantId && product.hasVariants) {
          const variant = (product.variants && typeof product.variants.id === 'function')
            ? product.variants.id(item.variantId)
            : product.variants?.find(v => (v._id || v.id)?.toString() === item.variantId?.toString());
          if (variant) {
            variant.stock = totalStock;
          }
        } else {
          product.stock = totalStock;
        }
        await product.save(sessionOpt);
      } else {
        const getVariantStock = (p, vId) => {
          if (!p.variants) return 0;
          const v = typeof p.variants.id === 'function' ? p.variants.id(vId) : p.variants.find(x => (x._id || x.id)?.toString() === vId?.toString());
          return v?.stock || 0;
        };

        previousStock = item.variantId
          ? getVariantStock(product, item.variantId)
          : product.stock;

        // Update stock
        if (item.variantId && product.hasVariants) {
          const variant = (product.variants && typeof product.variants.id === 'function')
            ? product.variants.id(item.variantId)
            : product.variants?.find(v => (v._id || v.id)?.toString() === item.variantId?.toString());
          if (variant) {
            variant.stock += item.quantity;
          }
        } else {
          product.stock += item.quantity;
        }
        await product.save(sessionOpt);

        newStock = item.variantId
          ? getVariantStock(product, item.variantId)
          : product.stock;
      }

      // Batch tracking: push batch entry if product has trackBatches enabled
      if (product.trackBatches && !item.variantId) {
        product.batches.push({
          batchNumber: item.batchNumber || `B-${purchase.invoiceNo}-${Date.now()}`,
          expiryDate: item.expiryDate || null,
          quantity: item.quantity,
          costPrice: item.unitPrice,
          receivedDate: new Date(),
          purchaseRef: purchase._id,
        });
        await product.save(sessionOpt);
      }

      // Create stock transaction
      await StockTransaction.create([{
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
      }], sessionOpt);
    }

    // Update supplier stats
    if (supplierDoc) {
      supplierDoc.totalPurchases += 1;
      supplierDoc.totalAmount += totalAmount;
      supplierDoc.totalDue += purchase.due;
      await supplierDoc.save(sessionOpt);
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

  // Cancel purchase (reverse stock)
  async cancelPurchase(shopId, userId, purchaseId) {
    const purchase = await Purchase.findOne({
      _id: purchaseId,
      shop: shopId,
    });

    if (!purchase) {
      throw new AppError('ক্রয়টি পাওয়া যায়নি', 'Purchase not found', 404);
    }

    if (purchase.status === 'cancelled') {
      throw new AppError('এই ক্রয়টি আগেই বাতিল করা হয়েছে', 'Purchase already cancelled', 400);
    }

    // Reverse stock for each item
    for (const item of purchase.items) {
      const product = await Product.findById(item.product);
      if (!product) continue;

      const getVariantStock = (p, vId) => {
        if (!p.variants) return 0;
        const v = typeof p.variants.id === 'function' ? p.variants.id(vId) : p.variants.find(x => (x._id || x.id)?.toString() === vId?.toString());
        return v?.stock || 0;
      };

      const previousStock = item.variantId
        ? getVariantStock(product, item.variantId)
        : product.stock;

      if (item.variantId && product.hasVariants) {
        const variant = (product.variants && typeof product.variants.id === 'function')
          ? product.variants.id(item.variantId)
          : product.variants?.find(v => (v._id || v.id)?.toString() === item.variantId?.toString());
        if (variant) {
          variant.stock = Math.max(0, variant.stock - item.quantity);
        }
      } else {
        product.stock = Math.max(0, product.stock - item.quantity);
      }
      await product.save();

      const newStock = item.variantId
        ? getVariantStock(product, item.variantId)
        : product.stock;

      // Create reversal stock transaction
      await StockTransaction.create({
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

    // Update supplier stats
    if (purchase.supplier) {
      const supplier = await Supplier.findById(purchase.supplier);
      if (supplier) {
        supplier.totalPurchases = Math.max(0, supplier.totalPurchases - 1);
        supplier.totalAmount = Math.max(0, supplier.totalAmount - purchase.totalAmount);
        supplier.totalDue = Math.max(0, supplier.totalDue - purchase.due);
        await supplier.save();
      }
    }

    purchase.status = 'cancelled';
    await purchase.save();

    // Audit log
    await AuditLog.create({
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
    });

    return { success: true };
  }

  // Get purchase summary
  async getSummary(shopId, options = {}) {
    const { startDate, endDate } = options;

    let start, end;
    if (startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
    } else {
      // Default to current month
      const now = new Date();
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const [monthSummary, todaySummary] = await Promise.all([
      Purchase.getSummary(shopId, start, end),
      Purchase.getSummary(shopId, todayStart, todayEnd),
    ]);

    return {
      period: { start, end },
      month: monthSummary,
      today: todaySummary,
    };
  }
  // Record payment for a purchase
  async recordPayment(shopId, userId, purchaseId, paymentData) {
    const { amount, method = 'cash', notes } = paymentData;

    const purchase = await Purchase.findOne({ _id: purchaseId, shop: shopId });
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

    // Create payment record
    const payment = await Payment.create({
      shop: shopId,
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
  async getPurchasePayments(shopId, purchaseId) {
    const purchase = await Purchase.findOne({ _id: purchaseId, shop: shopId });
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
