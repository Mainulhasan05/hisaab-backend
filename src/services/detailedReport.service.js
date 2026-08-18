const mongoose = require('mongoose');

const Sale = require('../models/Sale.model');
const SalesReturn = require('../models/SalesReturn.model');
const Payment = require('../models/Payment.model');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const DueAdjustment = require('../models/DueAdjustment.model');
const Supplier = require('../models/Supplier.model');
const SupplierBalance = require('../models/SupplierBalance.model');
const SupplierDueAdjustment = require('../models/SupplierDueAdjustment.model');
const Purchase = require('../models/Purchase.model');
const Product = require('../models/Product.model');

const { buildDateMatch } = require('../utils/reportScope.util');
const { isBranchCustomerScope } = require('../utils/branchScope.util');
const { quantizeMoney } = require('../utils/quantity.util');
const { paidAtMatch, PAID_AT_EXPR } = require('../utils/paymentDate.util');
const { PAYMENT_TYPES } = require('../config/constants');

/**
 * The three printable business documents: a customer statement of account, a
 * stock valuation, and a supplier statement of account.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THESE ARE NOT PARAMETERS ON THE EXISTING REPORT ENDPOINTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `getCustomerReport` and `getProductReport` in report.service.js are DASHBOARD
 * feeds: `.limit(20)`, top-N ordering, and — for the product one — a shared
 * cache the dashboard depends on. They answer "who are my best customers" in a
 * card. A statement answers "what does Rahim owe me and how did it get there",
 * which needs every row, not the top twenty, and must never be served from a
 * cache warmed by a different question.
 *
 * Bolting a `full=true` onto them would put an unbounded scan behind the same
 * cache key the dashboard hits every 30 seconds. These are separate methods
 * with separate routes for that reason.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LEDGER CONVENTION, SHARED BY BOTH STATEMENTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Both statements emit the same row shape so one renderer can print either:
 *
 *     debit   raises the running balance
 *     credit  lowers it
 *     balance running total, oldest entry first
 *
 * What the balance MEANS flips between the two, and that is the whole
 * difference:
 *
 *     customer statement → money owed TO the shop (receivable)
 *     supplier statement → money owed BY the shop (payable)
 *
 * So a sale is a customer debit and a purchase is a supplier debit; a
 * collection is a customer credit and a payment out is a supplier credit. Each
 * report's column headings say which, because "ডেবিট" alone is meaningless to
 * the person holding the paper.
 *
 * The closing balance of a statement run to today MUST equal the party's stored
 * `totalDue`. Both are returned (`closingBalance` and `recordedDue`) rather than
 * one being trusted: a gap means a write path updated one book and not the
 * other, and a statement that quietly hides that is worse than one that shows
 * it. Same reasoning as `customer.service.getCustomerLedger`.
 */

const oid = (id) => new mongoose.Types.ObjectId(String(id));

/** Hard ceiling on parties per statement run. A PDF past this is unreadable. */
const MAX_PARTIES = 500;
const DEFAULT_PARTIES = 200;

/**
 * Hard ceiling on documents pulled per collection for the in-range detail.
 * Reached only by a shop asking for years of history at once; the payload says
 * `truncated: true` so the report can print the warning rather than silently
 * showing a statement that does not add up.
 */
const MAX_ROWS_PER_COLLECTION = 20000;

const clampLimit = (value, fallback, max) => {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
};

/** Oldest first, ties broken so an opening line reads before the day's invoice. */
const ENTRY_RANK = {
  opening: 0, adjustment: 1, purchase: 2, sale: 3, return: 4, refund: 5, payment: 6,
};

function sortLedger(entries) {
  return entries.sort((a, b) => {
    const d = new Date(a.date) - new Date(b.date);
    return d !== 0 ? d : (ENTRY_RANK[a.type] ?? 9) - (ENTRY_RANK[b.type] ?? 9);
  });
}

/** Accumulate a running balance from `opening` over already-sorted entries. */
function applyRunningBalance(entries, opening) {
  let balance = quantizeMoney(opening);
  for (const e of entries) {
    balance = quantizeMoney(balance + (e.debit || 0) - (e.credit || 0));
    e.balance = balance;
  }
  return balance;
}

/** Sum a numeric key over rows. */
const sumBy = (rows, key) => quantizeMoney(rows.reduce((acc, r) => acc + (r[key] || 0), 0));

class DetailedReportService {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. CUSTOMER STATEMENT OF ACCOUNT
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Per-customer statements: opening balance, every movement in the window,
   * closing balance.
   *
   * Runs in a fixed number of queries regardless of how many customers are in
   * scope — the opening balances are four grouped aggregations over history,
   * and the detail is four range-bounded finds. A per-customer loop would be
   * `4 × N` round trips, which is how a 200-customer statement becomes a
   * timeout.
   *
   * @param {string} shopId
   * @param {object} options startDate, endDate, customerId, withDueOnly,
   *                         includeEmpty, limit
   * @param {object} req     carries branch scope
   */
  async getCustomerStatements(shopId, options = {}, req = null) {
    const {
      startDate,
      endDate,
      customerId = null,
      withDueOnly = false,
      includeEmpty = false,
    } = options;

    const limit = clampLimit(options.limit, DEFAULT_PARTIES, MAX_PARTIES);

    // Same visibility rule as every other customer read: shop-wide under shared
    // books, this branch's ledger under separate ones. A statement that ignored
    // it would hand one branch another branch's receivables.
    const branchScoped = isBranchCustomerScope(req);
    const branchId = branchScoped ? req.branchId : null;

    const parties = await this._selectCustomers(shopId, {
      branchId, customerId, withDueOnly, limit,
    });

    if (parties.length === 0) {
      return this._emptyStatement({ startDate, endDate, branchId, kind: 'customer' });
    }

    const ids = parties.map((p) => oid(p._id));
    const range = buildDateMatch(startDate, endDate);
    const rangeStart = range?.$gte || null;

    const scope = { shop: oid(shopId), customer: { $in: ids } };
    if (branchId) scope.branch = oid(branchId);

    const [openings, entriesByCustomer] = await Promise.all([
      this._customerOpeningBalances(scope, rangeStart),
      this._customerRangeEntries(scope, range),
    ]);

    const statements = [];
    for (const party of parties) {
      const key = String(party._id);
      const opening = openings.get(key) || 0;
      const entries = sortLedger(entriesByCustomer.get(key) || []);
      const closing = applyRunningBalance(entries, opening);

      // A customer with no movement and nothing outstanding contributes a
      // heading and a blank table — pure paper. Kept only on request.
      if (!includeEmpty && entries.length === 0 && opening === 0 && closing === 0) continue;

      statements.push({
        party: {
          _id: key,
          name: party.name,
          phone: party.phone || null,
          address: party.address || null,
          openingDue: party.openingDue || 0,
        },
        openingBalance: quantizeMoney(opening),
        entries,
        totals: {
          debit: sumBy(entries, 'debit'),
          credit: sumBy(entries, 'credit'),
          entryCount: entries.length,
          closingBalance: quantizeMoney(closing),
          // What the customer document says is owed right now. Equal to
          // `closingBalance` when the statement runs to today; deliberately
          // surfaced so a mismatch is visible rather than silently reconciled.
          recordedDue: party.totalDue || 0,
        },
      });
    }

    return {
      kind: 'customer',
      period: { startDate: startDate || null, endDate: endDate || null },
      scope: { branchId: branchId ? String(branchId) : null, branchScoped },
      statements,
      summary: {
        partyCount: statements.length,
        openingBalance: sumBy(statements, 'openingBalance'),
        totalDebit: quantizeMoney(statements.reduce((a, s) => a + s.totals.debit, 0)),
        totalCredit: quantizeMoney(statements.reduce((a, s) => a + s.totals.credit, 0)),
        closingBalance: quantizeMoney(statements.reduce((a, s) => a + s.totals.closingBalance, 0)),
      },
      truncated: parties.length >= limit,
    };
  }

  /** The customers a statement run covers, name-ordered so the PDF reads. */
  async _selectCustomers(shopId, { branchId, customerId, withDueOnly, limit }) {
    const fields = 'name phone address totalDue totalPaid totalPurchases openingDue';

    if (customerId) {
      const one = await Customer.findOne({ _id: customerId, shop: shopId })
        .select(fields)
        .lean();
      if (!one) return [];
      if (!branchId) return [one];

      // Under separate books the figures on the statement must be the branch's,
      // exactly as the customer's own page shows them.
      const row = await CustomerBalance.findOne({
        shop: shopId, customer: customerId, branch: branchId,
      }).lean();
      if (!row) return [];
      return [{ ...one, totalDue: row.totalDue || 0, openingDue: row.openingDue || 0 }];
    }

    if (branchId) {
      return CustomerBalance.aggregate([
        {
          $match: {
            shop: oid(shopId),
            branch: oid(branchId),
            ...(withDueOnly ? { totalDue: { $gt: 0 } } : {}),
          },
        },
        { $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: 'c' } },
        { $unwind: '$c' },
        { $match: { 'c.isActive': true } },
        {
          $project: {
            _id: '$c._id',
            name: '$c.name',
            phone: '$c.phone',
            address: '$c.address',
            totalDue: 1,
            totalPaid: 1,
            totalPurchases: 1,
            openingDue: 1,
          },
        },
        { $sort: { name: 1 } },
        { $limit: limit },
      ]);
    }

    return Customer.find({
      shop: shopId,
      isActive: true,
      ...(withDueOnly ? { totalDue: { $gt: 0 } } : {}),
    })
      .select(fields)
      .sort({ name: 1 })
      .limit(limit)
      .lean();
  }

  /**
   * Balance carried into the window, per customer.
   *
   * Four grouped aggregations rather than four document fetches: the history
   * before a statement window can be years long, and nothing about it is
   * printed — only its net effect on the opening line.
   *
   * Returns an empty map when the window is open-ended at the start, which is
   * correct: with no `startDate` the whole history IS the window and every row
   * is printed, so the opening line is zero for everyone.
   */
  async _customerOpeningBalances(scope, rangeStart) {
    const balances = new Map();
    if (!rangeStart) return balances;

    const before = { $lt: rangeStart };
    const add = (id, amount) => {
      const key = String(id);
      balances.set(key, quantizeMoney((balances.get(key) || 0) + amount));
    };

    const [sales, payments, adjustments, returns] = await Promise.all([
      Sale.aggregate([
        { $match: { ...scope, status: { $ne: 'cancelled' }, createdAt: before } },
        { $group: { _id: '$customer', total: { $sum: '$total' } } },
      ]),
      Payment.aggregate([
        // Effective date throughout this file — a backdated বাকি আদায় has to
        // land on the same side of the statement's opening line as it does in
        // the খতিয়ান, or the opening balance and the entries disagree by
        // exactly that payment.
        { $match: { ...scope, ...paidAtMatch(before) } },
        {
          $group: {
            _id: '$customer',
            // A refund hands cash back, which REVERSES the credit the customer
            // got for paying — so it moves the balance the other way. Signed
            // here so the two never need separating downstream.
            total: {
              $sum: {
                $cond: [
                  { $eq: ['$type', PAYMENT_TYPES.REFUND] },
                  '$amount',
                  { $multiply: ['$amount', -1] },
                ],
              },
            },
          },
        },
      ]),
      DueAdjustment.aggregate([
        { $match: { ...scope, createdAt: before } },
        { $group: { _id: '$customer', total: { $sum: '$amount' } } },
      ]),
      SalesReturn.aggregate([
        { $match: { ...scope, refundStatus: 'settled' } },
        // Settled-later returns are dated by settlement, matching
        // `getCustomerLedger` — the credit lands when the money did, not when
        // the goods were handed over.
        { $addFields: { effectiveDate: { $ifNull: ['$settledAt', '$createdAt'] } } },
        { $match: { effectiveDate: before } },
        { $group: { _id: '$customer', total: { $sum: '$totalAmount' } } },
      ]),
    ]);

    for (const r of sales) add(r._id, r.total);
    for (const r of payments) add(r._id, r.total);
    for (const r of adjustments) add(r._id, r.total);
    for (const r of returns) add(r._id, -r.total);

    return balances;
  }

  /**
   * Every printable movement inside the window, bucketed by customer.
   *
   * The entry shapes mirror `customer.service.getCustomerLedger` exactly,
   * including the two-line treatment of a cash return (goods back = credit,
   * cash out = debit, and they cancel). Diverging here would give a customer a
   * statement whose closing balance disagrees with the খতিয়ান tab they can open
   * on the same screen.
   */
  async _customerRangeEntries(scope, range) {
    const dated = range ? { createdAt: range } : {};

    const [sales, payments, adjustments, returns] = await Promise.all([
      Sale.find({ ...scope, status: { $ne: 'cancelled' }, ...dated })
        .select('customer invoiceNo total createdAt')
        .sort({ createdAt: 1 })
        .limit(MAX_ROWS_PER_COLLECTION)
        .lean(),
      Payment.find({ ...scope, ...paidAtMatch(range) })
        .select('customer amount method type notes createdAt paidAt')
        .sort({ createdAt: 1 })
        .limit(MAX_ROWS_PER_COLLECTION)
        .lean(),
      DueAdjustment.find({ ...scope, ...dated })
        .select('customer amount kind note createdAt')
        .sort({ createdAt: 1 })
        .limit(MAX_ROWS_PER_COLLECTION)
        .lean(),
      SalesReturn.aggregate([
        { $match: { ...scope, refundStatus: 'settled' } },
        { $addFields: { effectiveDate: { $ifNull: ['$settledAt', '$createdAt'] } } },
        ...(range ? [{ $match: { effectiveDate: range } }] : []),
        { $sort: { effectiveDate: 1 } },
        { $limit: MAX_ROWS_PER_COLLECTION },
        {
          $project: {
            customer: 1, returnNo: 1, totalAmount: 1, refundMethod: 1, effectiveDate: 1,
          },
        },
      ]),
    ]);

    const byCustomer = new Map();
    const push = (customerId, entry) => {
      const key = String(customerId);
      if (!byCustomer.has(key)) byCustomer.set(key, []);
      byCustomer.get(key).push(entry);
    };

    for (const s of sales) {
      // The invoice total is the debit. Money taken at the till arrives as its
      // own Payment row, so crediting `paid` here too would credit it twice.
      push(s.customer, {
        type: 'sale',
        date: s.createdAt,
        label: `ইনভয়েস ${s.invoiceNo}`,
        ref: s.invoiceNo,
        debit: s.total || 0,
        credit: 0,
      });
    }

    for (const r of returns) {
      push(r.customer, {
        type: 'return',
        date: r.effectiveDate,
        label: `মাল ফেরত ${r.returnNo}`,
        ref: r.returnNo,
        debit: 0,
        credit: r.totalAmount || 0,
      });
    }

    for (const p of payments) {
      const isRefund = p.type === PAYMENT_TYPES.REFUND;
      push(p.customer, {
        type: isRefund ? 'refund' : 'payment',
        date: p.paidAt || p.createdAt,
        label: isRefund
          ? 'ফেরত (নগদ প্রদান)'
          : (p.type === PAYMENT_TYPES.DUE_COLLECTION ? 'বাকি আদায়' : 'পেমেন্ট'),
        method: p.method || null,
        note: p.notes || null,
        debit: isRefund ? (p.amount || 0) : 0,
        credit: isRefund ? 0 : (p.amount || 0),
      });
    }

    for (const a of adjustments) {
      push(a.customer, {
        type: a.kind === 'opening' ? 'opening' : 'adjustment',
        date: a.createdAt,
        label: a.kind === 'opening' ? 'পূর্বের বাকি (খাতা থেকে)' : 'বাকি সমন্বয়',
        note: a.note || null,
        debit: a.amount > 0 ? a.amount : 0,
        credit: a.amount < 0 ? -a.amount : 0,
      });
    }

    return byCustomer;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. SUPPLIER STATEMENT OF ACCOUNT
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Per-supplier statements. Same shape as the customer one, opposite sign:
   * `balance` is what the shop OWES.
   *
   * ── The one modelling decision worth knowing ────────────────────────────────
   *
   * A purchase records `paid` on the document itself, and `recordPayment` later
   * writes `Payment` rows against it. There is NO Payment row for money handed
   * over at the counter when the goods arrived — `createPurchase` only sets
   * `paid`. So the amount settled on the spot is
   *
   *     paidAtPurchase = purchase.paid − Σ(Payment rows for that purchase)
   *
   * and the statement prints it as a same-day credit under the bill. Without
   * that line a shop that pays cash on delivery gets a statement claiming it
   * owes for every delivery it ever settled.
   */
  async getSupplierStatements(shopId, options = {}, req = null) {
    const {
      startDate,
      endDate,
      supplierId = null,
      withDueOnly = false,
      includeEmpty = false,
    } = options;

    const limit = clampLimit(options.limit, DEFAULT_PARTIES, MAX_PARTIES);

    // Suppliers are shop-wide by design (every branch buys from the same
    // vendors) — it is the MONEY that follows the active branch. Same rule
    // `supplier.service.getSuppliers` applies, so the statement and the
    // supplier page cannot show different figures.
    const branchId = req?.branchId || null;

    const parties = await this._selectSuppliers(shopId, {
      branchId, supplierId, withDueOnly, limit,
    });

    if (parties.length === 0) {
      return this._emptyStatement({ startDate, endDate, branchId, kind: 'supplier' });
    }

    const ids = parties.map((p) => oid(p._id));
    const range = buildDateMatch(startDate, endDate);
    const rangeStart = range?.$gte || null;

    const purchaseScope = { shop: oid(shopId), supplier: { $in: ids }, status: { $ne: 'cancelled' } };
    if (branchId) purchaseScope.branch = oid(branchId);

    const paymentScope = { shop: oid(shopId), type: PAYMENT_TYPES.PURCHASE_PAYMENT };
    if (branchId) paymentScope.branch = oid(branchId);

    const adjustmentScope = { shop: oid(shopId), supplier: { $in: ids } };
    if (branchId) adjustmentScope.branch = oid(branchId);

    const [openings, entriesBySupplier] = await Promise.all([
      this._supplierOpeningBalances({ purchaseScope, paymentScope, adjustmentScope, ids, rangeStart }),
      this._supplierRangeEntries({ purchaseScope, paymentScope, adjustmentScope, ids, range }),
    ]);

    const statements = [];
    for (const party of parties) {
      const key = String(party._id);
      const opening = openings.get(key) || 0;
      const entries = sortLedger(entriesBySupplier.get(key) || []);
      const closing = applyRunningBalance(entries, opening);

      if (!includeEmpty && entries.length === 0 && opening === 0 && closing === 0) continue;

      statements.push({
        party: {
          _id: key,
          name: party.name,
          companyName: party.companyName || null,
          phone: party.phone || null,
          address: party.address || null,
          openingDue: party.openingDue || 0,
        },
        openingBalance: quantizeMoney(opening),
        entries,
        totals: {
          debit: sumBy(entries, 'debit'),
          credit: sumBy(entries, 'credit'),
          entryCount: entries.length,
          closingBalance: quantizeMoney(closing),
          recordedDue: party.totalDue || 0,
        },
      });
    }

    return {
      kind: 'supplier',
      period: { startDate: startDate || null, endDate: endDate || null },
      scope: { branchId: branchId ? String(branchId) : null, branchScoped: Boolean(branchId) },
      statements,
      summary: {
        partyCount: statements.length,
        openingBalance: sumBy(statements, 'openingBalance'),
        totalDebit: quantizeMoney(statements.reduce((a, s) => a + s.totals.debit, 0)),
        totalCredit: quantizeMoney(statements.reduce((a, s) => a + s.totals.credit, 0)),
        closingBalance: quantizeMoney(statements.reduce((a, s) => a + s.totals.closingBalance, 0)),
      },
      truncated: parties.length >= limit,
    };
  }

  async _selectSuppliers(shopId, { branchId, supplierId, withDueOnly, limit }) {
    const fields = 'name companyName phone address totalDue totalAmount openingDue';

    const query = { shop: shopId, isActive: true };
    if (supplierId) query._id = supplierId;

    // ── The due filter narrows the QUERY, never the fetched page ──────────────
    //
    // Filtering `withDueOnly` in JS after fetching `limit` name-ordered
    // suppliers looks equivalent and is not: a shop with more vendors than the
    // cap would get "the vendors we owe" computed from the alphabetically first
    // 200, silently omitting every debt from S onwards. The set has to be
    // narrowed before the cap is applied.
    //
    // Which COLUMN counts as "owed" depends on the active branch, because that
    // is the figure the supplier list is showing: with a branch selected the
    // ids come from that branch's ledger rows, otherwise from the shop-wide
    // rollup.
    if (withDueOnly && !supplierId) {
      if (branchId) {
        const owed = await SupplierBalance.find({
          shop: shopId, branch: branchId, totalDue: { $gt: 0 },
        }).select('supplier').lean();
        if (owed.length === 0) return [];
        query._id = { $in: owed.map((row) => row.supplier) };
      } else {
        query.totalDue = { $gt: 0 };
      }
    }

    const suppliers = await Supplier.find(query)
      .select(fields)
      .sort({ name: 1 })
      .limit(supplierId ? 1 : limit)
      .lean();

    // `overlayBranchFigures` is the sanctioned way to put a branch's money on a
    // shop-wide supplier row — reused rather than re-derived so the statement
    // and the supplier list cannot show different figures for the same vendor.
    if (branchId && suppliers.length > 0) {
      return SupplierBalance.overlayBranchFigures(suppliers, shopId, branchId);
    }

    return suppliers;
  }

  /**
   * Payable carried into the window, per supplier.
   *
   * Not simply `Σ purchase.due`: `due` reflects every payment ever made,
   * including ones after the window opened. The window's opening line needs the
   * bill less only what had been paid BY then, so the bills, the on-the-spot
   * settlements and the later payment rows are counted separately.
   *
   * Known edge: a purchase whose `date` is backdated to after a payment already
   * recorded against it would land its bill outside the pre-window group while
   * the payment stays inside it. That requires editing a purchase date
   * backwards past its own payment, which no screen offers.
   */
  async _supplierOpeningBalances({ purchaseScope, paymentScope, adjustmentScope, ids, rangeStart }) {
    const balances = new Map();
    if (!rangeStart) return balances;

    const before = { $lt: rangeStart };
    const add = (id, amount) => {
      const key = String(id);
      balances.set(key, quantizeMoney((balances.get(key) || 0) + amount));
    };

    const [bills, payments, adjustments] = await Promise.all([
      Purchase.aggregate([
        { $match: { ...purchaseScope, date: before } },
        {
          $lookup: {
            from: 'payments',
            localField: '_id',
            foreignField: 'purchase',
            as: 'laterPayments',
          },
        },
        {
          $group: {
            _id: '$supplier',
            billed: { $sum: '$totalAmount' },
            // See the block comment on `getSupplierStatements`: what was handed
            // over when the goods arrived is `paid` minus everything the
            // payment ledger has since added.
            paidAtPurchase: {
              $sum: {
                $subtract: [
                  { $ifNull: ['$paid', 0] },
                  { $sum: '$laterPayments.amount' },
                ],
              },
            },
          },
        },
      ]),
      Payment.aggregate([
        { $match: { ...paymentScope, ...paidAtMatch(before) } },
        { $lookup: { from: 'purchases', localField: 'purchase', foreignField: '_id', as: 'p' } },
        { $unwind: '$p' },
        { $match: { 'p.supplier': { $in: ids } } },
        { $group: { _id: '$p.supplier', total: { $sum: '$amount' } } },
      ]),
      SupplierDueAdjustment.aggregate([
        { $match: { ...adjustmentScope, createdAt: before } },
        { $group: { _id: '$supplier', total: { $sum: '$amount' } } },
      ]),
    ]);

    for (const r of bills) add(r._id, (r.billed || 0) - (r.paidAtPurchase || 0));
    for (const r of payments) add(r._id, -r.total);
    for (const r of adjustments) add(r._id, r.total);

    return balances;
  }

  async _supplierRangeEntries({ purchaseScope, paymentScope, adjustmentScope, ids, range }) {
    const [purchases, payments, adjustments] = await Promise.all([
      Purchase.aggregate([
        { $match: { ...purchaseScope, ...(range ? { date: range } : {}) } },
        { $sort: { date: 1 } },
        { $limit: MAX_ROWS_PER_COLLECTION },
        {
          $lookup: {
            from: 'payments',
            localField: '_id',
            foreignField: 'purchase',
            as: 'laterPayments',
          },
        },
        {
          $project: {
            supplier: 1,
            invoiceNo: 1,
            totalAmount: 1,
            date: 1,
            itemCount: { $size: { $ifNull: ['$items', []] } },
            paidAtPurchase: {
              $subtract: [{ $ifNull: ['$paid', 0] }, { $sum: '$laterPayments.amount' }],
            },
          },
        },
      ]),
      Payment.aggregate([
        { $match: { ...paymentScope, ...paidAtMatch(range) } },
        { $lookup: { from: 'purchases', localField: 'purchase', foreignField: '_id', as: 'p' } },
        { $unwind: '$p' },
        // The cap comes AFTER the supplier filter, deliberately. Capping first
        // would count purchase payments belonging to suppliers this run does
        // not cover against the same ceiling, and could drop every row that
        // actually belongs on the statement.
        { $match: { 'p.supplier': { $in: ids } } },
        { $sort: { createdAt: 1 } },
        { $limit: MAX_ROWS_PER_COLLECTION },
        {
          $project: {
            supplier: '$p.supplier',
            invoiceNo: '$p.invoiceNo',
            amount: 1,
            method: 1,
            notes: 1,
            createdAt: 1,
            paidAt: PAID_AT_EXPR,
          },
        },
      ]),
      SupplierDueAdjustment.find({ ...adjustmentScope, ...(range ? { createdAt: range } : {}) })
        .select('supplier amount kind note createdAt')
        .sort({ createdAt: 1 })
        .limit(MAX_ROWS_PER_COLLECTION)
        .lean(),
    ]);

    const bySupplier = new Map();
    const push = (supplierId, entry) => {
      const key = String(supplierId);
      if (!bySupplier.has(key)) bySupplier.set(key, []);
      bySupplier.get(key).push(entry);
    };

    for (const p of purchases) {
      push(p.supplier, {
        type: 'purchase',
        date: p.date,
        label: `ক্রয় ${p.invoiceNo}`,
        ref: p.invoiceNo,
        itemCount: p.itemCount || 0,
        debit: p.totalAmount || 0,
        credit: 0,
      });

      // The cash-on-delivery leg. Same date as the bill and ranked after it, so
      // the pair reads "বিল ৫,০০০ / সাথে সাথে দিলাম ২,০০০" down the page.
      const atPurchase = quantizeMoney(p.paidAtPurchase || 0);
      if (atPurchase > 0) {
        push(p.supplier, {
          type: 'payment',
          date: p.date,
          label: `ক্রয়ের সময় পরিশোধ (${p.invoiceNo})`,
          ref: p.invoiceNo,
          debit: 0,
          credit: atPurchase,
        });
      }
    }

    for (const q of payments) {
      push(q.supplier, {
        type: 'payment',
        date: q.paidAt || q.createdAt,
        label: q.invoiceNo ? `পরিশোধ (${q.invoiceNo})` : 'পরিশোধ',
        ref: q.invoiceNo || null,
        method: q.method || null,
        note: q.notes || null,
        debit: 0,
        credit: q.amount || 0,
      });
    }

    for (const a of adjustments) {
      push(a.supplier, {
        type: a.kind === 'opening' ? 'opening' : 'adjustment',
        date: a.createdAt,
        label: a.kind === 'opening' ? 'পূর্বের দেনা (খাতা থেকে)' : 'দেনা সমন্বয়',
        note: a.note || null,
        debit: a.amount > 0 ? a.amount : 0,
        credit: a.amount < 0 ? -a.amount : 0,
      });
    }

    return bySupplier;
  }

  _emptyStatement({ startDate, endDate, branchId, kind }) {
    return {
      kind,
      period: { startDate: startDate || null, endDate: endDate || null },
      scope: { branchId: branchId ? String(branchId) : null, branchScoped: Boolean(branchId) },
      statements: [],
      summary: {
        partyCount: 0,
        openingBalance: 0,
        totalDebit: 0,
        totalCredit: 0,
        closingBalance: 0,
      },
      truncated: false,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. STOCK VALUATION
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The whole catalogue, valued, with a per-category roll-up.
   *
   * ── Why the money columns are named the way they are ────────────────────────
   *
   * `buyingPrice`, `totalCost`, `totalBuyingValue` and `totalProfit` are the
   * exact key names `utils/dataSanitizer.util.js` strips for a user without
   * `products.view_cost` / `reports.view_profit`. Naming them anything else
   * (`costValue`, `potentialProfit`) would sail straight past the sanitiser and
   * hand a cashier the shop's margin on every line — the report is served
   * through `sanitizeReport` precisely so it cannot.
   *
   * ── Why the whole thing is one `$facet` ─────────────────────────────────────
   *
   * The rows are capped and the totals are not: a summary computed from the
   * capped page would report the value of the first 2000 products as the value
   * of the shop. `$facet` runs both off the same filtered stream, so the totals
   * cover everything the filter matched however many rows are printed.
   */
  async getStockReport(shopId, options = {}, req = null) {
    const {
      status = 'all',
      categoryId = null,
      brandId = null,
      search = '',
      sortBy = 'name',
      sortOrder = 'asc',
      includeInactive = false,
    } = options;

    const limit = clampLimit(options.limit, 2000, 10000);
    const branchId = req?.branchId || null;

    // Products are per-branch documents, so scope is shop plus optional branch —
    // the same `productScope` shape report.service.js uses.
    const match = { shop: oid(shopId), isDeleted: { $ne: true } };
    if (branchId) match.branch = oid(branchId);
    if (!includeInactive) match.isActive = true;
    if (categoryId) match.category = oid(categoryId);
    if (brandId) match.brand = oid(brandId);
    if (search) {
      const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      match.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { code: { $regex: escaped, $options: 'i' } },
        { barcode: { $regex: escaped, $options: 'i' } },
      ];
    }

    // A product with variants holds no stock of its own — the units sit on the
    // variants. Reading `$stock` for those would report every variant product
    // as out of stock, which is the bug the dashboard's inventory stats already
    // guard against; the same `$reduce` shape is used here on purpose.
    const variantAware = (field) => ({
      $cond: [
        { $eq: ['$hasVariants', true] },
        {
          $reduce: {
            input: { $ifNull: ['$variants', []] },
            initialValue: 0,
            in: {
              $add: [
                '$$value',
                {
                  $multiply: [
                    { $ifNull: ['$$this.stock', 0] },
                    { $ifNull: [`$$this.${field}`, { $ifNull: [`$${field}`, 0] }] },
                  ],
                },
              ],
            },
          },
        },
        { $multiply: [{ $ifNull: ['$stock', 0] }, { $ifNull: [`$${field}`, 0] }] },
      ],
    });

    const valuationStage = {
      $addFields: {
        effectiveStock: {
          $cond: [
            { $eq: ['$hasVariants', true] },
            { $sum: { $ifNull: ['$variants.stock', []] } },
            { $ifNull: ['$stock', 0] },
          ],
        },
        totalCost: variantAware('buyingPrice'),
        totalRetail: variantAware('sellingPrice'),
      },
    };

    const statusStage = {
      all: null,
      out: { $match: { effectiveStock: { $lte: 0 } } },
      low: { $match: { $expr: { $and: [{ $gt: ['$effectiveStock', 0] }, { $lt: ['$effectiveStock', '$minStock'] }] } } },
      in: { $match: { effectiveStock: { $gt: 0 } } },
    }[status] || null;

    const sortField = { name: 'name', stock: 'effectiveStock', value: 'totalRetail', code: 'code' }[sortBy] || 'name';
    const sortDir = sortOrder === 'desc' ? -1 : 1;

    const [result] = await Product.aggregate([
      { $match: match },
      valuationStage,
      ...(statusStage ? [statusStage] : []),
      {
        $facet: {
          rows: [
            { $sort: { [sortField]: sortDir, _id: 1 } },
            { $limit: limit },
            { $lookup: { from: 'categories', localField: 'category', foreignField: '_id', as: 'cat' } },
            { $lookup: { from: 'brands', localField: 'brand', foreignField: '_id', as: 'brnd' } },
            {
              $project: {
                _id: 1,
                name: 1,
                code: 1,
                barcode: 1,
                unit: 1,
                categoryName: { $ifNull: [{ $arrayElemAt: ['$cat.name', 0] }, null] },
                brandName: { $ifNull: [{ $arrayElemAt: ['$brnd.name', 0] }, null] },
                stock: '$effectiveStock',
                minStock: { $ifNull: ['$minStock', 0] },
                hasVariants: { $ifNull: ['$hasVariants', false] },
                variantCount: { $size: { $ifNull: ['$variants', []] } },
                buyingPrice: { $ifNull: ['$buyingPrice', 0] },
                sellingPrice: { $ifNull: ['$sellingPrice', 0] },
                totalCost: { $round: ['$totalCost', 2] },
                totalRetail: { $round: ['$totalRetail', 2] },
                isActive: 1,
                lastSold: 1,
                totalSold: { $ifNull: ['$totalSold', 0] },
                stockStatus: {
                  $switch: {
                    branches: [
                      { case: { $lte: ['$effectiveStock', 0] }, then: 'out' },
                      { case: { $lt: ['$effectiveStock', '$minStock'] }, then: 'low' },
                    ],
                    default: 'ok',
                  },
                },
              },
            },
          ],
          summary: [
            {
              $group: {
                _id: null,
                totalProducts: { $sum: 1 },
                totalUnits: { $sum: '$effectiveStock' },
                totalBuyingValue: { $sum: '$totalCost' },
                totalRetailValue: { $sum: '$totalRetail' },
                lowStockCount: {
                  $sum: {
                    $cond: [
                      { $and: [{ $gt: ['$effectiveStock', 0] }, { $lt: ['$effectiveStock', '$minStock'] }] },
                      1, 0,
                    ],
                  },
                },
                outOfStockCount: { $sum: { $cond: [{ $lte: ['$effectiveStock', 0] }, 1, 0] } },
              },
            },
          ],
          byCategory: [
            {
              $group: {
                _id: '$category',
                productCount: { $sum: 1 },
                totalUnits: { $sum: '$effectiveStock' },
                totalBuyingValue: { $sum: '$totalCost' },
                totalRetailValue: { $sum: '$totalRetail' },
              },
            },
            { $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'cat' } },
            {
              $project: {
                _id: 1,
                categoryName: { $ifNull: [{ $arrayElemAt: ['$cat.name', 0] }, 'অন্যান্য'] },
                productCount: 1,
                totalUnits: { $round: ['$totalUnits', 3] },
                totalBuyingValue: { $round: ['$totalBuyingValue', 2] },
                totalRetailValue: { $round: ['$totalRetailValue', 2] },
              },
            },
            { $sort: { totalRetailValue: -1 } },
          ],
        },
      },
    ]);

    const rows = result?.rows || [];
    const raw = result?.summary?.[0] || {};
    const totalBuyingValue = quantizeMoney(raw.totalBuyingValue || 0);
    const totalRetailValue = quantizeMoney(raw.totalRetailValue || 0);

    return {
      kind: 'stock',
      filters: {
        status, categoryId, brandId, search: search || null, sortBy, sortOrder, includeInactive,
      },
      scope: { branchId: branchId ? String(branchId) : null },
      rows,
      byCategory: result?.byCategory || [],
      summary: {
        totalProducts: raw.totalProducts || 0,
        totalUnits: Math.round((raw.totalUnits || 0) * 1000) / 1000,
        totalBuyingValue,
        totalRetailValue,
        // Margin locked up in stock — what the shelves would earn if everything
        // sold at list. Named `totalProfit` so the sanitiser strips it for a
        // user without profit rights, alongside the cost figure it is derived
        // from.
        totalProfit: quantizeMoney(totalRetailValue - totalBuyingValue),
        lowStockCount: raw.lowStockCount || 0,
        outOfStockCount: raw.outOfStockCount || 0,
      },
      truncated: rows.length >= limit,
    };
  }
}

module.exports = new DetailedReportService();
