const Sale = require('../models/Sale.model');
const Product = require('../models/Product.model');
const Customer = require('../models/Customer.model');
const Payment = require('../models/Payment.model');
const StockTransaction = require('../models/StockTransaction.model');
const Shop = require('../models/Shop.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');

class SaleService {
  // Generate invoice number
  async generateInvoiceNumber(shopId) {
    const today = new Date();
    const datePrefix = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

    // Get count of sales today
    const startOfDay = new Date(today.setHours(0, 0, 0, 0));
    const endOfDay = new Date(today.setHours(23, 59, 59, 999));

    const count = await Sale.countDocuments({
      shop: shopId,
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    });

    return `INV-${datePrefix}-${String(count + 1).padStart(4, '0')}`;
  }

  // Build query from filters (shared by getSales and getSalesSummary)
  _buildQuery(shopId, options = {}) {
    const { search, status, customerId, startDate, endDate, paymentMethod } = options;

    const query = { shop: shopId };

    if (search) {
      query.$or = [
        { invoiceNo: { $regex: search, $options: 'i' } },
        { customerName: { $regex: search, $options: 'i' } },
        { customerPhone: { $regex: search, $options: 'i' } },
      ];
    }

    if (status) {
      query.status = status;
    }

    if (customerId) {
      query.customer = customerId;
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
    const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

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
          totalSales: { $sum: '$total' },
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
  async getSaleById(shopId, saleId) {
    const sale = await Sale.findOne({ _id: saleId, shop: shopId })
      .populate('customer', 'name phone address')
      .populate('createdBy', 'name phone')
      .populate('items.product', 'name code');

    if (!sale) {
      throw new AppError('Sale not found', 'বিক্রয় পাওয়া যায়নি', 404);
    }

    return sale;
  }

  // Create new sale
  async createSale(shopId, userId, saleData) {
    const {
      items,
      customerId: rawCustomerId,
      customer: rawCustomer,
      customerName,
      customerPhone,
      discount = 0,
      tax = 0,
      paid = 0,
      paymentMethod = 'cash',
      notes,
    } = saleData;
    const customerId = rawCustomerId || rawCustomer;

    // Validate items and calculate totals
    let subtotal = 0;
    const processedItems = [];

    for (const item of items) {
      const product = await Product.findOne({ _id: item.productId, shop: shopId });
      if (!product) {
        throw new AppError(`Product not found: ${item.productId}`, `পণ্য পাওয়া যায়নি: ${item.productName || item.productId}`, 404);
      }

      let unitPrice, variantInfo = {};

      if (item.variantId) {
        const variant = product.variants.id(item.variantId);
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
        variantInfo = {
          variantId: variant._id,
          variantSku: variant.sku,
          variantAttributes: variant.attributes,
        };

        // Reduce stock
        variant.stock -= item.quantity;
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
        product.stock -= item.quantity;
      }

      await product.save();

      const itemDiscount = item.discount || 0;
      const itemTotal = (unitPrice * item.quantity) - itemDiscount;

      processedItems.push({
        product: product._id,
        productName: product.name,
        ...variantInfo,
        quantity: item.quantity,
        unitPrice,
        discount: itemDiscount,
        total: itemTotal,
      });

      subtotal += itemTotal;

      // Get buying price for cost tracking
      const buyingPrice = item.variantId
        ? (product.variants.id(item.variantId)?.buyingPrice || product.buyingPrice)
        : product.buyingPrice;

      // Create stock transaction with price info
      await StockTransaction.create({
        shop: shopId,
        product: product._id,
        productName: product.name,
        productCode: product.code,
        variantId: item.variantId || null,
        variantSku: variantInfo.variantSku || null,
        variantAttributes: variantInfo.variantAttributes || null,
        type: 'sale',
        quantity: -item.quantity,
        previousStock: (item.variantId ? product.variants.id(item.variantId)?.stock : product.stock) + item.quantity,
        newStock: item.variantId ? product.variants.id(item.variantId)?.stock : product.stock,
        unitCost: buyingPrice || 0,
        totalCost: (buyingPrice || 0) * item.quantity,
        unitPrice: unitPrice,
        totalPrice: itemTotal,
        notes: `Sale item`,
        createdBy: userId,
      });
    }

    const total = subtotal - discount + tax;
    const due = Math.max(0, total - paid);
    const status = due <= 0 ? 'completed' : (paid > 0 ? 'partial' : 'unpaid');

    // Handle customer
    let customer = null;
    let finalCustomerName = customerName;
    let finalCustomerPhone = customerPhone;

    if (customerId) {
      customer = await Customer.findOne({ _id: customerId, shop: shopId });
      if (customer) {
        finalCustomerName = customer.name;
        finalCustomerPhone = customer.phone;
      }
    } else if (customerPhone) {
      // Try to find existing customer or create new one
      customer = await Customer.findOne({ shop: shopId, phone: customerPhone });
      if (!customer && customerName) {
        customer = await Customer.create({
          shop: shopId,
          phone: customerPhone,
          name: customerName,
          createdBy: userId,
        });
      }
    }

    // Create sale with retry for invoice number collision
    let sale;
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const invoiceNo = await this.generateInvoiceNumber(shopId);
        sale = await Sale.create({
          shop: shopId,
          invoiceNo,
          customer: customer?._id,
          customerName: finalCustomerName,
          customerPhone: finalCustomerPhone,
          items: processedItems,
          subtotal,
          discount,
          tax,
          total,
          paid,
          due,
          paymentMethod,
          status,
          notes,
          createdBy: userId,
        });
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
      customer.totalPurchases += total;
      customer.totalPaid += paid;
      customer.totalDue += due;
      customer.purchaseCount += 1;
      customer.lastPurchase = new Date();
      await customer.save();
    }

    // Create payment record if paid amount > 0
    if (paid > 0) {
      await Payment.create({
        shop: shopId,
        sale: sale._id,
        customer: customer?._id,
        amount: paid,
        method: paymentMethod,
        type: 'sale_payment',
        receivedBy: userId,
      });
    }

    // Update shop statistics
    await Shop.findByIdAndUpdate(shopId, {
      $inc: { 'stats.totalSales': 1 },
    });

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

    return sale;
  }

  // Record payment for existing sale
  async recordPayment(shopId, userId, saleId, paymentData) {
    const { amount, method, transactionId, notes } = paymentData;

    const sale = await Sale.findOne({ _id: saleId, shop: shopId });
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

    return { sale, payment };
  }

  // Cancel sale
  async cancelSale(shopId, userId, saleId, reason) {
    const sale = await Sale.findOne({ _id: saleId, shop: shopId });
    if (!sale) {
      throw new AppError('Sale not found', 'বিক্রয় পাওয়া যায়নি', 404);
    }

    if (sale.status === 'cancelled') {
      throw new AppError('Sale is already cancelled', 'বিক্রয় ইতিমধ্যে বাতিল করা হয়েছে', 400);
    }

    // Restore stock
    for (const item of sale.items) {
      const product = await Product.findById(item.product);
      if (product) {
        if (item.variantId) {
          const variant = product.variants.id(item.variantId);
          if (variant) {
            variant.stock += item.quantity;
          }
        } else {
          product.stock += item.quantity;
        }
        await product.save();

        // Create stock transaction
        await StockTransaction.create({
          shop: shopId,
          product: product._id,
          variantId: item.variantId || null,
          type: 'return',
          quantity: item.quantity,
          reference: {
            type: 'sale',
            id: sale._id,
          },
          notes: `Sale cancelled: ${sale.invoiceNo}`,
          createdBy: userId,
        });
      }
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
    }

    // Update sale status
    sale.status = 'cancelled';
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

    return sale;
  }

  // Get today's sales summary
  async getTodaySummary(shopId) {
    const today = new Date();
    const startOfDay = new Date(today.setHours(0, 0, 0, 0));
    const endOfDay = new Date(today.setHours(23, 59, 59, 999));

    const result = await Sale.aggregate([
      {
        $match: {
          shop: shopId,
          status: { $ne: 'cancelled' },
          createdAt: { $gte: startOfDay, $lte: endOfDay },
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: '$total' },
          totalPaid: { $sum: '$paid' },
          totalDue: { $sum: '$due' },
          count: { $sum: 1 },
        },
      },
    ]);

    return result[0] || { totalSales: 0, totalPaid: 0, totalDue: 0, count: 0 };
  }

  // Get recent sales
  async getRecentSales(shopId, limit = 10) {
    const sales = await Sale.find({ shop: shopId, status: { $ne: 'cancelled' } })
      .populate('customer', 'name phone')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return sales;
  }

  // Get payments for a sale
  async getSalePayments(shopId, saleId) {
    const sale = await Sale.findOne({ _id: saleId, shop: shopId });
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
