const Sale = require('../models/Sale.model');
const Product = require('../models/Product.model');
const Customer = require('../models/Customer.model');
const Payment = require('../models/Payment.model');
const Expense = require('../models/Expense.model');
const SalesReturn = require('../models/SalesReturn.model');
const Purchase = require('../models/Purchase.model');
const CashRegister = require('../models/CashRegister.model');
const mongoose = require('mongoose');
const cacheService = require('./cache.service');
const { KEYS, getTTL } = require('../config/cacheKeys');

// Bangladesh is UTC+6. All dates from frontend are in Bangladesh local time.
const BD_OFFSET_MS = 6 * 60 * 60 * 1000;

// Get current date string in Bangladesh time ("YYYY-MM-DD")
function getBangladeshTodayStr() {
  const bdNow = new Date(Date.now() + BD_OFFSET_MS);
  return bdNow.toISOString().split('T')[0];
}

// Convert a Bangladesh date string ("YYYY-MM-DD") to UTC start/end timestamps
function getBangladeshDayRange(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  // Bangladesh midnight = UTC midnight minus 6 hours (BD is UTC+6)
  const startOfDay = new Date(Date.UTC(year, month - 1, day) - BD_OFFSET_MS);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { startOfDay, endOfDay };
}

class ReportService {
  // Get dashboard statistics
  async getDashboardStats(shopId) {
    // Try cache first
    const cacheKey = KEYS.DASHBOARD_STATS(shopId);
    const cached = await cacheService.get(cacheKey);
    if (cached) return cached;
    const { startOfDay, endOfDay } = getBangladeshDayRange(getBangladeshTodayStr());

    // Get today's sales
    const todaySalesResult = await Sale.aggregate([
      {
        $match: {
          shop: new mongoose.Types.ObjectId(shopId),
          status: { $ne: 'cancelled' },
          createdAt: { $gte: startOfDay, $lte: endOfDay },
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: '$total' },
          totalPaid: { $sum: '$paid' },
          totalDue: { $sum: '$due' },
          totalProfit: { $sum: '$profit' },
          count: { $sum: 1 },
        },
      },
    ]);

    // Today's profit is already available from the aggregation below via $profit field.
    // No need for a separate $lookup-based calculateProfit call.

    // Get total due from all customers
    const customerDueResult = await Customer.aggregate([
      {
        $match: {
          shop: new mongoose.Types.ObjectId(shopId),
          isActive: true,
        },
      },
      {
        $group: {
          _id: null,
          totalDue: { $sum: '$totalDue' },
        },
      },
    ]);

    // Get low stock count
    const lowStockCount = await Product.countDocuments({
      shop: shopId,
      isActive: true,
      $expr: { $lt: ['$stock', '$minStock'] },
    });

    // Get total customers
    const totalCustomers = await Customer.countDocuments({
      shop: shopId,
      isActive: true,
    });

    // Get total products
    const totalProducts = await Product.countDocuments({
      shop: shopId,
      isActive: true,
    });

    // Get recent sales
    const recentSales = await Sale.find({
      shop: shopId,
      status: { $ne: 'cancelled' },
    })
      .populate('customer', 'name phone')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    // Get top selling products (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const topProducts = await Sale.aggregate([
      {
        $match: {
          shop: new mongoose.Types.ObjectId(shopId),
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
      { $sort: { totalQuantity: -1 } },
      { $limit: 5 },
    ]);

    // Get sales chart data (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const salesChart = await Sale.aggregate([
      {
        $match: {
          shop: new mongoose.Types.ObjectId(shopId),
          status: { $ne: 'cancelled' },
          createdAt: { $gte: sevenDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
          },
          sales: { $sum: '$total' },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const todaySales = todaySalesResult[0] || { totalSales: 0, totalPaid: 0, totalDue: 0, totalProfit: 0, count: 0 };
    const totalDue = customerDueResult[0]?.totalDue || 0;

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
    };

    // Cache the result
    await cacheService.set(cacheKey, result, getTTL.dashboardStats);
    return result;
  }


  // Get sales report — uses $facet to combine period breakdown, summary, and profit in a single pipeline
  async getSalesReport(shopId, options = {}) {
    const { startDate, endDate, groupBy = 'day' } = options;

    const matchStage = {
      shop: new mongoose.Types.ObjectId(shopId),
      status: { $ne: 'cancelled' },
    };

    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) matchStage.createdAt.$gte = new Date(startDate);
      if (endDate) matchStage.createdAt.$lte = new Date(endDate);
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
                totalSales: { $sum: '$total' },
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
                totalSales: { $sum: '$total' },
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
  async getProductReport(shopId, options = {}) {
    const { startDate, endDate } = options;

    // Top selling products
    const matchStage = {
      shop: new mongoose.Types.ObjectId(shopId),
      status: { $ne: 'cancelled' },
    };

    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) matchStage.createdAt.$gte = new Date(startDate);
      if (endDate) matchStage.createdAt.$lte = new Date(endDate);
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
      { $sort: { totalQuantity: -1 } },
      { $limit: 20 },
    ]);

    // Low stock products
    const lowStock = await Product.find({
      shop: shopId,
      isActive: true,
      $expr: { $lt: ['$stock', '$minStock'] },
    })
      .select('name code stock minStock sellingPrice')
      .sort({ stock: 1 })
      .limit(20)
      .lean();

    // No stock products
    const noStock = await Product.find({
      shop: shopId,
      isActive: true,
      stock: { $lte: 0 },
    })
      .select('name code stock minStock sellingPrice')
      .limit(20)
      .lean();

    // Product summary
    const summaryResult = await Product.aggregate([
      {
        $match: {
          shop: new mongoose.Types.ObjectId(shopId),
          isActive: true,
        },
      },
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
  async getCustomerReport(shopId, options = {}) {
    const { startDate, endDate } = options;

    // Top customers by purchase
    const topCustomers = await Customer.find({
      shop: shopId,
      isActive: true,
    })
      .select('name phone totalPurchases totalPaid totalDue purchaseCount lastPurchase')
      .sort({ totalPurchases: -1 })
      .limit(20)
      .lean();

    // Customers with due
    const customersWithDue = await Customer.find({
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

    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) matchStage.createdAt.$gte = new Date(startDate);
      if (endDate) matchStage.createdAt.$lte = new Date(endDate);
    }

    const newCustomers = await Customer.find(matchStage)
      .select('name phone createdAt')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    // Customer summary
    const summaryResult = await Customer.aggregate([
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
  async getDailySummary(shopId, options = {}) {
    const { date } = options;
    // Use Bangladesh today if no date provided
    const dateStr = date || getBangladeshTodayStr();

    // Try cache first
    const cacheKey = KEYS.DAILY_SUMMARY(shopId, dateStr);
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
        { $match: { shop: shopObjId, status: { $ne: 'cancelled' }, ...dateMatch } },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$total' },
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
        { $match: { shop: shopObjId, status: { $ne: 'cancelled' }, ...dateMatch } },
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
        { $match: { shop: shopObjId, status: { $ne: 'cancelled' }, ...dateMatch } },
        {
          $group: {
            _id: { $hour: '$createdAt' },
            revenue: { $sum: '$total' },
            profit: { $sum: '$profit' },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // 4. Expenses summary
      Expense.aggregate([
        { $match: { shop: shopObjId, ...expenseDateMatch } },
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
        { $match: { shop: shopObjId, ...expenseDateMatch } },
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
        { $match: { shop: shopObjId, status: { $ne: 'cancelled' }, ...dateMatch } },
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
            shop: shopObjId,
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
        { $match: { shop: shopObjId, ...dateMatch } },
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
        shop: shopObjId,
        date: { $gte: startOfDay, $lte: endOfDay },
      }).lean(),

      // 10. Top products sold today
      Sale.aggregate([
        { $match: { shop: shopObjId, status: { $ne: 'cancelled' }, ...dateMatch } },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            productName: { $first: '$items.productName' },
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: '$items.total' },
          },
        },
        { $sort: { totalQuantity: -1 } },
        { $limit: 10 },
      ]),

      // 11. Low stock products
      Product.find({
        shop: shopObjId,
        isActive: true,
        $expr: { $lte: ['$stock', '$minStock'] },
      })
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
    const netEarnings = sales.totalProfit - expenses.totalExpenses - returns.totalProfitLoss;

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

  // Get Profit & Loss statement
  async getProfitLoss(shopId, options = {}) {
    const { startDate, endDate } = options;

    // Try cache first
    const cacheKey = KEYS.PROFIT_LOSS(shopId, startDate, endDate);
    const cached = await cacheService.get(cacheKey);
    if (cached) return cached;

    const shopObjId = new mongoose.Types.ObjectId(shopId);

    const dateMatch = {};
    if (startDate || endDate) {
      dateMatch.createdAt = {};
      if (startDate) dateMatch.createdAt.$gte = new Date(startDate);
      if (endDate) dateMatch.createdAt.$lte = new Date(endDate);
    }

    const expenseDateMatch = {};
    if (startDate || endDate) {
      expenseDateMatch.date = {};
      if (startDate) expenseDateMatch.date.$gte = new Date(startDate);
      if (endDate) expenseDateMatch.date.$lte = new Date(endDate);
    }

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
            shop: shopObjId,
            status: { $ne: 'cancelled' },
            ...dateMatch,
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$total' },
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
            shop: shopObjId,
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
            shop: shopObjId,
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
            shop: shopObjId,
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
            shop: shopObjId,
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
            shop: shopObjId,
            status: { $ne: 'cancelled' },
            ...dateMatch,
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
            },
            revenue: { $sum: '$total' },
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
            shop: shopObjId,
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
    const netProfit = sales.totalProfit - expenses.totalExpenses - returns.totalProfitLoss;

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
  async getDateWiseSummary(shopId, options = {}) {
    const { month } = options; // format: 'YYYY-MM'
    const shopObjId = new mongoose.Types.ObjectId(shopId);

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
            shop: shopObjId,
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
            totalSales: { $sum: '$total' },
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
            shop: shopObjId,
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
  async getSalesByDate(shopId, dateStr) {
    const shopObjId = new mongoose.Types.ObjectId(shopId);
    const { startOfDay, endOfDay } = getBangladeshDayRange(dateStr);

    const [sales, summary, expenseTotal] = await Promise.all([
      Sale.find({
        shop: shopObjId,
        createdAt: { $gte: startOfDay, $lte: endOfDay },
      })
        .populate('customer', 'name phone')
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 })
        .lean(),

      Sale.aggregate([
        {
          $match: {
            shop: shopObjId,
            status: { $ne: 'cancelled' },
            createdAt: { $gte: startOfDay, $lte: endOfDay },
          },
        },
        {
          $group: {
            _id: null,
            totalSales: { $sum: '$total' },
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
            shop: shopObjId,
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
  async getTrendingProducts(shopId, options = {}) {
    const { period = 7, limit = 20 } = options;
    const shopObjId = new mongoose.Types.ObjectId(shopId);

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
            shop: shopObjId,
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
        { $sort: { totalQuantity: -1 } },
      ]),

      Sale.aggregate([
        {
          $match: {
            shop: shopObjId,
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
        currentPeriodQty: curr.totalQuantity,
        previousPeriodQty: prevQty,
        currentRevenue: curr.totalRevenue,
        previousRevenue: prevRevenue,
        growthPercent: Math.round(growthPercent),
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
        previousPeriodQty: prev.totalQuantity,
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
      .sort((a, b) => b.currentPeriodQty - a.currentPeriodQty)
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

  // Export report (placeholder - implement actual export logic)
  async exportReport(shopId, type, format, options) {
    // This would generate actual PDF/Excel/CSV files
    // For now, return the data
    let data;
    switch (type) {
      case 'sales':
        data = await this.getSalesReport(shopId, options);
        break;
      case 'products':
        data = await this.getProductReport(shopId, options);
        break;
      case 'customers':
        data = await this.getCustomerReport(shopId, options);
        break;
      default:
        throw new Error('Invalid report type');
    }

    return data;
  }
}

module.exports = new ReportService();
