const Customer = require('../models/Customer.model');
const Sale = require('../models/Sale.model');
const Payment = require('../models/Payment.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { runInTransaction } = require('../utils/transaction.util');

class CustomerService {
  // Get all customers with filtering, searching, pagination
  async getCustomers(shopId, options = {}) {
    const {
      page = 1,
      limit = 20,
      search,
      hasDue,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;

    const query = { shop: shopId, isActive: true };

    // Search by name or phone
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }

    // Filter by due status
    if (hasDue === 'true' || hasDue === true) {
      query.totalDue = { $gt: 0 };
    }

    const skip = (page - 1) * limit;
    const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const [customers, total] = await Promise.all([
      Customer.find(query)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Customer.countDocuments(query),
    ]);

    return {
      data: customers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Get single customer by ID
  async getCustomerById(shopId, customerId) {
    const customer = await Customer.findOne({ _id: customerId, shop: shopId })
      .populate('createdBy', 'name phone');

    if (!customer) {
      throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
    }

    return customer;
  }

  // Get customer by phone
  async getCustomerByPhone(shopId, phone) {
    const customer = await Customer.findOne({ shop: shopId, phone, isActive: true });
    return customer;
  }

  // Create new customer
  async createCustomer(shopId, userId, customerData) {
    const { phone, name, address, notes } = customerData;

    // Check if customer with same phone exists
    const existingCustomer = await Customer.findOne({ shop: shopId, phone });
    if (existingCustomer) {
      throw new AppError('এই ফোন নম্বর দিয়ে ইতিমধ্যে কাস্টমার আছে', 'Customer with this phone already exists', 400);
    }

    const customer = await Customer.create({
      shop: shopId,
      phone,
      name,
      address,
      notes,
      createdBy: userId,
    });

    // Create audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'customer_create',
      actionBn: 'নতুন কাস্টমার যোগ',
      description: `Created customer: ${name}`,
      descriptionBn: `নতুন কাস্টমার যোগ করা হয়েছে: ${name}`,
      entity: {
        type: 'customer',
        id: customer._id,
        name: name,
      },
      changes: {
        after: customer.toObject(),
      },
    });

    return customer;
  }

  // Update customer
  async updateCustomer(shopId, userId, customerId, updateData) {
    const customer = await Customer.findOne({ _id: customerId, shop: shopId });
    if (!customer) {
      throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
    }

    const beforeData = customer.toObject();

    // Check if phone is being changed and if it conflicts
    if (updateData.phone && updateData.phone !== customer.phone) {
      const existingCustomer = await Customer.findOne({ shop: shopId, phone: updateData.phone, _id: { $ne: customerId } });
      if (existingCustomer) {
        throw new AppError('এই ফোন নম্বর দিয়ে ইতিমধ্যে কাস্টমার আছে', 'Customer with this phone already exists', 400);
      }
    }

    // Update customer
    Object.assign(customer, updateData);
    await customer.save();

    // Create audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'customer_update',
      actionBn: 'কাস্টমার আপডেট',
      description: `Updated customer: ${customer.name}`,
      descriptionBn: `কাস্টমার আপডেট করা হয়েছে: ${customer.name}`,
      entity: {
        type: 'customer',
        id: customer._id,
        name: customer.name,
      },
      changes: {
        before: beforeData,
        after: customer.toObject(),
      },
    });

    return customer;
  }

  // Delete customer (soft delete)
  async deleteCustomer(shopId, userId, customerId) {
    const customer = await Customer.findOne({ _id: customerId, shop: shopId });
    if (!customer) {
      throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
    }

    // Check if customer has due balance
    if (customer.totalDue > 0) {
      throw new AppError('বাকি আছে এমন কাস্টমার ডিলিট করা যাবে না', 'Cannot delete customer with due balance', 400);
    }

    customer.isActive = false;
    await customer.save();

    // Create audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'customer_delete',
      actionBn: 'কাস্টমার মুছে ফেলা',
      description: `Deleted customer: ${customer.name}`,
      descriptionBn: `কাস্টমার মুছে ফেলা হয়েছে: ${customer.name}`,
      entity: {
        type: 'customer',
        id: customer._id,
        name: customer.name,
      },
    });

    return { success: true };
  }

  // Record due payment
  async collectDuePayment(shopId, userId, customerId, paymentData) {
    return await runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};
      const { amount, method, transactionId, notes } = paymentData;

    const customer = await Customer.findOne({ _id: customerId, shop: shopId }).session(session || null);
    if (!customer) {
      throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
    }

    if (amount > customer.totalDue) {
      throw new AppError('পেমেন্টের পরিমাণ বাকির চেয়ে বেশি', 'Payment amount exceeds due balance', 400);
    }

    // Create payment record
    const [payment] = await Payment.create([{
      shop: shopId,
      customer: customerId,
      amount,
      method: method || 'cash',
      transactionId,
      type: 'due_collection',
      notes,
      receivedBy: userId,
    }], sessionOpt);

    // Update customer balance
    customer.totalPaid += amount;
    customer.totalDue -= amount;
    await customer.save(sessionOpt);

    // Create audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'due_collection',
      actionBn: 'বাকি আদায়',
      description: `Collected ৳${amount} from ${customer.name}`,
      descriptionBn: `${customer.name} থেকে ৳${amount} বাকি আদায় করা হয়েছে`,
      entity: {
        type: 'customer',
        id: customer._id,
        name: customer.name,
      },
      changes: {
        before: { totalDue: customer.totalDue + amount },
        after: { totalDue: customer.totalDue },
      },
    });

    return { customer, payment };
    });
  }

  // Get customer purchase history
  async getCustomerHistory(shopId, customerId, options = {}) {
    const { page = 1, limit = 20 } = options;

    const customer = await Customer.findOne({ _id: customerId, shop: shopId });
    if (!customer) {
      throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
    }

    const skip = (page - 1) * limit;

    const [sales, payments, totalSales, totalPayments] = await Promise.all([
      Sale.find({ shop: shopId, customer: customerId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Payment.find({ shop: shopId, customer: customerId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Sale.countDocuments({ shop: shopId, customer: customerId }),
      Payment.countDocuments({ shop: shopId, customer: customerId }),
    ]);

    return {
      customer,
      sales: {
        data: sales,
        total: totalSales,
      },
      payments: {
        data: payments,
        total: totalPayments,
      },
    };
  }

  // Get customers with due
  async getCustomersWithDue(shopId, options = {}) {
    const { limit = 50, minDue = 0 } = options;

    const customers = await Customer.find({
      shop: shopId,
      isActive: true,
      totalDue: { $gt: minDue },
    })
      .sort({ totalDue: -1 })
      .limit(limit)
      .lean();

    const totalDue = customers.reduce((sum, c) => sum + c.totalDue, 0);

    return {
      customers,
      summary: {
        count: customers.length,
        totalDue,
      },
    };
  }

  // Get top customers by purchase
  async getTopCustomers(shopId, limit = 10) {
    const customers = await Customer.find({
      shop: shopId,
      isActive: true,
    })
      .sort({ totalPurchases: -1 })
      .limit(limit)
      .lean();

    return customers;
  }

  // Get customer leaderboard (sortable by purchaseCount, totalPurchases, totalDue)
  async getCustomerLeaderboard(shopId, options = {}) {
    const {
      page = 1,
      limit = 20,
      sortBy = 'purchaseCount',
      sortOrder = 'desc',
      search,
    } = options;

    const allowedSortFields = ['purchaseCount', 'totalPurchases', 'totalDue', 'lastPurchase', 'createdAt'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'purchaseCount';

    const query = { shop: shopId, isActive: true };
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (page - 1) * limit;
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

    const [customers, total] = await Promise.all([
      Customer.find(query)
        .select('name phone totalPurchases totalPaid totalDue purchaseCount lastPurchase tags createdAt')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Customer.countDocuments(query),
    ]);

    // Add rank
    const ranked = customers.map((c, i) => ({
      ...c,
      rank: skip + i + 1,
    }));

    return {
      data: ranked,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Bulk import customers
  async bulkImportCustomers(shopId, userId, customers) {
    const results = [];

    for (const customerData of customers) {
      try {
        // Check if customer exists
        const existing = await Customer.findOne({ shop: shopId, phone: customerData.phone });
        if (existing) {
          results.push({ phone: customerData.phone, success: false, error: 'Already exists' });
          continue;
        }

        const customer = await this.createCustomer(shopId, userId, customerData);
        results.push({ phone: customerData.phone, success: true, customerId: customer._id });
      } catch (error) {
        results.push({ phone: customerData.phone, success: false, error: error.message });
      }
    }

    return results;
  }

  /**
   * Due Aging Analysis — Groups customer dues by age buckets
   * Returns per-customer breakdown: 0-30 days, 31-60 days, 60+ days
   */
  async getDueAging(shopId, branchId = null) {
    const now = new Date();
    const days30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const days60 = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const matchStage = {
      shop: require('mongoose').Types.ObjectId.createFromHexString(shopId.toString()),
      due: { $gt: 0 },
      status: { $ne: 'cancelled' }
    };
    if (branchId) matchStage.branch = require('mongoose').Types.ObjectId.createFromHexString(branchId.toString());

    const result = await Sale.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$customer',
          customerName: { $first: '$customerName' },
          customerPhone: { $first: '$customerPhone' },
          totalDue: { $sum: '$due' },
          due0to30: {
            $sum: { $cond: [{ $gte: ['$createdAt', days30] }, '$due', 0] }
          },
          due31to60: {
            $sum: { $cond: [{ $and: [{ $lt: ['$createdAt', days30] }, { $gte: ['$createdAt', days60] }] }, '$due', 0] }
          },
          due60plus: {
            $sum: { $cond: [{ $lt: ['$createdAt', days60] }, '$due', 0] }
          },
          oldestDue: { $min: '$createdAt' },
          saleCount: { $sum: 1 }
        }
      },
      { $sort: { totalDue: -1 } }
    ]);

    // Summary totals
    const summary = result.reduce((acc, c) => ({
      totalDue: acc.totalDue + c.totalDue,
      due0to30: acc.due0to30 + c.due0to30,
      due31to60: acc.due31to60 + c.due31to60,
      due60plus: acc.due60plus + c.due60plus,
      customerCount: acc.customerCount + 1,
    }), { totalDue: 0, due0to30: 0, due31to60: 0, due60plus: 0, customerCount: 0 });

    return { customers: result, summary };
  }
}

module.exports = new CustomerService();
