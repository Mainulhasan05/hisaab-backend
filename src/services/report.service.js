const Sale = require('../models/Sale.model');
const Product = require('../models/Product.model');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Payment = require('../models/Payment.model');
const Expense = require('../models/Expense.model');
const SalesReturn = require('../models/SalesReturn.model');
const Purchase = require('../models/Purchase.model');
const CashRegister = require('../models/CashRegister.model');
const Branch = require('../models/Branch.model');
const User = require('../models/User.model');
const Role = require('../models/Role.model');
const mongoose = require('mongoose');
const cacheService = require('./cache.service');
const { KEYS, getTTL } = require('../config/cacheKeys');
const { isBranchCustomerScope } = require('../utils/branchScope.util');
const { quantizeMoney } = require('../utils/quantity.util');
const { MAX_DECIMALS } = require('../config/units');
// Safe direction: customer.service depends on models only, never on reports.
const customerService = require('./customer.service');

/**
 * Snap an aggregated quantity to the registry's maximum precision.
 *
 * Reports `$sum` quantities ACROSS products, so there is no single unit to
 * round at — MAX_DECIMALS is the correct ceiling: it is the finest precision
 * any unit is allowed, so rounding there can never coarsen a real value while
 * still clearing the float residue that summing fractions leaves behind
 * (12 x 0.1 sums to 1.1102230246251565e-16 over 1.2).
 *
 * Money uses `quantizeMoney` (2 dp); this is for quantities only.
 */
const roundReportQty = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = Math.pow(10, MAX_DECIMALS);
  return Math.round(num * factor) / factor;
};

/**
 * Aggregation stage that applies the same snap server-side, for pipelines whose
 * `$group` output is sorted and returned without passing through JS. Must come
 * AFTER the `$group` — `$round` cannot wrap a `$sum` accumulator in place.
 */
const roundQtyStage = { $set: { totalQuantity: { $round: ['$totalQuantity', MAX_DECIMALS] } } };

// Products are per-branch documents, so a report's product scope is just the
// shop plus the optional branch — no join to a separate stock collection.
function productScope(shopId, branchId, extra = {}) {
  const scope = { shop: new mongoose.Types.ObjectId(shopId), isDeleted: { $ne: true }, ...extra };
  if (branchId) scope.branch = new mongoose.Types.ObjectId(branchId);
  return scope;
}

// Bangladesh is UTC+6. All dates from frontend are in Bangladesh local time.
// These used to be defined here; they moved to utils/bdTime.util.js when the
// Telegram digest job needed the same notion of "today". Two copies of this
// conversion would eventually disagree, and a digest that reports a different
// day than the dashboard is worse than no digest.
const { getBangladeshTodayStr, getBangladeshDayRange } = require('../utils/bdTime.util');

function netSaleAmountExpr() {
  return {
    $max: [
      { $subtract: ['$total', { $ifNull: ['$returnedAmount', 0] }] },
      0,
    ],
  };
}

class ReportService {
  /**
   * Build the base $match for aggregation with optional branch scoping.
   * @param {string} shopId - Shop ID
   * @param {string|null} branchId - Branch ID (null = all branches)
   * @returns {Object} Base match object
   */
  _baseMatch(shopId, branchId = null) {
    const match = { shop: new mongoose.Types.ObjectId(shopId) };
    if (branchId) {
      match.branch = new mongoose.Types.ObjectId(branchId);
    }
    return match;
  }

  /**
   * Build date range match object for queries.
   * Ensures end of day (23:59:59.999) is used when endDate is date-only string or midnight timestamp.
   */
  _buildDateMatch(startDate, endDate) {
    if (!startDate && !endDate) return null;
    const match = {};

    if (startDate) {
      match.$gte = new Date(startDate);
    }

    if (endDate) {
      const end = new Date(endDate);
      if (typeof endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(endDate.trim())) {
        const { endOfDay } = getBangladeshDayRange(endDate.trim());
        match.$lte = endOfDay;
      } else if (end.getUTCHours() === 0 && end.getUTCMinutes() === 0 && end.getUTCSeconds() === 0 && end.getUTCMilliseconds() === 0) {
        match.$lte = new Date(end.getTime() + (24 * 60 * 60 * 1000 - 1));
      } else {
        match.$lte = end;
      }
    }

    return match;
  }

  // Get dashboard statistics
  /**
   * Count of products below their reorder point, cached for 60s.
   *
   * ── Why this needs its own cache, on top of the dashboard's ──────────────
   *
   * The predicate is `$expr: { $lt: ['$stock', '$minStock'] }` — a comparison
   * between two fields of the SAME document. MongoDB cannot serve that from an
   * index, no matter how the shop/branch keys are arranged, so it is a
   * COLLECTION SCAN of the shop's whole catalogue every time it runs.
   *
   * Measured at 189ms for a single query against 5k products, and it is a
   * major share of the dashboard's server time (PERFORMANCE_BASELINE.md §N-1).
   *
   * The dashboard result is already cached, but that cache is version-keyed and
   * bumped by every write burst, so an active shop misses it often and pays the
   * scan again. A short independent TTL means the scan runs at most once a
   * minute per (shop, branch) regardless of how often the dashboard is rebuilt.
   * 60s staleness is fine for a reorder alert — `getTTL.lowStock` was already
   * set to exactly that and had no caller.
   *
   * The key is scoped by `branchId` because the QUERY is scoped by `branchId`
   * (via productScope). Do not reduce that to a shop-only key — see the long
   * note on the inventory-stats key in product.service.js for what happens when
   * a cache key partitions more coarsely than the data it holds.
   *
   * A permanent fix would be a denormalized indexed flag maintained on every
   * stock write; that is a larger change and is deliberately not attempted here.
   */
  async _lowStockCount(shopId, branchId = null) {
    const cacheKey = `${KEYS.LOW_STOCK(shopId)}:count:${branchId || 'all'}`;

    // `!= null` deliberately, not a truthiness check: zero is both a perfectly
    // valid count and a cache hit worth honouring. `cached || compute` here
    // would re-run the scan for every shop that is fully stocked — that is,
    // for the healthiest shops, forever.
    const cached = await cacheService.get(cacheKey);
    if (cached != null) return cached;

    const count = await Product.countDocuments(
      productScope(shopId, branchId, { isActive: true, $expr: { $lt: ['$stock', '$minStock'] } })
    );
    await cacheService.set(cacheKey, count, getTTL.lowStock);
    return count;
  }

  async getDashboardStats(shopId, branchId = null, isMultiBranch = false, req = null) {
    // Customers and dues are read per-branch or shop-wide depending on the
    // shop's setting (Phase 7). The two produce different numbers from the same
    // (shop, branch), so the scope has to be part of the cache key — otherwise
    // flipping the flag would serve the old figures until the version bumps.
    const scopedCustomers = isBranchCustomerScope(req);

    // Try cache first (include branchId and shop cache version in the key —
    // sale writes bump the version instead of deleting keys)
    const version = await cacheService.getShopCacheVersion(shopId);
    const scopeTag = scopedCustomers ? ':cs=branch' : '';
    const cacheKey = branchId
      ? `${KEYS.DASHBOARD_STATS(shopId)}:branch:${branchId}${scopeTag}:v${version}`
      : `${KEYS.DASHBOARD_STATS(shopId)}:v${version}`;
    const cached = await cacheService.get(cacheKey);
    if (cached) return cached;
    const { startOfDay, endOfDay } = getBangladeshDayRange(getBangladeshTodayStr());

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Branch breakdown is only meaningful for a shop that actually has
    // branches. It used to run whenever no branch was selected, which is always
    // true for a single-branch shop — two extra queries on the hottest endpoint
    // for every such shop, returning an empty array (FEATURE_AUDIT.md M-12).
    const wantBranchBreakdown = isMultiBranch && !branchId;

    // These eight queries are independent of each other. They used to run as
    // eight sequential `await`s, so the endpoint paid one full network round
    // trip per query — ~500ms of pure latency before any work. Running them
    // together collapses that to roughly a single round trip.
    const [
      todaySalesResult,
      customerDueResult,
      lowStockCount,
      totalCustomers,
      totalProducts,
      recentSales,
      topProducts,
      salesChart,
      salesByBranch,
      activeBranches,
    ] = await Promise.all([
      // Today's sales
      Sale.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            status: { $ne: 'cancelled' },
            createdAt: { $gte: startOfDay, $lte: endOfDay },
          },
        },
        {
          $group: {
            _id: null,
            totalSales: { $sum: netSaleAmountExpr() },
            totalPaid: { $sum: '$paid' },
            totalDue: { $sum: '$due' },
            totalProfit: { $sum: '$profit' },
            count: { $sum: 1 },
          },
        },
      ]),

      // Total due across customers. Shop-wide unless this shop keeps separate
      // books per branch, in which case only what is owed to THIS branch.
      //
      // An owner in All-Branches has no branch to scope to, and the sum across
      // every branch is precisely the shop-wide rollup — so the aggregate view
      // falls through to the same query in both modes, with no special case.
      scopedCustomers
        ? CustomerBalance.aggregate([
          {
            $match: {
              shop: new mongoose.Types.ObjectId(shopId),
              branch: new mongoose.Types.ObjectId(branchId),
            },
          },
          { $group: { _id: null, totalDue: { $sum: '$totalDue' } } },
        ])
        : Customer.aggregate([
          { $match: { shop: new mongoose.Types.ObjectId(shopId), isActive: true } },
          { $group: { _id: null, totalDue: { $sum: '$totalDue' } } },
        ]),

      this._lowStockCount(shopId, branchId),

      scopedCustomers
        ? CustomerBalance.countDocuments({ shop: shopId, branch: branchId })
        : Customer.countDocuments({ shop: shopId, isActive: true }),

      Product.countDocuments(productScope(shopId, branchId, { isActive: true })),

      Sale.find({
        shop: shopId,
        ...(branchId ? { branch: branchId } : {}),
        status: { $ne: 'cancelled' },
      })
        .populate('customer', 'name phone')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),

      // Top selling products (last 30 days)
      Sale.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            status: { $ne: 'cancelled' },
            createdAt: { $gte: thirtyDaysAgo },
          },
        },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            productName: { $first: '$items.productName' },
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: '$items.total' },
          },
        },
        roundQtyStage,
        { $sort: { totalQuantity: -1 } },
        { $limit: 5 },
      ]),

      // Sales chart (last 7 days)
      Sale.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            status: { $ne: 'cancelled' },
            createdAt: { $gte: sevenDaysAgo },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            sales: { $sum: netSaleAmountExpr() },
            orders: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Per-branch today's figures — multi-branch shops only
      wantBranchBreakdown
        ? Sale.aggregate([
          {
            $match: {
              shop: new mongoose.Types.ObjectId(shopId),
              status: { $ne: 'cancelled' },
              createdAt: { $gte: startOfDay, $lte: endOfDay },
            },
          },
          {
            $group: {
              _id: '$branch',
              todaySales: { $sum: netSaleAmountExpr() },
              todayProfit: { $sum: '$profit' },
              todayOrders: { $sum: 1 },
            },
          },
        ])
        : [],

      wantBranchBreakdown
        ? Branch.find({ shop: shopId, isActive: true }).lean()
        : [],
    ]);

    const todaySales = todaySalesResult[0] || { totalSales: 0, totalPaid: 0, totalDue: 0, totalProfit: 0, count: 0 };
    const totalDue = customerDueResult[0]?.totalDue || 0;

    const branchBreakdown = activeBranches.map((branch) => {
      const stats = salesByBranch.find((x) => x._id && x._id.toString() === branch._id.toString()) || {
        todaySales: 0,
        todayProfit: 0,
        todayOrders: 0,
      };
      return {
        branchId: branch._id,
        name: branch.name,
        code: branch.code,
        address: branch.address,
        phone: branch.phone,
        isDefault: branch.isDefault,
        todaySales: stats.todaySales,
        todayProfit: stats.todayProfit,
        todayOrders: stats.todayOrders,
      };
    });

    const result = {
      todaySales: todaySales.totalSales,
      todayProfit: todaySales.totalProfit,
      todayOrders: todaySales.count,
      totalDue,
      lowStockCount,
      totalCustomers,
      totalProducts,
      recentSales,
      topProducts,
      salesChart,
      branchBreakdown,
    };

    // Cache the result
    await cacheService.set(cacheKey, result, getTTL.dashboardStats);
    return result;
  }


  // Get sales report — uses $facet to combine period breakdown, summary, and profit in a single pipeline
  async getSalesReport(shopId, options = {}, branchId = null) {
    const { startDate, endDate, groupBy = 'day' } = options;

    const matchStage = {
      ...this._baseMatch(shopId, branchId),
      status: { $ne: 'cancelled' },
    };

    const dateMatch = this._buildDateMatch(startDate, endDate);
    if (dateMatch) {
      matchStage.createdAt = dateMatch;
    }

    let dateFormat;
    switch (groupBy) {
      case 'hour':
        dateFormat = '%Y-%m-%d %H:00';
        break;
      case 'day':
        dateFormat = '%Y-%m-%d';
        break;
      case 'week':
        dateFormat = '%Y-W%V';
        break;
      case 'month':
        dateFormat = '%Y-%m';
        break;
      default:
        dateFormat = '%Y-%m-%d';
    }

    // Single $facet pipeline: one DB scan for both period data and summary
    const facetResult = await Sale.aggregate([
      { $match: matchStage },
      {
        $facet: {
          byPeriod: [
            {
              $group: {
                _id: {
                  $dateToString: { format: dateFormat, date: '$createdAt' },
                },
                totalSales: { $sum: netSaleAmountExpr() },
                totalPaid: { $sum: '$paid' },
                totalDue: { $sum: '$due' },
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ],
          summary: [
            {
              $group: {
                _id: null,
                totalSales: { $sum: netSaleAmountExpr() },
                totalPaid: { $sum: '$paid' },
                totalDue: { $sum: '$due' },
                totalProfit: { $sum: '$profit' },
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]);

    const data = facetResult[0]?.byPeriod || [];
    const summary = facetResult[0]?.summary[0] || { totalSales: 0, totalPaid: 0, totalDue: 0, totalProfit: 0, count: 0 };

    return {
      data,
      summary,
    };
  }

  // Get product report
  async getProductReport(shopId, options = {}, branchId = null) {
    const { startDate, endDate } = options;

    // Top selling products
    const matchStage = {
      ...this._baseMatch(shopId, branchId),
      status: { $ne: 'cancelled' },
    };

    const dateMatch = this._buildDateMatch(startDate, endDate);
    if (dateMatch) {
      matchStage.createdAt = dateMatch;
    }

    const topSelling = await Sale.aggregate([
      { $match: matchStage },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.product',
          productName: { $first: '$items.productName' },
          totalQuantity: { $sum: '$items.quantity' },
          totalRevenue: { $sum: '$items.total' },
          salesCount: { $sum: 1 },
        },
      },
      roundQtyStage,
      { $sort: { totalQuantity: -1 } },
      { $limit: 20 },
    ]);

    // Low stock products
    const lowStock = await Product.find(
      productScope(shopId, branchId, { isActive: true, $expr: { $lt: ['$stock', '$minStock'] } })
    )
      .select('name code stock minStock sellingPrice')
      .sort({ stock: 1 })
      .limit(20)
      .lean();

    // No stock products
    const noStock = await Product.find(
      productScope(shopId, branchId, { isActive: true, stock: { $lte: 0 } })
    )
      .select('name code stock minStock sellingPrice')
      .limit(20)
      .lean();

    // Product summary
    const summaryResult = await Product.aggregate([
      { $match: productScope(shopId, branchId, { isActive: true }) },
      {
        $group: {
          _id: null,
          totalProducts: { $sum: 1 },
          totalStock: { $sum: '$stock' },
          totalValue: { $sum: { $multiply: ['$stock', '$sellingPrice'] } },
        },
      },
    ]);
    const summary = summaryResult[0] || { totalProducts: 0, totalStock: 0, totalValue: 0 };

    return {
      topSelling,
      lowStock,
      noStock,
      summary,
    };
  }

  // Get customer report
  // Customers are shop-wide (product decision #2/#7), so this report is
  // deliberately NOT branch-scoped. It previously accepted a `branchId` and
  // silently ignored it, which read as a bug (FEATURE_AUDIT.md H-9).
  async getCustomerReport(shopId, options = {}, req = null) {
    const { startDate, endDate } = options;

    // Reverses locked decision #7 ("customer report is shop-wide"): under
    // separate books a shop-wide report would hand every branch the customer
    // list and dues the rest of this phase keeps apart.
    const scopedCustomers = isBranchCustomerScope(req);
    const branchId = scopedCustomers ? req.branchId : null;

    // Top customers by purchase
    const topCustomers = scopedCustomers
      ? await customerService._topBranchBalances(shopId, branchId, { sortField: 'totalPurchases', limit: 20 })
      : await Customer.find({
        shop: shopId,
        isActive: true,
      })
        .select('name phone totalPurchases totalPaid totalDue purchaseCount lastPurchase')
        .sort({ totalPurchases: -1 })
        .limit(20)
        .lean();

    // Customers with due
    const customersWithDue = scopedCustomers
      ? await customerService._topBranchBalances(shopId, branchId, {
        sortField: 'totalDue',
        limit: 20,
        extraMatch: { totalDue: { $gt: 0 } },
      })
      : await Customer.find({
        shop: shopId,
        isActive: true,
        totalDue: { $gt: 0 },
      })
        .select('name phone totalDue lastPurchase')
        .sort({ totalDue: -1 })
        .limit(20)
        .lean();

    // New customers in date range
    const matchStage = {
      shop: new mongoose.Types.ObjectId(shopId),
      isActive: true,
    };

    const dateMatch = this._buildDateMatch(startDate, endDate);
    if (dateMatch) {
      matchStage.createdAt = dateMatch;
    }

    // "New" means new TO THIS BRANCH under separate books — a customer who has
    // shopped elsewhere for years is still new here the first time they walk in,
    // so this keys off when the branch ledger row appeared, not the person.
    const newCustomers = scopedCustomers
      ? await CustomerBalance.aggregate([
        {
          $match: {
            shop: new mongoose.Types.ObjectId(shopId),
            branch: new mongoose.Types.ObjectId(branchId),
            ...(dateMatch ? { createdAt: dateMatch } : {}),
          },
        },
        { $sort: { createdAt: -1 } },
        { $limit: 20 },
        { $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: 'customer' } },
        { $unwind: '$customer' },
        { $match: { 'customer.isActive': true } },
        { $project: { _id: '$customer._id', name: '$customer.name', phone: '$customer.phone', createdAt: 1 } },
      ])
      : await Customer.find(matchStage)
        .select('name phone createdAt')
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();

    // Customer summary
    const summaryResult = scopedCustomers
      ? await CustomerBalance.aggregate([
        {
          $match: {
            shop: new mongoose.Types.ObjectId(shopId),
            branch: new mongoose.Types.ObjectId(branchId),
          },
        },
        {
          $group: {
            _id: null,
            totalCustomers: { $sum: 1 },
            totalDue: { $sum: '$totalDue' },
            totalPurchases: { $sum: '$totalPurchases' },
          },
        },
      ])
      : await Customer.aggregate([
        {
          $match: {
            shop: new mongoose.Types.ObjectId(shopId),
            isActive: true,
          },
        },
        {
          $group: {
            _id: null,
            totalCustomers: { $sum: 1 },
            totalDue: { $sum: '$totalDue' },
            totalPurchases: { $sum: '$totalPurchases' },
          },
        },
      ]);

    const summary = summaryResult[0] || { totalCustomers: 0, totalDue: 0, totalPurchases: 0 };

    return {
      topCustomers,
      customersWithDue,
      newCustomers,
      summary,
    };
  }

  // Get Daily Business Summary
  async getDailySummary(shopId, options = {}, branchId = null) {
    const { date } = options;
    // Use Bangladesh today if no date provided
    const dateStr = date || getBangladeshTodayStr();

    // Try cache first. Only today's summary changes as sales come in, so only
    // today's key carries the shop cache version; past dates cache on TTL alone.
    const isToday = dateStr === getBangladeshTodayStr();
    const versionSuffix = isToday ? `:v${await cacheService.getShopCacheVersion(shopId)}` : '';
    const cacheKey = (branchId
      ? `${KEYS.DAILY_SUMMARY(shopId, dateStr)}:branch:${branchId}`
      : KEYS.DAILY_SUMMARY(shopId, dateStr)) + versionSuffix;
    const cached = await cacheService.get(cacheKey);
    if (cached) return cached;

    const shopObjId = new mongoose.Types.ObjectId(shopId);

    // Parse date as Bangladesh local time (UTC+6) to get correct UTC boundaries
    const { startOfDay, endOfDay } = getBangladeshDayRange(dateStr);

    const dateMatch = { createdAt: { $gte: startOfDay, $lte: endOfDay } };
    const expenseDateMatch = { date: { $gte: startOfDay, $lte: endOfDay } };

    // Run all aggregations in parallel
    const [
      salesAgg,
      salesByMethod,
      salesByHour,
      expenseAgg,
      expenseByCategory,
      purchaseAgg,
      dueCollections,
      returnsAgg,
      cashRegister,
      topProducts,
      lowStockProducts,
    ] = await Promise.all([
      // 1. Sales summary
      Sale.aggregate([
        { $match: { ...this._baseMatch(shopId, branchId), status: { $ne: 'cancelled' }, ...dateMatch } },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: netSaleAmountExpr() },
            totalProfit: { $sum: '$profit' },
            totalPaid: { $sum: '$paid' },
            totalDue: { $sum: '$due' },
            totalDiscount: { $sum: '$discount' },
            totalItems: { $sum: { $size: '$items' } },
            count: { $sum: 1 },
          },
        },
      ]),

      // 2. Sales by payment method
      Sale.aggregate([
        { $match: { ...this._baseMatch(shopId, branchId), status: { $ne: 'cancelled' }, ...dateMatch } },
        {
          $group: {
            _id: '$paymentMethod',
            total: { $sum: '$total' },
            paid: { $sum: '$paid' },
            count: { $sum: 1 },
          },
        },
        { $sort: { total: -1 } },
      ]),

      // 3. Sales by hour (for hourly chart)
      Sale.aggregate([
        { $match: { ...this._baseMatch(shopId, branchId), status: { $ne: 'cancelled' }, ...dateMatch } },
        {
          $group: {
            _id: { $hour: '$createdAt' },
            revenue: { $sum: netSaleAmountExpr() },
            profit: { $sum: '$profit' },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // 4. Expenses summary
      Expense.aggregate([
        { $match: { ...this._baseMatch(shopId, branchId), ...expenseDateMatch } },
        {
          $group: {
            _id: null,
            totalExpenses: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ]),

      // 5. Expenses by category
      Expense.aggregate([
        { $match: { ...this._baseMatch(shopId, branchId), ...expenseDateMatch } },
        {
          $group: {
            _id: '$category',
            categoryName: { $first: '$categoryName' },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
        { $sort: { total: -1 } },
      ]),

      // 6. Purchases summary
      Purchase.aggregate([
        { $match: { ...this._baseMatch(shopId, branchId), status: { $ne: 'cancelled' }, ...dateMatch } },
        {
          $group: {
            _id: null,
            totalPurchases: { $sum: '$totalAmount' },
            totalPaid: { $sum: '$paid' },
            totalDue: { $sum: '$due' },
            count: { $sum: 1 },
          },
        },
      ]),

      // 7. Due collections (payments for old dues)
      Payment.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            type: 'due_collection',
            createdAt: { $gte: startOfDay, $lte: endOfDay },
          },
        },
        {
          $group: {
            _id: '$method',
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ]),

      // 8. Sales returns
      SalesReturn.aggregate([
        { $match: { ...this._baseMatch(shopId, branchId), ...dateMatch } },
        {
          $group: {
            _id: null,
            totalReturns: { $sum: '$totalAmount' },
            totalProfitLoss: { $sum: '$profitReduction' },
            count: { $sum: 1 },
          },
        },
      ]),

      // 9. Cash register for this date
      CashRegister.findOne({
        ...this._baseMatch(shopId, branchId),
        date: { $gte: startOfDay, $lte: endOfDay },
      }).lean(),

      // 10. Top products sold today
      Sale.aggregate([
        { $match: { ...this._baseMatch(shopId, branchId), status: { $ne: 'cancelled' }, ...dateMatch } },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            productName: { $first: '$items.productName' },
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: '$items.total' },
          },
        },
        roundQtyStage,
        { $sort: { totalQuantity: -1 } },
        { $limit: 10 },
      ]),

      // 11. Low stock products
      Product.find(productScope(shopId, branchId, { isActive: true, $expr: { $lte: ['$stock', '$minStock'] } }))
        .select('name code stock minStock sellingPrice')
        .sort({ stock: 1 })
        .limit(15)
        .lean(),
    ]);

    const sales = salesAgg[0] || { totalRevenue: 0, totalProfit: 0, totalPaid: 0, totalDue: 0, totalDiscount: 0, totalItems: 0, count: 0 };
    const expenses = expenseAgg[0] || { totalExpenses: 0, count: 0 };
    const purchases = purchaseAgg[0] || { totalPurchases: 0, totalPaid: 0, totalDue: 0, count: 0 };
    const returns = returnsAgg[0] || { totalReturns: 0, totalProfitLoss: 0, count: 0 };

    // Due collections total
    const dueCollectionTotal = dueCollections.reduce((sum, d) => sum + d.total, 0);
    const dueCollectionCount = dueCollections.reduce((sum, d) => sum + d.count, 0);

    // Cash flow
    const cashIn = sales.totalPaid + dueCollectionTotal;
    const cashOut = expenses.totalExpenses + purchases.totalPaid + returns.totalReturns;
    const netCashFlow = cashIn - cashOut;

    // Net earnings for the day
    const netEarnings = sales.totalProfit - expenses.totalExpenses;

    // Build hourly chart data (0-23 hours)
    const hourlyData = [];
    for (let h = 0; h < 24; h++) {
      const hourData = salesByHour.find((d) => d._id === h);
      hourlyData.push({
        hour: h,
        label: `${h}:00`,
        revenue: hourData?.revenue || 0,
        profit: hourData?.profit || 0,
        orders: hourData?.count || 0,
      });
    }

    const result = {
      date: startOfDay.toISOString().split('T')[0],

      // Summary
      netEarnings,
      netCashFlow,

      // Sales
      sales: {
        revenue: sales.totalRevenue,
        profit: sales.totalProfit,
        paid: sales.totalPaid,
        due: sales.totalDue,
        discount: sales.totalDiscount,
        items: sales.totalItems,
        count: sales.count,
        byMethod: salesByMethod,
      },

      // Expenses
      expenses: {
        total: expenses.totalExpenses,
        count: expenses.count,
        byCategory: expenseByCategory,
      },

      // Purchases
      purchases: {
        total: purchases.totalPurchases,
        paid: purchases.totalPaid,
        due: purchases.totalDue,
        count: purchases.count,
      },

      // Due collections
      dueCollections: {
        total: dueCollectionTotal,
        count: dueCollectionCount,
        byMethod: dueCollections,
      },

      // Returns
      returns: {
        total: returns.totalReturns,
        profitLoss: returns.totalProfitLoss,
        count: returns.count,
      },

      // Cash flow
      cashFlow: {
        cashIn,
        cashOut,
        net: netCashFlow,
      },

      // Cash register
      cashRegister: cashRegister || null,

      // Charts
      hourlyData,
      topProducts,

      // Stock alerts
      lowStockProducts,
    };

    // Cache the result
    await cacheService.set(cacheKey, result, getTTL.dailySummary);
    return result;
  }

  /**
   * The three numbers the Telegram daily digest sends, per branch and in total.
   *
   * Deliberately NOT built on getDailySummary(): that runs eleven aggregations
   * to fill a dashboard, and the digest needs three columns. At 10 PM every
   * shop fires at once, so this is one aggregation per shop — grouped by
   * branch — instead of eleven per branch per shop.
   *
   * The match and the money expressions are the same ones getDailySummary uses,
   * so the digest total always equals what the owner sees on the dashboard.
   * Note that `revenue` is net of returns while `profit` is not; that asymmetry
   * is inherited on purpose, because matching the dashboard matters more than
   * being internally tidy — an owner comparing the two must not find a gap.
   */
  async getDigestTotals(shopId, dateStr, { multiBranch = false } = {}) {
    const { startOfDay, endOfDay } = getBangladeshDayRange(dateStr);

    const rows = await Sale.aggregate([
      {
        $match: {
          shop: new mongoose.Types.ObjectId(shopId),
          status: { $ne: 'cancelled' },
          createdAt: { $gte: startOfDay, $lte: endOfDay },
        },
      },
      {
        $group: {
          _id: multiBranch ? '$branch' : null,
          revenue: { $sum: netSaleAmountExpr() },
          profit: { $sum: '$profit' },
          count: { $sum: 1 },
        },
      },
    ]);

    const total = rows.reduce(
      (acc, r) => ({
        count: acc.count + (r.count || 0),
        revenue: acc.revenue + (r.revenue || 0),
        profit: acc.profit + (r.profit || 0),
      }),
      { count: 0, revenue: 0, profit: 0 }
    );

    const result = {
      date: dateStr,
      total: {
        count: total.count,
        revenue: quantizeMoney(total.revenue),
        profit: quantizeMoney(total.profit),
      },
      byBranch: [],
    };

    if (!multiBranch) return result;

    // Every active branch appears, including those with no sales — "0 invoices
    // at Uttara" is the line an owner most needs to see, and omitting the row
    // would read as though the branch simply wasn't counted.
    const branches = await Branch.find({ shop: shopId, isActive: true })
      .select('name')
      .sort({ isDefault: -1, name: 1 })
      .lean();

    const byId = new Map(rows.map((r) => [String(r._id), r]));
    result.byBranch = branches.map((b) => {
      const row = byId.get(String(b._id)) || {};
      return {
        branchId: b._id,
        name: b.name,
        count: row.count || 0,
        revenue: quantizeMoney(row.revenue || 0),
        profit: quantizeMoney(row.profit || 0),
      };
    });

    return result;
  }

  // Get Profit & Loss statement
  async getProfitLoss(shopId, options = {}, branchId = null) {
    const { startDate, endDate } = options;

    // Try cache first (versioned — invalidated by shop cache-version bumps)
    const plVersion = await cacheService.getShopCacheVersion(shopId);
    const cacheKey = (branchId
      ? `${KEYS.PROFIT_LOSS(shopId, startDate, endDate)}:branch:${branchId}`
      : KEYS.PROFIT_LOSS(shopId, startDate, endDate)) + `:v${plVersion}`;
    const cached = await cacheService.get(cacheKey);
    if (cached) return cached;

    const shopObjId = new mongoose.Types.ObjectId(shopId);

    const dateQuery = this._buildDateMatch(startDate, endDate);
    const dateMatch = dateQuery ? { createdAt: dateQuery } : {};
    const expenseDateMatch = dateQuery ? { date: dateQuery } : {};

    // Run all aggregations in parallel
    const [
      salesAgg,
      expenseAgg,
      expenseByCategory,
      returnsAgg,
      purchaseAgg,
      dailySales,
      dailyExpenses,
    ] = await Promise.all([
      // 1. Sales: revenue, COGS, profit, count
      Sale.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            status: { $ne: 'cancelled' },
            ...dateMatch,
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: netSaleAmountExpr() },
            totalProfit: { $sum: '$profit' },
            totalPaid: { $sum: '$paid' },
            totalDue: { $sum: '$due' },
            totalDiscount: { $sum: '$discount' },
            count: { $sum: 1 },
          },
        },
      ]),

      // 2. Total expenses
      Expense.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            ...expenseDateMatch,
          },
        },
        {
          $group: {
            _id: null,
            totalExpenses: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ]),

      // 3. Expenses by category
      Expense.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            ...expenseDateMatch,
          },
        },
        {
          $group: {
            _id: '$category',
            categoryName: { $first: '$categoryName' },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
        { $sort: { total: -1 } },
      ]),

      // 4. Sales returns
      SalesReturn.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            ...dateMatch,
          },
        },
        {
          $group: {
            _id: null,
            totalReturns: { $sum: '$totalAmount' },
            totalProfitLoss: { $sum: '$profitReduction' },
            count: { $sum: 1 },
          },
        },
      ]),

      // 5. Purchases
      Purchase.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            status: { $ne: 'cancelled' },
            ...dateMatch,
          },
        },
        {
          $group: {
            _id: null,
            totalPurchases: { $sum: '$totalAmount' },
            totalPaid: { $sum: '$paid' },
            totalDue: { $sum: '$due' },
            count: { $sum: 1 },
          },
        },
      ]),

      // 6. Daily sales breakdown (for chart)
      Sale.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            status: { $ne: 'cancelled' },
            ...dateMatch,
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
            },
            revenue: { $sum: netSaleAmountExpr() },
            profit: { $sum: '$profit' },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // 7. Daily expenses breakdown (for chart)
      Expense.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            ...expenseDateMatch,
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$date' },
            },
            expense: { $sum: '$amount' },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const sales = salesAgg[0] || { totalRevenue: 0, totalProfit: 0, totalPaid: 0, totalDue: 0, totalDiscount: 0, count: 0 };
    const expenses = expenseAgg[0] || { totalExpenses: 0, count: 0 };
    const returns = returnsAgg[0] || { totalReturns: 0, totalProfitLoss: 0, count: 0 };
    const purchases = purchaseAgg[0] || { totalPurchases: 0, totalPaid: 0, totalDue: 0, count: 0 };

    // COGS = Revenue - Profit (since profit = revenue - COGS - discounts, and revenue already has discounts subtracted)
    const cogs = sales.totalRevenue - sales.totalProfit;

    // Net profit = Sales profit - Expenses - Returns profit loss
    const netProfit = sales.totalProfit - expenses.totalExpenses;

    // Merge daily sales and expenses into a single chart dataset
    const dailyMap = new Map();
    for (const d of dailySales) {
      dailyMap.set(d._id, { date: d._id, revenue: d.revenue, profit: d.profit, orders: d.count, expense: 0 });
    }
    for (const d of dailyExpenses) {
      if (dailyMap.has(d._id)) {
        dailyMap.get(d._id).expense = d.expense;
      } else {
        dailyMap.set(d._id, { date: d._id, revenue: 0, profit: 0, orders: 0, expense: d.expense });
      }
    }
    const chartData = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    const result = {
      // Summary
      revenue: sales.totalRevenue,
      cogs,
      grossProfit: sales.totalProfit,
      totalExpenses: expenses.totalExpenses,
      returnsLoss: returns.totalProfitLoss,
      netProfit,

      // Details
      sales: {
        revenue: sales.totalRevenue,
        paid: sales.totalPaid,
        due: sales.totalDue,
        discount: sales.totalDiscount,
        count: sales.count,
        profit: sales.totalProfit,
      },
      expenses: {
        total: expenses.totalExpenses,
        count: expenses.count,
        byCategory: expenseByCategory,
      },
      returns: {
        total: returns.totalReturns,
        profitLoss: returns.totalProfitLoss,
        count: returns.count,
      },
      purchases: {
        total: purchases.totalPurchases,
        paid: purchases.totalPaid,
        due: purchases.totalDue,
        count: purchases.count,
      },

      // Chart
      chartData,
    };

    // Cache the result
    await cacheService.set(cacheKey, result, getTTL.profitLoss);
    return result;
  }

  // Get Date-wise Summary for a month (scrollable table)
  async getDateWiseSummary(shopId, options = {}, branchId = null) {
    const { month } = options; // format: 'YYYY-MM'

    // Determine start and end of the month in BD time
    let year, mon;
    if (month) {
      [year, mon] = month.split('-').map(Number);
    } else {
      const bdNow = new Date(Date.now() + BD_OFFSET_MS);
      year = bdNow.getFullYear();
      mon = bdNow.getMonth() + 1;
    }

    // First and last day of month in BD timezone
    const startOfMonth = new Date(Date.UTC(year, mon - 1, 1) - BD_OFFSET_MS);
    const lastDay = new Date(year, mon, 0).getDate(); // last day of month
    const endOfMonth = new Date(Date.UTC(year, mon - 1, lastDay + 1) - BD_OFFSET_MS - 1);

    // Run sales and expenses aggregations in parallel
    const [dailySales, dailyExpenses] = await Promise.all([
      Sale.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            status: { $ne: 'cancelled' },
            createdAt: { $gte: startOfMonth, $lte: endOfMonth },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$createdAt',
                timezone: '+06:00',
              },
            },
            totalSales: { $sum: netSaleAmountExpr() },
            totalProfit: { $sum: '$profit' },
            totalPaid: { $sum: '$paid' },
            totalDue: { $sum: '$due' },
            orderCount: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      Expense.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            date: { $gte: startOfMonth, $lte: endOfMonth },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$date',
                timezone: '+06:00',
              },
            },
            totalExpenses: { $sum: '$amount' },
            expenseCount: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    // Build the days array for the entire month
    const days = [];
    let monthTotalSales = 0;
    let monthTotalExpenses = 0;
    let monthTotalProfit = 0;
    let monthTotalOrders = 0;

    for (let d = 1; d <= lastDay; d++) {
      const dateStr = `${year}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const salesData = dailySales.find((s) => s._id === dateStr);
      const expenseData = dailyExpenses.find((e) => e._id === dateStr);

      const sales = salesData?.totalSales || 0;
      const expenses = expenseData?.totalExpenses || 0;
      const profit = salesData?.totalProfit || 0;
      const orders = salesData?.orderCount || 0;
      const netEarnings = profit - expenses;

      monthTotalSales += sales;
      monthTotalExpenses += expenses;
      monthTotalProfit += profit;
      monthTotalOrders += orders;

      days.push({
        date: dateStr,
        sales,
        expenses,
        profit,
        paid: salesData?.totalPaid || 0,
        due: salesData?.totalDue || 0,
        orderCount: orders,
        expenseCount: expenseData?.expenseCount || 0,
        netEarnings,
      });
    }

    return {
      month: `${year}-${String(mon).padStart(2, '0')}`,
      days,
      monthTotal: {
        sales: monthTotalSales,
        expenses: monthTotalExpenses,
        profit: monthTotalProfit,
        netEarnings: monthTotalProfit - monthTotalExpenses,
        orderCount: monthTotalOrders,
      },
    };
  }

  // Get all sales for a specific date (drill-down)
  async getSalesByDate(shopId, dateStr, branchId = null) {
    const { startOfDay, endOfDay } = getBangladeshDayRange(dateStr);

    const [sales, summary, expenseTotal] = await Promise.all([
      Sale.find({
        ...this._baseMatch(shopId, branchId),
        createdAt: { $gte: startOfDay, $lte: endOfDay },
      })
        .populate('customer', 'name phone')
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 })
        .lean(),

      Sale.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            status: { $ne: 'cancelled' },
            createdAt: { $gte: startOfDay, $lte: endOfDay },
          },
        },
        {
          $group: {
            _id: null,
            totalSales: { $sum: netSaleAmountExpr() },
            totalProfit: { $sum: '$profit' },
            totalPaid: { $sum: '$paid' },
            totalDue: { $sum: '$due' },
            count: { $sum: 1 },
          },
        },
      ]),

      Expense.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            date: { $gte: startOfDay, $lte: endOfDay },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const summaryData = summary[0] || {
      totalSales: 0,
      totalProfit: 0,
      totalPaid: 0,
      totalDue: 0,
      count: 0,
    };
    const expenseData = expenseTotal[0] || { total: 0, count: 0 };

    return {
      date: dateStr,
      sales,
      summary: {
        ...summaryData,
        totalExpenses: expenseData.total,
        expenseCount: expenseData.count,
        netEarnings: summaryData.totalProfit - expenseData.total,
        averageOrderValue:
          summaryData.count > 0
            ? Math.round(summaryData.totalSales / summaryData.count)
            : 0,
      },
    };
  }

  // Get trending products (7-day vs previous 7-day comparison)
  async getTrendingProducts(shopId, options = {}, branchId = null) {
    const { period = 7, limit = 20 } = options;

    const now = new Date();
    const currentStart = new Date(now);
    currentStart.setDate(now.getDate() - period);
    const previousStart = new Date(currentStart);
    previousStart.setDate(currentStart.getDate() - period);

    // Get sales for current period and previous period
    const [currentPeriod, previousPeriod] = await Promise.all([
      Sale.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            status: { $ne: 'cancelled' },
            createdAt: { $gte: currentStart, $lte: now },
          },
        },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            productName: { $first: '$items.productName' },
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: '$items.total' },
            salesCount: { $sum: 1 },
          },
        },
        roundQtyStage,
        { $sort: { totalRevenue: -1 } },
      ]),

      Sale.aggregate([
        {
          $match: {
            ...this._baseMatch(shopId, branchId),
            status: { $ne: 'cancelled' },
            createdAt: { $gte: previousStart, $lt: currentStart },
          },
        },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            productName: { $first: '$items.productName' },
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: '$items.total' },
          },
        },
        roundQtyStage,
      ]),
    ]);

    // Create lookup map for previous period
    const previousMap = new Map();
    for (const p of previousPeriod) {
      previousMap.set(p._id.toString(), p);
    }

    // Calculate trends
    const products = currentPeriod.map((curr) => {
      const prev = previousMap.get(curr._id.toString());
      const prevQty = prev?.totalQuantity || 0;
      const prevRevenue = prev?.totalRevenue || 0;

      let growthPercent = 0;
      if (prevQty > 0) {
        growthPercent = ((curr.totalQuantity - prevQty) / prevQty) * 100;
      } else if (curr.totalQuantity > 0) {
        growthPercent = 100; // New entry
      }

      let trend = 'stable';
      if (!prev) trend = 'new';
      else if (growthPercent > 10) trend = 'rising';
      else if (growthPercent < -10) trend = 'declining';

      return {
        productId: curr._id,
        productName: curr.productName,
        currentPeriodQty: roundReportQty(curr.totalQuantity),
        previousPeriodQty: prevQty,
        currentRevenue: curr.totalRevenue,
        previousRevenue: prevRevenue,
        growthPercent: Math.round(growthPercent),
        // Already rounded to 1 dp — divisions like 100/3 are exactly where a
        // "৩৩.৩৩৩৩৩৩৩৩৩৩৩" reaches the screen.
        velocity: Math.round((curr.totalQuantity / period) * 10) / 10,
        salesCount: curr.salesCount,
        trend,
      };
    });

    // Also check for declining products (were in previous but not in current)
    const currentIds = new Set(currentPeriod.map((c) => c._id.toString()));
    const declining = previousPeriod
      .filter((p) => !currentIds.has(p._id.toString()))
      .map((prev) => ({
        productId: prev._id,
        productName: prev.productName,
        currentPeriodQty: 0,
        previousPeriodQty: roundReportQty(prev.totalQuantity),
        currentRevenue: 0,
        previousRevenue: prev.totalRevenue,
        growthPercent: -100,
        velocity: 0,
        salesCount: 0,
        trend: 'declining',
      }));

    // Merge and sort
    const all = [...products, ...declining];

    // Separate by category
    const trending = all
      .filter((p) => p.trend === 'rising' || p.trend === 'new')
      .sort((a, b) => b.growthPercent - a.growthPercent)
      .slice(0, limit);

    const declinedList = all
      .filter((p) => p.trend === 'declining')
      .sort((a, b) => a.growthPercent - b.growthPercent)
      .slice(0, limit);

    const topSelling = all
      .sort((a, b) => b.currentRevenue - a.currentRevenue)
      .slice(0, limit);

    return {
      period,
      currentPeriodLabel: `Last ${period} days`,
      previousPeriodLabel: `Previous ${period} days`,
      trending,
      declining: declinedList,
      topSelling,
    };
  }

  /**
   * Staff-wise sales report: per-staff totals (net sales, paid, due, profit,
   * count, returns) over an optional date range, sorted by net sales.
   * Includes the owner's own sales — everyone who created a sale appears.
   */
  async getStaffReport(shopId, options = {}, branchId = null) {
    const { startDate, endDate, staffId } = options;

    const match = {
      ...this._baseMatch(shopId, branchId),
      status: { $ne: 'cancelled' },
    };
    const dateMatch = this._buildDateMatch(startDate, endDate);
    if (dateMatch) {
      match.createdAt = dateMatch;
    }
    if (staffId) {
      match.createdBy = new mongoose.Types.ObjectId(staffId);
    }

    const returnMatch = { ...match };
    delete returnMatch.status; // returns have their own lifecycle

    const [salesByStaff, returnsByStaff] = await Promise.all([
      Sale.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$createdBy',
            totalSales: { $sum: netSaleAmountExpr() },
            totalPaid: { $sum: '$paid' },
            totalDue: { $sum: '$due' },
            totalProfit: { $sum: '$profit' },
            saleCount: { $sum: 1 },
            avgSale: { $avg: netSaleAmountExpr() },
            lastSaleAt: { $max: '$createdAt' },
          },
        },
        { $sort: { totalSales: -1 } },
      ]),
      SalesReturn.aggregate([
        { $match: returnMatch },
        {
          $group: {
            _id: '$createdBy',
            totalReturned: { $sum: '$totalAmount' },
            returnCount: { $sum: 1 },
          },
        },
      ]),
    ]);

    // Resolve staff identities (name, phone, role, active) in one query
    const User = require('../models/User.model');
    const userIds = [
      ...new Set([
        ...salesByStaff.map((s) => String(s._id)),
        ...returnsByStaff.map((r) => String(r._id)),
      ]),
    ].filter(Boolean);

    const users = await User.find({ _id: { $in: userIds } })
      .select('name phone isOwner isActive role')
      .populate('role', 'name')
      .lean();
    const userMap = new Map(users.map((u) => [String(u._id), u]));
    const returnMap = new Map(returnsByStaff.map((r) => [String(r._id), r]));

    const staff = salesByStaff.map((s) => {
      const user = userMap.get(String(s._id));
      const returns = returnMap.get(String(s._id));
      return {
        staffId: s._id,
        name: user?.name || 'Unknown',
        phone: user?.phone || null,
        roleName: user?.isOwner ? 'Owner' : (user?.role?.name || null),
        isOwner: user?.isOwner === true,
        isActive: user?.isActive !== false,
        totalSales: s.totalSales,
        totalPaid: s.totalPaid,
        totalDue: s.totalDue,
        totalProfit: s.totalProfit,
        saleCount: s.saleCount,
        avgSale: Math.round(s.avgSale || 0),
        lastSaleAt: s.lastSaleAt,
        totalReturned: returns?.totalReturned || 0,
        returnCount: returns?.returnCount || 0,
      };
    });

    const summary = staff.reduce(
      (acc, s) => {
        acc.totalSales += s.totalSales || 0;
        acc.totalPaid += s.totalPaid || 0;
        acc.totalDue += s.totalDue || 0;
        acc.totalProfit += s.totalProfit || 0;
        acc.saleCount += s.saleCount || 0;
        acc.totalReturned += s.totalReturned || 0;
        acc.returnCount += s.returnCount || 0;
        return acc;
      },
      { totalSales: 0, totalPaid: 0, totalDue: 0, totalProfit: 0, saleCount: 0, totalReturned: 0, returnCount: 0 }
    );

    return { staff, summary, startDate: startDate || null, endDate: endDate || null };
  }

  /**
   * Detailed Staff Sales Report (Date-wise & Item-wise):
   * Provides complete breakdown of which staff member sold what products on which days.
   */
  async getDetailedStaffReport(shopId, options = {}, branchId = null) {
    const { startDate, endDate, staffId, search } = options;

    const match = {
      ...this._baseMatch(shopId, branchId),
      status: { $ne: 'cancelled' },
    };

    const dateMatch = this._buildDateMatch(startDate, endDate);
    if (dateMatch) {
      match.createdAt = dateMatch;
    }
    if (staffId) {
      match.createdBy = new mongoose.Types.ObjectId(staffId);
    }

    const aggregationPipeline = [
      { $match: match },
      { $unwind: '$items' },
      {
        $group: {
          _id: {
            createdBy: '$createdBy',
            date: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$createdAt',
                timezone: '+06:00', // Bangladesh local time
              },
            },
            product: '$items.product',
            productName: '$items.productName',
          },
          quantitySold: { $sum: '$items.quantity' },
          totalRevenue: { $sum: '$items.total' },
          unitPrice: { $avg: '$items.unitPrice' },
          buyingPrice: { $avg: { $ifNull: ['$items.buyingPrice', 0] } },
          totalCost: {
            $sum: {
              $multiply: [{ $ifNull: ['$items.buyingPrice', 0] }, '$items.quantity'],
            },
          },
          totalProfit: {
            $sum: {
              $subtract: [
                '$items.total',
                { $multiply: [{ $ifNull: ['$items.buyingPrice', 0] }, '$items.quantity'] },
              ],
            },
          },
          invoices: { $addToSet: '$invoiceNo' },
          salesCount: { $addToSet: '$_id' },
        },
      },
      {
        $project: {
          createdBy: '$_id.createdBy',
          date: '$_id.date',
          product: '$_id.product',
          productName: '$_id.productName',
          quantitySold: 1,
          totalRevenue: 1,
          unitPrice: 1,
          buyingPrice: 1,
          totalCost: 1,
          totalProfit: 1,
          invoiceCount: { $size: '$invoices' },
          invoices: 1,
          salesCount: { $size: '$salesCount' },
        },
      },
      {
        $sort: { date: -1, totalRevenue: -1 },
      },
    ];

    const rawResults = await Sale.aggregate(aggregationPipeline);

    // Collect staff IDs to fetch staff user details
    const User = require('../models/User.model');
    const userIds = [...new Set(rawResults.map((r) => String(r.createdBy)))].filter(Boolean);

    const users = await User.find({ _id: { $in: userIds } })
      .select('name phone isOwner isActive role')
      .populate('role', 'name')
      .lean();

    const userMap = new Map(users.map((u) => [String(u._id), u]));

    // Build flat records and hierarchical records
    const flatItems = [];
    const staffMap = new Map();

    let grandTotalRevenue = 0;
    let grandTotalQuantity = 0;
    let grandTotalProfit = 0;

    for (const item of rawResults) {
      const staffUser = userMap.get(String(item.createdBy));
      const staffName = staffUser?.name || 'Unknown Staff';
      const staffRole = staffUser?.isOwner ? 'Owner' : (staffUser?.role?.name || 'Staff');

      // Filtering search query (if search provided)
      if (search) {
        const query = search.toLowerCase();
        const matchesStaff = staffName.toLowerCase().includes(query);
        const matchesProduct = (item.productName || '').toLowerCase().includes(query);
        const matchesDate = (item.date || '').toLowerCase().includes(query);
        if (!matchesStaff && !matchesProduct && !matchesDate) {
          continue;
        }
      }

      grandTotalRevenue += item.totalRevenue || 0;
      grandTotalQuantity = roundReportQty(grandTotalQuantity + (item.quantitySold || 0));
      grandTotalProfit += item.totalProfit || 0;

      const flatRecord = {
        staffId: item.createdBy,
        staffName,
        staffPhone: staffUser?.phone || '',
        roleName: staffRole,
        date: item.date,
        productId: item.product,
        productName: item.productName,
        // `quantitySold` is a $sum over possibly-fractional item quantities, so
        // it needs the same snap every other quantity gets — a raw sum reaches
        // the CSV export as 12.000000000000002.
        quantitySold: roundReportQty(item.quantitySold),
        // Paisa, NOT whole taka. This was `Math.round`, which is correct only
        // while every unit price is a whole number of taka. Once a shop sells
        // by the piece or the gram, a ৳0.50 unit price reported as ৳1 (or ৳0)
        // makes the product report disagree with the invoices it summarises.
        unitPrice: quantizeMoney(item.unitPrice || 0),
        totalRevenue: Math.round(item.totalRevenue || 0),
        totalProfit: Math.round(item.totalProfit || 0),
        invoiceCount: item.invoiceCount,
        invoices: item.invoices,
      };

      flatItems.push(flatRecord);

      // Hierarchical grouping: Staff -> Date -> Products
      const sIdStr = String(item.createdBy);
      if (!staffMap.has(sIdStr)) {
        staffMap.set(sIdStr, {
          staffId: item.createdBy,
          staffName,
          staffPhone: staffUser?.phone || '',
          roleName: staffRole,
          isOwner: staffUser?.isOwner === true,
          isActive: staffUser?.isActive !== false,
          totalRevenue: 0,
          totalQuantity: 0,
          totalProfit: 0,
          datesMap: new Map(),
        });
      }

      const staffNode = staffMap.get(sIdStr);
      staffNode.totalRevenue += item.totalRevenue || 0;
      staffNode.totalQuantity = roundReportQty(staffNode.totalQuantity + (item.quantitySold || 0));
      staffNode.totalProfit += item.totalProfit || 0;

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
      dateNode.totalRevenue += item.totalRevenue || 0;
      dateNode.totalQuantity = roundReportQty(dateNode.totalQuantity + (item.quantitySold || 0));
      dateNode.totalProfit += item.totalProfit || 0;

      dateNode.products.push({
        productId: item.product,
        productName: item.productName,
        quantitySold: roundReportQty(item.quantitySold),
        unitPrice: quantizeMoney(item.unitPrice || 0),
        totalRevenue: Math.round(item.totalRevenue || 0),
        totalProfit: Math.round(item.totalProfit || 0),
        invoiceCount: item.invoiceCount,
        invoices: item.invoices,
      });
    }

    // Convert Maps to Arrays
    const staffDetails = Array.from(staffMap.values()).map((s) => ({
      ...s,
      totalRevenue: Math.round(s.totalRevenue),
      totalProfit: Math.round(s.totalProfit),
      dates: Array.from(s.datesMap.values()).map((d) => ({
        ...d,
        totalRevenue: Math.round(d.totalRevenue),
        totalProfit: Math.round(d.totalProfit),
      })),
    }));

    return {
      staffDetails,
      flatItems,
      summary: {
        totalStaff: staffDetails.length,
        totalRevenue: Math.round(grandTotalRevenue),
        totalQuantity: roundReportQty(grandTotalQuantity),
        totalProfit: Math.round(grandTotalProfit),
      },
      startDate: startDate || null,
      endDate: endDate || null,
    };
  }

  // Export report (placeholder - implement actual export logic)
  async exportReport(shopId, type, format, options, branchId = null) {
    // This would generate actual PDF/Excel/CSV files
    // For now, return the data
    let data;
    switch (type) {
      case 'sales':
        data = await this.getSalesReport(shopId, options, branchId);
        break;
      case 'products':
        data = await this.getProductReport(shopId, options, branchId);
        break;
      case 'customers':
        data = await this.getCustomerReport(shopId, options);
        break;
      case 'staff':
        data = await this.getStaffReport(shopId, options, branchId);
        break;
      case 'staff-detailed':
        data = await this.getDetailedStaffReport(shopId, options, branchId);
        break;
      default:
        throw new Error('Invalid report type');
    }

    return data;
  }
}

module.exports = new ReportService();
