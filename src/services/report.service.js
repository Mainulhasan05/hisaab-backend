const Sale = require('../models/Sale.model');
const Product = require('../models/Product.model');
const Customer = require('../models/Customer.model');
const Payment = require('../models/Payment.model');
const Expense = require('../models/Expense.model');
const SalesReturn = require('../models/SalesReturn.model');
const Purchase = require('../models/Purchase.model');
const mongoose = require('mongoose');

class ReportService {
  // Get dashboard statistics
  async getDashboardStats(shopId) {
    const today = new Date();
    const startOfDay = new Date(today);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);

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
          count: { $sum: 1 },
        },
      },
    ]);

    // Calculate today's profit
    const todayProfit = await this.calculateProfit(shopId, startOfDay, endOfDay);

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

    const todaySales = todaySalesResult[0] || { totalSales: 0, totalPaid: 0, totalDue: 0, count: 0 };
    const totalDue = customerDueResult[0]?.totalDue || 0;

    return {
      todaySales: todaySales.totalSales,
      todayProfit: todayProfit,
      todayOrders: todaySales.count,
      totalDue,
      lowStockCount,
      totalCustomers,
      totalProducts,
      recentSales,
      topProducts,
      salesChart,
    };
  }

  // Calculate profit for date range
  async calculateProfit(shopId, startDate, endDate) {
    const result = await Sale.aggregate([
      {
        $match: {
          shop: new mongoose.Types.ObjectId(shopId),
          status: { $ne: 'cancelled' },
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      { $unwind: '$items' },
      {
        $lookup: {
          from: 'products',
          localField: 'items.product',
          foreignField: '_id',
          as: 'productDetails',
        },
      },
      { $unwind: '$productDetails' },
      {
        $project: {
          profit: {
            $multiply: [
              { $subtract: ['$items.unitPrice', '$productDetails.buyingPrice'] },
              '$items.quantity',
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          totalProfit: { $sum: '$profit' },
        },
      },
    ]);

    return result[0]?.totalProfit || 0;
  }

  // Get sales report
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

    const data = await Sale.aggregate([
      { $match: matchStage },
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
    ]);

    // Get summary
    const summaryResult = await Sale.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalSales: { $sum: '$total' },
          totalPaid: { $sum: '$paid' },
          totalDue: { $sum: '$due' },
          count: { $sum: 1 },
        },
      },
    ]);

    const summary = summaryResult[0] || { totalSales: 0, totalPaid: 0, totalDue: 0, count: 0 };

    // Calculate profit
    const profit = await this.calculateProfit(
      shopId,
      startDate ? new Date(startDate) : new Date(0),
      endDate ? new Date(endDate) : new Date()
    );

    return {
      data,
      summary: {
        ...summary,
        totalProfit: profit,
      },
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

  // Get Profit & Loss statement
  async getProfitLoss(shopId, options = {}) {
    const { startDate, endDate } = options;
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

    return {
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
