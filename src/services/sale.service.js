const Sale = require('../models/Sale.model');
const Product = require('../models/Product.model');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Payment = require('../models/Payment.model');
const User = require('../models/User.model');
const StockTransaction = require('../models/StockTransaction.model');
const Shop = require('../models/Shop.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const cacheService = require('./cache.service');
const { branchFilter, requireBranch, getBranchCode, wrongBranchError } = require('../utils/branchScope.util');
const mongoose = require('mongoose');
const { runInTransaction } = require('../utils/transaction.util');

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
  async generateInvoiceNumber(shopId, branchCode = null) {
    const { startOfDay, endOfDay, dateStr } = getBangladeshTodayRange();
    // Date prefix from Bangladesh local date
    const datePrefix = dateStr.replace(/-/g, '');

    const count = await Sale.countDocuments({
      shop: shopId,
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    });

    const prefix = branchCode
      ? `INV-${branchCode}-${datePrefix}`
      : `INV-${datePrefix}`;

    return `${prefix}-${String(count + 1).padStart(4, '0')}`;
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

      let unitPrice, buyingPrice, variantInfo = {};

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

        unitPrice = variant.sellingPrice;
        buyingPrice = variant.buyingPrice || product.buyingPrice || 0;
        variantInfo = {
          variantId: variant._id,
          variantSku: variant.sku,
          variantAttributes: variant.attributes,
        };

        const previousStock = variant.stock;
        // Track stock change in memory for validation of subsequent items of same product
        variant.stock -= item.quantity;

        {
          // Queue bulkWrite operation for variant stock with atomic $gte guard
          bulkStockOps.push({
            updateOne: {
              filter: { _id: product._id, variants: { $elemMatch: { _id: variant._id, stock: { $gte: item.quantity } } } },
              update: { $inc: { 'variants.$.stock': -item.quantity } },
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

        unitPrice = product.sellingPrice;
        buyingPrice = product.buyingPrice || 0;

        const previousStock = product.stock;
        // Track stock change in memory for validation of subsequent items of same product
        product.stock -= item.quantity;

        {
          // Queue bulkWrite operation for product stock with atomic $gte guard
          bulkStockOps.push({
            updateOne: {
              filter: { _id: product._id, stock: { $gte: item.quantity } },
              update: { $inc: { stock: -item.quantity } },
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

        // FEFO batch deduction for batch-tracked products
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
        }
      }

      const itemDiscount = item.discount || 0;
      const itemTotal = (unitPrice * item.quantity) - itemDiscount;

      // Update totalPrice in the last queued stock transaction
      stockTransactions[stockTransactions.length - 1].totalPrice = itemTotal;

      processedItems.push({
        product: product._id,
        productName: product.name,
        ...variantInfo,
        quantity: item.quantity,
        unitPrice,
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

    // Handle customer
    let customer = null;
    let finalCustomerName = customerName;
    let finalCustomerPhone = customerPhone;

    if (customerId) {
      customer = await Customer.findOne({ _id: customerId, shop: shopId }).session(session || null);
      if (customer) {
        finalCustomerName = customer.name;
        finalCustomerPhone = customer.phone;
      }
    } else if (customerPhone) {
      // Try to find existing customer or create new one
      customer = await Customer.findOne({ shop: shopId, phone: customerPhone }).session(session || null);
      if (!customer && customerName) {
        const [newCustomer] = await Customer.create([{
          shop: shopId,
          phone: customerPhone,
          name: customerName,
          createdBy: userId,
        }], sessionOpt);
        customer = newCustomer;
      }
    }

    // Create sale with retry for invoice number collision
    let sale;
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const branchCode = req ? getBranchCode(req) : null;
        const invoiceNo = await this.generateInvoiceNumber(shopId, branchCode);
        const [newSale] = await Sale.create([{
          shop: shopId,
          branch: branchId,
          invoiceNo,
          customer: customer?._id,
          customerName: finalCustomerName,
          customerPhone: finalCustomerPhone,
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

    // Create audit log
    await AuditLog.create({
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
        after: sale.toObject(),
      },
    });

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
    const cancelProducts = await Product.find({ _id: { $in: cancelProductIds } });
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

      if (item.variantId) {
        const variant = (product.variants && typeof product.variants.id === 'function')
          ? product.variants.id(item.variantId)
          : product.variants?.find(v => (v._id || v.id)?.toString() === item.variantId?.toString());
        previousStock = variant?.stock || 0;
        newStock = previousStock + item.quantity;
        if (variant) variant.stock = newStock;

        restoreOps.push({
          updateOne: {
            filter: { _id: product._id, 'variants._id': item.variantId },
            update: { $inc: { 'variants.$.stock': item.quantity } },
          },
        });
      } else {
        previousStock = product.stock || 0;
        newStock = previousStock + item.quantity;
        product.stock = newStock;

        restoreOps.push({
          updateOne: {
            filter: { _id: product._id },
            update: { $inc: { stock: item.quantity } },
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
