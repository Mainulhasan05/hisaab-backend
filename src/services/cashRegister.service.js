const mongoose = require('mongoose');
const CashRegister = require('../models/CashRegister.model');
const Sale = require('../models/Sale.model');
const Payment = require('../models/Payment.model');
const Expense = require('../models/Expense.model');
const Purchase = require('../models/Purchase.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { AUDIT_ACTIONS } = require('../config/constants');
const { branchFilter, requireBranch, isAllBranchesView } = require('../utils/branchScope.util');
const { toBangladeshDateStr, getBangladeshDayRange, endOfBangladeshDay } = require('../utils/bdTime.util');

class CashRegisterService {
  /**
   * The till's day — Bangladesh local, like every other "today" in this system.
   *
   * This used to be `setHours(0, 0, 0, 0)`, i.e. SERVER local midnight. The
   * server runs UTC, so the register's day began at 06:00 Dhaka: a sale rung up
   * at 2am counted into yesterday's till while `getTodaySummary` (which has
   * always used Bangladesh time) put it in today's sales. The dashboard and the
   * drawer disagreed by exactly the night's takings, every night.
   *
   * `bdTime.util` is the one definition of that conversion — see the note at the
   * top of it. Nothing here computes an offset of its own.
   */
  _dayRange(date = new Date()) {
    const { startOfDay, endOfDay } = getBangladeshDayRange(toBangladeshDateStr(date));
    return { start: startOfDay, end: endOfDay };
  }

  // Helper: aggregate today's cash flows from all sources
  async _calculateCashFlows(shopId, start, end, branchId = null) {
    const shopOid = new mongoose.Types.ObjectId(shopId);
    const branchMatch = branchId ? { branch: new mongoose.Types.ObjectId(branchId) } : {};

    const [
      cashSales,
      cashDueCollections,
      cashExpenses,
      cashPurchases,
      cashRefunds,
      cashSupplierPayments,
    ] = await Promise.all([
      // ── Cash taken at the counter ────────────────────────────────────────
      //
      // Summed from the sale's `payments[]` LEGS, not from `paid` filtered on
      // `paymentMethod`. `paymentMethod` is only "whichever leg was largest"
      // (sale.service.js, split-payment block), so filtering on it was wrong in
      // both directions and by the full amount:
      //
      //   ৳400 cash + ৳600 bKash → paymentMethod 'bkash' → ৳0 counted as cash
      //   ৳600 cash + ৳400 card  → paymentMethod 'cash'  → ৳1000 counted as cash
      //
      // The drawer was short on the first and over on the second, and neither
      // was attributable to anything the shopkeeper could see.
      //
      // `payments[]` covers only what was settled AT CHECKOUT; money collected
      // later against the same invoice writes a `Payment{type:'sale_payment'}`
      // and is picked up by `cashSaleCollections` below. The two are disjoint,
      // so nothing is counted twice.
      //
      // The fallback branch is for sales written before `createSale` began
      // populating `payments[]` unconditionally. Those all predate today, so in
      // practice it only ever sees `paid: 0` rows and contributes nothing.
      Sale.aggregate([
        {
          $match: {
            shop: shopOid,
            ...branchMatch,
            status: { $ne: 'cancelled' },
            createdAt: { $gte: start, $lte: end },
          },
        },
        {
          $project: {
            cashAmount: {
              $cond: [
                { $gt: [{ $size: { $ifNull: ['$payments', []] } }, 0] },
                {
                  $sum: {
                    $map: {
                      input: {
                        $filter: {
                          input: '$payments',
                          as: 'p',
                          cond: { $eq: ['$$p.method', 'cash'] },
                        },
                      },
                      as: 'p',
                      in: { $ifNull: ['$$p.amount', 0] },
                    },
                  },
                },
                { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$paid', 0] },
              ],
            },
          },
        },
        { $group: { _id: null, total: { $sum: '$cashAmount' } } },
      ]),

      // ── Cash collected against invoices AFTER checkout ───────────────────
      //
      // Both streams that settle a customer's debt later, in one bucket:
      //
      //   `due_collection` — the customer-level "বাকি আদায়" screen
      //   `sale_payment`   — `recordPayment` on a specific invoice
      //
      // The second was counted by NOTHING. `cashSales` above is bounded by the
      // SALE's `createdAt`, so cash taken today against an invoice raised on any
      // earlier day fell through both filters: real money in the drawer that no
      // bucket accounted for, and the till read over by exactly that amount
      // every time an old due was settled from the invoice screen.
      //
      // ── `atCheckout` is what makes this disjoint from `cashSales` ─────────
      //
      // The comment here used to claim `payments[]` and `Payment{sale_payment}`
      // were disjoint "by construction". They were not: `createSale` writes a
      // `sale_payment` row for the checkout amount, so every cash sale was
      // counted once from its legs above and again here. Expected closing ran
      // over by essentially the whole day's cash takings, and the shopkeeper saw
      // a drawer that was short by exactly what was in it.
      //
      // The flag is the discriminator (see its note on Payment.model). Excluding
      // it with `$ne: true` rather than `$eq: false` so rows written before the
      // field existed — where it is simply absent — are still matched by the
      // legacy-collection case they belong to; `backfill-payment-at-checkout.js`
      // stamps the checkout ones.
      Payment.aggregate([
        {
          $match: {
            shop: shopOid,
            ...branchMatch,
            method: 'cash',
            type: { $in: ['due_collection', 'sale_payment'] },
            atCheckout: { $ne: true },
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
            ...branchMatch,
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
            ...branchMatch,
            paymentMethod: 'cash',
            status: { $ne: 'cancelled' },
            date: { $gte: start, $lte: end },
          },
        },
        { $group: { _id: null, total: { $sum: '$paid' } } },
      ]),

      // Cash refunds (from Payment model)
      Payment.aggregate([
        {
          $match: {
            shop: shopOid,
            ...branchMatch,
            method: 'cash',
            type: 'refund',
            createdAt: { $gte: start, $lte: end },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),

      // ── Supplier payments made after the purchase ────────────────────────
      //
      // This was missing entirely, and it is real money leaving the drawer.
      // `cashPurchases` above only counts `Purchase.paid` — what was settled at
      // the counter on the day of the purchase. Paying a supplier's outstanding
      // balance later writes a `Payment{type:'purchase_payment'}` instead, and
      // nothing here looked at it.
      //
      // So: buy ৳50,000 on credit today, hand the supplier ৳20,000 cash
      // tomorrow, and tomorrow's expected closing was ৳20,000 too high — the
      // till looked short by exactly the amount that had legitimately been
      // paid out.
      //
      // No double count: `createPurchase` writes no Payment row, so the two
      // streams are disjoint by construction.
      Payment.aggregate([
        {
          $match: {
            shop: shopOid,
            ...branchMatch,
            method: 'cash',
            type: 'purchase_payment',
            createdAt: { $gte: start, $lte: end },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    return {
      sales: cashSales[0]?.total || 0,
      dueCollections: cashDueCollections[0]?.total || 0,
      expenses: cashExpenses[0]?.total || 0,
      // Goods paid for at the counter, plus supplier balances settled later.
      // Both are cash out against purchases, so they share the one bucket the
      // register already renders.
      purchases: (cashPurchases[0]?.total || 0) + (cashSupplierPayments[0]?.total || 0),
      refunds: cashRefunds[0]?.total || 0,
    };
  }

  // Get today's register (find or create, auto-calculate)
  async getTodayRegister(shopId, userId, req) {
    const { start, end } = this._dayRange();

    // A cash register belongs to exactly one branch, so "All Branches" has no
    // single register to show. Returning one anyway would pick an arbitrary
    // branch's till and present it as the shop's — say so instead.
    // (This path previously threw 403 and broke the page outright — H-1.)
    if (isAllBranchesView(req)) {
      return { exists: false, allBranchesView: true };
    }

    const branchId = req?.branchId || null;
    const branchQuery = branchId ? { branch: branchId } : {};

    let register = await CashRegister.findOne({
      shop: shopId,
      ...branchQuery,
      date: { $gte: start, $lte: end },
    });

    if (!register) {
      // Check for unclosed previous day
      const previousRegister = await CashRegister.findOne({
        shop: shopId,
        ...branchQuery,
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

    // ── A closed register is a settled record, not a live view ──────────────
    //
    // This recalculated and SAVED unconditionally, and the model's pre-save
    // derives `expectedClosing` and `difference` from those figures. So closing
    // the till at 10pm with a difference of ৳0 and merely OPENING the page
    // afterwards could rewrite it into a discrepancy — a reconciliation that
    // changes after the fact is worse than no reconciliation, because the
    // shopkeeper has already signed off on the number they saw.
    //
    // Reopening is the sanctioned way to make a closed day's figures move
    // again; `reopenRegister` recalculates on the way through.
    //
    // (This is also why the recalculation is not simply hoisted out of the GET:
    // an open register genuinely is a live view, and the page has to show the
    // day's takings as they accumulate.)
    if (register.status === 'closed') {
      return { exists: true, register: register.toJSON() };
    }

    // Auto-calculate cash flows from live data
    const flows = await this._calculateCashFlows(shopId, start, end, branchId);

    // Update auto-calculated fields (preserve manual 'other' entries)
    register.cashIn.sales = flows.sales;
    register.cashIn.dueCollections = flows.dueCollections;
    register.cashOut.expenses = flows.expenses;
    register.cashOut.purchases = flows.purchases;
    register.cashOut.refunds = flows.refunds;

    await register.save();

    return {
      exists: true,
      register: register.toJSON(),
    };
  }

  // Open today's register
  async openRegister(shopId, userId, openingBalance, req) {
    const { start, end } = this._dayRange();
    // WRITE: opening a till belongs to exactly one branch.
    const branchId = req ? requireBranch(req) : null;
    const branchQuery = branchId ? { branch: branchId } : {};

    // Check if already exists
    let register = await CashRegister.findOne({
      shop: shopId,
      ...branchQuery,
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
      // Stamped with the start of the BANGLADESH day — the same instant every
      // lookup in this file searches from.
      //
      // This was `new Date()` + `setHours(0,0,0,0)`, i.e. SERVER-local midnight,
      // while `_dayRange` (used by every read) works in Bangladesh time. On a UTC
      // host the two agree for most of the day and diverge between 00:00 and
      // 06:00 Dhaka: a register opened at 2am was written with yesterday's UTC
      // midnight, which falls outside today's Bangladesh range, so
      // `getTodayRegister` reported no register existed and a second one could be
      // opened for the same day — until the unique index on
      // {shop, branch, date} refused it and the till could not be opened at all.
      //
      // This is the exact defect the header comment on `_dayRange` describes as
      // fixed; the write path had been missed.
      register = await CashRegister.create({
        shop: shopId,
        branch: branchId,
        date: start,
        openingBalance: openingBalance || 0,
        createdBy: userId,
      });
    }

    // Calculate live cash flows
    const flows = await this._calculateCashFlows(shopId, start, end, branchId);
    register.cashIn.sales = flows.sales;
    register.cashIn.dueCollections = flows.dueCollections;
    register.cashOut.expenses = flows.expenses;
    register.cashOut.purchases = flows.purchases;
    register.cashOut.refunds = flows.refunds;
    await register.save();

    // Audit log
    await AuditLog.create({
      shop: shopId,
      branch: branchId || null,
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
  async updateRegister(shopId, userId, data, req = null) {
    const { start, end } = this._dayRange();
    const branchId = req ? requireBranch(req) : null;
    const branchQuery = branchId ? { branch: branchId } : {};

    const register = await CashRegister.findOne({
      shop: shopId,
      ...branchQuery,
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
    const flows = await this._calculateCashFlows(shopId, start, end, branchId);
    register.cashIn.sales = flows.sales;
    register.cashIn.dueCollections = flows.dueCollections;
    register.cashOut.expenses = flows.expenses;
    register.cashOut.purchases = flows.purchases;
    register.cashOut.refunds = flows.refunds;

    await register.save();

    // Audit log
    await AuditLog.create({
      shop: shopId,
      branch: branchId || null,
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
  async closeRegister(shopId, userId, actualClosing, notes, req = null) {
    const { start, end } = this._dayRange();
    const branchId = req ? requireBranch(req) : null;
    const branchQuery = branchId ? { branch: branchId } : {};

    const register = await CashRegister.findOne({
      shop: shopId,
      ...branchQuery,
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
    const flows = await this._calculateCashFlows(shopId, start, end, branchId);
    register.cashIn.sales = flows.sales;
    register.cashIn.dueCollections = flows.dueCollections;
    register.cashOut.expenses = flows.expenses;
    register.cashOut.purchases = flows.purchases;
    register.cashOut.refunds = flows.refunds;

    register.actualClosing = actualClosing;
    register.status = 'closed';
    register.closedBy = userId;
    register.closedAt = new Date();
    if (notes) register.notes = notes;

    await register.save();

    // Audit log
    await AuditLog.create({
      shop: shopId,
      branch: branchId || null,
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
  async closePreviousRegister(shopId, userId, registerId, actualClosing, notes, req = null) {
    // WRITE: settles one branch's till.
    const branchId = req ? requireBranch(req) : null;
    const branchQuery = branchId ? { branch: branchId } : {};

    const register = await CashRegister.findOne({
      _id: registerId,
      shop: shopId,
      ...branchQuery,
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
      branch: branchId || null,
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
  async reopenRegister(shopId, userId, reason, req = null) {
    const { start, end } = this._dayRange();
    // WRITE: reopens one branch's till for today.
    const branchId = req ? requireBranch(req) : null;
    const branchQuery = branchId ? { branch: branchId } : {};

    const register = await CashRegister.findOne({
      shop: shopId,
      ...branchQuery,
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
    const flows = await this._calculateCashFlows(shopId, start, end, branchId);
    register.cashIn.sales = flows.sales;
    register.cashIn.dueCollections = flows.dueCollections;
    register.cashOut.expenses = flows.expenses;
    register.cashOut.purchases = flows.purchases;
    register.cashOut.refunds = flows.refunds;

    await register.save();

    // Audit log
    await AuditLog.create({
      shop: shopId,
      branch: branchId || null,
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
  async getHistory(shopId, options = {}, req = null) {
    const { page = 1, limit = 10, startDate, endDate } = options;

    const query = req ? branchFilter(req, { shop: shopId }) : { shop: shopId };

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      // End of the BANGLADESH day, not the server's. `setHours(23,59,59,999)` on
      // a UTC host ended the window at 05:59 the next morning Dhaka time, so the
      // history list and the registers it lists disagreed about which day a
      // register belonged to — the same six-hour drift `_dayRange` exists to
      // eliminate.
      if (endDate) query.date.$lte = endOfBangladeshDay(endDate);
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
