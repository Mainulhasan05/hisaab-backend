const mongoose = require('mongoose');
const Sale = require('../models/Sale.model');
const SalesReturn = require('../models/SalesReturn.model');
const Product = require('../models/Product.model');
const User = require('../models/User.model');
const Branch = require('../models/Branch.model');
const { quantizeMoney } = require('../utils/quantity.util');
const { baseMatch, buildDateMatch, roundReportQty } = require('../utils/reportScope.util');

/**
 * পণ্যভিত্তিক বিক্রি — every sale LINE of a product, one row each.
 *
 * ── The question it answers ──────────────────────────────────────────────────
 *
 * "এই পণ্যটা কবে, কে, কার কাছে, কত দামে বিক্রি করেছে?" Nothing else in the app
 * answered it. The product report groups by product; the staff report groups by
 * staff × day × product and averages the price away; the stock history has the
 * date and the staff but no invoice, no customer and no discount. Each held a
 * piece, none held the line.
 *
 * ── What a row is ────────────────────────────────────────────────────────────
 *
 * One `Sale.items[]` entry, carrying its bill's date, invoice, seller, customer
 * and branch. The price is shown the way the invoice shows it — the list rate
 * (`unitPrice`), the negotiated rate when there was one (`agreedUnitPrice`), the
 * concession in taka (`discount`) and the line total — never re-derived.
 *
 * ── Totals ───────────────────────────────────────────────────────────────────
 *
 * A cancelled sale is LISTED, so the trail is complete, and EXCLUDED from every
 * total — the same rule every register in the app follows. Returns are reported
 * beside the sales (quantity and taka that came back against these lines), not
 * netted into them, so a return never quietly shrinks the day it was sold on.
 *
 * Line totals are before the bill-level discount. That is the figure printed on
 * the invoice's line, and pro-rating a bill discount onto one product would
 * invent a per-line number no document carries.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 *
 * `branchId` goes through `baseMatch`, which casts (I-3). Cost and profit ride
 * under `buyingPrice` / `totalCost` / `profit` / `totalProfit` so the
 * controller's `sanitizeReport` strips them per user without being taught this
 * report exists.
 */

const DEFAULT_LIMIT = 50;
// A download re-fetches page by page at this size; the screen never asks for it.
const MAX_LIMIT = 500;

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A single valid ObjectId, or null. Malformed ids are ignored, never a 500. */
function toObjectId(value) {
  if (!value) return null;
  const s = String(value).trim();
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

function toInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

class ProductSalesService {
  /**
   * The Sale-level match and the line-level match, from the query string.
   *
   * Both halves matter. The Sale match narrows BILLS before the `$unwind` (and
   * uses `{shop, items.product, createdAt}`); the line match then keeps only the
   * lines of the product asked for — a bill that sold rice and oil must produce
   * one rice row, not two.
   */
  _scope(shopId, query = {}, branchId = null) {
    const sale = baseMatch(shopId, branchId);
    const line = {};

    const dateMatch = buildDateMatch(query.startDate, query.endDate);
    if (dateMatch) sale.createdAt = dateMatch;

    const productId = toObjectId(query.productId);
    if (productId) {
      sale['items.product'] = productId;
      line['items.product'] = productId;
    }
    const variantId = toObjectId(query.variantId);
    if (variantId) line['items.variantId'] = variantId;

    const staffId = toObjectId(query.staffId);
    if (staffId) sale.createdBy = staffId;

    const customerId = toObjectId(query.customerId);
    if (customerId) sale.customer = customerId;

    if (query.status === 'cancelled') sale.status = 'cancelled';
    else if (query.status === 'active') sale.status = { $ne: 'cancelled' };

    const term = typeof query.search === 'string' ? query.search.trim() : '';
    if (term) {
      const rx = { $regex: escapeRegex(term), $options: 'i' };
      // After the unwind, so "কোক" finds the Coke lines rather than every line
      // of every bill that contained a Coke.
      line.$or = [
        { invoiceNo: rx },
        { customerName: rx },
        { customerPhone: rx },
        { 'items.productName': rx },
        { 'items.productCode': rx },
        { 'items.variantSku': rx },
      ];
    }

    return { sale, line, productId, variantId };
  }

  async getProductSales(shopId, query = {}, branchId = null) {
    const page = toInt(query.page, 1);
    const limit = toInt(query.limit, DEFAULT_LIMIT, { max: MAX_LIMIT });
    const { sale, line, productId } = this._scope(shopId, query, branchId);

    const lineStages = [
      { $match: sale },
      { $unwind: '$items' },
      ...(Object.keys(line).length ? [{ $match: line }] : []),
    ];

    const notCancelled = { $ne: ['$status', 'cancelled'] };
    const whenLive = (expr) => ({ $cond: [notCancelled, expr, 0] });

    const [result] = await Sale.aggregate([
      ...lineStages,
      {
        $facet: {
          rows: [
            { $sort: { createdAt: -1, _id: -1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                _id: 0,
                lineId: '$items._id',
                saleId: '$_id',
                invoiceNo: 1,
                date: '$createdAt',
                status: 1,
                branch: 1,
                staffId: '$createdBy',
                customerId: '$customer',
                customerName: 1,
                customerPhone: 1,
                productId: '$items.product',
                productName: '$items.productName',
                productCode: '$items.productCode',
                variantId: '$items.variantId',
                variantSku: '$items.variantSku',
                variantAttributes: '$items.variantAttributes',
                unit: '$items.unit',
                saleUnit: '$items.saleUnit',
                packUnit: '$items.packUnit',
                packQuantity: '$items.packQuantity',
                quantity: '$items.quantity',
                unitPrice: '$items.unitPrice',
                agreedUnitPrice: '$items.agreedUnitPrice',
                discount: { $ifNull: ['$items.discount', 0] },
                total: '$items.total',
                buyingPrice: '$items.buyingPrice',
                priceTier: 1,
              },
            },
          ],
          summary: [
            {
              $group: {
                _id: null,
                lineCount: { $sum: 1 },
                cancelledLines: { $sum: { $cond: [notCancelled, 0, 1] } },
                bills: { $addToSet: { $cond: [notCancelled, '$_id', null] } },
                customers: { $addToSet: { $cond: [notCancelled, '$customer', null] } },
                quantity: { $sum: whenLive('$items.quantity') },
                grossAmount: { $sum: whenLive({ $multiply: ['$items.unitPrice', '$items.quantity'] }) },
                discount: { $sum: whenLive({ $ifNull: ['$items.discount', 0] }) },
                totalAmount: { $sum: whenLive('$items.total') },
                totalCost: {
                  $sum: whenLive({ $multiply: [{ $ifNull: ['$items.buyingPrice', 0] }, '$items.quantity'] }),
                },
                firstSale: { $min: '$createdAt' },
                lastSale: { $max: '$createdAt' },
              },
            },
          ],
        },
      },
    ]);

    const rawRows = result?.rows || [];
    const s = result?.summary?.[0] || null;
    const total = s?.lineCount || 0;

    // ── Who sold it, and where ────────────────────────────────────────────────
    // Looked up for the page only, not joined in the pipeline: fifty ids is one
    // indexed query, and a `$lookup` per line across a year of sales is not.
    const staffIds = [...new Set(rawRows.map((r) => String(r.staffId)).filter((id) => id && id !== 'undefined'))];
    const branchIds = [...new Set(rawRows.map((r) => r.branch && String(r.branch)).filter(Boolean))];

    const [staff, branches, returnsByLine] = await Promise.all([
      staffIds.length
        ? User.find({ _id: { $in: staffIds }, shop: shopId }).select('name').lean()
        : [],
      branchIds.length
        ? Branch.find({ _id: { $in: branchIds }, shop: shopId }).select('name code').lean()
        : [],
      this._returnsForLines(shopId, rawRows.map((r) => r.lineId).filter(Boolean)),
    ]);
    const staffMap = new Map(staff.map((u) => [String(u._id), u.name]));
    const branchMap = new Map(branches.map((b) => [String(b._id), b.name]));

    const rows = rawRows.map((r) => {
      const returned = returnsByLine.get(String(r.lineId));
      const cancelled = r.status === 'cancelled';
      const row = {
        ...r,
        staffName: staffMap.get(String(r.staffId)) || null,
        quantity: roundReportQty(r.quantity),
        total: quantizeMoney(r.total || 0),
        discount: quantizeMoney(r.discount || 0),
        totalCost: quantizeMoney((r.buyingPrice || 0) * (r.quantity || 0)),
        profit: cancelled ? 0 : quantizeMoney((r.total || 0) - (r.buyingPrice || 0) * (r.quantity || 0)),
        returnedQuantity: returned ? roundReportQty(returned.quantity) : 0,
        returnedAmount: returned ? quantizeMoney(returned.total) : 0,
      };
      // A single-branch shop's rows carry no branch keys at all (I-1).
      if (r.branch) row.branchName = branchMap.get(String(r.branch)) || null;
      else delete row.branch;
      return row;
    });

    let summary = null;
    if (s) {
      const returned = await this._returnsForScope(shopId, sale, line);
      const totalCost = quantizeMoney(s.totalCost);
      const totalAmount = quantizeMoney(s.totalAmount);
      summary = {
        lineCount: s.lineCount,
        cancelledLines: s.cancelledLines,
        billCount: s.bills.filter(Boolean).length,
        customerCount: s.customers.filter(Boolean).length,
        // A quantity sum across different products is kg plus pieces — only
        // meaningful, and only returned, when one product is in scope.
        quantity: productId ? roundReportQty(s.quantity) : null,
        grossAmount: quantizeMoney(s.grossAmount),
        discount: quantizeMoney(s.discount),
        totalAmount,
        totalCost,
        totalProfit: quantizeMoney(totalAmount - totalCost),
        returnedQuantity: productId ? roundReportQty(returned.quantity) : null,
        returnedAmount: quantizeMoney(returned.total),
        firstSale: s.firstSale,
        lastSale: s.lastSale,
      };
    }

    const [product, staffOptions] = await Promise.all([
      productId ? this._product(shopId, productId) : null,
      // The seller filter's options. Served here rather than from `/staff`
      // because `reports.view` does not imply `staff.view` — the same reason the
      // staff report carries its own roster.
      User.find({ shop: shopId }).select('name').sort({ name: 1 }).lean(),
    ]);

    return {
      rows,
      summary,
      product,
      staffOptions: staffOptions.map((u) => ({ _id: u._id, name: u.name })),
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /** Quantity and taka returned against each of these sale lines. */
  async _returnsForLines(shopId, lineIds) {
    if (!lineIds.length) return new Map();
    const rows = await SalesReturn.aggregate([
      { $match: { shop: new mongoose.Types.ObjectId(shopId), 'items.saleItemId': { $in: lineIds } } },
      { $unwind: '$items' },
      { $match: { 'items.saleItemId': { $in: lineIds } } },
      { $group: { _id: '$items.saleItemId', quantity: { $sum: '$items.quantity' }, total: { $sum: '$items.total' } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r]));
  }

  /**
   * Returns against every line in scope, for the summary.
   *
   * Scoped through the SALE (its date, seller, customer, branch), because a
   * return belongs to the line it came off: "what came back of what we sold in
   * August" is the question the summary beside August's sales is asking.
   */
  async _returnsForScope(shopId, sale, line) {
    const shop = new mongoose.Types.ObjectId(shopId);
    const saleMatch = { ...sale };
    delete saleMatch.shop;
    // The sale-level status filter is about which SALE rows to list; returns
    // against a cancelled sale are not part of any live total either way.
    saleMatch.status = { $ne: 'cancelled' };

    const itemMatch = {};
    if (line['items.product']) itemMatch['items.product'] = line['items.product'];
    if (line['items.variantId']) itemMatch['items.variantId'] = line['items.variantId'];

    const [row] = await SalesReturn.aggregate([
      { $match: { shop, ...(itemMatch['items.product'] ? { 'items.product': itemMatch['items.product'] } : {}) } },
      {
        $lookup: {
          from: Sale.collection.name,
          localField: 'sale',
          foreignField: '_id',
          as: '_sale',
          pipeline: [{ $match: { shop, ...saleMatch } }, { $project: { _id: 1 } }],
        },
      },
      { $match: { '_sale.0': { $exists: true } } },
      { $unwind: '$items' },
      ...(Object.keys(itemMatch).length ? [{ $match: itemMatch }] : []),
      { $group: { _id: null, quantity: { $sum: '$items.quantity' }, total: { $sum: '$items.total' } } },
    ]);
    return row || { quantity: 0, total: 0 };
  }

  /** The product in scope — for the page heading and the variant picker. */
  async _product(shopId, productId) {
    const p = await Product.findOne({ _id: productId, shop: shopId })
      .select('name code unit hasVariants variants._id variants.sku variants.attributes')
      .lean();
    if (!p) return null;
    return {
      _id: p._id,
      name: p.name,
      code: p.code,
      unit: p.unit,
      hasVariants: Boolean(p.hasVariants),
      variants: (p.variants || []).map((v) => ({ _id: v._id, sku: v.sku, attributes: v.attributes })),
    };
  }
}

module.exports = new ProductSalesService();
