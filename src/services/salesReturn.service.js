const SalesReturn = require('../models/SalesReturn.model');
const Sale = require('../models/Sale.model');
const Product = require('../models/Product.model');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Payment = require('../models/Payment.model');
const StockTransaction = require('../models/StockTransaction.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { AUDIT_ACTIONS } = require('../config/constants');
const { branchFilter, requireBranch } = require('../utils/branchScope.util');
const saleService = require('./sale.service');
const mongoose = require('mongoose');
const { runInTransaction } = require('../utils/transaction.util');
const {
  parseQuantity,
  quantityUnit,
  storageUnit,
  quantize,
  quantizeMoney,
} = require('../utils/quantity.util');

const getInvoiceDiscountAmount = (sale) => {
  const discount = Number(sale.discount) || 0;
  const subtotal = Number(sale.subtotal) || 0;

  if (sale.discountType === 'percentage') {
    return (subtotal * discount) / 100;
  }

  return discount;
};

const getInvoiceDiscountShareForItem = (sale, saleItem) => {
  const subtotal = Number(sale.subtotal) || 0;
  if (subtotal <= 0) return 0;

  const itemTotal = Number.isFinite(Number(saleItem.total))
    ? Number(saleItem.total)
    : ((Number(saleItem.unitPrice) || 0) * (Number(saleItem.quantity) || 0)) - (Number(saleItem.discount) || 0);

  return (getInvoiceDiscountAmount(sale) * Math.max(0, itemTotal)) / subtotal;
};

class SalesReturnService {
  /**
   * Create a sales return
   */
  async createReturn(shopId, userId, returnData, req) {
    return await runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};
      const { saleId, items, refundMethod, paymentMethod, reason, notes } = returnData;

    // 1. Fetch the sale — scoped, so a sale from another branch is not even
    // visible here. Previously this was shop-only: a cashier could open a
    // return against another branch's sale, and step 2 below would then book
    // the refund into that branch (FEATURE_AUDIT.md H-4).
    const sale = await Sale.findOne(branchFilter(req, { _id: saleId, shop: shopId }))
      .session(session || null);
    if (!sale) {
      throw new AppError('Sale not found', 'বিক্রয় পাওয়া যায়নি', 404);
    }

    // Returns happen at the branch that made the sale (product decision #10).
    // For an owner in "All Branches" the filter above is a no-op, so the sale's
    // own branch is enforced here instead of silently accepting the mismatch.
    const branchId = sale.branch || null;
    if (req?.shop?.multiBranchEnabled && req.branchId && String(req.branchId) !== String(branchId || '')) {
      throw new AppError(
        'This sale belongs to another branch. Switch to that branch to process the return.',
        'এই বিক্রয়টি অন্য শাখার। ফেরত নিতে ওই শাখায় যান।',
        403
      );
    }

    // 2. Validate sale status
    if (sale.status === 'cancelled') {
      throw new AppError(
        'বাতিল বিক্রয় থেকে মাল ফেরত নেওয়া যাবে না',
        'Cannot return from cancelled sale',
        400
      );
    }

    // 3. Validate refundMethod='adjustment' requires customer
    if (refundMethod === 'adjustment' && !sale.customer) {
      throw new AppError(
        'Walk-in কাস্টমারের জন্য বাকি সমন্বয় করা যাবে না',
        'Cannot adjust due for walk-in customer',
        400
      );
    }

    // 3b. A reason is mandatory on every NEW return.
    //
    // Enforced here rather than in the schema on purpose: returns written before
    // this rule have no reason, and a schema-level `required` would make each of
    // them fail validation on any future save. The service only ever sees new
    // ones, so this is the boundary where the rule can be absolute without
    // stranding existing data.
    if (!reason || !String(reason).trim()) {
      throw new AppError(
        'A return reason is required',
        'ফেরতের কারণ লিখুন',
        400
      );
    }

    // 4. Build already-returned map from existing returns
    const existingReturns = await SalesReturn.find({ shop: shopId, sale: saleId }).session(session || null);
    const alreadyReturnedMap = {};
    for (const ret of existingReturns) {
      for (const ri of ret.items) {
        const key = ri.saleItemId.toString();
        alreadyReturnedMap[key] = (alreadyReturnedMap[key] || 0) + ri.quantity;
      }
    }

    // Products for the sale items being returned. Fetched once, up front, so
    // the per-item loop can resolve each unit's precision without an N+1 —
    // step 8 below re-fetches them for the stock write inside the transaction.
    // Not branch-filtered: the sale has already been branch-checked above, and
    // a product moved or deleted since must not block a legitimate refund.
    const returnProductIds = [...new Set(
      (items || [])
        .map((ri) => {
          const si = (sale.items && typeof sale.items.id === 'function')
            ? sale.items.id(ri.saleItemId)
            : sale.items?.find(i => (i._id || i.id)?.toString() === ri.saleItemId?.toString());
          return si ? String(si.product) : null;
        })
        .filter(Boolean)
    )];
    const returnProducts = returnProductIds.length
      ? await Product.find({ shop: shopId, _id: { $in: returnProductIds } })
        .select('_id unit')
        .session(session || null)
        .lean()
      : [];
    const returnProductMap = new Map(returnProducts.map(p => [String(p._id), p]));

    // 5. Process and validate each return item
    const processedItems = [];
    let totalRefundAmount = 0;
    let totalProfitReduction = 0;

    for (const returnItem of items) {
      const saleItem = (sale.items && typeof sale.items.id === 'function')
        ? sale.items.id(returnItem.saleItemId)
        : sale.items?.find(i => (i._id || i.id)?.toString() === returnItem.saleItemId?.toString());
      if (!saleItem) {
        throw new AppError(
          'বিক্রিত আইটেম পাওয়া যায়নি',
          `Sale item not found: ${returnItem.saleItemId}`,
          404
        );
      }

      const alreadyReturned = alreadyReturnedMap[returnItem.saleItemId.toString()] || 0;
      const maxReturnable = saleItem.quantity - alreadyReturned;

      // A return must be expressible in the same unit the sale was, so this
      // resolves the unit from the PRODUCT and not from a client-supplied
      // field. A 0.5 kg return against a 2 kg sale is valid; a 0.5 piece return
      // is refused by `parseQuantity` because 'piece' is `decimals: 0`.
      //
      // `returnProduct` may be null for a product deleted since the sale — the
      // sale item itself is the source of truth for what may be returned, so a
      // missing product falls back to the flag-off precision rather than
      // blocking the refund.
      const returnProduct = returnProductMap.get(String(saleItem.product));
      returnItem.quantity = parseQuantity(
        returnItem.quantity,
        quantityUnit(req, returnProduct),
        { label: saleItem.productName }
      );

      if (returnItem.quantity > maxReturnable) {
        throw new AppError(
          `"${saleItem.productName}" এর সর্বোচ্চ ${maxReturnable}টি ফেরত দেওয়া যাবে`,
          `Cannot return more than ${maxReturnable} of ${saleItem.productName}`,
          400
        );
      }

      // Calculate proportional item-level and invoice-level discounts.
      const perUnitItemDiscount = saleItem.quantity > 0 ? (saleItem.discount || 0) / saleItem.quantity : 0;
      const itemReturnItemDiscount = perUnitItemDiscount * returnItem.quantity;
      const invoiceDiscountShare = getInvoiceDiscountShareForItem(sale, saleItem);
      const perUnitInvoiceDiscount = saleItem.quantity > 0 ? invoiceDiscountShare / saleItem.quantity : 0;
      const itemReturnInvoiceDiscount = perUnitInvoiceDiscount * returnItem.quantity;
      // Rounded to paisa. Every term above is a division by `saleItem.quantity`,
      // which may now be fractional — 1000/3 is 333.33333333333337, and an
      // unrounded refund total lands on the invoice and in the cash register.
      const itemReturnDiscount = quantizeMoney(itemReturnItemDiscount + itemReturnInvoiceDiscount);
      const itemReturnTotal = quantizeMoney((saleItem.unitPrice * returnItem.quantity) - itemReturnDiscount);
      const itemProfitLoss = quantizeMoney(((saleItem.unitPrice - (saleItem.buyingPrice || 0)) * returnItem.quantity) - itemReturnDiscount);

      processedItems.push({
        saleItemId: saleItem._id,
        product: saleItem.product,
        productName: saleItem.productName,
        productCode: saleItem.productCode,
        variantId: saleItem.variantId,
        variantSku: saleItem.variantSku,
        variantAttributes: saleItem.variantAttributes,
        quantity: returnItem.quantity,
        unitPrice: saleItem.unitPrice,
        buyingPrice: saleItem.buyingPrice || 0,
        discount: itemReturnDiscount,
        total: itemReturnTotal,
        profitLoss: itemProfitLoss,
        reason: returnItem.reason || reason || '',
      });

      totalRefundAmount = quantizeMoney(totalRefundAmount + itemReturnTotal);
      totalProfitReduction = quantizeMoney(totalProfitReduction + itemProfitLoss);
    }

    // 6. Generate return number
    const returnNo = await SalesReturn.generateReturnNo(shopId);

    // 7. Create SalesReturn document
    const [salesReturn] = await SalesReturn.create([{
      shop: shopId,
      branch: branchId,
      returnNo,
      sale: sale._id,
      invoiceNo: sale.invoiceNo,
      customer: sale.customer,
      customerName: sale.customerName,
      customerPhone: sale.customerPhone,
      items: processedItems,
      totalAmount: totalRefundAmount,
      profitReduction: totalProfitReduction,
      refundMethod,
      paymentMethod: refundMethod === 'cash' ? (paymentMethod || 'cash') : undefined,
      reason,
      notes,
      createdBy: userId,
    }], sessionOpt);

    // 8. Restore stock for each returned item
    for (const item of processedItems) {
      const product = await Product.findById(item.product).session(session || null);
      if (product) {
        let previousStock, newStock;
        {
          const stkUnit = storageUnit(product);
          if (item.variantId && product.hasVariants) {
            const variant = (product.variants && typeof product.variants.id === 'function')
              ? product.variants.id(item.variantId)
              : product.variants?.find(v => (v._id || v.id)?.toString() === item.variantId?.toString());
            if (variant) {
              previousStock = variant.stock;
              variant.stock = quantize(variant.stock + item.quantity, stkUnit);
              newStock = variant.stock;
            }
            // Rolled-up total across variants — also quantized, or summing a
            // dozen 3-decimal variant stocks reintroduces the drift the
            // individual writes just eliminated.
            product.stock = quantize(
              product.variants.reduce((sum, v) => quantize(sum + v.stock, stkUnit), 0),
              stkUnit
            );
          } else {
            previousStock = product.stock;
            product.stock = quantize(product.stock + item.quantity, stkUnit);
            newStock = product.stock;
          }
          await product.save(sessionOpt);
        }

        // Create stock transaction
        await StockTransaction.create([{
          shop: shopId,
          branch: branchId,
          product: item.product,
          productName: item.productName,
          productCode: item.productCode,
          variantId: item.variantId || null,
          variantSku: item.variantSku,
          variantAttributes: item.variantAttributes,
          type: 'return',
          quantity: item.quantity,
          previousStock: previousStock || 0,
          newStock: newStock || 0,
          reference: {
            type: 'return',
            id: salesReturn._id,
            invoiceNo: returnNo,
          },
          notes: `মাল ফেরত: ${returnNo} (বিক্রয়: ${sale.invoiceNo})`,
          createdBy: userId,
        }], sessionOpt);
      }
    }

    // 9. Update Sale: returnedAmount, profit, due and status (using updateOne to bypass pre-save hook recalculations)
    const newReturnedAmount = (sale.returnedAmount || 0) + totalRefundAmount;
    const newProfit = (sale.profit || 0) - totalProfitReduction;
    
    let newDue = sale.due;
    if (refundMethod === 'adjustment') {
      newDue = Math.max(0, sale.due - totalRefundAmount);
    }
    
    const isFullyReturned = newReturnedAmount >= (sale.total || 0) - 0.01;
    let newStatus = sale.status;
    if (isFullyReturned) {
      newStatus = 'cancelled';
      newDue = 0;
    } else if (newDue === 0 && sale.status !== 'cancelled') {
      newStatus = 'completed';
    } else if (newDue < sale.due && sale.status !== 'cancelled') {
      newStatus = 'partial';
    }

    const saleUpdate = {
      returnedAmount: newReturnedAmount,
      profit: isFullyReturned ? 0 : newProfit,
      due: newDue,
      status: newStatus,
    };

    if (isFullyReturned) {
      saleUpdate.cancelledAt = new Date();
      saleUpdate.cancelledBy = userId;
      saleUpdate.cancelReason = `Fully returned via ${returnNo}`;
      saleUpdate.notes = `${sale.notes || ''}\nFully returned: ${returnNo}`;
    }

    await Sale.updateOne(
      { _id: sale._id },
      { $set: saleUpdate },
      sessionOpt
    );

    // 10. Handle refund by method
    if (refundMethod === 'cash') {
      // Create refund payment
      await Payment.create([{
        shop: shopId,
        branch: branchId,
        sale: sale._id,
        customer: sale.customer,
        amount: totalRefundAmount,
        method: paymentMethod || 'cash',
        type: 'refund',
        reference: returnNo,
        notes: `মাল ফেরত: ${returnNo}`,
        receivedBy: userId,
      }], sessionOpt);

      // Adjust customer totals for cash refund
      if (sale.customer) {
        await Customer.findByIdAndUpdate(sale.customer, {
          $inc: {
            totalPurchases: -totalRefundAmount,
            totalPaid: -totalRefundAmount,
          },
        }, sessionOpt);
        // Recalculate due
        const customer = await Customer.findById(sale.customer).session(session || null);
        if (customer) {
          customer.totalDue = Math.max(0, customer.totalPurchases - customer.totalPaid);
          await customer.save(sessionOpt);
        }

        // Same two steps, per branch. `recomputeDue` mirrors the Math.max clamp
        // above rather than $inc-ing totalDue: an over-refunded customer clamps
        // on one side, and clamping on only one of them is exactly how the two
        // books silently drift apart. Returns are only allowed at the branch
        // that made the sale (decision #10), so sale.branch is this branch.
        await CustomerBalance.applyDelta({
          shop: shopId,
          customer: sale.customer,
          branch: sale.branch,
          purchases: -totalRefundAmount,
          paid: -totalRefundAmount,
        }, session);
        await CustomerBalance.recomputeDue({
          shop: shopId,
          customer: sale.customer,
          branch: sale.branch,
        }, session);
      }
    } else if (refundMethod === 'adjustment' && sale.customer) {
      // Reduce customer's totalPurchases → recalc due
      const customer = await Customer.findById(sale.customer).session(session || null);
      if (customer) {
        customer.totalPurchases -= totalRefundAmount;
        customer.totalDue = Math.max(0, customer.totalPurchases - customer.totalPaid);
        await customer.save(sessionOpt);
      }

      await CustomerBalance.applyDelta({
        shop: shopId,
        customer: sale.customer,
        branch: sale.branch,
        purchases: -totalRefundAmount,
      }, session);
      await CustomerBalance.recomputeDue({
        shop: shopId,
        customer: sale.customer,
        branch: sale.branch,
      }, session);
    }
    // store_credit: no financial changes, just recorded

    // 11. Audit log
    await AuditLog.create({
      shop: shopId,
      branch: branchId,
      user: userId,
      action: AUDIT_ACTIONS.SALES_RETURN_CREATE.en,
      actionBn: AUDIT_ACTIONS.SALES_RETURN_CREATE.bn,
      description: `Sales return ${returnNo} for invoice ${sale.invoiceNo}. Amount: ৳${totalRefundAmount}. Method: ${refundMethod}`,
      descriptionBn: `মাল ফেরত ${returnNo}, ইনভয়েস ${sale.invoiceNo}। পরিমাণ: ৳${totalRefundAmount}`,
      entity: {
        type: 'sales_return',
        id: salesReturn._id,
        name: returnNo,
      },
      changes: {
        after: {
          returnNo,
          saleInvoice: sale.invoiceNo,
          totalAmount: totalRefundAmount,
          refundMethod,
          items: processedItems.map(i => `${i.productName} x${i.quantity}`).join(', '),
        },
      },
    });

    saleService.invalidateCache(shopId).catch(() => {});

    return salesReturn;
    });
  }

  /**
   * Get all returns (paginated, filtered)
   */
  async getReturns(shopId, options = {}) {
    const {
      page = 1,
      limit = 20,
      search,
      saleId,
      customerId,
      startDate,
      endDate,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;

    const query = { shop: shopId };

    // Branch scoping
    if (options.branchId) {
      query.branch = options.branchId;
    }

    if (search) {
      query.$or = [
        { returnNo: { $regex: search, $options: 'i' } },
        { invoiceNo: { $regex: search, $options: 'i' } },
        { customerName: { $regex: search, $options: 'i' } },
        { customerPhone: { $regex: search, $options: 'i' } },
      ];
    }

    if (saleId) query.sale = saleId;
    if (customerId) query.customer = customerId;

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const skip = (page - 1) * limit;
    const sortField = ['createdAt', 'total', 'returnNo'].includes(sortBy) ? sortBy : 'createdAt';
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

    const [returns, total] = await Promise.all([
      SalesReturn.find(query)
        .populate('customer', 'name phone')
        .populate('createdBy', 'name')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      SalesReturn.countDocuments(query),
    ]);

    return {
      data: returns,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get single return by ID
   */
  async getReturnById(shopId, returnId, req = null) {
    const salesReturn = await SalesReturn.findOne(branchFilter(req, { _id: returnId, shop: shopId }))
      .populate('sale', 'invoiceNo total paid due status')
      .populate('customer', 'name phone address')
      .populate('createdBy', 'name phone');

    if (!salesReturn) {
      throw new AppError('Sales return not found', 'ফেরত পাওয়া যায়নি', 404);
    }

    return salesReturn;
  }

  /**
   * Get all returns for a specific sale
   */
  async getReturnsBySale(shopId, saleId, req = null) {
    return SalesReturn.find(branchFilter(req, { shop: shopId, sale: saleId }))
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .lean();
  }

  /**
   * Get returnable items for a sale (powers the return modal)
   */
  async getReturnableItems(shopId, saleId, req = null) {
    const sale = await Sale.findOne(branchFilter(req, { _id: saleId, shop: shopId }));
    if (!sale) {
      throw new AppError('Sale not found', 'বিক্রয় পাওয়া যায়নি', 404);
    }

    if (sale.status === 'cancelled') {
      throw new AppError(
        'Cannot return from cancelled sale',
        'বাতিল বিক্রয় থেকে মাল ফেরত নেওয়া যাবে না',
        400
      );
    }

    // Get existing returns
    const existingReturns = await SalesReturn.find({ shop: shopId, sale: saleId });
    const returnedMap = {};
    for (const ret of existingReturns) {
      for (const ri of ret.items) {
        const key = ri.saleItemId.toString();
        returnedMap[key] = (returnedMap[key] || 0) + ri.quantity;
      }
    }

    // Build returnable items
    const returnableItems = sale.items
      .map(item => {
        const returned = returnedMap[item._id.toString()] || 0;
        const maxReturnable = item.quantity - returned;
        const invoiceDiscount = getInvoiceDiscountShareForItem(sale, item);
        const totalDiscount = (item.discount || 0) + invoiceDiscount;
        return {
          saleItemId: item._id,
          product: item.product,
          productName: item.productName,
          productCode: item.productCode,
          variantId: item.variantId,
          variantSku: item.variantSku,
          variantAttributes: item.variantAttributes,
          originalQuantity: item.quantity,
          alreadyReturned: returned,
          maxReturnable,
          unitPrice: item.unitPrice,
          buyingPrice: item.buyingPrice,
          discount: totalDiscount,
          itemDiscount: item.discount || 0,
          invoiceDiscount,
        };
      })
      .filter(item => item.maxReturnable > 0);

    return {
      sale: {
        _id: sale._id,
        invoiceNo: sale.invoiceNo,
        customerName: sale.customerName,
        customer: sale.customer,
        total: sale.total,
        due: sale.due,
        status: sale.status,
      },
      returnableItems,
    };
  }

  /**
   * Get returns summary for stats
   */
  async getReturnsSummary(shopId, options = {}) {
    const { startDate, endDate } = options;

    let start, end;
    if (startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
    } else {
      const now = new Date();
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    return SalesReturn.getReturnsSummary(shopId, start, end);
  }
}

module.exports = new SalesReturnService();
