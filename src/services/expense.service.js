const Expense = require('../models/Expense.model');
const ExpenseCategory = require('../models/ExpenseCategory.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { getBranchForCreate } = require('../utils/branchScope.util');

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
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.date.$lte = end;
      }
    }

    const skip = (page - 1) * limit;
    const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const [expenses, total] = await Promise.all([
      Expense.find(query)
        .populate('category', 'name icon')
        .populate('createdBy', 'name')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Expense.countDocuments(query),
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
      branch: req ? getBranchForCreate(req) : null,
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
      branch: req ? getBranchForCreate(req) : null,
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
  async updateExpense(shopId, userId, expenseId, updateData) {
    const expense = await Expense.findOne({ _id: expenseId, shop: shopId });
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
  async deleteExpense(shopId, userId, expenseId) {
    const expense = await Expense.findOne({ _id: expenseId, shop: shopId });
    if (!expense) {
      throw new AppError('খরচটি পাওয়া যায়নি', 'Expense not found', 404);
    }

    const deletedInfo = { amount: expense.amount, categoryName: expense.categoryName };
    await Expense.deleteOne({ _id: expenseId });

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'expense_delete',
      actionBn: 'খরচ মুছে ফেলা',
      description: `Deleted expense: ৳${deletedInfo.amount} - ${deletedInfo.categoryName}`,
      descriptionBn: `খরচ মুছে ফেলা হয়েছে: ৳${deletedInfo.amount} - ${deletedInfo.categoryName}`,
      entity: {
        type: 'expense',
        id: expenseId,
        name: deletedInfo.categoryName,
      },
    });

    return { success: true };
  }

  // Get expense summary (by category, totals)
  async getSummary(shopId, options = {}) {
    const { startDate, endDate, period = 'month' } = options;

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

    const [byCategory, totals, todayTotal] = await Promise.all([
      Expense.getSummaryByCategory(shopId, start, end),
      Expense.getTotal(shopId, start, end),
      Expense.getTotal(
        shopId,
        new Date(new Date().setHours(0, 0, 0, 0)),
        new Date(new Date().setHours(23, 59, 59, 999))
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

    // Check if any expenses use this category
    const expenseCount = await Expense.countDocuments({ shop: shopId, category: categoryId });
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
