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

// Scoping and rounding primitives are shared with staffReport.service.js — see
// utils/reportScope.util.js for why they no longer live here.
const {
  baseMatch: sharedBaseMatch,
  buildDateMatch: sharedBuildDateMatch,
  netSaleAmountExpr,
  roundReportQty,
} = require('../utils/reportScope.util');
const staffReportService = require('./staffReport.service');

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
// `BD_OFFSET_MS` is imported, not redeclared: `getDateWiseSummary` builds its
// own month boundaries from the raw offset, and a local copy here would be the
// third in the codebase (sale.service.js still has one). Two constants that
// must agree and don't is how a report ends up disagreeing with the dashboard
// about which day a sale landed on.
const { BD_OFFSET_MS, BD_TZ, getBangladeshTodayStr, getBangladeshDayRange } = require('../utils/bdTime.util');
const { paidAtMatch } = require('../utils/paymentDate.util');

class ReportService {
  /**
   * Build the base $match for aggregation with optional branch scoping.
   * @param {string} shopId - Shop ID
   * @param {string|null} branchId - Branch ID (null = all branches)
   * @returns {Object} Base match object
   */
  _baseMatch(shopId, branchId = null) {
    return sharedBaseMatch(shopId, branchId);
  }

  /**
   * Build date range match object for queries.
   * Ensures end of day (23:59:59.999) is used when endDate is date-only string or midnight timestamp.
   */
  _buildDateMatch(startDate, endDate) {
    return sharedBuildDateMatch(startDate, endDate);
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
      // Carries the customer COUNT too, so the tile and the due beside it can no
      // longer be counted over two different populations.
      customerDueResult,
      lowStockCount,
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

      // Total due across customers, and how many there are. Shop-wide unless
      // this shop keeps separate books per branch, in which case only what is
      // owed to THIS branch.
      //
      // An owner in All-Branches has no branch to scope to, and the sum across
      // every branch is precisely the shop-wide rollup — so the aggregate view
      // falls through to the same query in both modes, with no special case.
      //
      // ── Both arms must ask the SAME question ────────────────────────────────
      //
      // The branch arm used to read `CustomerBalance` raw while the shop-wide
      // arm filtered `isActive: true`. Deleted customers therefore counted at
      // branch level and vanished at shop level, so the branch tiles did not add
      // up to the All-Branches tile and there was no figure on the page that
      // explained the gap. One real shop: আক্কেলপুর ৳14,980,592 + নয়াগোলা
      // ৳639,015 = ৳15,619,607 against an All-Branches ৳15,513,302 — the
      // ৳106,305 difference being five soft-deleted customers, one of whom still
      // owed ৳106,305 of it. The join below is what keeps the two arms
      // answerable to each other; `_applyDueAdjustment` now refuses to create
      // that state in the first place.
      scopedCustomers
        ? CustomerBalance.aggregate([
          {
            $match: {
              shop: new mongoose.Types.ObjectId(shopId),
              branch: new mongoose.Types.ObjectId(branchId),
            },
          },
          {
            $lookup: {
              from: 'customers',
              localField: 'customer',
              foreignField: '_id',
              // Only the flag is needed, and the branch's due list can run to
              // thousands of rows — pulling whole customer documents through the
              // join to read one boolean is the expensive way to do this.
              pipeline: [{ $project: { isActive: 1 } }],
              as: 'c',
            },
          },
          { $unwind: '$c' },
          { $match: { 'c.isActive': true } },
          { $group: { _id: null, totalDue: { $sum: '$totalDue' }, count: { $sum: 1 } } },
        ])
        : Customer.aggregate([
          { $match: { shop: new mongoose.Types.ObjectId(shopId), isActive: true } },
          { $group: { _id: null, totalDue: { $sum: '$totalDue' }, count: { $sum: 1 } } },
        ]),

      this._lowStockCount(shopId, branchId),

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
            // `timezone` is not optional here — see BD_TZ in bdTime.util.js.
            // Without it these buckets are UTC days while the window above is a
            // BD day, so a sale rung at 01:00 Dhaka joins yesterday's bar.
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: BD_TZ } },
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
    const totalCustomers = customerDueResult[0]?.count || 0;

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

    // Versioned cache, same contract as getDashboardStats/getProfitLoss: sale
    // writes bump the shop's version (debounced to once per 30s) and superseded
    // entries age out on TTL. `KEYS.SALES_REPORT` and `getTTL.salesReport` were
    // already defined in config/cacheKeys.js and had no caller.
    //
    // The key carries every input the pipeline is scoped by — dates, groupBy AND
    // branch. Dropping branch here would serve one branch's figures to another
    // for five minutes; see the long note on the inventory-stats key in
    // product.service.js for what that looks like in practice.
    const srVersion = await cacheService.getShopCacheVersion(shopId);
    const srCacheKey =
      `${KEYS.SALES_REPORT(shopId, startDate, endDate, groupBy)}:branch:${branchId || 'all'}:v${srVersion}`;
    const srCached = await cacheService.get(srCacheKey);
    if (srCached) return srCached;

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
        // `%G`, not `%Y`. `%V` is the ISO-8601 week number, whose year is the
        // ISO WEEK-year (`%G`) and not the calendar year — the two disagree at
        // 82 of the next 100 year boundaries. Pairing `%V` with `%Y` labelled
        // 31 Dec 2029 as "2029-W01", which sorts to the top of the year and
        // merges with the real January week whenever a range spans both.
        dateFormat = '%G-W%V';
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
                  $dateToString: { format: dateFormat, date: '$createdAt', timezone: BD_TZ },
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

    const srResult = {
      data,
      summary,
    };

    await cacheService.set(srCacheKey, srResult, getTTL.salesReport);
    return srResult;
  }

  // Get product report
  async getProductReport(shopId, options = {}, branchId = null) {
    const { startDate, endDate } = options;

    // Cached for the same reason `_lowStockCount` above is: two of the four
    // queries below carry `$expr: { $lt: ['$stock', '$minStock'] }`, a
    // comparison between two fields of one document that MongoDB cannot serve
    // from an index at any arrangement. Each is a collection scan of the shop's
    // catalogue. The dashboard already shields its copy behind a 60s cache;
    // this method ran the same scan twice on every call with no cache at all.
    const prVersion = await cacheService.getShopCacheVersion(shopId);
    const prCacheKey =
      `${KEYS.PRODUCT_REPORT(shopId, startDate, endDate)}:branch:${branchId || 'all'}:v${prVersion}`;
    const prCached = await cacheService.get(prCacheKey);
    if (prCached) return prCached;

    // Top selling products
    const matchStage = {
      ...this._baseMatch(shopId, branchId),
      status: { $ne: 'cancelled' },
    };

    const dateMatch = this._buildDateMatch(startDate, endDate);
    if (dateMatch) {
      matchStage.createdAt = dateMatch;
    }

    // These four are independent of one another and used to run as four
    // sequential `await`s — four full round trips before the first byte.
    const [topSelling, lowStock, noStock, summaryResult] = await Promise.all([
      Sale.aggregate([
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
      ]),

      // Low stock products
      Product.find(
        productScope(shopId, branchId, { isActive: true, $expr: { $lt: ['$stock', '$minStock'] } })
      )
        .select('name code stock minStock sellingPrice')
        .sort({ stock: 1 })
        .limit(20)
        .lean(),

      // No stock products
      Product.find(
        productScope(shopId, branchId, { isActive: true, stock: { $lte: 0 } })
      )
        .select('name code stock minStock sellingPrice')
        .limit(20)
        .lean(),

      // Product summary
      Product.aggregate([
        { $match: productScope(shopId, branchId, { isActive: true }) },
        {
          $group: {
            _id: null,
            totalProducts: { $sum: 1 },
            totalStock: { $sum: '$stock' },
            totalValue: { $sum: { $multiply: ['$stock', '$sellingPrice'] } },
          },
        },
      ]),
    ]);

    const summary = summaryResult[0] || { totalProducts: 0, totalStock: 0, totalValue: 0 };

    const prResult = {
      topSelling,
      lowStock,
      noStock,
      summary,
    };

    await cacheService.set(prCacheKey, prResult, getTTL.productReport);
    return prResult;
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
            // `discountAmount`, not `discount`. The latter holds "10" on a
            // percentage invoice, so summing it reported ৳10 of discount given
            // on a ৳10,000 sale — the figure was meaningless for any shop that
            // discounts by percentage. `$ifNull` falls back for invoices written
            // before the resolved amount was stored; those are overwhelmingly
            // `fixed`, where the two fields agree by definition.
            totalDiscount: { $sum: { $ifNull: ['$discountAmount', '$discount'] } },
            // ── Per-LINE discounts, which nothing used to count ───────────────
            //
            // `discountAmount` above is the INVOICE-level discount only. From
            // the moment `features.lineDiscount` shipped, a shop could knock
            // ৳10 a kilo off individual items all month and "মোট ছাড়" would
            // report ৳0 — the exact figure an owner switches the capability on
            // to watch.
            //
            // Reported as its OWN number rather than merged into the one above.
            // "I gave ৳2,000 off whole bills" and "I gave ৳8,000 off individual
            // items" are different management problems: the first is a policy,
            // the second is usually one member of staff.
            //
            // `$reduce`, not `$sum: '$items.discount'` — the latter is a valid
            // expression on an array field but silently yields 0 for documents
            // whose `items` is missing, and `$ifNull` on each line is what
            // keeps a pre-feature sale item (no `discount` key at all) from
            // turning the whole sum into null.
            totalLineDiscount: {
              $sum: {
                $reduce: {
                  input: { $ifNull: ['$items', []] },
                  initialValue: 0,
                  in: { $add: ['$$value', { $ifNull: ['$$this.discount', 0] }] },
                },
              },
            },
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
            // Effective date: a collection entered today for last Tuesday
            // belongs on last Tuesday's summary, not this one.
            ...paidAtMatch({ $gte: startOfDay, $lte: endOfDay }),
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
        // The invoice-level figure above and the per-line one here stay apart
        // on purpose — see the aggregation. A caller wanting "total given
        // away" adds them; one wanting to know WHERE it went cannot un-merge
        // them.
        lineDiscount: sales.totalLineDiscount,
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
   *
   * ── BOTH numbers here are net of returns. ─────────────────────────────────
   *
   * This comment used to claim the opposite — that `revenue` was net of returns
   * and `profit` was not, and that the gap was deliberate. It was not true, and
   * a wrong comment on a money expression is worse than none: the next person to
   * read it goes looking for the asymmetry, "fixes" it by subtracting
   * `SalesReturn.profitReduction` somewhere, and double-counts every return on
   * the platform.
   *
   * What actually happens is that a return writes BOTH adjustments back onto the
   * original `Sale` document, in `salesReturn.service.createReturn`:
   *
   *     returnedAmount += refund          → `netSaleAmountExpr` nets revenue
   *     profit         -= profitReduction → `$sum: '$profit'` is already net
   *
   * So the two agree, and `SalesReturn.profitReduction` must never be subtracted
   * again downstream. `getProfitLoss` reports it as a separate line for the
   * owner's information and correctly leaves it out of `netProfit`.
   *
   * The one consequence worth knowing: because both adjustments land on the
   * original sale, a return re-dates itself to the day of the SALE. A report for
   * last Tuesday, re-run after a Tuesday sale is returned on Friday, shows less
   * revenue and less profit than the same report did on Wednesday. That is a
   * deliberate accounting choice, not drift.
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
            // `discountAmount`, not `discount`. The latter holds "10" on a
            // percentage invoice, so summing it reported ৳10 of discount given
            // on a ৳10,000 sale — the figure was meaningless for any shop that
            // discounts by percentage. `$ifNull` falls back for invoices written
            // before the resolved amount was stored; those are overwhelmingly
            // `fixed`, where the two fields agree by definition.
            totalDiscount: { $sum: { $ifNull: ['$discountAmount', '$discount'] } },
            // ── Per-LINE discounts, which nothing used to count ───────────────
            //
            // `discountAmount` above is the INVOICE-level discount only. From
            // the moment `features.lineDiscount` shipped, a shop could knock
            // ৳10 a kilo off individual items all month and "মোট ছাড়" would
            // report ৳0 — the exact figure an owner switches the capability on
            // to watch.
            //
            // Reported as its OWN number rather than merged into the one above.
            // "I gave ৳2,000 off whole bills" and "I gave ৳8,000 off individual
            // items" are different management problems: the first is a policy,
            // the second is usually one member of staff.
            //
            // `$reduce`, not `$sum: '$items.discount'` — the latter is a valid
            // expression on an array field but silently yields 0 for documents
            // whose `items` is missing, and `$ifNull` on each line is what
            // keeps a pre-feature sale item (no `discount` key at all) from
            // turning the whole sum into null.
            totalLineDiscount: {
              $sum: {
                $reduce: {
                  input: { $ifNull: ['$items', []] },
                  initialValue: 0,
                  in: { $add: ['$$value', { $ifNull: ['$$this.discount', 0] }] },
                },
              },
            },
            // Needed to strip pass-through money out of the COGS derivation
            // below. Neither is refunded by a return, so both stay whole even on
            // a fully-returned invoice — which is exactly why subtracting them
            // from the NET revenue is correct.
            totalTax: { $sum: { $ifNull: ['$tax', 0] } },
            totalDelivery: { $sum: { $ifNull: ['$deliveryCharge', 0] } },
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
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: BD_TZ },
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
              // Must stay in step with the sales bucket above — the P&L chart
              // joins the two series on this key, so a UTC expense day against a
              // BD sales day would misalign cost from revenue by six hours.
              $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: BD_TZ },
            },
            expense: { $sum: '$amount' },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const sales = salesAgg[0] || {
      totalRevenue: 0, totalProfit: 0, totalPaid: 0, totalDue: 0,
      totalDiscount: 0, totalTax: 0, totalDelivery: 0, count: 0,
    };
    const expenses = expenseAgg[0] || { totalExpenses: 0, count: 0 };
    const returns = returnsAgg[0] || { totalReturns: 0, totalProfitLoss: 0, count: 0 };
    const purchases = purchaseAgg[0] || { totalPurchases: 0, totalPaid: 0, totalDue: 0, count: 0 };

    /**
     * ── COGS is derived from MERCHANDISE revenue, not from total revenue ──────
     *
     * This was `totalRevenue - totalProfit`, and the identity it relied on does
     * not hold: `revenue` sums `Sale.total`, which includes `tax` and
     * `deliveryCharge`, while `Sale.profit` counts neither of them (see the
     * pre-save hook — profit is built from line margins less discounts). So
     * every taka of delivery the shop billed, and every taka of tax it merely
     * collected on someone else's behalf, was reported as cost of goods sold.
     *
     * For a shop doing home delivery that is not a rounding error: the whole
     * delivery line lands in COGS and gross margin reads far worse than it is.
     *
     * Stripping both terms leaves the merchandise revenue the margin actually
     * came from, and the three figures now tie out exactly —
     * `merchandiseRevenue - cogs === grossProfit` — because that identity is
     * what `Sale.pre('save')` computes per invoice.
     */
    const merchandiseRevenue = quantizeMoney(
      Math.max(0, sales.totalRevenue - (sales.totalTax || 0) - (sales.totalDelivery || 0))
    );
    const cogs = quantizeMoney(Math.max(0, merchandiseRevenue - sales.totalProfit));

    /**
     * Net profit = Sales profit - Expenses. Returns are NOT subtracted here,
     * and the comment that used to sit on this line claiming they were
     * ("- Returns profit loss") described an expression the code has never
     * evaluated.
     *
     * They are not subtracted because they are already gone: `createReturn`
     * decrements `profit` on the original Sale, so `sales.totalProfit` above is
     * net of every return raised against the period. Subtracting
     * `returns.totalProfitLoss` again would count each return twice.
     *
     * It is still reported, as `returnsLoss` below — an owner wants to see how
     * much of the month walked back through the door, and cannot read that off
     * a profit figure it has already been removed from.
     */
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
      // Revenue less the two pass-through lines. Exposed so the P&L can show
      // why `revenue - cogs` is not `grossProfit` when a shop bills delivery.
      merchandiseRevenue,
      tax: sales.totalTax || 0,
      deliveryCharge: sales.totalDelivery || 0,
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
        lineDiscount: sales.totalLineDiscount,
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
                timezone: BD_TZ,
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
                timezone: BD_TZ,
              },
            },
            totalExpenses: { $sum: '$amount' },
            expenseCount: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    // Build the days array for the entire month.
    // Indexed once rather than re-scanned per day: the two `.find()` calls that
    // used to sit inside this loop made it O(days x rows).
    const salesByDate = new Map(dailySales.map((s) => [s._id, s]));
    const expensesByDate = new Map(dailyExpenses.map((e) => [e._id, e]));

    const days = [];
    let monthTotalSales = 0;
    let monthTotalExpenses = 0;
    let monthTotalProfit = 0;
    let monthTotalOrders = 0;

    for (let d = 1; d <= lastDay; d++) {
      const dateStr = `${year}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const salesData = salesByDate.get(dateStr);
      const expenseData = expensesByDate.get(dateStr);

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

  /**
   * Get all sales for a specific date (drill-down).
   *
   * `options.staffId` narrows the day to one salesperson, which is what the
   * staff report drills into. Expenses are deliberately left out of that view:
   * an expense belongs to the shop, not to whoever happened to be at the till,
   * so attributing the day's rent to one employee would make their "আসল আয়"
   * a number that means nothing. When the day is staff-scoped the expense
   * totals come back as zero and the caller shows sales figures only.
   */
  async getSalesByDate(shopId, dateStr, branchId = null, options = {}) {
    const { startOfDay, endOfDay } = getBangladeshDayRange(dateStr);
    const staffId = options.staffId ? new mongoose.Types.ObjectId(options.staffId) : null;

    const dayMatch = {
      ...this._baseMatch(shopId, branchId),
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    };
    if (staffId) dayMatch.createdBy = staffId;

    const [sales, summary, expenseTotal, staff] = await Promise.all([
      Sale.find(dayMatch)
        .populate('customer', 'name phone')
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 })
        .lean(),

      Sale.aggregate([
        { $match: { ...dayMatch, status: { $ne: 'cancelled' } } },
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

      staffId
        ? Promise.resolve([])
        : Expense.aggregate([
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

      // Scoped to the shop, so one shop cannot drill into another's staff by
      // guessing an id — the sale match already enforces it, but the identity
      // echoed back in the response must be held to the same rule.
      staffId
        ? User.findOne({ _id: staffId, shop: shopId }).select('name phone isOwner role').populate('role', 'name').lean()
        : Promise.resolve(null),
    ]);

    if (staffId && !staff) {
      const err = new Error('Staff member not found');
      err.statusCode = 404;
      err.messageBn = 'কর্মচারী পাওয়া যায়নি';
      // Operational, so the production error handler sends the Bengali sentence
      // above rather than the generic "কিছু একটা সমস্যা হয়েছে".
      err.isOperational = true;
      throw err;
    }

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
      staff: staff
        ? {
            staffId: String(staff._id),
            name: staff.name,
            phone: staff.phone || null,
            roleName: staff.isOwner ? 'Owner' : staff.role?.name || null,
            isOwner: staff.isOwner === true,
          }
        : null,
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
   * Staff / salesman-wise reports.
   *
   * The implementation lives in staffReport.service.js — it grew filters,
   * period comparison, a day-by-day series and per-line bill allocation, and
   * this file was already 1900 lines. These two remain as the public entry
   * points so every existing caller (controller, exportReport below) is
   * unchanged.
   */
  async getStaffReport(shopId, options = {}, branchId = null) {
    return staffReportService.getSummary(shopId, options, branchId);
  }

  async getDetailedStaffReport(shopId, options = {}, branchId = null) {
    return staffReportService.getDetailed(shopId, options, branchId);
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
