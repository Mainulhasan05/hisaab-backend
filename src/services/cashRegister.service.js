const mongoose = require('mongoose');
const CashRegister = require('../models/CashRegister.model');
const Sale = require('../models/Sale.model');
const Payment = require('../models/Payment.model');
const Expense = require('../models/Expense.model');
const Purchase = require('../models/Purchase.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { AUDIT_ACTIONS } = require('../config/constants');

class CashRegisterService {
  // Helper: get start and end of a date
  _dayRange(date = new Date()) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  // Helper: aggregate today's cash flows from all sources
  async _calculateCashFlows(shopId, start, end) {
    const shopOid = new mongoose.Types.ObjectId(shopId);

    const [cashSales, cashDueCollections, cashExpenses, cashPurchases] = await Promise.all([
      // Cash sales (paid amount from cash sales)
      Sale.aggregate([
        {
          $match: {
            shop: shopOid,
            paymentMethod: 'cash',
            status: { $ne: 'cancelled' },
            createdAt: { $gte: start, $lte: end },
          },
        },
        { $group: { _id: null, total: { $sum: '$paid' } } },
      ]),

      // Cash due collections (from Payment model)
      Payment.aggregate([
        {
          $match: {
            shop: shopOid,
            method: 'cash',
            type: 'due_collection',
            createdAt: { $gte: start, $lte: end },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),

      // Cash expenses
      Expense.aggregate([
        {
          $match: {
            shop: shopOid,
            paymentMethod: 'cash',
            date: { $gte: start, $lte: end },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),

      // Cash purchases (paid amount from cash purchases)
      Purchase.aggregate([
        {
          $match: {
            shop: shopOid,
            paymentMethod: 'cash',
            status: { $ne: 'cancelled' },
            date: { $gte: start, $lte: end },
          },
        },
        { $group: { _id: null, total: { $sum: '$paid' } } },
      ]),
    ]);

    return {
      sales: cashSales[0]?.total || 0,
      dueCollections: cashDueCollections[0]?.total || 0,
      expenses: cashExpenses[0]?.total || 0,
      purchases: cashPurchases[0]?.total || 0,
    };
  }

  // Get today's register (find or create, auto-calculate)
  async getTodayRegister(shopId, userId) {
    const { start, end } = this._dayRange();

    let register = await CashRegister.findOne({
      shop: shopId,
      date: { $gte: start, $lte: end },
    });

    if (!register) {
      // Check for unclosed previous day
      const previousRegister = await CashRegister.findOne({
        shop: shopId,
        date: { $lt: start },
      }).sort({ date: -1 });

      // Check if previous day is unclosed
      const unclosedPrevious = previousRegister?.status === 'open' ? {
        _id: previousRegister._id,
        date: previousRegister.date,
        openingBalance: previousRegister.openingBalance,
        expectedClosing: previousRegister.expectedClosing,
      } : null;

      return {
        exists: false,
        suggestedOpening: previousRegister?.actualClosing ?? previousRegister?.expectedClosing ?? 0,
        previousDate: previousRegister?.date || null,
        unclosedPrevious,
      };
    }

    // Auto-calculate cash flows from live data
    const flows = await this._calculateCashFlows(shopId, start, end);

    // Update auto-calculated fields (preserve manual 'other' entries)
    register.cashIn.sales = flows.sales;
    register.cashIn.dueCollections = flows.dueCollections;
    register.cashOut.expenses = flows.expenses;
    register.cashOut.purchases = flows.purchases;

    await register.save();

    return {
      exists: true,
      register: register.toJSON(),
    };
  }

  // Open today's register
  async openRegister(shopId, userId, openingBalance) {
    const { start, end } = this._dayRange();

    // Check if already exists
    let register = await CashRegister.findOne({
      shop: shopId,
      date: { $gte: start, $lte: end },
    });

    if (register) {
      if (register.status === 'closed') {
        throw new AppError(
          'আজকের রেজিস্টার ইতিমধ্যে বন্ধ হয়ে গেছে',
          'Today\'s register is already closed',
          400
        );
      }
      // Update opening balance
      register.openingBalance = openingBalance;
      await register.save();
    } else {
      // Create new register
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      register = await CashRegister.create({
        shop: shopId,
        date: today,
        openingBalance: openingBalance || 0,
        createdBy: userId,
      });
    }

    // Calculate live cash flows
    const flows = await this._calculateCashFlows(shopId, start, end);
    register.cashIn.sales = flows.sales;
    register.cashIn.dueCollections = flows.dueCollections;
    register.cashOut.expenses = flows.expenses;
    register.cashOut.purchases = flows.purchases;
    await register.save();

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: AUDIT_ACTIONS.CASH_REGISTER_OPEN.en,
      actionBn: AUDIT_ACTIONS.CASH_REGISTER_OPEN.bn,
      description: `Cash register opened with balance: ৳${openingBalance}`,
      descriptionBn: `ক্যাশ রেজিস্টার খোলা হয়েছে, শুরুর ব্যালান্স: ৳${openingBalance}`,
      entity: {
        type: 'cash_register',
        id: register._id,
      },
      changes: {
        after: { openingBalance },
      },
    });

    return register.toJSON();
  }

  // Update register (manual entries: other cash in/out)
  async updateRegister(shopId, userId, data) {
    const { start, end } = this._dayRange();

    const register = await CashRegister.findOne({
      shop: shopId,
      date: { $gte: start, $lte: end },
    });

    if (!register) {
      throw new AppError(
        'আজকের রেজিস্টার খোলা হয়নি',
        'Today\'s register is not open',
        404
      );
    }

    if (register.status === 'closed') {
      throw new AppError(
        'বন্ধ রেজিস্টার আপডেট করা যায় না',
        'Cannot update a closed register',
        400
      );
    }

    // Update manual fields only
    if (data.cashInOther != null) register.cashIn.other = data.cashInOther;
    if (data.cashInOtherNote != null) register.cashIn.otherNote = data.cashInOtherNote;
    if (data.cashOutOther != null) register.cashOut.other = data.cashOutOther;
    if (data.cashOutOtherNote != null) register.cashOut.otherNote = data.cashOutOtherNote;
    if (data.notes != null) register.notes = data.notes;

    // Recalculate auto fields
    const flows = await this._calculateCashFlows(shopId, start, end);
    register.cashIn.sales = flows.sales;
    register.cashIn.dueCollections = flows.dueCollections;
    register.cashOut.expenses = flows.expenses;
    register.cashOut.purchases = flows.purchases;

    await register.save();

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: AUDIT_ACTIONS.CASH_REGISTER_UPDATE.en,
      actionBn: AUDIT_ACTIONS.CASH_REGISTER_UPDATE.bn,
      description: 'Cash register updated',
      descriptionBn: 'ক্যাশ রেজিস্টার আপডেট হয়েছে',
      entity: {
        type: 'cash_register',
        id: register._id,
      },
      changes: {
        after: data,
      },
    });

    return register.toJSON();
  }

  // Close today's register
  async closeRegister(shopId, userId, actualClosing, notes) {
    const { start, end } = this._dayRange();

    const register = await CashRegister.findOne({
      shop: shopId,
      date: { $gte: start, $lte: end },
    });

    if (!register) {
      throw new AppError(
        'আজকের রেজিস্টার খোলা হয়নি',
        'Today\'s register is not open',
        404
      );
    }

    if (register.status === 'closed') {
      throw new AppError(
        'আজকের রেজিস্টার ইতিমধ্যে বন্ধ',
        'Register is already closed',
        400
      );
    }

    // Final recalculation before closing
    const flows = await this._calculateCashFlows(shopId, start, end);
    register.cashIn.sales = flows.sales;
    register.cashIn.dueCollections = flows.dueCollections;
    register.cashOut.expenses = flows.expenses;
    register.cashOut.purchases = flows.purchases;

    register.actualClosing = actualClosing;
    register.status = 'closed';
    register.closedBy = userId;
    register.closedAt = new Date();
    if (notes) register.notes = notes;

    await register.save();

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: AUDIT_ACTIONS.CASH_REGISTER_CLOSE.en,
      actionBn: AUDIT_ACTIONS.CASH_REGISTER_CLOSE.bn,
      description: `Cash register closed. Expected: ৳${register.expectedClosing}, Actual: ৳${actualClosing}, Diff: ৳${register.difference}`,
      descriptionBn: `ক্যাশ রেজিস্টার বন্ধ। প্রত্যাশিত: ৳${register.expectedClosing}, প্রকৃত: ৳${actualClosing}, পার্থক্য: ৳${register.difference}`,
      entity: {
        type: 'cash_register',
        id: register._id,
      },
      changes: {
        after: {
          actualClosing,
          expectedClosing: register.expectedClosing,
          difference: register.difference,
        },
      },
    });

    return register.toJSON();
  }

  // Close a previous day's register by ID
  async closePreviousRegister(shopId, userId, registerId, actualClosing, notes) {
    const register = await CashRegister.findOne({
      _id: registerId,
      shop: shopId,
    });

    if (!register) {
      throw new AppError(
        'রেজিস্টার পাওয়া যায়নি',
        'Register not found',
        404
      );
    }

    if (register.status === 'closed') {
      throw new AppError(
        'এই রেজিস্টার ইতিমধ্যে বন্ধ',
        'Register is already closed',
        400
      );
    }

    register.actualClosing = actualClosing;
    register.status = 'closed';
    register.closedBy = userId;
    register.closedAt = new Date();
    if (notes) register.notes = notes;

    await register.save();

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: AUDIT_ACTIONS.CASH_REGISTER_CLOSE.en,
      actionBn: AUDIT_ACTIONS.CASH_REGISTER_CLOSE.bn,
      description: `Previous day cash register closed. Date: ${register.date.toLocaleDateString()}, Expected: ৳${register.expectedClosing}, Actual: ৳${actualClosing}, Diff: ৳${register.difference}`,
      descriptionBn: `আগের দিনের ক্যাশ রেজিস্টার বন্ধ। তারিখ: ${register.date.toLocaleDateString('bn-BD')}, প্রত্যাশিত: ৳${register.expectedClosing}, প্রকৃত: ৳${actualClosing}, পার্থক্য: ৳${register.difference}`,
      entity: {
        type: 'cash_register',
        id: register._id,
      },
      changes: {
        after: {
          actualClosing,
          expectedClosing: register.expectedClosing,
          difference: register.difference,
        },
      },
    });

    return register.toJSON();
  }

  // Reopen a closed register (owner only)
  async reopenRegister(shopId, userId, reason) {
    const { start, end } = this._dayRange();

    const register = await CashRegister.findOne({
      shop: shopId,
      date: { $gte: start, $lte: end },
    });

    if (!register) {
      throw new AppError(
        'আজকের রেজিস্টার পাওয়া যায়নি',
        'Today\'s register not found',
        404
      );
    }

    if (register.status !== 'closed') {
      throw new AppError(
        'রেজিস্টার ইতিমধ্যে খোলা আছে',
        'Register is already open',
        400
      );
    }

    // Store previous closing data for audit
    const previousData = {
      actualClosing: register.actualClosing,
      difference: register.difference,
      closedAt: register.closedAt,
      closedBy: register.closedBy,
    };

    // Reset closing data
    register.status = 'open';
    register.actualClosing = undefined;
    register.difference = 0;
    register.closedAt = undefined;
    register.closedBy = undefined;

    // Recalculate cash flows
    const flows = await this._calculateCashFlows(shopId, start, end);
    register.cashIn.sales = flows.sales;
    register.cashIn.dueCollections = flows.dueCollections;
    register.cashOut.expenses = flows.expenses;
    register.cashOut.purchases = flows.purchases;

    await register.save();

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: AUDIT_ACTIONS.CASH_REGISTER_REOPEN.en,
      actionBn: AUDIT_ACTIONS.CASH_REGISTER_REOPEN.bn,
      description: `Cash register reopened. Reason: ${reason || 'Not specified'}`,
      descriptionBn: `ক্যাশ রেজিস্টার পুনরায় খোলা হয়েছে। কারণ: ${reason || 'উল্লেখ নেই'}`,
      entity: {
        type: 'cash_register',
        id: register._id,
      },
      changes: {
        before: previousData,
        after: { status: 'open', reason },
      },
    });

    return register.toJSON();
  }

  // Get register history
  async getHistory(shopId, options = {}) {
    const { page = 1, limit = 10, startDate, endDate } = options;

    const query = { shop: shopId };

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.date.$lte = end;
      }
    }

    const [registers, total] = await Promise.all([
      CashRegister.find(query)
        .sort({ date: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('closedBy', 'name')
        .lean(),
      CashRegister.countDocuments(query),
    ]);

    return {
      data: registers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }
}

module.exports = new CashRegisterService();
