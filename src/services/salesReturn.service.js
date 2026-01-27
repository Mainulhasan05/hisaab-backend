const SalesReturn = require('../models/SalesReturn.model');
const Sale = require('../models/Sale.model');
const Product = require('../models/Product.model');
const Customer = require('../models/Customer.model');
const Payment = require('../models/Payment.model');
const StockTransaction = require('../models/StockTransaction.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { AUDIT_ACTIONS } = require('../config/constants');

class SalesReturnService {
  /**
   * Create a sales return
   */
  async createReturn(shopId, userId, returnData) {
    const { saleId, items, refundMethod, paymentMethod, reason, notes } = returnData;

    // 1. Fetch the sale
    const sale = await Sale.findOne({ _id: saleId, shop: shopId });
    if (!sale) {
      throw new AppError('Sale not found', 'বিক্রয় পাওয়া যায়নি', 404);
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

    // 4. Build already-returned map from existing returns
    const existingReturns = await SalesReturn.find({ shop: shopId, sale: saleId });
    const alreadyReturnedMap = {};
    for (const ret of existingReturns) {
      for (const ri of ret.items) {
        const key = ri.saleItemId.toString();
        alreadyReturnedMap[key] = (alreadyReturnedMap[key] || 0) + ri.quantity;
      }
    }

    // 5. Process and validate each return item
    const processedItems = [];
    let totalRefundAmount = 0;
    let totalProfitReduction = 0;

    for (const returnItem of items) {
      const saleItem = sale.items.id(returnItem.saleItemId);
      if (!saleItem) {
        throw new AppError(
          'বিক্রিত আইটেম পাওয়া যায়নি',
          `Sale item not found: ${returnItem.saleItemId}`,
          404
        );
      }

      const alreadyReturned = alreadyReturnedMap[returnItem.saleItemId.toString()] || 0;
      const maxReturnable = saleItem.quantity - alreadyReturned;

      if (returnItem.quantity <= 0) {
        throw new AppError(
          'ফেরতের পরিমাণ কমপক্ষে ১ হতে হবে',
          'Return quantity must be at least 1',
          400
        );
      }

      if (returnItem.quantity > maxReturnable) {
        throw new AppError(
          `"${saleItem.productName}" এর সর্বোচ্চ ${maxReturnable}টি ফেরত দেওয়া যাবে`,
          `Cannot return more than ${maxReturnable} of ${saleItem.productName}`,
          400
        );
      }

      // Calculate proportional discount
      const perUnitDiscount = saleItem.quantity > 0 ? saleItem.discount / saleItem.quantity : 0;
      const itemReturnDiscount = perUnitDiscount * returnItem.quantity;
      const itemReturnTotal = (saleItem.unitPrice * returnItem.quantity) - itemReturnDiscount;
      const itemProfitLoss = ((saleItem.unitPrice - (saleItem.buyingPrice || 0)) * returnItem.quantity) - itemReturnDiscount;

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

      totalRefundAmount += itemReturnTotal;
      totalProfitReduction += itemProfitLoss;
    }

    // 6. Generate return number
    const returnNo = await SalesReturn.generateReturnNo(shopId);

    // 7. Create SalesReturn document
    const salesReturn = await SalesReturn.create({
      shop: shopId,
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
    });

    // 8. Restore stock for each returned item
    for (const item of processedItems) {
      const product = await Product.findById(item.product);
      if (product) {
        let previousStock, newStock;

        if (item.variantId && product.hasVariants) {
          const variant = product.variants.id(item.variantId);
          if (variant) {
            previousStock = variant.stock;
            variant.stock += item.quantity;
            newStock = variant.stock;
          }
        } else {
          previousStock = product.stock;
          product.stock += item.quantity;
          newStock = product.stock;
        }
        await product.save();

        // Create stock transaction
        await StockTransaction.create({
          shop: shopId,
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
        });
      }
    }

    // 9. Update Sale: returnedAmount and profit
    sale.returnedAmount = (sale.returnedAmount || 0) + totalRefundAmount;
    sale.profit = (sale.profit || 0) - totalProfitReduction;
    await sale.save();

    // 10. Handle refund by method
    if (refundMethod === 'cash') {
      // Create refund payment
      await Payment.create({
        shop: shopId,
        sale: sale._id,
        customer: sale.customer,
        amount: totalRefundAmount,
        method: paymentMethod || 'cash',
        type: 'refund',
        reference: returnNo,
        notes: `মাল ফেরত: ${returnNo}`,
        receivedBy: userId,
      });

      // Adjust customer totals for cash refund
      if (sale.customer) {
        await Customer.findByIdAndUpdate(sale.customer, {
          $inc: {
            totalPurchases: -totalRefundAmount,
            totalPaid: -totalRefundAmount,
          },
        });
        // Recalculate due
        const customer = await Customer.findById(sale.customer);
        if (customer) {
          customer.totalDue = Math.max(0, customer.totalPurchases - customer.totalPaid);
          await customer.save();
        }
      }
    } else if (refundMethod === 'adjustment' && sale.customer) {
      // Reduce customer's totalPurchases → recalc due
      const customer = await Customer.findById(sale.customer);
      if (customer) {
        customer.totalPurchases -= totalRefundAmount;
        customer.totalDue = Math.max(0, customer.totalPurchases - customer.totalPaid);
        await customer.save();
      }
    }
    // store_credit: no financial changes, just recorded

    // 11. Audit log
    await AuditLog.create({
      shop: shopId,
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

    return salesReturn;
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
    const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

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
  async getReturnById(shopId, returnId) {
    const salesReturn = await SalesReturn.findOne({ _id: returnId, shop: shopId })
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
  async getReturnsBySale(shopId, saleId) {
    return SalesReturn.find({ shop: shopId, sale: saleId })
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .lean();
  }

  /**
   * Get returnable items for a sale (powers the return modal)
   */
  async getReturnableItems(shopId, saleId) {
    const sale = await Sale.findOne({ _id: saleId, shop: shopId });
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
          discount: item.discount,
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
