const Shop = require('../models/Shop.model');
const User = require('../models/User.model');
const Admin = require('../models/Admin.model');
const Sale = require('../models/Sale.model');
const Purchase = require('../models/Purchase.model');
const Expense = require('../models/Expense.model');
const CashRegister = require('../models/CashRegister.model');
const StockTransaction = require('../models/StockTransaction.model');
const SalesReturn = require('../models/SalesReturn.model');
const SMSLog = require('../models/SMSLog.model');
const SMSQuota = require('../models/SMSQuota.model');
const AuditLog = require('../models/AuditLog.model');
const Payment = require('../models/Payment.model');
const Product = require('../models/Product.model');
const Branch = require('../models/Branch.model');
const HeldCart = require('../models/HeldCart.model');
const mongoose = require('mongoose');
const { AUDIT_ACTIONS } = require('../config/constants');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { AppError } = require('../middleware/error.middleware');
const cacheService = require('./cache.service');
const { invalidateShopAuthCache, invalidateBranchCache } = require('../utils/authCache.util');
const { refuseDeletion } = require('../utils/deletionDisabled.util');
const { KEYS, getTTL } = require('../config/cacheKeys');
const { FEATURES, FEATURE_KEYS } = require('../utils/features.util');

const escapeRegex = (value) => String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Parses a filter boundary into a Date pinned to the edge of the day it names.
 *
 * A bare `YYYY-MM-DD` from an `<input type="date">` parses as UTC midnight, so
 * an unadjusted `endDate` excludes everything logged on the day the operator
 * actually asked for. The suffix is applied before parsing rather than via
 * setHours() so the window does not shift with the server's local zone.
 */
const dayBoundary = (value, edge) => {
  const raw = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}${edge === 'end' ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}`
    : raw;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

class AdminService {
  // Admin login
  async login(phone, password) {
    const admin = await Admin.findOne({ phone, isActive: true }).select('+password');
    if (!admin) {
      throw new AppError('ফোন নম্বর বা পাসওয়ার্ড সঠিক নয়', 'Invalid credentials', 401);
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      throw new AppError('ফোন নম্বর বা পাসওয়ার্ড সঠিক নয়', 'Invalid credentials', 401);
    }

    // Update last login
    admin.lastLogin = new Date();
    await admin.save();

    // Generate token
    const token = jwt.sign(
      { id: admin._id, role: admin.role, isAdmin: true },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
    );

    return {
      admin: {
        id: admin._id,
        name: admin.name,
        phone: admin.phone,
        role: admin.role,
      },
      token,
    };
  }

  // Get admin statistics
  async getStats() {
    // Try cache first
    const cacheKey = KEYS.ADMIN_STATS();
    const cached = await cacheService.get(cacheKey);
    if (cached) return cached;

    // Date helpers
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);

    const [
      totalShops,
      activeShops,
      paidShops,
      expiredShops,
      suspendedShops,
      totalUsers,
      todayNewShops,
      todayNewUsers,
    ] = await Promise.all([
      Shop.countDocuments(),
      Shop.countDocuments({ 'subscription.status': 'active' }),
      Shop.countDocuments({ 'subscription.plan': 'paid' }),
      Shop.countDocuments({ 'subscription.status': 'expired' }),
      Shop.countDocuments({ 'subscription.status': 'suspended' }),
      User.countDocuments({ isActive: true }),
      Shop.countDocuments({ createdAt: { $gte: todayStart } }),
      User.countDocuments({ createdAt: { $gte: todayStart } }),
    ]);

    // Today's sales stats across all shops
    const todaySalesResult = await Sale.aggregate([
      { $match: { createdAt: { $gte: todayStart }, status: { $ne: 'cancelled' } } },
      {
        $group: {
          _id: null,
          totalSales: { $sum: 1 },
          totalRevenue: { $sum: '$grandTotal' },
          totalItems: { $sum: { $size: '$items' } },
        },
      },
    ]);

    // Yesterday's sales for comparison
    const yesterdaySalesResult = await Sale.aggregate([
      { $match: { createdAt: { $gte: yesterdayStart, $lt: todayStart }, status: { $ne: 'cancelled' } } },
      { $group: { _id: null, totalRevenue: { $sum: '$grandTotal' } } },
    ]);

    // This month's sales
    const monthSalesResult = await Sale.aggregate([
      { $match: { createdAt: { $gte: monthStart }, status: { $ne: 'cancelled' } } },
      {
        $group: {
          _id: null,
          totalSales: { $sum: 1 },
          totalRevenue: { $sum: '$grandTotal' },
        },
      },
    ]);

    // Subscription revenue
    const revenueResult = await Payment.aggregate([
      { $match: { type: 'subscription' } },
      { $group: { _id: null, totalRevenue: { $sum: '$amount' } } },
    ]);

    const monthlyRevenueResult = await Payment.aggregate([
      { $match: { type: 'subscription', createdAt: { $gte: monthStart } } },
      { $group: { _id: null, monthlyRevenue: { $sum: '$amount' } } },
    ]);

    // Today's new customers across all shops
    const Customer = require('../models/Customer.model');
    const todayNewCustomers = await Customer.countDocuments({ createdAt: { $gte: todayStart } });

    // Calculate growth percentages
    const todayRevenue = todaySalesResult[0]?.totalRevenue || 0;
    const yesterdayRevenue = yesterdaySalesResult[0]?.totalRevenue || 0;
    const revenueGrowth = yesterdayRevenue > 0
      ? Math.round(((todayRevenue - yesterdayRevenue) / yesterdayRevenue) * 100)
      : 0;

    // Today's new products across all shops
    const Product = require('../models/Product.model');
    const todayNewProducts = await Product.countDocuments({ createdAt: { $gte: todayStart } });

    const result = {
      // Shop stats
      totalShops,
      activeShops,
      paidShops,
      expiredShops,
      suspendedShops,
      totalUsers,

      // Today's stats (formatted for dashboard display)
      today: {
        sales: todaySalesResult[0]?.totalSales || 0,
        salesAmount: todaySalesResult[0]?.totalRevenue || 0,
        customers: todayNewCustomers,
        products: todayNewProducts,
        shops: todayNewShops,
        users: todayNewUsers,
        itemsSold: todaySalesResult[0]?.totalItems || 0,
      },

      // Legacy fields (for backward compatibility)
      todayNewShops,
      todayNewUsers,
      todayNewCustomers,
      todaySalesCount: todaySalesResult[0]?.totalSales || 0,
      todaySalesRevenue: todaySalesResult[0]?.totalRevenue || 0,
      todayItemsSold: todaySalesResult[0]?.totalItems || 0,

      // Month stats
      monthSalesCount: monthSalesResult[0]?.totalSales || 0,
      monthSalesRevenue: monthSalesResult[0]?.totalRevenue || 0,

      // Subscription revenue
      totalRevenue: revenueResult[0]?.totalRevenue || 0,
      monthlyRevenue: monthlyRevenueResult[0]?.monthlyRevenue || 0,

      // Growth
      revenueGrowth,
    };

    // Cache the result
    await cacheService.set(cacheKey, result, getTTL.adminStats);
    return result;
  }

  // Get top performers (shops, products)
  async getTopPerformers() {
    // Try cache first
    const cacheKey = KEYS.ADMIN_TOP_PERFORMERS();
    const cached = await cacheService.get(cacheKey);
    if (cached) return cached;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Top 5 shops by sales revenue (last 30 days)
    const topShops = await Sale.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo }, status: { $ne: 'cancelled' } } },
      {
        $group: {
          _id: '$shop',
          totalRevenue: { $sum: '$grandTotal' },
          totalSales: { $sum: 1 },
        },
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'shops',
          localField: '_id',
          foreignField: '_id',
          as: 'shopDetails',
        },
      },
      { $unwind: '$shopDetails' },
      {
        $project: {
          _id: 1,
          name: '$shopDetails.name',
          address: '$shopDetails.address',
          totalRevenue: 1,
          totalSales: 1,
        },
      },
    ]);

    // Top 5 products by quantity sold (last 30 days)
    const topProducts = await Sale.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo }, status: { $ne: 'cancelled' } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.product',
          totalQuantity: { $sum: '$items.quantity' },
          totalRevenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
          name: { $first: '$items.productName' },
        },
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: 5 },
    ]);

    // Most active shops (by number of transactions today)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const mostActiveToday = await Sale.aggregate([
      { $match: { createdAt: { $gte: todayStart } } },
      {
        $group: {
          _id: '$shop',
          salesCount: { $sum: 1 },
        },
      },
      { $sort: { salesCount: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'shops',
          localField: '_id',
          foreignField: '_id',
          as: 'shopDetails',
        },
      },
      { $unwind: '$shopDetails' },
      {
        $project: {
          _id: 1,
          name: '$shopDetails.name',
          salesCount: 1,
        },
      },
    ]);

    const result = {
      topShops,
      topProducts,
      mostActiveToday,
    };

    // Cache the result
    await cacheService.set(cacheKey, result, getTTL.adminTopPerformers);
    return result;
  }

  // Get system metrics
  async getSystemMetrics() {
    // Try cache first
    const cacheKey = KEYS.ADMIN_SYSTEM_METRICS();
    const cached = await cacheService.get(cacheKey);
    if (cached) return cached;

    const Product = require('../models/Product.model');
    const Customer = require('../models/Customer.model');
    const Expense = require('../models/Expense.model');

    // Helper to format bytes
    const formatBytes = (bytes) => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    // Helper to format uptime
    const formatUptime = (seconds) => {
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      if (days > 0) return `${days}d ${hours}h ${mins}m`;
      if (hours > 0) return `${hours}h ${mins}m`;
      return `${mins}m`;
    };

    const [
      totalProducts,
      totalCustomers,
      totalSales,
      totalExpenses,
      totalAuditLogs,
    ] = await Promise.all([
      Product.countDocuments(),
      Customer.countDocuments(),
      Sale.countDocuments(),
      Expense.countDocuments(),
      AuditLog.countDocuments(),
    ]);

    // Database stats
    const dbStats = await mongoose.connection.db.stats();

    // Get collection sizes
    const collections = await mongoose.connection.db.listCollections().toArray();
    const collectionStats = [];

    for (const col of collections.slice(0, 10)) { // Top 10 collections
      try {
        const stats = await mongoose.connection.db.collection(col.name).stats();
        collectionStats.push({
          name: col.name,
          count: stats.count,
          size: formatBytes(stats.size),
          sizeRaw: stats.size,
          avgObjSize: stats.avgObjSize,
        });
      } catch (e) {
        // Skip if can't get stats
      }
    }

    // Sort by size
    collectionStats.sort((a, b) => b.sizeRaw - a.sizeRaw);

    // Format memory usage
    const memUsage = process.memoryUsage();

    const result = {
      database: {
        name: dbStats.db,
        collections: dbStats.collections,
        dataSize: formatBytes(dbStats.dataSize),
        storageSize: formatBytes(dbStats.storageSize),
        indexes: dbStats.indexes,
        indexSize: formatBytes(dbStats.indexSize),
      },
      counts: {
        shops: await Shop.countDocuments(),
        users: await User.countDocuments(),
        products: totalProducts,
        customers: totalCustomers,
        sales: totalSales,
        expenses: totalExpenses,
        auditLogs: totalAuditLogs,
      },
      topCollections: collectionStats.slice(0, 5),
      serverTime: new Date(),
      nodeVersion: process.version,
      memoryUsage: {
        heapUsed: formatBytes(memUsage.heapUsed),
        heapTotal: formatBytes(memUsage.heapTotal),
        rss: formatBytes(memUsage.rss),
        external: formatBytes(memUsage.external),
      },
      uptime: formatUptime(process.uptime()),
    };

    // Cache the result
    await cacheService.set(cacheKey, result, getTTL.adminSystemMetrics);
    return result;
  }

  // Get all shops with filtering
  async getAllShops(options = {}) {
    const {
      page = 1,
      limit = 20,
      status,
      search,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;

    const query = {};
    const now = new Date();

    // Filter by subscription status — expired includes shops with status='active' but past expiresAt
    if (status === 'expired') {
      query.$or = [
        { 'subscription.status': 'expired' },
        { 'subscription.status': 'active', 'subscription.expiresAt': { $lt: now } },
      ];
    } else if (status === 'active') {
      query['subscription.status'] = 'active';
      query.$or = [
        { 'subscription.expiresAt': { $gt: now } },
        { 'subscription.expiresAt': null },
        { 'subscription.expiresAt': { $exists: false } },
      ];
    } else if (status) {
      query['subscription.status'] = status;
    }

    // Search by name, phone, or owner
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (page - 1) * limit;
    const sortField = ['createdAt', 'name', 'subscription.expiresAt'].includes(sortBy) ? sortBy : 'createdAt';
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

    const [shops, total] = await Promise.all([
      Shop.find(query)
        .populate('owner', 'name phone')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Shop.countDocuments(query),
    ]);

    // Fetch SMS quotas for all shops
    const shopIds = shops.map(s => s._id);
    const smsQuotas = await SMSQuota.find({ shop: { $in: shopIds } }).lean();
    const quotaMap = new Map(smsQuotas.map(q => [q.shop.toString(), q]));

    // Merge SMS quota data with shops, compute effective status, and fetch real-time stats
    const shopsWithQuota = await Promise.all(shops.map(async (shop) => {
      // Compute effective status: active in DB but past expiresAt = effectively expired
      let effectiveStatus = shop.subscription?.status || 'trial';
      if (
        effectiveStatus === 'active' &&
        shop.subscription?.expiresAt &&
        new Date(shop.subscription.expiresAt) < now
      ) {
        effectiveStatus = 'expired';
      }

      // Query real-time stats
      const [totalProducts, salesStats] = await Promise.all([
        Product.countDocuments({ shop: shop._id, isActive: true }),
        Sale.aggregate([
          {
            $match: {
              shop: shop._id,
              status: { $ne: 'cancelled' }
            }
          },
          {
            $group: {
              _id: null,
              totalSales: { $sum: '$total' }
            }
          }
        ])
      ]);

      const totalSales = salesStats[0]?.totalSales || 0;

      return {
        ...shop,
        effectiveStatus,
        smsQuota: quotaMap.get(shop._id.toString()) || null,
        stats: {
          totalProducts,
          totalSales,
          totalCustomers: shop.stats?.totalCustomers || 0,
          totalRevenue: shop.stats?.totalRevenue || 0
        }
      };
    }));

    // Fetch registration audit logs (IP/device) for all shops in this page
    const registrationLogs = await AuditLog.find({
      shop: { $in: shopIds },
      action: 'user_register',
    }).sort({ createdAt: 1 }).lean();

    // Map: first registration log per shop
    const regLogMap = new Map();
    for (const log of registrationLogs) {
      const sid = log.shop.toString();
      if (!regLogMap.has(sid)) regLogMap.set(sid, log);
    }

    // Merge registration info
    const shopsWithRegInfo = shopsWithQuota.map(shop => {
      const regLog = regLogMap.get(shop._id.toString());
      return {
        ...shop,
        registrationInfo: regLog?.metadata ? {
          ip: regLog.metadata.ip || null,
          browser: regLog.metadata.browser || null,
          os: regLog.metadata.os || null,
          device: regLog.metadata.device || null,
          userAgent: regLog.metadata.userAgent || null,
        } : null,
      };
    });

    return {
      data: shopsWithRegInfo,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Get shop details
  async getShopDetails(shopId) {
    const shop = await Shop.findById(shopId)
      .populate('owner', 'name phone isOwner');

    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    // Get shop statistics
    const [usersCount, customersCount, productsCount, salesStats, smsQuota] = await Promise.all([
      User.countDocuments({ shop: shopId, isActive: true }),
      mongoose.model('Customer').countDocuments({ shop: shopId, isActive: true }),
      mongoose.model('Product').countDocuments({ shop: shopId, isActive: true }),
      Sale.aggregate([
        {
          $match: {
            shop: new mongoose.Types.ObjectId(shopId),
            status: { $ne: 'cancelled' },
          },
        },
        {
          $group: {
            _id: null,
            totalSales: { $sum: '$total' },
            salesCount: { $sum: 1 },
          },
        },
      ]),
      SMSQuota.findOne({ shop: shopId }),
    ]);

    // Fetch branches for this shop
    const branches = await Branch.find({ shop: shopId }).sort({ createdAt: -1 });

    // Fetch registration audit log for IP/device info
    const registrationLog = await AuditLog.findOne({
      shop: shopId,
      action: 'user_register',
    }).sort({ createdAt: 1 }).lean();

    return {
      ...shop.toObject(),
      branches: branches.map(b => b.toObject()),
      registrationInfo: registrationLog?.metadata ? {
        ip: registrationLog.metadata.ip || null,
        browser: registrationLog.metadata.browser || null,
        os: registrationLog.metadata.os || null,
        device: registrationLog.metadata.device || null,
        userAgent: registrationLog.metadata.userAgent || null,
      } : null,
      statistics: {
        usersCount,
        customersCount,
        productsCount,
        totalSales: salesStats[0]?.totalSales || 0,
        salesCount: salesStats[0]?.salesCount || 0,
        smsQuota: smsQuota ? {
          total: smsQuota.totalQuota,
          used: smsQuota.usedQuota,
          remaining: smsQuota.remainingQuota,
        } : null,
      },
    };
  }

  // Get all products across all shops
  async getAllProducts(options = {}) {
    const {
      page = 1,
      limit = 20,
      search,
      shopId,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;

    const query = {};

    if (shopId) {
      query.shop = shopId;
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { barcode: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (page - 1) * limit;
    const validSortFields = ['createdAt', 'name', 'sellingPrice', 'stock'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

    const [products, total] = await Promise.all([
      Product.find(query)
        .populate('shop', 'name phone')
        .populate('category', 'name')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Product.countDocuments(query),
    ]);

    return {
      data: products,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Update shop status
  async updateShopStatus(adminId, shopId, status, reason) {
    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    const previousStatus = shop.subscription.status;
    shop.subscription.status = status;
    // Only suspended shops should be deactivated — trial/active/expired shops remain accessible
    shop.isActive = status !== 'suspended';
    await shop.save();
    await invalidateShopAuthCache(shop._id);

    // Create audit log
    await AuditLog.create({
      admin: adminId,
      action: 'shop_status_update',
      actionBn: 'দোকানের স্ট্যাটাস পরিবর্তন',
      description: `Updated shop ${shop.name} status from ${previousStatus} to ${status}. Reason: ${reason}`,
      descriptionBn: `${shop.name} এর স্ট্যাটাস ${previousStatus} থেকে ${status} করা হয়েছে। কারণ: ${reason}`,
      entity: {
        type: 'shop',
        id: shop._id,
        name: shop.name,
      },
      changes: {
        before: { status: previousStatus },
        after: { status },
      },
    });

    return shop;
  }

  // Update shop subscription (admin sets expiry directly)
  async updateShopSubscription(adminId, shopId, expiresAt) {
    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    const previousExpiry = shop.subscription.expiresAt;

    shop.subscription.plan = 'paid';
    shop.subscription.expiresAt = new Date(expiresAt);
    shop.subscription.status = 'active';
    shop.isActive = true;
    await shop.save();
    await invalidateShopAuthCache(shop._id);

    // Create audit log
    await AuditLog.create({
      admin: adminId,
      action: 'subscription_update',
      actionBn: 'সাবস্ক্রিপশন আপডেট',
      description: `Updated subscription for ${shop.name}: expires ${new Date(expiresAt).toLocaleDateString()}`,
      descriptionBn: `${shop.name} এর সাবস্ক্রিপশন আপডেট করা হয়েছে`,
      entity: {
        type: 'shop',
        id: shop._id,
        name: shop.name,
      },
      changes: {
        before: { expiresAt: previousExpiry },
        after: { expiresAt },
      },
    });

    return shop;
  }

  // Get subscription payments
  async getSubscriptionPayments(options = {}) {
    const { page = 1, limit = 20, shopId } = options;

    const query = { type: 'subscription' };
    if (shopId) {
      query.shop = shopId;
    }

    const skip = (page - 1) * limit;

    const [payments, total] = await Promise.all([
      Payment.find(query)
        .populate('shop', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Payment.countDocuments(query),
    ]);

    return {
      data: payments,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Record subscription payment (flat ১০০০৳/month)
  async recordSubscriptionPayment(adminId, paymentData) {
    const { shopId, amount, months = 1, method, transactionId, notes } = paymentData;

    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    // Create payment record
    const payment = await Payment.create({
      shop: shopId,
      amount,
      method,
      transactionId,
      type: 'subscription',
      notes: `Subscription: ${months} month(s). ${notes || ''}`,
      receivedBy: adminId,
    });

    // Calculate new expiry date (extend from current expiry or now)
    const currentExpiry = shop.subscription.expiresAt > new Date()
      ? shop.subscription.expiresAt
      : new Date();
    const newExpiry = new Date(currentExpiry);
    newExpiry.setMonth(newExpiry.getMonth() + months);

    // Update shop subscription
    shop.subscription.plan = 'paid';
    shop.subscription.expiresAt = newExpiry;
    shop.subscription.status = 'active';
    shop.isActive = true;
    await shop.save();
    await invalidateShopAuthCache(shop._id);

    // Create audit log
    await AuditLog.create({
      admin: adminId,
      action: 'payment_recorded',
      actionBn: 'পেমেন্ট রেকর্ড',
      description: `Recorded payment ৳${amount} for ${shop.name} (${months} month(s))`,
      descriptionBn: `${shop.name} এর জন্য ৳${amount} পেমেন্ট রেকর্ড করা হয়েছে (${months} মাস)`,
      entity: {
        type: 'shop',
        id: shop._id,
        name: shop.name,
      },
    });

    return { payment, shop };
  }

  // Allocate SMS quota
  async allocateSMSQuota(adminId, allocationData) {
    const { shopId, quantity, price, paymentMethod, transactionId, notes } = allocationData;

    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    // Find or create SMS quota
    let smsQuota = await SMSQuota.findOne({ shop: shopId });
    if (!smsQuota) {
      smsQuota = await SMSQuota.create({
        shop: shopId,
        totalQuota: 0,
        usedQuota: 0,
        remainingQuota: 0,
        isEnabled: true,
      });
    }

    // Update quota
    smsQuota.totalQuota += quantity;
    smsQuota.remainingQuota += quantity;
    smsQuota.isEnabled = true;
    smsQuota.allocations.push({
      quantity,
      price,
      allocatedBy: adminId,
      allocatedAt: new Date(),
      paymentMethod,
      transactionId,
    });
    await smsQuota.save();

    // Create audit log
    await AuditLog.create({
      admin: adminId,
      action: 'sms_allocation',
      actionBn: 'এসএমএস বরাদ্দ',
      description: `Allocated ${quantity} SMS to ${shop.name}`,
      descriptionBn: `${shop.name} কে ${quantity} এসএমএস বরাদ্দ করা হয়েছে`,
      entity: {
        type: 'shop',
        id: shop._id,
        name: shop.name,
      },
      changes: {
        before: { remainingQuota: smsQuota.remainingQuota - quantity },
        after: { remainingQuota: smsQuota.remainingQuota },
      },
    });

    return smsQuota;
  }

  // ── Telegram notifications ────────────────────────────────────────────

  /**
   * Delivery log for every Telegram message the platform has sent.
   *
   * There is deliberately no companion "clear logs" method: the collection
   * carries a 90-day TTL index and purges itself, and hard deletion from the
   * admin panel is disabled platform-wide (utils/deletionDisabled.util.js).
   */
  async getTelegramLogs(options = {}) {
    const { page = 1, limit = 50, shopId, status, eventType } = options;
    const NotificationLog = require('../models/NotificationLog.model');

    const query = { channel: 'telegram' };
    if (shopId) query.shop = shopId;
    if (status) query.status = status;
    if (eventType) query.eventType = eventType;

    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      NotificationLog.find(query)
        .populate('shop', 'name')
        .populate('user', 'name phone')
        .sort({ sentAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      NotificationLog.countDocuments(query),
    ]);

    return {
      data: logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /** Every shop currently receiving Telegram notifications. */
  async getTelegramLinks(options = {}) {
    const { page = 1, limit = 50 } = options;
    const TelegramLink = require('../models/TelegramLink.model');

    const query = { isActive: true };
    const skip = (page - 1) * limit;

    const [links, total] = await Promise.all([
      TelegramLink.find(query)
        .populate('shop', 'name phone')
        .populate('user', 'name phone')
        .sort({ linkedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      TelegramLink.countDocuments(query),
    ]);

    return {
      data: links,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Headline numbers for the Telegram page.
   *
   * "Today" here is the server's last 24 hours rather than a Bangladesh
   * calendar day — this is an operator health check ("is delivery working right
   * now?"), not a business figure that has to reconcile with a shop's books.
   */
  async getTelegramStats() {
    const NotificationLog = require('../models/NotificationLog.model');
    const TelegramLink = require('../models/TelegramLink.model');

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [byStatus, connectedShops, mutedShops] = await Promise.all([
      NotificationLog.aggregate([
        { $match: { channel: 'telegram', sentAt: { $gte: since } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      TelegramLink.countDocuments({ isActive: true }),
      TelegramLink.countDocuments({ isActive: true, 'preferences.dailySummary': false }),
    ]);

    const counts = byStatus.reduce((acc, row) => ({ ...acc, [row._id]: row.count }), {});

    return {
      last24h: {
        sent: counts.sent || 0,
        failed: counts.failed || 0,
        blocked: counts.blocked || 0,
      },
      connectedShops,
      mutedShops,
    };
  }

  // Get all SMS logs (admin level - all shops)
  async getSMSLogs(options = {}) {
    const { page = 1, limit = 50, shopId, status, type } = options;
    const SMSLog = require('../models/SMSLog.model');

    const query = {};
    if (shopId) query.shop = shopId;
    if (status) query.status = status;
    if (type) query.type = type;

    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      SMSLog.find(query)
        .populate('shop', 'name')
        .populate('sentBy', 'name phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      SMSLog.countDocuments(query),
    ]);

    return {
      data: logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Get SMS allocation history (all shops)
  async getSMSAllocations(options = {}) {
    const { page = 1, limit = 50, shopId } = options;

    const query = {};
    if (shopId) query.shop = shopId;

    const skip = (page - 1) * limit;

    const [quotas, total] = await Promise.all([
      SMSQuota.find(query)
        .populate('shop', 'name phone')
        .populate('allocations.allocatedBy', 'name')
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      SMSQuota.countDocuments(query),
    ]);

    // Flatten allocations from all shops
    const allocations = [];
    quotas.forEach(quota => {
      if (quota.allocations && quota.allocations.length > 0) {
        quota.allocations.forEach(alloc => {
          allocations.push({
            ...alloc,
            shop: quota.shop,
            shopQuota: {
              totalQuota: quota.totalQuota,
              usedQuota: quota.usedQuota,
              remainingQuota: quota.remainingQuota,
            },
          });
        });
      }
    });

    // Sort by date descending
    allocations.sort((a, b) => new Date(b.allocatedAt) - new Date(a.allocatedAt));

    return {
      data: allocations.slice(skip, skip + parseInt(limit)),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: allocations.length,
        pages: Math.ceil(allocations.length / limit),
      },
    };
  }

  // Get SMS stats summary
  async getSMSStats() {
    const quotaSummary = await SMSQuota.getQuotaSummary();

    const SMSLog = require('../models/SMSLog.model');

    // Get today's SMS stats
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayStats = await SMSLog.aggregate([
      { $match: { createdAt: { $gte: today } } },
      {
        $group: {
          _id: null,
          totalSent: { $sum: '$sentCount' },
          totalDelivered: { $sum: '$deliveredCount' },
          totalFailed: { $sum: '$failedCount' },
          count: { $sum: 1 },
        },
      },
    ]);

    return {
      ...quotaSummary,
      today: todayStats[0] || { totalSent: 0, totalDelivered: 0, totalFailed: 0, count: 0 },
    };
  }

  // Get all users (shop owners + staff) across all shops (admin level)
  async getAllUsers(options = {}) {
    const User = require('../models/User.model');
    const { page = 1, limit = 30, shopId, search, role } = options;

    const query = {};
    if (shopId) query.shop = shopId;
    if (role) query.role = role;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [users, total] = await Promise.all([
      User.find(query)
        .populate('shop', 'name phone subscription.status subscription.plan isActive')
        .select('-password -otp -permissions')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      User.countDocuments(query),
    ]);

    return {
      data: users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    };
  }

  // Impersonate a user — generates a user JWT WITHOUT creating an audit log
  async impersonateUser(userId) {
    const User = require('../models/User.model');
    const Shop = require('../models/Shop.model');

    const user = await User.findById(userId).select('-password -otp');
    if (!user) {
      const err = new Error('User not found');
      err.statusCode = 404;
      throw err;
    }

    const shop = await Shop.findById(user.shop).lean();
    if (!shop) {
      const err = new Error('Shop not found');
      err.statusCode = 404;
      throw err;
    }

    const token = user.generateToken();
    return { token, user, shop };
  }

  // Get all customers across all shops (admin level)
  async getAllCustomers(options = {}) {
    const Customer = require('../models/Customer.model');
    const { page = 1, limit = 50, shopId, search, hasDue } = options;

    const query = {};
    if (shopId) query.shop = shopId;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }
    if (hasDue === 'true') query.totalDue = { $gt: 0 };

    const skip = (page - 1) * limit;

    const [customers, total] = await Promise.all([
      Customer.find(query)
        .populate('shop', 'name phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Customer.countDocuments(query),
    ]);

    return {
      data: customers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Get all sales across all shops (admin level)
  async getAllSales(options = {}) {
    const { page = 1, limit = 50, shopId, status, startDate, endDate, minAmount, maxAmount } = options;

    const query = {};
    if (shopId) query.shop = shopId;
    if (status) query.status = status;
    if (startDate && endDate) {
      query.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }
    if (minAmount) query.total = { ...query.total, $gte: parseInt(minAmount) };
    if (maxAmount) query.total = { ...query.total, $lte: parseInt(maxAmount) };

    const skip = (page - 1) * limit;

    const [sales, total] = await Promise.all([
      Sale.find(query)
        .populate('shop', 'name phone')
        .populate('customer', 'name phone')
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Sale.countDocuments(query),
    ]);

    return {
      data: sales,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Restrict/suspend shop account
  async restrictShop(adminId, shopId, restrictionData) {
    const { action, reason } = restrictionData;

    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    if (action === 'suspend') {
      shop.subscription.status = 'suspended';
      shop.isActive = false;
    } else if (action === 'activate') {
      shop.subscription.status = 'active';
      shop.isActive = true;
    }

    await shop.save();
    await invalidateShopAuthCache(shop._id);

    // Create audit log
    await AuditLog.create({
      admin: adminId,
      shop: shop._id,
      action: action === 'suspend' ? 'shop_suspend' : 'shop_activate',
      actionBn: action === 'suspend' ? 'দোকান স্থগিত' : 'দোকান সক্রিয়',
      description: `Shop ${shop.name} ${action === 'suspend' ? 'suspended' : 'activated'}. Reason: ${reason || 'N/A'}`,
      descriptionBn: `${shop.name} ${action === 'suspend' ? 'স্থগিত' : 'সক্রিয়'} করা হয়েছে। কারণ: ${reason || 'উল্লেখ নেই'}`,
      entity: {
        type: 'shop',
        id: shop._id,
        name: shop.name,
      },
    });

    return shop;
  }

  /**
   * Shop purge — DISABLED.
   *
   * The previous implementation looped `Model.deleteMany({ shop })` over 15
   * models with `Product` first and `Sale` second. `immutableGuard` rejects
   * `deleteMany` on Sale/Payment/Purchase/Expense with a 403, so the loop
   * deleted the shop's entire product catalogue, threw on the second model, and
   * left the shop, its sales, its users and everything else in place. It could
   * never complete — it only ever destroyed the catalogue.
   *
   * It also never listed 7 collections that reference a shop, which is where
   * Phase 0's 2,830 orphan rows came from.
   *
   * Hard deletion returns as its own piece of work behind step-up
   * authentication. Until then: suspend the shop (`updateShopStatus`), which
   * sets `isActive: false` and locks out every user of that shop immediately.
   */
  async purgeShop() {
    refuseDeletion('a shop', 'Suspend it instead: PATCH /api/admin/shops/:id/status.');
  }


  // Get online users (from cache/heartbeat tracking)
  async getOnlineUsers(options = {}) {
    const onlineTrackingService = require('./onlineTracking.service');
    const cacheService = require('./cache.service');
    const { shopId } = options;

    let onlineUsers = [];

    if (shopId) {
      // Get online users for specific shop
      onlineUsers = await onlineTrackingService.getShopOnlineUsers(shopId);
    } else {
      // Get all online users from cache
      const allUserIds = await cacheService.sMembers('online:users');

      for (const userId of allUserIds) {
        const userData = await cacheService.get(`online:user:${userId}`);
        if (userData) {
          onlineUsers.push(userData);
        }
      }
    }

    // Enrich with user details from DB
    if (onlineUsers.length > 0) {
      const userIds = onlineUsers.map(u => u.userId);
      const users = await User.find({ _id: { $in: userIds } })
        .select('name phone role')
        .populate('shop', 'name')
        .lean();

      const userMap = new Map(users.map(u => [u._id.toString(), u]));

      onlineUsers = onlineUsers.map(ou => ({
        ...ou,
        user: userMap.get(ou.userId) || null,
      }));
    }

    return {
      data: onlineUsers,
      count: onlineUsers.length,
      timestamp: Date.now(),
    };
  }

  // Get audit logs (system level)
  async getAuditLogs(options = {}) {
    const {
      page = 1,
      limit = 50,
      shopId,
      action,
      userId,
      customerId,
      entityType,
      search,
      startDate,
      endDate,
    } = options;

    const query = {};
    /* Every clause that needs its own $or is collected here and joined with
       $and. Assigning `query.$or` twice silently drops the first one, so a
       category filter and a search filter would have cancelled each other and
       returned rows matching only the second. */
    const and = [];

    if (shopId) query.shop = shopId;
    // Support prefix-based action filtering (e.g., "customer" matches "customer_create", "customer_update", "due_collection")
    if (action) {
      if (action === 'customer') {
        and.push({
          $or: [
            { action: { $regex: '^customer', $options: 'i' } },
            { action: 'due_collection' },
            { 'entity.type': 'customer' },
          ],
        });
      } else if (action === 'auth') {
        and.push({
          $or: [
            { action: { $regex: '^user_', $options: 'i' } },
            { action: 'auth_failed' },
            { action: 'password_change' },
          ],
        });
      } else {
        query.action = { $regex: `^${escapeRegex(action)}`, $options: 'i' };
      }
    }
    if (userId) query.user = userId;
    if (customerId) query.customer = customerId;
    if (entityType) query['entity.type'] = entityType;

    /* Free text over the fields an operator actually types into the box: the
       action name, the human description, the affected record and the IP. The
       console previously filtered the loaded page in the browser, so searching
       an IP across 40k entries only ever looked at the 50 already on screen and
       reported "no matches" for everything else. */
    if (search && String(search).trim()) {
      const rx = { $regex: escapeRegex(search), $options: 'i' };
      and.push({
        $or: [
          { action: rx },
          { description: rx },
          { descriptionBn: rx },
          { 'entity.name': rx },
          { 'entity.type': rx },
          { 'metadata.ip': rx },
        ],
      });
    }

    const createdAt = {};
    if (startDate) {
      const from = dayBoundary(startDate, 'start');
      if (from) createdAt.$gte = from;
    }
    if (endDate) {
      const to = dayBoundary(endDate, 'end');
      if (to) createdAt.$lte = to;
    }
    if (Object.keys(createdAt).length) query.createdAt = createdAt;

    if (and.length) query.$and = and;

    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      AuditLog.find(query)
        .populate('user', 'name phone email')
        .populate('admin', 'name phone email')
        .populate('customer', 'name phone email')
        .populate('shop', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),

      AuditLog.countDocuments(query),
    ]);

    return {
      data: logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Update shop settings (admin level)
  async updateShopSettings(adminId, shopId, settingsData) {
    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    const previousSettings = { ...shop.settings.toObject() };

    // Update allowed settings
    if (settingsData.enabledVariantTypes !== undefined) {
      shop.settings.enabledVariantTypes = settingsData.enabledVariantTypes;
    }
    if (settingsData.taxEnabled !== undefined) {
      shop.settings.taxEnabled = settingsData.taxEnabled;
    }
    if (settingsData.taxRate !== undefined) {
      shop.settings.taxRate = settingsData.taxRate;
    }
    if (settingsData.showUnitOnInvoice !== undefined) {
      shop.settings.showUnitOnInvoice = settingsData.showUnitOnInvoice;
    }
    if (settingsData.lowStockThreshold !== undefined) {
      shop.settings.lowStockThreshold = settingsData.lowStockThreshold;
    }
    if (settingsData.invoicePrefix !== undefined) {
      shop.settings.invoicePrefix = settingsData.invoicePrefix;
    }
    if (settingsData.smsSettings !== undefined) {
      shop.settings.smsSettings = {
        ...shop.settings.smsSettings,
        ...settingsData.smsSettings,
      };
    }

    await shop.save();
    await invalidateShopAuthCache(shop._id);

    // Create audit log
    await AuditLog.create({
      admin: adminId,
      action: 'shop_settings_update',
      actionBn: 'দোকানের সেটিংস আপডেট',
      description: `Updated settings for ${shop.name}`,
      descriptionBn: `${shop.name} এর সেটিংস আপডেট করা হয়েছে`,
      entity: {
        type: 'shop',
        id: shop._id,
        name: shop.name,
      },
      changes: {
        before: previousSettings,
        after: shop.settings.toObject(),
      },
    });

    return shop;
  }

  // Create admin user
  async createAdmin(creatorId, adminData) {
    const { phone, password, name, role } = adminData;

    // Check if admin exists
    const existingAdmin = await Admin.findOne({ phone });
    if (existingAdmin) {
      throw new AppError('এই ফোন নম্বর দিয়ে ইতিমধ্যে অ্যাডমিন আছে', 'Admin with this phone already exists', 400);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 11);

    const admin = await Admin.create({
      phone,
      password: hashedPassword,
      name,
      role,
    });

    // Create audit log
    await AuditLog.create({
      admin: creatorId,
      action: 'admin_create',
      actionBn: 'নতুন অ্যাডমিন তৈরি',
      description: `Created admin: ${name}`,
      descriptionBn: `নতুন অ্যাডমিন তৈরি: ${name}`,
      entity: {
        type: 'admin',
        id: admin._id,
        name: name,
      },
    });

    return {
      id: admin._id,
      name: admin.name,
      phone: admin.phone,
      role: admin.role,
    };
  }

  /**
   * Enable multi-branch mode for a shop.
   * This is a one-way operation that:
   * 1. Creates a default "Main Branch"
   * 2. Backfills all existing data with the default branch
   * 3. Assigns all staff to the default branch
   * 4. Assigns the existing product catalogue to the default branch
   */
  async enableMultiBranch(shopId, adminId, branchName = null) {
    const Customer = require('../models/Customer.model');
    const CustomerBalance = require('../models/CustomerBalance.model');

    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('Shop not found', 'Shop not found', 404);
    }

    if (shop.multiBranchEnabled) {
      throw new AppError('Multi-branch already enabled', 'Multi-branch already enabled', 400);
    }

    // 1. Default branch. Reuse an existing one rather than creating a second
    // MAIN — a shop that was enabled, disabled, then re-enabled still has its
    // branches, and Branch.create would hit the {shop, code} unique index and
    // 500 (FEATURE_AUDIT.md M-4).
    let defaultBranch =
      (await Branch.findOne({ shop: shopId, isDefault: true })) ||
      (await Branch.findOne({ shop: shopId }).sort({ createdAt: 1 }));

    if (defaultBranch) {
      if (!defaultBranch.isDefault || !defaultBranch.isActive) {
        defaultBranch.isDefault = true;
        defaultBranch.isActive = true;
        defaultBranch.deletedAt = null;
        await defaultBranch.save();
      }
    } else {
      defaultBranch = await Branch.create({
        shop: shopId,
        name: branchName || 'Main Branch',
        code: 'MAIN',
        address: shop.address,
        phone: shop.phone,
        isDefault: true
      });
    }

    // 2. Backfill BEFORE flipping the flag. The flag used to be set first, so
    // an interrupted backfill left the shop live with half its rows untagged
    // and therefore invisible in any branch-selected view (M-6).
    // HeldCart was missing from this list entirely (M-5).
    const branchScopedModels = [
      Sale, Purchase, Expense, CashRegister, StockTransaction,
      Payment, SalesReturn, SMSLog, AuditLog, HeldCart
    ];

    // Batched so a large history never builds one unbounded write, and so a
    // failure part-way can be resumed simply by re-running (the filter only
    // ever matches rows that are still untagged).
    const BATCH = 5000;
    const backfilled = {};
    for (const Model of branchScopedModels) {
      let total = 0;
      for (;;) {
        const ids = await Model.find({ shop: shopId, branch: null }, { _id: 1 })
          .limit(BATCH).lean();
        if (ids.length === 0) break;
        const res = await Model.updateMany(
          { _id: { $in: ids.map((d) => d._id) } },
          { $set: { branch: defaultBranch._id } }
        );
        total += res.modifiedCount;
        if (ids.length < BATCH) break;
      }
      backfilled[Model.modelName] = total;
    }

    // 3. Assign all non-owner staff to the default branch
    const staffResult = await User.updateMany(
      { shop: shopId, isOwner: false, branch: null },
      { $set: { branch: defaultBranch._id } }
    );

    // 4. The existing catalogue becomes the default branch's catalogue.
    // Stock already lives on these documents, so nothing is recalculated.
    const productResult = await Product.updateMany(
      { shop: shopId, branch: null },
      { $set: { branch: defaultBranch._id } }
    );

    // 4b. Seed the per-branch customer ledger (Phase 7). Every row above now
    // belongs to the default branch, so this is a clean one-row-per-customer
    // derivation from the shop-wide rollup — no aggregation over history
    // needed, and Σ branch dues equals Customer.totalDue by construction.
    //
    // Rows are seeded whatever `customerScope` ends up being: writes never
    // consult the flag, only reads do, which is what lets the platform admin
    // flip it later with nothing to migrate.
    const customerBalanceOps = [];
    for await (const customer of Customer.find({ shop: shopId }).select('_id totalPurchases totalPaid totalDue purchaseCount lastPurchase').lean()) {
      customerBalanceOps.push({
        updateOne: {
          filter: { shop: shopId, customer: customer._id, branch: defaultBranch._id },
          update: {
            $set: {
              totalPurchases: customer.totalPurchases || 0,
              totalPaid: customer.totalPaid || 0,
              totalDue: customer.totalDue || 0,
              purchaseCount: customer.purchaseCount || 0,
              lastPurchase: customer.lastPurchase || null,
              updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          upsert: true,
        },
      });
    }
    let customerBalancesSeeded = 0;
    if (customerBalanceOps.length > 0) {
      const res = await CustomerBalance.bulkWrite(customerBalanceOps, { ordered: false });
      customerBalancesSeeded = (res.upsertedCount || 0) + (res.modifiedCount || 0);
    }

    // 5. Everything is tagged — only now is the shop switched over.
    shop.multiBranchEnabled = true;
    // Default: branches keep SEPARATE customer books. Set explicitly rather
    // than relying on the schema default, so a shop enabled before this line
    // shipped never has its meaning changed underneath it by a later deploy.
    if (!shop.customerScope) shop.customerScope = 'branch';
    await shop.save();

    // 6. Log audit
    await AuditLog.log({
      shop: shopId,
      branch: defaultBranch._id,
      admin: adminId,
      action: AUDIT_ACTIONS.MULTI_BRANCH_ENABLED.en,
      description: `"${shop.name}" দোকানে মাল্টি-ব্রাঞ্চ সক্রিয় করা হয়েছে`,
      entity: { type: 'shop', id: shop._id, name: shop.name }
    });

    // Invalidate cache
    await invalidateShopAuthCache(shopId);

    return {
      shop: shop.toObject(),
      defaultBranch: defaultBranch.toObject(),
      backedUp: {
        models: branchScopedModels.length,
        rows: backfilled,
        staff: staffResult.modifiedCount,
        products: productResult.modifiedCount,
        customerBalances: customerBalancesSeeded
      }
    };
  }

  /**
   * Disable multi-branch support for a shop
   */
  async disableMultiBranch(shopId, adminId) {
    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    if (!shop.multiBranchEnabled) {
      throw new AppError('মাল্টি-ব্রাঞ্চ ইতিমধ্যেই নিষ্ক্রিয়', 'Multi-branch is already disabled', 400);
    }

    // Disable multi-branch
    shop.multiBranchEnabled = false;
    await shop.save();

    // Log audit
    await AuditLog.log({
      shop: shopId,
      admin: adminId,
      action: AUDIT_ACTIONS.MULTI_BRANCH_DISABLED.en,
      description: `"${shop.name}" দোকানে মাল্টি-ব্রাঞ্চ নিষ্ক্রিয় করা হয়েছে`,
      entity: { type: 'shop', id: shop._id, name: shop.name }
    });

    // Invalidate cache
    await invalidateShopAuthCache(shopId);

    return shop.toObject();
  }

  /**
   * Set whether a shop's branches share one customer book (Phase 7).
   *
   * Platform-admin only, deliberately: it changes what every branch of the shop
   * can see about every customer, so it sits beside enable/disable multi-branch
   * rather than in the owner's settings — same rule as branch create/delete.
   *
   * Purely a read-path switch. Both books are maintained on every write
   * regardless of this value, so flipping it takes effect on the next request,
   * needs no migration, and can be flipped back with nothing lost.
   */
  async setCustomerScope(shopId, adminId, scope) {
    if (!['shop', 'branch'].includes(scope)) {
      throw new AppError(
        'Customer scope must be "shop" or "branch"',
        'কাস্টমার স্কোপ "shop" অথবা "branch" হতে হবে',
        400
      );
    }

    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    if (!shop.multiBranchEnabled) {
      throw new AppError(
        'Enable multi-branch first — a single-branch shop has only one customer book',
        'আগে মাল্টি-ব্রাঞ্চ চালু করুন — এক শাখার দোকানে কাস্টমার আলাদা করার কিছু নেই',
        400
      );
    }

    const previous = shop.customerScope || 'branch';
    if (previous === scope) {
      return shop.toObject();
    }

    shop.customerScope = scope;
    await shop.save();

    await AuditLog.log({
      shop: shopId,
      admin: adminId,
      action: 'customer_scope_changed',
      description: scope === 'branch'
        ? `"${shop.name}" — কাস্টমার ও বাকি এখন শাখা-ভিত্তিক`
        : `"${shop.name}" — কাস্টমার ও বাকি এখন সব শাখায় শেয়ার্ড`,
      entity: { type: 'shop', id: shop._id, name: shop.name },
      changes: { before: { customerScope: previous }, after: { customerScope: scope } }
    });

    // The flag rides in the shop payload of the auth cache, so every session
    // must be invalidated for it to take effect on the next request.
    await invalidateShopAuthCache(shopId);
    // The dashboard is cached per (shop, branch, scope) and its numbers change
    // meaning here, so retire the current generation rather than serve the old
    // figures until something else happens to bump it.
    await cacheService.bumpShopCacheVersion(shopId, 0);

    return shop.toObject();
  }

  /**
   * Turn an opt-in capability on or off for one shop. Platform-admin only.
   *
   * Deliberately ONE generic endpoint rather than the enable-X / disable-X pair
   * multi-branch has. Every capability added after this reuses it, so the admin
   * router stops growing a method per feature and the audit trail has a single
   * consistent shape to search.
   *
   * Unlike `enableMultiBranch`, there is nothing to back-fill. `features.*` are
   * read-path switches over data that is already in its final shape:
   *
   *   - packaging OFF -> stock is an integer count of the product's unit
   *   - packaging ON  -> stock is the same number, now allowed a fraction
   *
   * so flipping it takes effect on the next request and flipping it back loses
   * nothing. If you ever add a capability that DOES need a back-fill, do not
   * reuse this method: copy `enableMultiBranch`'s ordering — back-fill first,
   * flip the flag last (FEATURE_AUDIT.md M-6), or an interruption leaves the
   * shop half-migrated with the flag already on.
   *
   * @param {string} shopId
   * @param {string} adminId
   * @param {string} key      a FEATURE_KEYS value
   * @param {boolean} enabled
   */
  async setShopFeature(shopId, adminId, key, enabled) {
    if (!FEATURE_KEYS.includes(key)) {
      throw new AppError(
        `Unknown feature "${key}". Valid: ${FEATURE_KEYS.join(', ')}`,
        'এই ফিচারটি পাওয়া যায়নি',
        400
      );
    }

    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    const value = enabled === true;
    const previous = shop.features?.[key] === true;
    if (previous === value) {
      return shop.toObject();
    }

    if (!shop.features) shop.features = {};
    shop.features[key] = value;
    // `features` is a nested object; Mongoose does not always see a mutation on
    // a sub-path of a non-subdocument object, and a missed change here would
    // return 200 while saving nothing.
    shop.markModified('features');
    await shop.save();

    const meta = FEATURES[key];
    await AuditLog.log({
      shop: shopId,
      admin: adminId,
      action: value ? 'shop_feature_enabled' : 'shop_feature_disabled',
      description: value
        ? `"${shop.name}" দোকানে "${meta.bn}" ফিচার চালু করা হয়েছে`
        : `"${shop.name}" দোকানে "${meta.bn}" ফিচার বন্ধ করা হয়েছে`,
      entity: { type: 'shop', id: shop._id, name: shop.name },
      changes: { before: { [`features.${key}`]: previous }, after: { [`features.${key}`]: value } }
    });

    // The flag rides in the shop payload of the auth cache, so every session
    // must be invalidated for it to take effect on the next request.
    await invalidateShopAuthCache(shopId);
    // Product listings are cached and their unit/precision handling changes
    // meaning here — retire the current generation rather than serve stale rows.
    await cacheService.bumpShopCacheVersion(shopId, 0);

    return shop.toObject();
  }

  /**
   * Capability list for the admin UI: every known feature with its label and
   * this shop's current state. Built from FEATURES, never hand-listed, so a new
   * capability appears in the admin panel the moment it is registered.
   */
  async getShopFeatures(shopId) {
    const shop = await Shop.findById(shopId).select('name features').lean();
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    return {
      shop: { _id: String(shop._id), name: shop.name },
      features: FEATURE_KEYS.map((key) => ({
        key,
        label: FEATURES[key].bn,
        labelEn: FEATURES[key].en,
        description: FEATURES[key].description,
        enabled: shop.features?.[key] === true,
      })),
    };
  }

  // Get all branches of a shop for admin
  async getShopBranches(shopId) {
    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }
    return await Branch.find({ shop: shopId }).sort({ createdAt: -1 });
  }

  // Add a branch to a shop by admin
  async addShopBranch(shopId, adminId, data) {
    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    // Check code uniqueness within shop
    const normalizedCode = data.code.toUpperCase().trim();
    const existing = await Branch.findOne({ shop: shopId, code: normalizedCode });
    if (existing) {
      throw new AppError('এই কোডের শাখা ইতোমধ্যে রয়েছে', 'Branch with this code already exists', 400);
    }

    const branch = await Branch.create({
      shop: shopId,
      name: data.name,
      code: normalizedCode,
      address: data.address || '',
      phone: data.phone || '',
      createdBy: adminId
    });

    // Optionally seed the new branch's catalogue from an existing branch.
    // Prices, variants and settings are copied; stock starts at 0 and the owner
    // fills it in. Batches/serials/sales history are NOT copied — they belong
    // to the branch that actually holds them.
    let clonedProducts = 0;
    if (data.copyProductsFromBranch) {
      clonedProducts = await this.cloneBranchProducts(
        shopId, data.copyProductsFromBranch, branch._id
      );
    }

    // Log audit
    await AuditLog.log({
      shop: shopId,
      branch: branch._id,
      admin: adminId,
      action: AUDIT_ACTIONS.BRANCH_CREATE.en,
      description: `শাখা "${data.name}" (কোড: ${normalizedCode}) অ্যাডমিন কর্তৃক তৈরি করা হয়েছে`,
      entity: { type: 'branch', id: branch._id, name: branch.name }
    });

    // Branch list is cached inside auth:user:{id}; refresh it for this shop's users
    await invalidateBranchCache(shopId);

    return { ...branch.toObject(), clonedProducts };
  }

  /**
   * Copy a branch's product catalogue into another branch.
   *
   * Copied: name, code, barcode, category, unit, prices, variants (with their
   * prices), minStock, images, tags, online flags.
   * Reset:  stock 0, batches [], serials [], totalSold 0, lastSold null.
   *
   * `code` is preserved so the two branches' copies stay matchable — that is
   * what stock transfer keys on — and `clonedFrom` records the lineage.
   * Batched by _id cursor so a large catalogue never builds one huge write.
   */
  async cloneBranchProducts(shopId, sourceBranchId, targetBranchId) {
    const Product = require('../models/Product.model');
    const BATCH = 500;

    const sourceBranch = await Branch.findOne({ _id: sourceBranchId, shop: shopId });
    if (!sourceBranch) {
      throw new AppError('Source branch not found', 'Source branch not found', 404);
    }

    // Never overwrite what the target branch already stocks.
    const existingCodes = new Set(
      (await Product.find({ shop: shopId, branch: targetBranchId }, { code: 1 }).lean())
        .map((p) => p.code)
    );

    let copied = 0;
    let cursorId = null;

    for (;;) {
      const filter = { shop: shopId, branch: sourceBranchId, isDeleted: { $ne: true } };
      if (cursorId) filter._id = { $gt: cursorId };

      const batch = await Product.find(filter).sort({ _id: 1 }).limit(BATCH).lean();
      if (batch.length === 0) break;
      cursorId = batch[batch.length - 1]._id;

      const docs = batch
        .filter((p) => !existingCodes.has(p.code))
        .map((p) => {
          const { _id, createdAt, updatedAt, __v, ...rest } = p;
          return {
            ...rest,
            branch: targetBranchId,
            clonedFrom: p.clonedFrom || p._id,
            stock: 0,
            variants: (p.variants || []).map((v) => ({ ...v, stock: 0 })),
            batches: [],
            serials: [],
            totalSold: 0,
            lastSold: null,
          };
        });

      if (docs.length > 0) {
        await Product.insertMany(docs, { ordered: false });
        copied += docs.length;
        docs.forEach((d) => existingCodes.add(d.code));
      }

      if (batch.length < BATCH) break;
    }

    return copied;
  }

  // Update a shop's branch by admin
  async updateShopBranch(shopId, branchId, adminId, data) {
    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    const branch = await Branch.findOne({ _id: branchId, shop: shopId });
    if (!branch) {
      throw new AppError('শাখা পাওয়া যায়নি', 'Branch not found', 404);
    }

    if (data.name !== undefined) branch.name = data.name;
    if (data.code !== undefined) {
      const normalizedCode = data.code.toUpperCase().trim();
      const existing = await Branch.findOne({ shop: shopId, code: normalizedCode, _id: { $ne: branchId } });
      if (existing) {
        throw new AppError('এই কোডের শাখা ইতোমধ্যে রয়েছে', 'Branch with this code already exists', 400);
      }
      branch.code = normalizedCode;
    }
    if (data.address !== undefined) branch.address = data.address;
    if (data.phone !== undefined) branch.phone = data.phone;
    if (typeof data.isActive === 'boolean') branch.isActive = data.isActive;

    await branch.save();

    // Log audit
    await AuditLog.log({
      shop: shopId,
      branch: branch._id,
      admin: adminId,
      action: AUDIT_ACTIONS.BRANCH_UPDATE.en,
      description: `শাখা "${branch.name}" অ্যাডমিন কর্তৃক আপডেট করা হয়েছে`,
      entity: { type: 'branch', id: branch._id, name: branch.name }
    });

    await invalidateBranchCache(shopId);

    return branch;
  }

  // Delete/Deactivate a shop's branch by admin
  async deleteShopBranch(shopId, branchId, adminId, options = {}) {
    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('Shop not found', 'Shop not found', 404);
    }

    const branch = await Branch.findOne({ _id: branchId, shop: shopId });
    if (!branch) {
      throw new AppError('Branch not found', 'Branch not found', 404);
    }

    // Deactivating a branch with work in progress strands it: assigned staff
    // are locked out on their next request, an open till never closes, held
    // carts become unreachable and in-transit stock is deducted but never
    // received. `force` is available for the deliberate case.
    if (!options.force) {
      const branchService = require('./branch.service');
      const impact = await branchService.getBranchDeletionImpact(branchId, shopId);
      if (!impact.canDeactivate) {
        const err = new AppError(
          `Cannot deactivate this branch: ${impact.blockers.join('; ')}`,
          impact.blockers.join('; '),
          400
        );
        err.code = 'BRANCH_HAS_ACTIVITY';
        err.impact = impact;
        throw err;
      }
    }

    branch.isActive = false;
    await branch.save();

    // Log audit
    await AuditLog.log({
      shop: shopId,
      branch: branch._id,
      admin: adminId,
      action: AUDIT_ACTIONS.BRANCH_DEACTIVATE.en,
      description: `শাখা "${branch.name}" অ্যাডমিন কর্তৃক নিষ্ক্রিয় করা হয়েছে`,
      entity: { type: 'branch', id: branch._id, name: branch.name }
    });

    // Critical: staff pinned to this branch must stop resolving it immediately,
    // and owners must stop seeing it in their switcher.
    await invalidateBranchCache(shopId);

    return branch;
  }
}

module.exports = new AdminService();
