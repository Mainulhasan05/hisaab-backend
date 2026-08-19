const Expense = require('../models/Expense.model');
const ExpenseCategory = require('../models/ExpenseCategory.model');
const AuditLog = require('../models/AuditLog.model');
const paymentAccountService = require('./paymentAccount.service');
const { AppError } = require('../middleware/error.middleware');
const { endOfBangladeshDay, getBangladeshTodayRange, getBangladeshMonthRange, toBangladeshMonthStr } = require('../utils/bdTime.util');
const { branchFilter, requireBranch, branchMatch } = require('../utils/branchScope.util');
const { AI_MAX_EXPENSE_LINES } = require('../config/constants');

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
      throw new AppError('Expense category not found', 'ক্যাটাগরি পাওয়া যায়নি', 404);
    }

    // Which fund account the money left. Named by the caller, or the method's
    // default so a form that has not been updated still books the money
    // somewhere real. Null throughout for a shop without
    // `features.fundAccounts`, which makes the delta below a no-op (I-1).
    const account = expenseData.account
      ? (await paymentAccountService.assertUsableAccount(shopId, expenseData.account, req))._id
      : await paymentAccountService.resolveAccountForMethod(
          req?.shop || { _id: shopId }, paymentMethod || 'cash', req
        );

    const expense = await Expense.create({
      shop: shopId,
      branch: req ? requireBranch(req) : null,
      category: categoryDoc._id,
      categoryName: categoryDoc.name,
      amount,
      description,
      date: date || new Date(),
      paymentMethod: paymentMethod || 'cash',
      account,
      createdBy: userId,
    });

    // Money out.
    //
    // Not inside a transaction, because `createExpense` never opened one — the
    // Expense document is the only row it writes. If that changes, this must
    // move inside it: a balance moved outside the transaction that moved the
    // money it describes survives a rollback the money did not.
    await paymentAccountService.applyAccountDelta({
      shop: shopId,
      account,
      amount: -(Number(amount) || 0),
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

  /**
   * Create several expenses in one request.
   *
   * ── NOT ATOMIC, AND IT SAYS SO ─────────────────────────────────────────────
   *
   * There is not a single `startSession` in this codebase — no service uses
   * Mongo transactions, and adding the first one here would mean a deployment
   * requirement (a replica set) that the rest of the app does not have. So this
   * loops and reports per row: three created, one failed, and the response
   * names which one and why.
   *
   * That is the honest contract. Wrapping the loop in language that implies
   * all-or-nothing would be worse than the loop — a shopkeeper told "failed"
   * who actually has three new rows in their book will enter them again.
   *
   * The UI's job is to keep the failed rows on screen with their reason
   * attached, so retrying re-sends only those.
   *
   * ── WHY IT REUSES createExpense ROW BY ROW ─────────────────────────────────
   *
   * `insertMany` would be one round trip instead of N, and would skip the
   * category-belongs-to-this-shop check, the branch stamp, and the audit row.
   * Twenty documents is not the bottleneck worth breaking those for; the AI
   * path in particular MUST re-validate every category server-side, because the
   * ids it carries came back from a language model.
   *
   * @param {string} shopId
   * @param {string} userId
   * @param {Array}  rows    at most AI_MAX_EXPENSE_LINES entries
   * @param {Object} req
   * @param {string} source  'ai' | 'manual' — recorded on the batch audit row
   */
  async createBulk(shopId, userId, rows, req, source = 'manual') {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new AppError('No expenses provided', 'কোনো খরচ পাওয়া যায়নি', 400);
    }
    if (rows.length > AI_MAX_EXPENSE_LINES) {
      throw new AppError(
        `At most ${AI_MAX_EXPENSE_LINES} expenses per request`,
        `একসাথে সর্বোচ্চ ${AI_MAX_EXPENSE_LINES}টি খরচ যোগ করা যায়`,
        400
      );
    }

    const created = [];
    const failed = [];

    for (let i = 0; i < rows.length; i += 1) {
      try {
        // Sequential, not Promise.all. These all write AuditLog rows and touch
        // the same shop; twenty parallel writes buy milliseconds and make the
        // failure report non-deterministic about which rows landed.
        const expense = await this.createExpense(shopId, userId, rows[i], req);
        created.push(expense);
      } catch (err) {
        failed.push({
          index: i,
          reason: err?.messageBn || err?.message || 'খরচটি যোগ করা যায়নি',
        });
      }
    }

    // One row for the batch, on top of the per-expense ones createExpense
    // already writes. Without it the activity feed shows five unrelated entries
    // and nothing explains that they arrived together, or that a model drafted
    // them.
    if (created.length > 0) {
      const total = created.reduce((sum, e) => sum + e.amount, 0);
      await AuditLog.create({
        shop: shopId,
        branch: req ? requireBranch(req) : null,
        user: userId,
        action: 'expense_bulk_create',
        actionBn: 'একসাথে একাধিক খরচ যোগ',
        description: `Added ${created.length} expenses (৳${total}) via ${source}`,
        descriptionBn: `${created.length}টি খরচ একসাথে যোগ (৳${total})${source === 'ai' ? ' — এআই থেকে' : ''}`,
        entity: { type: 'expense', name: `${created.length} expenses` },
        changes: { after: { count: created.length, total, source } },
      }).catch(() => {
        // The expenses are already written. A failed summary row must not turn
        // a successful batch into an error the shopkeeper sees.
      });
    }

    return {
      created,
      failed,
      summary: { ok: created.length, failed: failed.length, total: rows.length },
    };
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
        throw new AppError('Expense category not found', 'ক্যাটাগরি পাওয়া যায়নি', 404);
      }
      updateData.categoryName = categoryDoc.name;
    }

    /**
     * Editing an expense moves money, and the balance has to move with it.
     *
     * `Object.assign` below writes whatever the payload holds — including
     * `amount` and `account`. Before fund accounts that was harmless: nothing
     * downstream held a running total. Now it is exactly the shape of the
     * `variants[].stock` drift — an edit path that updates one book and not the
     * other, silently, with the damage only visible months later when a bank
     * balance has never once matched the statement.
     *
     * So the old figure is reversed and the new one applied, both through the
     * one sanctioned writer. Correct when only the amount changes (৳500 → ৳800
     * on the same account nets to −৳300), when only the account changes (the
     * whole amount moves from one to the other), and when both do.
     *
     * Read BEFORE the assign, or the "before" figures are already the new ones.
     */
    const priorAmount = Number(expense.amount) || 0;
    const priorAccount = expense.account;

    if ('account' in updateData && updateData.account) {
      await paymentAccountService.assertUsableAccount(shopId, updateData.account, req);
    }

    Object.assign(expense, updateData);
    await expense.save();

    // A voided expense has already been given back, so re-applying the delta
    // here would credit the account twice. Editing one is not a normal flow —
    // the schema hides voided rows from this lookup by default — but the guard
    // costs nothing and the failure would be invisible.
    if (!expense.isVoided) {
      await paymentAccountService.applyAccountDelta({
        shop: shopId,
        account: priorAccount,
        amount: priorAmount,
      });
      await paymentAccountService.applyAccountDelta({
        shop: shopId,
        account: expense.account,
        amount: -(Number(expense.amount) || 0),
      });
    }

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

    // The money comes back. A void is the ONLY way an expense can be undone —
    // the row is immutable and `deleteExpense` was removed for that reason — so
    // this is the one place the account has to be made whole again. Skipping it
    // would leave the balance permanently short by every retracted expense,
    // which is the precise shape of the `variants[].stock` drift: a reversal
    // path that knew about one book and not the other.
    //
    // `recalc-account-balances.js` excludes voided rows for the same reason, so
    // the two agree.
    await paymentAccountService.applyAccountDelta({
      shop: shopId,
      account: expense.account,
      amount: Number(expense.amount) || 0,
    });

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
