const Expense = require('../models/Expense.model');
const ExpenseCategory = require('../models/ExpenseCategory.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { endOfBangladeshDay, getBangladeshTodayRange, getBangladeshMonthRange, toBangladeshMonthStr } = require('../utils/bdTime.util');
const { branchFilter, requireBranch, branchMatch } = require('../utils/branchScope.util');

class ExpenseService {
  // Get all expenses with filtering, pagination
  async getExpenses(shopId, options = {}) {
    const {
      page = 1,
      limit = 20,
      category,
      startDate,
      endDate,
      paymentMethod,
      sortBy = 'date',
      sortOrder = 'desc',
    } = options;

    const query = { shop: shopId };

    // Branch scoping
    if (options.branchId) {
      query.branch = options.branchId;
    }

    if (category) {
      query.category = category;
    }

    if (paymentMethod) {
      query.paymentMethod = paymentMethod;
    }

    // Date range filter
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      // End of the Bangladesh calendar day the client named. `setHours` here
      // was server-local, so on a UTC host "to the 31st" ended at 05:59 Dhaka
      // on the 31st and dropped almost a full day of entries.
      if (endDate) query.date.$lte = endOfBangladeshDay(endDate);
    }

    const skip = (page - 1) * limit;
    const sortField = ['date', 'createdAt', 'amount'].includes(sortBy) ? sortBy : 'date';
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

    /* Voided rows are hidden by the schema unless asked for. Off by default so
       the list reads as the shop's real spending; the toggle is for looking
       something up, not for daily use. */
    const includeVoided = options.includeVoided === true || options.includeVoided === 'true';

    const [expenses, total] = await Promise.all([
      Expense.find(query)
        .setOptions({ includeVoided })
        .populate('category', 'name icon')
        .populate('createdBy', 'name')
        .populate('voidedBy', 'name')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Expense.countDocuments(query).setOptions({ includeVoided }),
    ]);

    return {
      data: expenses,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Create expense
  async createExpense(shopId, userId, expenseData, req) {
    const { category, amount, description, date, paymentMethod } = expenseData;

    // Validate category exists
    const categoryDoc = await ExpenseCategory.findOne({
      _id: category,
      $or: [{ shop: shopId }, { shop: null }],
      isActive: true,
    });

    if (!categoryDoc) {
      throw new AppError('ক্যাটাগরি পাওয়া যায়নি', 'Expense category not found', 404);
    }

    const expense = await Expense.create({
      shop: shopId,
      branch: req ? requireBranch(req) : null,
      category: categoryDoc._id,
      categoryName: categoryDoc.name,
      amount,
      description,
      date: date || new Date(),
      paymentMethod: paymentMethod || 'cash',
      createdBy: userId,
    });

    // Populate for response
    await expense.populate('category', 'name icon');
    await expense.populate('createdBy', 'name');

    // Audit log
    await AuditLog.create({
      shop: shopId,
      branch: req ? requireBranch(req) : null,
      user: userId,
      action: 'expense_create',
      actionBn: 'নতুন খরচ যোগ',
      description: `Added expense: ৳${amount} - ${categoryDoc.name}`,
      descriptionBn: `নতুন খরচ যোগ: ৳${amount} - ${categoryDoc.name}`,
      entity: {
        type: 'expense',
        id: expense._id,
        name: categoryDoc.name,
      },
      changes: {
        after: { amount, category: categoryDoc.name, description },
      },
    });

    return expense;
  }

  // Update expense
  async updateExpense(shopId, userId, expenseId, updateData, req = null) {
    const expense = await Expense.findOne(branchFilter(req, { _id: expenseId, shop: shopId }));
    if (!expense) {
      throw new AppError('খরচটি পাওয়া যায়নি', 'Expense not found', 404);
    }

    const beforeData = { amount: expense.amount, categoryName: expense.categoryName, description: expense.description };

    // If category is being changed, validate it
    if (updateData.category && updateData.category !== String(expense.category)) {
      const categoryDoc = await ExpenseCategory.findOne({
        _id: updateData.category,
        $or: [{ shop: shopId }, { shop: null }],
        isActive: true,
      });
      if (!categoryDoc) {
        throw new AppError('ক্যাটাগরি পাওয়া যায়নি', 'Expense category not found', 404);
      }
      updateData.categoryName = categoryDoc.name;
    }

    Object.assign(expense, updateData);
    await expense.save();

    await expense.populate('category', 'name icon');
    await expense.populate('createdBy', 'name');

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'expense_update',
      actionBn: 'খরচ আপডেট',
      description: `Updated expense: ৳${expense.amount} - ${expense.categoryName}`,
      descriptionBn: `খরচ আপডেট: ৳${expense.amount} - ${expense.categoryName}`,
      entity: {
        type: 'expense',
        id: expense._id,
        name: expense.categoryName,
      },
      changes: {
        before: beforeData,
        after: { amount: expense.amount, categoryName: expense.categoryName, description: expense.description },
      },
    });

    return expense;
  }

  // Delete expense
  /**
   * Retract an expense without deleting it.
   *
   * This replaces `deleteExpense`, which could never succeed: the route, the
   * RBAC check and the service body all existed, and then `immutableGuard` on
   * the model refused the delete for every caller including the owner. The UI
   * shipped a bin icon and a confirm dialog that always ended in a 403.
   *
   * `includeVoided` on the lookup so voiding an already-voided expense reports
   * "already voided" instead of "not found" — the schema hides voided rows from
   * every query by default, this one included.
   */
  async voidExpense(shopId, userId, expenseId, reason, req = null) {
    const expense = await Expense.findOne(
      branchFilter(req, { _id: expenseId, shop: shopId })
    ).setOptions({ includeVoided: true });

    if (!expense) {
      throw new AppError('খরচটি পাওয়া যায়নি', 'Expense not found', 404);
    }

    if (expense.isVoided) {
      throw new AppError('খরচটি আগেই বাতিল করা হয়েছে', 'Expense is already voided', 400);
    }

    expense.isVoided = true;
    expense.voidedAt = new Date();
    expense.voidedBy = userId;
    expense.voidReason = reason || '';
    await expense.save();

    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'expense_void',
      actionBn: 'খরচ বাতিল',
      description: `Voided expense: ৳${expense.amount} - ${expense.categoryName}${reason ? `. Reason: ${reason}` : ''}`,
      descriptionBn: `খরচ বাতিল করা হয়েছে: ৳${expense.amount} - ${expense.categoryName}${reason ? `। কারণ: ${reason}` : ''}`,
      entity: {
        type: 'expense',
        id: expense._id,
        name: expense.categoryName,
      },
      changes: {
        before: { isVoided: false, amount: expense.amount },
        after: { isVoided: true, voidReason: reason || '' },
      },
    });

    return expense;
  }

  // Get expense summary (by category, totals)
  async getSummary(shopId, options = {}, req = null) {
    const { startDate, endDate, period = 'month' } = options;

    let start, end;

    if (startDate && endDate) {
      start = new Date(startDate);
      end = endOfBangladeshDay(endDate);
    } else {
      // Default to the current BANGLADESH month, not the server's.
      const { startOfMonth, endOfMonth } = getBangladeshMonthRange(toBangladeshMonthStr(new Date()));
      start = startOfMonth;
      end = endOfMonth;
    }

    // One resolution of "today", reused — calling the helper twice below would
    // straddle midnight on the one request per day where it matters.
    const { startOfDay: todayStart, endOfDay: todayEnd } = getBangladeshTodayRange();

    // Summary must match the scope of the list it sits beside — it was
    // shop-wide while the list was branch-scoped, so the two disagreed on the
    // same page (FEATURE_AUDIT.md H-10).
    const branchId = req?.branchId || null;

    const [byCategory, totals, todayTotal] = await Promise.all([
      Expense.getSummaryByCategory(shopId, start, end, branchId),
      Expense.getTotal(shopId, start, end, branchId),
      Expense.getTotal(
        shopId,
        todayStart,
        todayEnd,
        branchId
      ),
    ]);

    return {
      period: { start, end },
      totalAmount: totals.total,
      totalCount: totals.count,
      todayAmount: todayTotal.total,
      todayCount: todayTotal.count,
      byCategory,
    };
  }

  // Get expense categories for a shop
  async getCategories(shopId) {
    return ExpenseCategory.getCategories(shopId);
  }

  // Create custom expense category
  async createCategory(shopId, data) {
    const existing = await ExpenseCategory.findOne({
      $or: [{ shop: shopId }, { shop: null }],
      name: data.name,
    });

    if (existing) {
      throw new AppError('এই নামে ক্যাটাগরি আগে থেকেই আছে', 'Category with this name already exists', 400);
    }

    const category = await ExpenseCategory.create({
      shop: shopId,
      name: data.name,
      icon: data.icon || null,
    });

    return category;
  }

  // Delete custom expense category (only shop-specific, not defaults)
  async deleteCategory(shopId, categoryId) {
    const category = await ExpenseCategory.findOne({ _id: categoryId, shop: shopId });
    if (!category) {
      throw new AppError('ক্যাটাগরি পাওয়া যায়নি বা ডিফল্ট ক্যাটাগরি মুছা যায় না', 'Category not found or cannot delete default', 404);
    }

    // Voided expenses count here too. They still carry this category id, and a
    // category that vanishes underneath them makes the "বাতিল করা দেখুন" list
    // unresolvable later. `categoryName` is denormalised so the row would still
    // render, but the reference would dangle — cheaper to keep the block honest.
    const expenseCount = await Expense.countDocuments({ shop: shopId, category: categoryId })
      .setOptions({ includeVoided: true });
    if (expenseCount > 0) {
      throw new AppError(
        `এই ক্যাটাগরিতে ${expenseCount}টি খরচ আছে, আগে সেগুলো মুছুন বা পরিবর্তন করুন`,
        'Category has expenses, remove or reassign them first',
        400
      );
    }

    await ExpenseCategory.deleteOne({ _id: categoryId });
    return { success: true };
  }
}

module.exports = new ExpenseService();
