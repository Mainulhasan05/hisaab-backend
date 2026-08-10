const mongoose = require('mongoose');
const Sale = require('../models/Sale.model');
const SalesReturn = require('../models/SalesReturn.model');
const Payment = require('../models/Payment.model');
const Product = require('../models/Product.model');
const User = require('../models/User.model');
const { quantizeMoney } = require('../utils/quantity.util');
const { PAYMENT_TYPES } = require('../config/constants');
const {
  baseMatch,
  buildDateMatch,
  netSaleAmountExpr,
  roundReportQty,
} = require('../utils/reportScope.util');

// Every date bucket in this report is a Bangladesh calendar day, not a UTC one.
const BD_TZ = '+06:00';

// A month of a busy shop's item lines lands well inside this. `truncated` in the
// response tells the caller when it did not, so the UI can say so out loud
// rather than quietly reporting a partial total as if it were the whole.
const DEFAULT_ROW_LIMIT = 1500;
const MAX_ROW_LIMIT = 5000;

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ignore malformed ids rather than letting a CastError become a 500. */
function toObjectIdList(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return raw
    .map((v) => String(v).trim())
    .filter((v) => mongoose.Types.ObjectId.isValid(v))
    .map((v) => new mongoose.Types.ObjectId(v));
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Staff / salesman-wise billing reports.
 *
 * ── The one rule that makes these numbers trustworthy ──────────────────────
 *
 * A bill carries three things that do not live on any of its lines: a
 * bill-level discount, tax/delivery, and whatever has since been returned
 * against it. The item-level report used to ignore all three — it summed
 * `items.total`, which is the SUBTOTAL. So a shop that gave any bill-level
 * discount saw one salesman's total differ between the summary tab and the
 * itemised tab, and neither matched the invoices.
 *
 * Every line here is therefore valued as its SHARE OF THE BILL:
 *
 *     share_i     = items.total_i / sum(items.total)
 *     netRevenue_i = share_i x (total - returnedAmount)
 *     netProfit_i  = share_i x profit
 *
 * Summed over a bill's lines that is exactly `netSaleAmountExpr()` and exactly
 * `Sale.profit` — the same two expressions the summary tab, the dashboard and
 * the P&L already use. So the itemised view reconciles with the summary view by
 * construction, for any combination of discount, tax and returns.
 *
 * `grossRevenue` (the raw `items.total`) is kept alongside so the UI can still
 * show the pre-discount sticker price.
 */
class StaffReportService {
  /**
   * Resolve every filter into a single Sale `$match`, plus the metadata the
   * callers need. Filters that reference another collection (role, category)
   * are pre-resolved to id lists here rather than joined per-document.
   */
  async _resolveScope(shopId, options = {}, branchId = null) {
    const {
      startDate,
      endDate,
      staffId,
      roleId,
      categoryId,
      productId,
      paymentMethod,
      channel,
      minAmount,
      search,
    } = options;

    const match = {
      ...baseMatch(shopId, branchId),
      status: { $ne: 'cancelled' },
    };

    const dateMatch = buildDateMatch(startDate, endDate);
    if (dateMatch) match.createdAt = dateMatch;

    // ── Who ────────────────────────────────────────────────────────────────
    let staffIds = toObjectIdList(staffId);

    // A role filter ("show me all cashiers") is a staff filter once resolved.
    const roleIds = toObjectIdList(roleId);
    if (roleIds.length) {
      const inRole = await User.find({ shop: shopId, role: { $in: roleIds } })
        .select('_id')
        .lean();
      const roleStaffIds = inRole.map((u) => u._id);
      staffIds = staffIds.length
        ? staffIds.filter((id) => roleStaffIds.some((r) => r.equals(id)))
        : roleStaffIds;
      // An explicit role filter that matches nobody must return nothing, not
      // everything — so fall through with an impossible id rather than leaving
      // `createdBy` unset.
      if (!staffIds.length) staffIds = [new mongoose.Types.ObjectId()];
    }

    if (staffIds.length) {
      match.createdBy = staffIds.length === 1 ? staffIds[0] : { $in: staffIds };
    }

    // ── What ───────────────────────────────────────────────────────────────
    let productIds = toObjectIdList(productId);
    const categoryIds = toObjectIdList(categoryId);
    if (categoryIds.length) {
      const scope = { shop: new mongoose.Types.ObjectId(shopId), isDeleted: { $ne: true }, category: { $in: categoryIds } };
      if (branchId) scope.branch = new mongoose.Types.ObjectId(branchId);
      const inCategory = await Product.find(scope).select('_id').lean();
      const categoryProductIds = inCategory.map((p) => p._id);
      productIds = productIds.length
        ? productIds.filter((id) => categoryProductIds.some((c) => c.equals(id)))
        : categoryProductIds;
      if (!productIds.length) productIds = [new mongoose.Types.ObjectId()];
    }

    // ── How ────────────────────────────────────────────────────────────────
    if (paymentMethod) match.paymentMethod = paymentMethod;
    if (channel) match.channel = channel;

    const min = toNumber(minAmount, 0);
    if (min > 0) match.total = { $gte: min };

    // ── Free text ──────────────────────────────────────────────────────────
    // Matched server-side against staff name, product name, invoice number and
    // the day string. This used to be a JS filter applied AFTER the whole range
    // had been aggregated and returned, which meant every keystroke re-ran the
    // full aggregation and then threw most of it away.
    let searchStaffIds = [];
    const term = typeof search === 'string' ? search.trim() : '';
    if (term) {
      const nameMatches = await User.find({ shop: shopId, name: { $regex: escapeRegex(term), $options: 'i' } })
        .select('_id')
        .lean();
      searchStaffIds = nameMatches.map((u) => u._id);
    }

    return {
      match,
      productIds,
      search: term,
      searchStaffIds,
      dateMatch,
      startDate: startDate || null,
      endDate: endDate || null,
    };
  }

  /**
   * Free-text search, in two halves.
   *
   * `bill` narrows the candidate bills before the `$unwind` — cheap, and it is
   * what makes searching an invoice number, a customer, a staff name or a day
   * work at all.
   *
   * `line` then runs AFTER the unwind, and exists because those two are not the
   * same question. Searching "কোক" should show the Coke lines, not every line
   * of every bill that happened to contain a Coke. But searching a salesman's
   * name must still show all of their lines. So each bill carries `_billMatch`
   * — did it match for a reason that was NOT a product name — and a line
   * survives if its bill matched for a non-product reason, or if the line
   * itself is the product being searched for.
   */
  _searchStages(scope) {
    if (!scope.search) return null;
    const pattern = escapeRegex(scope.search);
    const rx = { $regex: pattern, $options: 'i' };
    const rxMatch = (field) => ({
      $regexMatch: { input: { $ifNull: [field, ''] }, regex: pattern, options: 'i' },
    });

    const billOr = [
      { 'items.productName': rx },
      { 'items.productCode': rx },
      { invoiceNo: rx },
      { _date: rx },
      { customerName: rx },
    ];
    const nonProductOr = [rxMatch('$invoiceNo'), rxMatch('$customerName'), rxMatch('$_date')];

    if (scope.searchStaffIds.length) {
      billOr.push({ createdBy: { $in: scope.searchStaffIds } });
      nonProductOr.push({ $in: ['$createdBy', scope.searchStaffIds] });
    }

    return {
      bill: [
        { $match: { $or: billOr } },
        { $addFields: { _billMatch: { $or: nonProductOr } } },
      ],
      line: {
        $match: {
          $or: [
            { _billMatch: true },
            { 'items.productName': rx },
            { 'items.productCode': rx },
          ],
        },
      },
    };
  }

  /**
   * The shop's full staff roster, for the report's filter controls.
   *
   * Served from the report rather than `/staff` on purpose: a manager can hold
   * `reports.view` without `staff.view`, and a filter you cannot populate is a
   * filter you cannot use.
   */
  async _roster(shopId) {
    const users = await User.find({ shop: shopId })
      .select('name phone isOwner isActive role')
      .populate('role', 'name')
      .lean();

    return users
      .map((u) => ({
        staffId: u._id,
        name: u.name,
        phone: u.phone || null,
        roleName: u.isOwner ? 'Owner' : (u.role?.name || null),
        isOwner: u.isOwner === true,
        isActive: u.isActive !== false,
      }))
      // Sorted here rather than with `.sort()` on the query: the ordering is
      // presentational, and keeping the query chain to select/populate/lean
      // means it reads the same as every other identity lookup in this file.
      .sort((a, b) => (b.isOwner ? 1 : 0) - (a.isOwner ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  }

  /** Bill-level totals for a match, used for both the current and prior period. */
  async _periodTotals(match) {
    const [row] = await Sale.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalSales: { $sum: netSaleAmountExpr() },
          totalPaid: { $sum: '$paid' },
          totalDue: { $sum: '$due' },
          totalProfit: { $sum: '$profit' },
          totalReturned: { $sum: { $ifNull: ['$returnedAmount', 0] } },
          saleCount: { $sum: 1 },
        },
      },
    ]);

    return {
      totalSales: Math.round(row?.totalSales || 0),
      totalPaid: Math.round(row?.totalPaid || 0),
      totalDue: Math.round(row?.totalDue || 0),
      totalProfit: Math.round(row?.totalProfit || 0),
      totalReturned: Math.round(row?.totalReturned || 0),
      saleCount: row?.saleCount || 0,
      avgSale: row?.saleCount ? Math.round((row.totalSales || 0) / row.saleCount) : 0,
    };
  }

  /**
   * The immediately preceding window of the same length, for period-on-period
   * deltas. Returns null unless the caller gave a bounded range — "since the
   * beginning of time" has no previous period to compare against.
   */
  _previousRange(dateMatch) {
    if (!dateMatch?.$gte || !dateMatch?.$lte) return null;
    const start = dateMatch.$gte.getTime();
    const end = dateMatch.$lte.getTime();
    const span = end - start;
    if (!Number.isFinite(span) || span <= 0) return null;
    return {
      $gte: new Date(start - span - 1),
      $lte: new Date(start - 1),
    };
  }

  /**
   * Per-staff totals over a date range, plus the day-by-day series that drives
   * the trend chart and the staff x date heatmap.
   */
  async getSummary(shopId, options = {}, branchId = null) {
    const scope = await this._resolveScope(shopId, options, branchId);
    const { match } = scope;
    const wantsCompare = options.compare === true || options.compare === 'true' || options.compare === '1';

    // Returns are attributed to the staff member who MADE the sale, via the
    // sale's own `returnedAmount` — not to whoever happened to process the
    // return. "Ravi's net sales" must mean goods Ravi sold and kept sold.
    // `returnsProcessed` below is the separate, deliberately visible metric of
    // who is putting returns through the till.
    const [salesByStaff, returnsProcessed, dueByStaff, trendRows, roster] = await Promise.all([
      Sale.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$createdBy',
            totalSales: { $sum: netSaleAmountExpr() },
            totalPaid: { $sum: '$paid' },
            totalDue: { $sum: '$due' },
            totalProfit: { $sum: '$profit' },
            totalReturned: { $sum: { $ifNull: ['$returnedAmount', 0] } },
            returnedBillCount: {
              $sum: { $cond: [{ $gt: [{ $ifNull: ['$returnedAmount', 0] }, 0] }, 1, 0] },
            },
            saleCount: { $sum: 1 },
            totalItems: { $sum: { $size: { $ifNull: ['$items', []] } } },
            avgSale: { $avg: netSaleAmountExpr() },
            lastSaleAt: { $max: '$createdAt' },
            firstSaleAt: { $min: '$createdAt' },
            activeDays: {
              $addToSet: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: BD_TZ } },
            },
          },
        },
        { $sort: { totalSales: -1 } },
      ]),

      SalesReturn.aggregate([
        {
          $match: (() => {
            const m = { ...baseMatch(shopId, branchId) };
            if (scope.dateMatch) m.createdAt = scope.dateMatch;
            return m;
          })(),
        },
        {
          $group: {
            _id: '$createdBy',
            returnsProcessedAmount: { $sum: '$totalAmount' },
            returnsProcessedCount: { $sum: 1 },
          },
        },
      ]),

      // Money walked in against an old bill. `Payment.receivedBy` has always
      // recorded who took it; nothing reported it until now.
      Payment.aggregate([
        {
          $match: (() => {
            const m = { ...baseMatch(shopId, branchId), type: PAYMENT_TYPES.DUE_COLLECTION };
            if (scope.dateMatch) m.createdAt = scope.dateMatch;
            return m;
          })(),
        },
        {
          $group: {
            _id: '$receivedBy',
            dueCollected: { $sum: '$amount' },
            dueCollectionCount: { $sum: 1 },
          },
        },
      ]),

      Sale.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              staffId: '$createdBy',
              date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: BD_TZ } },
            },
            netSales: { $sum: netSaleAmountExpr() },
            profit: { $sum: '$profit' },
            saleCount: { $sum: 1 },
          },
        },
        { $sort: { '_id.date': 1 } },
      ]),

      this._roster(shopId),
    ]);

    const rosterMap = new Map(roster.map((r) => [String(r.staffId), r]));
    const returnsMap = new Map(returnsProcessed.map((r) => [String(r._id), r]));
    const dueMap = new Map(dueByStaff.map((d) => [String(d._id), d]));

    // Union of everyone who did anything: sold, refunded, or collected a due.
    // The old report mapped over sales alone, so a staff member who spent the
    // week collecting dues simply did not appear.
    const ids = new Set([
      ...salesByStaff.map((s) => String(s._id)),
      ...returnsProcessed.map((r) => String(r._id)),
      ...dueByStaff.map((d) => String(d._id)),
    ].filter((id) => id && id !== 'null' && id !== 'undefined'));

    const salesMap = new Map(salesByStaff.map((s) => [String(s._id), s]));

    const staff = Array.from(ids).map((id) => {
      const s = salesMap.get(id);
      const identity = rosterMap.get(id);
      const ret = returnsMap.get(id);
      const due = dueMap.get(id);

      return {
        staffId: id,
        name: identity?.name || 'অজানা',
        phone: identity?.phone || null,
        roleName: identity?.roleName || null,
        isOwner: identity?.isOwner === true,
        isActive: identity?.isActive !== false,
        totalSales: Math.round(s?.totalSales || 0),
        totalPaid: Math.round(s?.totalPaid || 0),
        totalDue: Math.round(s?.totalDue || 0),
        totalProfit: Math.round(s?.totalProfit || 0),
        totalReturned: Math.round(s?.totalReturned || 0),
        returnedBillCount: s?.returnedBillCount || 0,
        saleCount: s?.saleCount || 0,
        itemCount: s?.totalItems || 0,
        avgSale: Math.round(s?.avgSale || 0),
        lastSaleAt: s?.lastSaleAt || null,
        firstSaleAt: s?.firstSaleAt || null,
        activeDays: s?.activeDays?.length || 0,
        returnsProcessedAmount: Math.round(ret?.returnsProcessedAmount || 0),
        returnsProcessedCount: ret?.returnsProcessedCount || 0,
        dueCollected: Math.round(due?.dueCollected || 0),
        dueCollectionCount: due?.dueCollectionCount || 0,
      };
    });

    staff.sort((a, b) => b.totalSales - a.totalSales || b.totalProfit - a.totalProfit);

    const summary = staff.reduce(
      (acc, s) => {
        acc.totalSales += s.totalSales;
        acc.totalPaid += s.totalPaid;
        acc.totalDue += s.totalDue;
        acc.totalProfit += s.totalProfit;
        acc.totalReturned += s.totalReturned;
        acc.saleCount += s.saleCount;
        acc.dueCollected += s.dueCollected;
        acc.dueCollectionCount += s.dueCollectionCount;
        acc.returnsProcessedAmount += s.returnsProcessedAmount;
        acc.returnsProcessedCount += s.returnsProcessedCount;
        return acc;
      },
      {
        totalSales: 0,
        totalPaid: 0,
        totalDue: 0,
        totalProfit: 0,
        totalReturned: 0,
        saleCount: 0,
        dueCollected: 0,
        dueCollectionCount: 0,
        returnsProcessedAmount: 0,
        returnsProcessedCount: 0,
      }
    );
    summary.staffCount = staff.length;
    summary.sellingStaffCount = staff.filter((s) => s.saleCount > 0).length;
    summary.avgSale = summary.saleCount ? Math.round(summary.totalSales / summary.saleCount) : 0;

    // Share of the shop's takings, so the leaderboard can draw a bar without
    // the client having to re-derive the denominator.
    for (const s of staff) {
      s.salesShare = summary.totalSales > 0 ? Math.round((s.totalSales / summary.totalSales) * 1000) / 10 : 0;
    }

    const trend = trendRows.map((r) => ({
      staffId: String(r._id.staffId),
      date: r._id.date,
      netSales: Math.round(r.netSales || 0),
      profit: Math.round(r.profit || 0),
      saleCount: r.saleCount || 0,
    }));

    let previous = null;
    if (wantsCompare) {
      const prevRange = this._previousRange(scope.dateMatch);
      if (prevRange) {
        const prevMatch = { ...match, createdAt: prevRange };
        previous = await this._periodTotals(prevMatch);
        previous.startDate = prevRange.$gte;
        previous.endDate = prevRange.$lte;
      }
    }

    return {
      staff,
      summary,
      previous,
      trend,
      roster,
      startDate: scope.startDate,
      endDate: scope.endDate,
    };
  }

  /**
   * Date-wise and item-wise breakdown: which staff member sold what, on which
   * day, on how many bills.
   */
  async getDetailed(shopId, options = {}, branchId = null) {
    const scope = await this._resolveScope(shopId, options, branchId);
    const { match } = scope;

    const sortBy = ['date', 'revenue', 'profit', 'quantity', 'product'].includes(options.sortBy)
      ? options.sortBy
      : 'date';
    const sortDir = options.sortOrder === 'asc' ? 1 : -1;
    const sortStage = {
      date: { date: sortDir, netRevenue: -1 },
      revenue: { netRevenue: sortDir },
      profit: { netProfit: sortDir },
      quantity: { quantitySold: sortDir },
      product: { productName: sortDir },
    }[sortBy];

    const limit = Math.min(Math.max(parseInt(options.limit, 10) || DEFAULT_ROW_LIMIT, 1), MAX_ROW_LIMIT);

    const pipeline = [
      { $match: match },
      {
        $addFields: {
          _date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: BD_TZ } },
          // Denominator for the per-line share. Recomputed from the lines
          // rather than trusting the stored `subtotal`, so a bill written
          // before the pre-save hook took its current shape still allocates
          // to exactly 100%.
          _itemsTotal: { $sum: '$items.total' },
          _netTotal: netSaleAmountExpr(),
        },
      },
    ];

    const searchStages = this._searchStages(scope);
    if (searchStages) pipeline.push(...searchStages.bill);

    pipeline.push({ $unwind: '$items' });

    if (searchStages) pipeline.push(searchStages.line);

    if (scope.productIds.length) {
      pipeline.push({ $match: { 'items.product': { $in: scope.productIds } } });
    }

    pipeline.push(
      {
        $addFields: {
          _share: {
            $cond: [{ $gt: ['$_itemsTotal', 0] }, { $divide: ['$items.total', '$_itemsTotal'] }, 0],
          },
        },
      },
      {
        $group: {
          _id: {
            createdBy: '$createdBy',
            date: '$_date',
            product: '$items.product',
            productName: '$items.productName',
          },
          quantitySold: { $sum: '$items.quantity' },
          grossRevenue: { $sum: '$items.total' },
          netRevenue: { $sum: { $multiply: ['$_share', '$_netTotal'] } },
          netProfit: { $sum: { $multiply: ['$_share', { $ifNull: ['$profit', 0] }] } },
          totalCost: {
            $sum: { $multiply: [{ $ifNull: ['$items.buyingPrice', 0] }, '$items.quantity'] },
          },
          unitPrice: { $avg: '$items.unitPrice' },
          invoices: { $addToSet: '$invoiceNo' },
          saleIds: { $addToSet: '$_id' },
        },
      },
      {
        $project: {
          _id: 0,
          createdBy: '$_id.createdBy',
          date: '$_id.date',
          product: '$_id.product',
          productName: '$_id.productName',
          quantitySold: { $round: ['$quantitySold', 3] },
          grossRevenue: 1,
          netRevenue: 1,
          netProfit: 1,
          totalCost: 1,
          unitPrice: 1,
          invoiceCount: { $size: '$invoices' },
          invoices: { $slice: ['$invoices', 25] },
          saleCount: { $size: '$saleIds' },
        },
      },
      {
        $facet: {
          rows: [{ $sort: sortStage }, { $limit: limit }],
          totals: [
            {
              $group: {
                _id: null,
                totalRevenue: { $sum: '$netRevenue' },
                totalGross: { $sum: '$grossRevenue' },
                totalProfit: { $sum: '$netProfit' },
                totalQuantity: { $sum: '$quantitySold' },
                totalStaff: { $addToSet: '$createdBy' },
                totalProducts: { $addToSet: '$product' },
                totalDays: { $addToSet: '$date' },
              },
            },
          ],
          count: [{ $count: 'n' }],
        },
      },
    );

    const [facet] = await Sale.aggregate(pipeline).allowDiskUse(true);
    const rawRows = facet?.rows || [];
    const totalsRow = facet?.totals?.[0];
    const totalRows = facet?.count?.[0]?.n || 0;

    const staffIds = [...new Set(rawRows.map((r) => String(r.createdBy)))].filter(Boolean);
    const users = await User.find({ _id: { $in: staffIds } })
      .select('name phone isOwner isActive role')
      .populate('role', 'name')
      .lean();
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    const flatItems = [];
    const staffMap = new Map();

    for (const item of rawRows) {
      const u = userMap.get(String(item.createdBy));
      const staffName = u?.name || 'অজানা';
      const roleName = u?.isOwner ? 'Owner' : (u?.role?.name || 'Staff');

      const row = {
        staffId: String(item.createdBy),
        staffName,
        staffPhone: u?.phone || '',
        roleName,
        date: item.date,
        productId: item.product,
        productName: item.productName,
        quantitySold: roundReportQty(item.quantitySold),
        // Paisa, NOT whole taka — a shop selling by the gram has real sub-taka
        // unit prices, and rounding them here makes the report disagree with
        // the invoice it summarises.
        unitPrice: quantizeMoney(item.unitPrice || 0),
        grossRevenue: Math.round(item.grossRevenue || 0),
        totalRevenue: Math.round(item.netRevenue || 0),
        totalProfit: Math.round(item.netProfit || 0),
        invoiceCount: item.invoiceCount,
        invoices: item.invoices,
      };
      flatItems.push(row);

      const key = row.staffId;
      if (!staffMap.has(key)) {
        staffMap.set(key, {
          staffId: key,
          staffName,
          staffPhone: row.staffPhone,
          roleName,
          isOwner: u?.isOwner === true,
          isActive: u?.isActive !== false,
          totalRevenue: 0,
          totalQuantity: 0,
          totalProfit: 0,
          datesMap: new Map(),
        });
      }

      const staffNode = staffMap.get(key);
      staffNode.totalRevenue += item.netRevenue || 0;
      staffNode.totalProfit += item.netProfit || 0;
      staffNode.totalQuantity = roundReportQty(staffNode.totalQuantity + (item.quantitySold || 0));

      if (!staffNode.datesMap.has(item.date)) {
        staffNode.datesMap.set(item.date, {
          date: item.date,
          totalRevenue: 0,
          totalQuantity: 0,
          totalProfit: 0,
          products: [],
        });
      }
      const dateNode = staffNode.datesMap.get(item.date);
      dateNode.totalRevenue += item.netRevenue || 0;
      dateNode.totalProfit += item.netProfit || 0;
      dateNode.totalQuantity = roundReportQty(dateNode.totalQuantity + (item.quantitySold || 0));
      dateNode.products.push({
        productId: item.product,
        productName: item.productName,
        quantitySold: row.quantitySold,
        unitPrice: row.unitPrice,
        grossRevenue: row.grossRevenue,
        totalRevenue: row.totalRevenue,
        totalProfit: row.totalProfit,
        invoiceCount: row.invoiceCount,
        invoices: row.invoices,
      });
    }

    const staffDetails = Array.from(staffMap.values())
      .map((s) => ({
        staffId: s.staffId,
        staffName: s.staffName,
        staffPhone: s.staffPhone,
        roleName: s.roleName,
        isOwner: s.isOwner,
        isActive: s.isActive,
        totalRevenue: Math.round(s.totalRevenue),
        totalProfit: Math.round(s.totalProfit),
        totalQuantity: s.totalQuantity,
        dates: Array.from(s.datesMap.values())
          .map((d) => ({
            date: d.date,
            totalRevenue: Math.round(d.totalRevenue),
            totalProfit: Math.round(d.totalProfit),
            totalQuantity: d.totalQuantity,
            products: d.products,
          }))
          .sort((a, b) => (a.date < b.date ? 1 : -1)),
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    return {
      staffDetails,
      flatItems,
      summary: {
        totalStaff: totalsRow?.totalStaff?.length || 0,
        totalProducts: totalsRow?.totalProducts?.length || 0,
        totalDays: totalsRow?.totalDays?.length || 0,
        totalRevenue: Math.round(totalsRow?.totalRevenue || 0),
        totalGross: Math.round(totalsRow?.totalGross || 0),
        totalProfit: Math.round(totalsRow?.totalProfit || 0),
        totalQuantity: roundReportQty(totalsRow?.totalQuantity || 0),
      },
      pagination: {
        rows: rawRows.length,
        totalRows,
        limit,
        // The KPI strip is computed over ALL matching rows; the list below it is
        // capped. When these differ the UI must say so rather than letting the
        // two disagree in silence.
        truncated: totalRows > rawRows.length,
      },
      sortBy,
      sortOrder: sortDir === 1 ? 'asc' : 'desc',
      startDate: scope.startDate,
      endDate: scope.endDate,
    };
  }
}

module.exports = new StaffReportService();
