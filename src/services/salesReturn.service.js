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
      // `store_credit` is the shop promising to pay later, so it is the only
      // method that leaves the return open. Cash moves now; adjustment settles
      // against the customer's due now. See the field's note on the model.
      refundStatus: refundMethod === 'store_credit' ? 'pending' : 'settled',
      reason,
      notes,
      createdBy: userId,
    }], sessionOpt);

    // 8. Restore stock for each returned item.
    //
    // Batched: one read for every returned product, one bulkWrite, one ledger
    // insert — replacing a findById + save + create per line
    // (PERFORMANCE_AUDIT.md H-3).
    //
    // The arithmetic is deliberately untouched, including the variant ROLLUP:
    // a variant return rewrites `variants[n].stock` AND recomputes
    // `product.stock` as the quantized sum across all variants. Both have to
    // ride in the same update, which is why the variant op below sets two
    // paths. Dropping the rollup would leave the product-level total stale on
    // every variant return.
    //
    // Two lines returning different variants of the SAME product each push
    // their own op; each recomputes the rollup from the in-memory document,
    // which has already absorbed the earlier line. bulkWrite is ordered, so the
    // last op for that product carries the correct final total.
    // Distinct from `returnProductMap` above, which is a `.lean()` projection of
    // just `_id` and `unit` used for precision resolution — it carries no
    // `stock` or `variants` and so cannot back a stock write. These are the
    // full documents.
    const stockProductIds = [...new Set(processedItems.map(i => String(i.product)))];
    const stockProducts = await Product.find({
      _id: { $in: stockProductIds }, shop: shopId,
    }).session(session || null);
    const stockProductMap = new Map(stockProducts.map(p => [String(p._id), p]));

    const returnStockOps = [];
    const returnTxns = [];

    for (const item of processedItems) {
      const product = stockProductMap.get(String(item.product));
      if (!product) continue;

      let previousStock, newStock;
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

        if (variant) {
          returnStockOps.push({
            updateOne: {
              filter: { _id: product._id },
              update: {
                $set: {
                  'variants.$[v].stock': variant.stock,
                  stock: product.stock, // the rollup, not the line quantity
                },
              },
              arrayFilters: [{ 'v._id': item.variantId }],
            },
          });
        }
      } else {
        previousStock = product.stock;
        product.stock = quantize(product.stock + item.quantity, stkUnit);
        newStock = product.stock;
        returnStockOps.push({
          updateOne: {
            filter: { _id: product._id },
            update: { $set: { stock: product.stock } },
          },
        });
      }

      // Create stock transaction
      returnTxns.push({
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
      });
    }

    if (returnStockOps.length > 0) {
      await Product.bulkWrite(returnStockOps, sessionOpt);
    }
    if (returnTxns.length > 0) {
      await StockTransaction.insertMany(returnTxns, sessionOpt);
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

    // "Which refunds do I still owe?" — the filter the pending status exists to
    // serve. Anything other than 'pending' is ignored rather than passed
    // through, so a stray query string cannot slice the list in a way the UI
    // has no way to display or clear.
    if (options.refundStatus === 'pending') {
      query.refundStatus = 'pending';
    }

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
   * Pay out a return that was recorded as "পরে দিবেন".
   *
   * ───────────────────────────────────────────────────────────────────────────
   * THIS IS THE SECOND HALF OF A CASH REFUND, RUN LATE
   * ───────────────────────────────────────────────────────────────────────────
   *
   * A `store_credit` return moved the goods and nothing else. Settling it does
   * exactly what `createReturn` does for `refundMethod: 'cash'` — writes the
   * refund `Payment`, and walks the customer's totals and per-branch balance
   * back down — only now, when the money actually leaves the drawer.
   *
   * The stock, the sale's `returnedAmount`, the profit reduction and the
   * customer's `totalPurchases` were all handled when the return was created.
   * Touching them again here would double-count them. The ONLY thing that
   * happens now is the money.
   *
   * Idempotent by guard: a return already `settled` is refused rather than
   * paid twice. That guard is the whole reason this is a status flip and not a
   * free-standing "record a refund" action.
   *
   * @param {string} shopId
   * @param {string} userId
   * @param {string} returnId
   * @param {Object} data           `{ settlementMethod }`
   * @param {Object} req
   */
  async settleRefund(shopId, userId, returnId, data = {}, req = null) {
    return await runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};

      const salesReturn = await SalesReturn.findOne(
        branchFilter(req, { _id: returnId, shop: shopId })
      ).session(session || null);

      if (!salesReturn) {
        throw new AppError('Sales return not found', 'ফেরত পাওয়া যায়নি', 404);
      }
      if (salesReturn.refundStatus !== 'pending') {
        throw new AppError(
          'This refund has already been settled',
          'এই ফেরতের টাকা ইতিমধ্যে দেওয়া হয়েছে',
          400
        );
      }

      const method = data.settlementMethod || 'cash';
      const amount = Number(salesReturn.totalAmount) || 0;

      await Payment.create([{
        shop: shopId,
        branch: salesReturn.branch,
        sale: salesReturn.sale,
        customer: salesReturn.customer,
        amount,
        method,
        type: 'refund',
        reference: salesReturn.returnNo,
        notes: `বকেয়া ফেরত পরিশোধ: ${salesReturn.returnNo}`,
        receivedBy: userId,
      }], sessionOpt);

      // Mirrors the cash branch of `createReturn` exactly. `totalPurchases` was
      // NOT reduced when the store-credit return was created — only a cash or
      // adjustment refund did that — so both sides move here, and the two books
      // (Customer and CustomerBalance) are clamped the same way. Clamping only
      // one of them is precisely how they drift apart.
      if (salesReturn.customer) {
        await Customer.findByIdAndUpdate(salesReturn.customer, {
          $inc: { totalPurchases: -amount, totalPaid: -amount },
        }, sessionOpt);

        const customer = await Customer.findById(salesReturn.customer).session(session || null);
        if (customer) {
          customer.totalDue = Math.max(0, customer.totalPurchases - customer.totalPaid);
          await customer.save(sessionOpt);
        }

        await CustomerBalance.applyDelta({
          shop: shopId,
          customer: salesReturn.customer,
          branch: salesReturn.branch,
          purchases: -amount,
          paid: -amount,
        }, session);
        await CustomerBalance.recomputeDue({
          shop: shopId,
          customer: salesReturn.customer,
          branch: salesReturn.branch,
        }, session);
      }

      salesReturn.refundStatus = 'settled';
      salesReturn.settledAt = new Date();
      salesReturn.settledBy = userId;
      salesReturn.settlementMethod = method;
      await salesReturn.save(sessionOpt);

      await AuditLog.create([{
        shop: shopId,
        branch: salesReturn.branch,
        user: userId,
        action: AUDIT_ACTIONS.SALE_RETURN || 'sale_return',
        actionBn: 'বকেয়া ফেরত পরিশোধ',
        description: `Settled pending refund ${salesReturn.returnNo}. Amount: ${amount}, method: ${method}`,
        descriptionBn: `${salesReturn.returnNo} এর বকেয়া ৳${amount} ফেরত দেওয়া হয়েছে`,
        entity: {
          type: 'sales_return',
          id: salesReturn._id,
          name: salesReturn.returnNo,
        },
      }], sessionOpt);

      return salesReturn;
    });
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
