const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Sale = require('../models/Sale.model');
const Payment = require('../models/Payment.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { branchFilter, requireBranch, isBranchCustomerScope } = require('../utils/branchScope.util');
const { runInTransaction } = require('../utils/transaction.util');
const { auditSnapshot, auditDiff, AUDIT_FIELDS } = require('../utils/auditDiff.util');
const mongoose = require('mongoose');

/** Escape user input before it reaches $regex — raw input is a ReDoS vector. */
const escapeRegex = (value) => String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Customer fields the list and leaderboard surface, projected out of a $lookup. */
const CUSTOMER_PROJECTION = {
  name: '$customer.name',
  phone: '$customer.phone',
  address: '$customer.address',
  notes: '$customer.notes',
  tags: '$customer.tags',
  isActive: '$customer.isActive',
  createdAt: '$customer.createdAt',
};

class CustomerService {
  /**
   * The customer list, joined to the active branch's ledger (Phase 7).
   *
   * Starts from `CustomerBalance` rather than `Customer`, which is what makes
   * this branch's customers the only ones returned — a customer with no row
   * here has never transacted at this branch and must not appear. The
   * `{shop, branch, totalDue: -1}` index serves the due-sorted case outright.
   *
   * Every returned document keeps the same shape as the shop-wide list, with
   * the branch's figures in place of the shop-wide ones, so no caller has to
   * know which mode it is in.
   */
  async _getBranchCustomers(shopId, branchId, options = {}) {
    const { page = 1, limit = 20, search, hasDue, sortBy = 'createdAt', sortOrder = 'desc' } = options;

    // Union of what the list and the leaderboard each allow — both funnel here.
    const sortField = ['createdAt', 'name', 'totalDue', 'totalPurchases', 'purchaseCount', 'lastPurchase'].includes(sortBy)
      ? sortBy : 'createdAt';
    const direction = sortOrder === 'asc' ? 1 : -1;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const match = {
      shop: new mongoose.Types.ObjectId(shopId),
      branch: new mongoose.Types.ObjectId(branchId),
    };
    if (hasDue === 'true' || hasDue === true) match.totalDue = { $gt: 0 };

    const postJoinMatch = { 'customer.isActive': true };
    if (search) {
      const escaped = escapeRegex(search);
      postJoinMatch.$or = [
        { 'customer.name': { $regex: escaped, $options: 'i' } },
        { 'customer.phone': { $regex: escaped, $options: 'i' } },
      ];
    }

    const [result] = await CustomerBalance.aggregate([
      { $match: match },
      {
        $lookup: {
          from: 'customers',
          localField: 'customer',
          foreignField: '_id',
          as: 'customer',
        },
      },
      { $unwind: '$customer' },
      { $match: postJoinMatch },
      {
        $project: {
          _id: '$customer._id',
          ...CUSTOMER_PROJECTION,
          totalPurchases: 1,
          totalPaid: 1,
          totalDue: 1,
          purchaseCount: 1,
          lastPurchase: 1,
        },
      },
      {
        $facet: {
          data: [{ $sort: { [sortField]: direction } }, { $skip: skip }, { $limit: parseInt(limit) }],
          count: [{ $count: 'total' }],
        },
      },
    ]);

    const total = result?.count?.[0]?.total || 0;

    return {
      data: result?.data || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    };
  }

  // Get all customers with filtering, searching, pagination
  async getCustomers(shopId, options = {}, req = null) {
    if (isBranchCustomerScope(req)) {
      return this._getBranchCustomers(shopId, req.branchId, options);
    }

    const {
      page = 1,
      limit = 20,
      search,
      hasDue,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;

    const query = { shop: shopId, isActive: true };

    // Search by name or phone (regex-escaped — raw input is a ReDoS vector)
    if (search) {
      const escaped = escapeRegex(search);
      query.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { phone: { $regex: escaped, $options: 'i' } },
      ];
    }

    // Filter by due status
    if (hasDue === 'true' || hasDue === true) {
      query.totalDue = { $gt: 0 };
    }

    const skip = (page - 1) * limit;
    const sortField = ['createdAt', 'name', 'totalDue', 'totalPurchases', 'lastPurchase'].includes(sortBy) ? sortBy : 'createdAt';
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

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

  /**
   * Overlay a customer document with the active branch's figures.
   *
   * Returns null when the customer has no row at this branch — they belong to
   * another branch entirely and, in branch scope, must not be readable here.
   */
  async _applyBranchFigures(customer, shopId, branchId) {
    const row = await CustomerBalance.findOne({
      shop: shopId,
      customer: customer._id,
      branch: branchId,
    }).lean();

    if (!row) return null;

    const plain = typeof customer.toObject === 'function' ? customer.toObject() : { ...customer };
    return {
      ...plain,
      totalPurchases: row.totalPurchases || 0,
      totalPaid: row.totalPaid || 0,
      totalDue: row.totalDue || 0,
      purchaseCount: row.purchaseCount || 0,
      lastPurchase: row.lastPurchase || null,
    };
  }

  // Get single customer by ID
  async getCustomerById(shopId, customerId, req = null) {
    const customer = await Customer.findOne({ _id: customerId, shop: shopId })
      .populate('createdBy', 'name phone');

    if (!customer) {
      throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
    }

    if (isBranchCustomerScope(req)) {
      const scoped = await this._applyBranchFigures(customer, shopId, req.branchId);
      // A plain 404, not a "wrong branch" hint: unlike a sale, whose branch an
      // owner may legitimately need to find, a customer this branch has never
      // served is simply not theirs to see. Naming the other branch would leak
      // the very thing separate customer books exist to keep apart.
      if (!scoped) {
        throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
      }
      return scoped;
    }

    return customer;
  }

  // Get customer by phone
  async getCustomerByPhone(shopId, phone, req = null) {
    // Deliberately shop-wide in BOTH modes. This is the till's lookup: a known
    // phone must resolve to the one existing person, or the same human ends up
    // with two records and the scope toggle stops being reversible. What branch
    // scope changes is what comes back with them — this branch's figures only,
    // never another branch's dues.
    const customer = await Customer.findOne({ shop: shopId, phone, isActive: true });
    if (!customer) return null;

    if (isBranchCustomerScope(req)) {
      const scoped = await this._applyBranchFigures(customer, shopId, req.branchId);
      // No row here yet — a first-time visit to this branch. Return them with
      // zeroed figures rather than null, so the till binds to the existing
      // person instead of creating a duplicate.
      return scoped || {
        ...customer.toObject(),
        totalPurchases: 0, totalPaid: 0, totalDue: 0, purchaseCount: 0, lastPurchase: null,
      };
    }

    return customer;
  }

  // Create new customer
  async createCustomer(shopId, userId, customerData, req) {
    const { phone, name, address, notes } = customerData;
    const branchId = req ? requireBranch(req) : null;

    // Check if customer with same phone exists.
    //
    // Deliberately shop-wide even in branch scope: one human is one record, and
    // {shop, phone} is unique. In branch scope the customer will not be in this
    // branch's list, so this reads as "already exists" for a customer the staff
    // cannot see — which is the honest answer, and the alternative (a second
    // document for the same phone) is what makes the scope toggle irreversible.
    const existingCustomer = await Customer.findOne({ shop: shopId, phone });
    if (existingCustomer) {
      // In branch scope the customer may exist shop-wide while being absent
      // from THIS branch's list — so "already exists" would be a dead end for a
      // record the staff cannot see or reach. Adopt them into this branch and
      // return them instead: the same silent bind the till does when a known
      // phone is typed. Their dues and history stay with the branches that
      // earned them; only their presence in this list is new.
      if (isBranchCustomerScope(req)) {
        await CustomerBalance.applyDelta({ shop: shopId, customer: existingCustomer._id, branch: branchId });
        return existingCustomer;
      }
      // Shared book: the customer really is in their list already, so the
      // error is both correct and actionable. Unchanged from before Phase 7.
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

    // Zero balance row for the creating branch. Without it a customer created
    // from the customers page — who has no sales yet — would be invisible in
    // the very branch that just created them.
    await CustomerBalance.applyDelta({ shop: shopId, customer: customer._id, branch: branchId });

    // Create audit log with request metadata & customer reference
    await AuditLog.log({
      shop: shopId,
      user: userId,
      customer: customer._id,
      action: 'customer_create',
      description: `Created customer: ${name} (${phone})`,
      entity: {
        type: 'customer',
        id: customer._id,
        name: name,
      },
      changes: {
        // Whitelisted, not the whole document — see utils/auditDiff.util.js.
        after: auditSnapshot(customer, AUDIT_FIELDS.customer),
      },
      req,
    });

    return customer;
  }

  // Update customer
  async updateCustomer(shopId, userId, customerId, updateData, req) {
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

    // Create audit log with request metadata & customer reference
    await AuditLog.log({
      shop: shopId,
      user: userId,
      customer: customer._id,
      action: 'customer_update',
      description: `Updated customer: ${customer.name} (${customer.phone})`,
      entity: {
        type: 'customer',
        id: customer._id,
        name: customer.name,
      },
      // Field-level diff rather than two full documents.
      changes: auditDiff(beforeData, customer, AUDIT_FIELDS.customer),
      req,
    });

    return customer;
  }

  // Delete customer (soft delete)
  async deleteCustomer(shopId, userId, customerId, req) {
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

    // Create audit log with request metadata & customer reference
    await AuditLog.log({
      shop: shopId,
      user: userId,
      customer: customer._id,
      action: 'customer_delete',
      description: `Deleted customer: ${customer.name} (${customer.phone})`,
      entity: {
        type: 'customer',
        id: customer._id,
        name: customer.name,
      },
      req,
    });

    return { success: true };
  }

  // Record due payment
  async collectDuePayment(shopId, userId, customerId, paymentData, req) {
    return await runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};
      const { amount, method, transactionId, notes } = paymentData;

    const customer = await Customer.findOne({ _id: customerId, shop: shopId }).session(session || null);
    if (!customer) {
      throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
    }

    const branchId = req ? requireBranch(req) : null;
    const branchScoped = isBranchCustomerScope(req);

    // Validate against whichever book this shop keeps.
    //
    // In branch scope this MUST be the branch figure. Validating against the
    // shop-wide total would let a branch collect ৳5,000 against a due that
    // exists only at another branch — the collecting branch would go negative
    // and the owing branch would stay overstated, permanently, with no error.
    let branchBalance = null;
    if (branchScoped) {
      branchBalance = await CustomerBalance.findOne(
        { shop: shopId, customer: customerId, branch: branchId },
        null,
        sessionOpt
      );
      const branchDue = branchBalance?.totalDue || 0;
      if (amount > branchDue) {
        throw new AppError(
          'Payment amount exceeds this branch\'s due balance',
          'পেমেন্টের পরিমাণ এই শাখার বাকির চেয়ে বেশি',
          400
        );
      }
    } else if (amount > customer.totalDue) {
      throw new AppError('পেমেন্টের পরিমাণ বাকির চেয়ে বেশি', 'Payment amount exceeds due balance', 400);
    }

    // Create payment record. `branch` is required: cashRegister._calculateCashFlows
    // matches due collections by branch, so an untagged payment is invisible to
    // every branch's till and understates expected closing (FEATURE_AUDIT.md H-6).
    const [payment] = await Payment.create([{
      shop: shopId,
      branch: branchId,
      customer: customerId,
      amount,
      method: method || 'cash',
      transactionId,
      type: 'due_collection',
      notes,
      receivedBy: userId,
    }], sessionOpt);

    // Update customer balance — the shop-wide rollup is maintained in both
    // modes, so the flag stays a read-path switch with nothing to migrate.
    customer.totalPaid += amount;
    customer.totalDue -= amount;
    await customer.save(sessionOpt);

    // A due collection is not tied to an invoice, so it is allocated to the
    // branches that actually hold the debt — collecting branch first, then
    // oldest. In branch scope the check above guarantees it all lands on the
    // collecting branch.
    await CustomerBalance.settleDue({
      shop: shopId,
      customer: customerId,
      preferBranch: branchId,
      amount,
    }, session);

    // Create audit log with request metadata & customer reference
    await AuditLog.log({
      shop: shopId,
      user: userId,
      customer: customer._id,
      action: 'due_collection',
      description: `Collected ৳${amount} from ${customer.name} (${customer.phone})`,
      entity: {
        type: 'customer',
        id: customer._id,
        name: customer.name,
      },
      changes: {
        before: { totalDue: customer.totalDue + amount },
        after: { totalDue: customer.totalDue },
      },
      req,
    });

    // Send payment receipt SMS (non-blocking — runs in background)
    const SMSService = require('./sms.service');
    SMSService.sendPaymentReceiptAsync(shopId, userId, {
      customerId: customer._id,
      amount,
    });

    return { customer, payment };
    });
  }

  // Get customer purchase history
  async getCustomerHistory(shopId, customerId, options = {}, req = null) {
    const { page = 1, limit = 20 } = options;

    // Reuses the visibility rule above: in branch scope this 404s for a
    // customer with no row at this branch, so history cannot be reached by
    // guessing an id that the list does not show.
    const customer = await this.getCustomerById(shopId, customerId, req);

    const skip = (page - 1) * limit;

    // In SHARED mode this stays shop-wide on purpose — one book means a branch
    // sees the customer's invoices from every other branch too, which is the
    // whole point of sharing. In SEPARATE mode it narrows to this branch.
    const scope = { shop: shopId, customer: customerId };
    if (isBranchCustomerScope(req)) {
      scope.branch = req.branchId;
    }

    const [sales, payments, totalSales, totalPayments] = await Promise.all([
      Sale.find(scope)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Payment.find(scope)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Sale.countDocuments(scope),
      Payment.countDocuments(scope),
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

  /**
   * Top N of this branch's ledger, joined back to the customer.
   *
   * Sorted and limited BEFORE the $lookup, so the join only ever touches the
   * rows that survive — this is the reason the ledger is its own collection
   * rather than an array on Customer, where the same query would mean an
   * $unwind and an in-memory sort over every customer in the shop.
   */
  async _topBranchBalances(shopId, branchId, { sortField, limit, extraMatch = {} }) {
    return CustomerBalance.aggregate([
      {
        $match: {
          shop: new mongoose.Types.ObjectId(shopId),
          branch: new mongoose.Types.ObjectId(branchId),
          ...extraMatch,
        },
      },
      { $sort: { [sortField]: -1 } },
      { $limit: parseInt(limit) },
      { $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: 'customer' } },
      { $unwind: '$customer' },
      { $match: { 'customer.isActive': true } },
      {
        $project: {
          _id: '$customer._id',
          ...CUSTOMER_PROJECTION,
          totalPurchases: 1,
          totalPaid: 1,
          totalDue: 1,
          purchaseCount: 1,
          lastPurchase: 1,
        },
      },
    ]);
  }

  // Get customers with due
  async getCustomersWithDue(shopId, options = {}, req = null) {
    const { limit = 50, minDue = 0 } = options;

    const customers = isBranchCustomerScope(req)
      ? await this._topBranchBalances(shopId, req.branchId, {
        sortField: 'totalDue',
        limit,
        extraMatch: { totalDue: { $gt: Number(minDue) } },
      })
      : await Customer.find({
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
  async getTopCustomers(shopId, limit = 10, req = null) {
    if (isBranchCustomerScope(req)) {
      return this._topBranchBalances(shopId, req.branchId, { sortField: 'totalPurchases', limit });
    }

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
  async getCustomerLeaderboard(shopId, options = {}, req = null) {
    const {
      page = 1,
      limit = 20,
      sortBy = 'purchaseCount',
      sortOrder = 'desc',
      search,
    } = options;

    const allowedSortFields = ['purchaseCount', 'totalPurchases', 'totalDue', 'lastPurchase', 'createdAt'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'purchaseCount';

    // The leaderboard is the customer list with a rank column, so it reuses the
    // same branch-joined query — one place where the visibility rule lives.
    if (isBranchCustomerScope(req)) {
      const skipRows = (parseInt(page) - 1) * parseInt(limit);
      const result = await this._getBranchCustomers(shopId, req.branchId, {
        page, limit, search, sortBy: sortField, sortOrder,
      });
      return {
        ...result,
        data: result.data.map((c, i) => ({ ...c, rank: skipRows + i + 1 })),
      };
    }

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
  async bulkImportCustomers(shopId, userId, customers, req) {
    const results = [];

    for (const customerData of customers) {
      try {
        // Check if customer exists
        const existing = await Customer.findOne({ shop: shopId, phone: customerData.phone });
        if (existing) {
          results.push({ phone: customerData.phone, success: false, error: 'Already exists' });
          continue;
        }

        const customer = await this.createCustomer(shopId, userId, customerData, req);
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
  async getDueAging(shopId, req = null) {
    const now = new Date();
    const days30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const days60 = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const matchStage = {
      shop: new mongoose.Types.ObjectId(shopId),
      due: { $gt: 0 },
      status: { $ne: 'cancelled' }
    };

    // Aging is derived from Sale.due, so it was already per-branch whenever a
    // branch was active — which was WRONG under shared customers: one book must
    // age as one book. It now follows the same flag as every other due read,
    // which also settles the older disagreement between this and
    // getCustomersWithDue about what "due" means.
    if (isBranchCustomerScope(req)) {
      matchStage.branch = new mongoose.Types.ObjectId(req.branchId);
    }

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
