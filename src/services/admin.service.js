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
const PlatformPayment = require('../models/PlatformPayment.model');
const Product = require('../models/Product.model');
const Branch = require('../models/Branch.model');
const HeldCart = require('../models/HeldCart.model');
const ShopAiUsage = require('../models/ShopAiUsage.model');
const PlatformSetting = require('../models/PlatformSetting.model');
const mongoose = require('mongoose');
const { getBangladeshTodayRange, getBangladeshTodayStr } = require('../utils/bdTime.util');
const { resolveDailyLimit } = require('../utils/aiQuota.util');
const { AUDIT_ACTIONS, AI_DAILY_MESSAGE_LIMIT, ADMIN_JWT_EXPIRES_IN } = require('../config/constants');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { AppError } = require('../middleware/error.middleware');
const cacheService = require('./cache.service');
const { invalidateShopAuthCache, invalidateBranchCache } = require('../utils/authCache.util');
const { resolveSubscription } = require('../utils/subscriptionState.util');
const { refuseDeletion } = require('../utils/deletionDisabled.util');
const { KEYS, getTTL } = require('../config/cacheKeys');
const platformNotify = require('./platformNotify.service');
const {
  FEATURES,
  FEATURE_KEYS,
  STORAGE_BACKED_FEATURES,
  missingDepsFor,
  unavailableReason,
  dependentsOf,
} = require('../utils/features.util');

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
  //
  // `req` is optional and used only to describe the login in the founder's
  // Telegram alert — where it came from, on what. Left optional so the
  // seeders and any script that signs in programmatically keep working.
  async login(phone, password, req = null) {
    const admin = await Admin.findOne({ phone, isActive: true }).select('+password');
    if (!admin) {
      throw new AppError('ফোন নম্বর বা পাসওয়ার্ড সঠিক নয়', 'Invalid credentials', 401);
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      // Counted per phone; the notifier speaks only once a burst forms. An
      // admin console being guessed at is worth waking someone for.
      platformNotify.failedLogin({ phone, name: admin.name, req });
      throw new AppError('ফোন নম্বর বা পাসওয়ার্ড সঠিক নয়', 'Invalid credentials', 401);
    }

    // Update last login
    admin.lastLogin = new Date();
    await admin.save();

    platformNotify.adminLogin({ admin, req });

    // Generate token
    const token = jwt.sign(
      { id: admin._id, role: admin.role, isAdmin: true },
      process.env.JWT_SECRET,
      { expiresIn: ADMIN_JWT_EXPIRES_IN }
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

    const Customer = require('../models/Customer.model');

    // The three sales windows are read in ONE pass via $facet.
    //
    // The outer $match must cover the earliest boundary any facet needs. On the
    // 1st of a month `yesterdayStart` falls in the PREVIOUS month, i.e. before
    // `monthStart` — matching on `monthStart` alone would silently drop
    // yesterday's revenue on exactly one day in thirty and make `revenueGrowth`
    // read +100% every month. So the floor is the earlier of the two.
    const salesRangeStart = monthStart < yesterdayStart ? monthStart : yesterdayStart;

    // Every query below is independent of the others. They used to run as
    // fifteen sequential `await`s — eight batched plus seven one at a time —
    // so the endpoint paid a full round trip per query, each an unindexed
    // platform-wide scan. One Promise.all collapses that to roughly one.
    const [
      totalShops,
      activeShops,
      paidShops,
      expiredShops,
      suspendedShops,
      totalUsers,
      todayNewShops,
      todayNewUsers,
      salesFacet,
      platformRevenueFacet,
      todayNewCustomers,
      todayNewProducts,
    ] = await Promise.all([
      Shop.countDocuments(),
      Shop.countDocuments({ 'subscription.status': 'active' }),
      Shop.countDocuments({ 'subscription.plan': 'paid' }),
      Shop.countDocuments({ 'subscription.status': 'expired' }),
      Shop.countDocuments({ 'subscription.status': 'suspended' }),
      User.countDocuments({ isActive: true }),
      Shop.countDocuments({ createdAt: { $gte: todayStart } }),
      User.countDocuments({ createdAt: { $gte: todayStart } }),

      // Today's / yesterday's / this month's sales across all shops.
      //
      // `$total` is the field the Sale schema actually defines — `sale.service.js`
      // writes it and `getAllShops` below already sums it. These three facets
      // summed `$grandTotal`, which exists nowhere on the model, so `$sum`
      // returned 0 for a missing path and the platform's revenue figures,
      // month figures and growth percentage have all read ৳0 since they were
      // written. The 60s cache faithfully cached the zero.
      Sale.aggregate([
        { $match: { createdAt: { $gte: salesRangeStart }, status: { $ne: 'cancelled' } } },
        {
          $facet: {
            today: [
              { $match: { createdAt: { $gte: todayStart } } },
              {
                $group: {
                  _id: null,
                  totalSales: { $sum: 1 },
                  totalRevenue: { $sum: '$total' },
                  totalItems: { $sum: { $size: '$items' } },
                },
              },
            ],
            yesterday: [
              { $match: { createdAt: { $gte: yesterdayStart, $lt: todayStart } } },
              { $group: { _id: null, totalRevenue: { $sum: '$total' } } },
            ],
            month: [
              { $match: { createdAt: { $gte: monthStart } } },
              {
                $group: {
                  _id: null,
                  totalSales: { $sum: 1 },
                  totalRevenue: { $sum: '$total' },
                },
              },
            ],
          },
        },
      ]),

      // Platform revenue — from PlatformPayment, not the shops' own ledger.
      //
      // These two used to read `Payment` with `type: 'subscription'`, a value
      // that is not in that model's enum, so every write threw and both figures
      // were structurally ৳0. Dated by `receivedAt` (when the money arrived), not
      // `createdAt` (when it was keyed in).
      //
      // Both facets read the same `type: 'subscription'` set, so they share one
      // pass rather than scanning it twice.
      PlatformPayment.aggregate([
        { $match: { type: 'subscription' } },
        {
          $facet: {
            allTime: [{ $group: { _id: null, totalRevenue: { $sum: '$amount' } } }],
            month: [
              { $match: { receivedAt: { $gte: monthStart } } },
              { $group: { _id: null, monthlyRevenue: { $sum: '$amount' } } },
            ],
          },
        },
      ]),

      // Today's new customers / products across all shops
      Customer.countDocuments({ createdAt: { $gte: todayStart } }),
      Product.countDocuments({ createdAt: { $gte: todayStart } }),
    ]);

    const todaySalesResult = salesFacet[0]?.today || [];
    const yesterdaySalesResult = salesFacet[0]?.yesterday || [];
    const monthSalesResult = salesFacet[0]?.month || [];
    const revenueResult = platformRevenueFacet[0]?.allTime || [];
    const monthlyRevenueResult = platformRevenueFacet[0]?.month || [];

    // Calculate growth percentages
    const todayRevenue = todaySalesResult[0]?.totalRevenue || 0;
    const yesterdayRevenue = yesterdaySalesResult[0]?.totalRevenue || 0;
    const revenueGrowth = yesterdayRevenue > 0
      ? Math.round(((todayRevenue - yesterdayRevenue) / yesterdayRevenue) * 100)
      : 0;

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

    // Most active shops (by number of transactions today)
    // Bangladesh midnight — the platform and every shop on it are in BD, so
    // "today" must not mean the server's UTC day.
    const { startOfDay: todayStart } = getBangladeshTodayRange();

    // These three aggregations are independent; they used to run sequentially.
    const [topShops, topProducts, mostActiveToday] = await Promise.all([
    // Top 5 shops by sales revenue (last 30 days).
    // `$total`, not `$grandTotal` — see the note in getStats(). This leaderboard
    // was sorting by a field the Sale schema does not define, so every shop
    // scored 0 and the "top 5" was whatever order the group happened to emit.
    Sale.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo }, status: { $ne: 'cancelled' } } },
      {
        $group: {
          _id: '$shop',
          totalRevenue: { $sum: '$total' },
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
    ]),

    // Top 5 products by quantity sold (last 30 days).
    //
    // Revenue reads the stored line total. It used to be
    // `$multiply: ['$items.price', '$items.quantity']`, but a sale item has no
    // `price` field — it has `unitPrice` and `total` (Sale.model.js:84,103).
    // `$multiply` over a missing path yields null, `$sum` skips nulls, so this
    // column was structurally ৳0 too. `$items.total` is also what
    // report.service.js sums for the same figure, so the two now agree.
    Sale.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo }, status: { $ne: 'cancelled' } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.product',
          totalQuantity: { $sum: '$items.quantity' },
          totalRevenue: { $sum: '$items.total' },
          name: { $first: '$items.productName' },
        },
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: 5 },
    ]),

    Sale.aggregate([
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
    ]),
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

    // ── Per-shop stats: two grouped queries, not two queries per shop ────────
    //
    // This used to be a `Promise.all(shops.map(async ...))` that ran a
    // `countDocuments` AND an `aggregate` for EVERY shop on the page — 2N
    // queries, measured at 45 round trips and 806ms for a page of 20
    // (PERFORMANCE_BASELINE.md). `Promise.all` made them concurrent, which hid
    // the latency but not the load: a full page could occupy most of the
    // 50-connection pool (config/database.js) and starve tenant traffic.
    //
    // Grouping by `$shop` over the page's ids gives the same numbers in two
    // queries regardless of page size.
    //
    // The sales aggregate is still unbounded — it sums each shop's whole
    // lifetime, which is what the column means. That is the remaining cost
    // here; the fix is to maintain the running total on `Shop.stats` (the
    // `$inc` in sale.service.js already does this for the sale COUNT) and read
    // it back instead. Deliberately left for a follow-up: it needs a backfill
    // and a reconciliation job, and this change is meant to stay behaviour-
    // preserving.
    const [productCounts, salesTotals] = await Promise.all([
      Product.aggregate([
        { $match: { shop: { $in: shopIds }, isActive: true } },
        { $group: { _id: '$shop', count: { $sum: 1 } } },
      ]),
      Sale.aggregate([
        { $match: { shop: { $in: shopIds }, status: { $ne: 'cancelled' } } },
        { $group: { _id: '$shop', totalSales: { $sum: '$total' } } },
      ]),
    ]);

    const productCountMap = new Map(productCounts.map(r => [String(r._id), r.count]));
    const salesTotalMap = new Map(salesTotals.map(r => [String(r._id), r.totalSales]));

    // Merge SMS quota data with shops, resolve subscription state, attach stats
    const shopsWithQuota = shops.map((shop) => {
      // The same resolver the auth middleware and the owner's banner use, so
      // the chip in this list cannot say "active" while the shop is being
      // refused writes. It also understands grace days and manual blocks, which
      // the old inline `status` comparison here did not.
      const resolved = resolveSubscription(shop, now);
      // `effectiveStatus` keeps its original vocabulary (active/expired/
      // suspended/trial) because the shops page renders chips off it; the
      // richer state rides alongside for anything that wants it.
      const effectiveStatus =
        resolved.state === 'blocked' ? 'suspended'
          : resolved.state === 'expired' ? 'expired'
            : resolved.state === 'trial' ? 'trial'
              : 'active';

      const shopKey = shop._id.toString();

      return {
        ...shop,
        effectiveStatus,
        subscriptionState: resolved.state,
        daysRemaining: resolved.daysRemaining,
        smsQuota: quotaMap.get(shopKey) || null,
        stats: {
          // `|| 0` preserves the previous shape: a shop with no matching rows
          // produced 0 from countDocuments and 0 from the empty aggregate.
          totalProducts: productCountMap.get(shopKey) || 0,
          totalSales: salesTotalMap.get(shopKey) || 0,
          totalCustomers: shop.stats?.totalCustomers || 0,
          totalRevenue: shop.stats?.totalRevenue || 0
        }
      };
    });

    // Fetch registration audit logs (IP/device) for all shops in this page.
    // Only `shop` and `metadata` are read below, and only the FIRST log per
    // shop survives — so the whole document was being fetched for nothing.
    // Served by the {shop, action, createdAt} index added to AuditLog.model.js.
    const registrationLogs = await AuditLog.find({
      shop: { $in: shopIds },
      action: 'user_register',
    }).select('shop metadata').sort({ createdAt: 1 }).lean();

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
      // 'deleted' | 'active' | undefined (all). The purge screen needs to list
      // exactly the soft-deleted rows, which was not reachable before.
      state,
    } = options;

    const query = {};

    if (shopId) {
      query.shop = shopId;
    }

    if (state === 'deleted') query.isDeleted = true;
    else if (state === 'active') query.isDeleted = { $ne: true };

    if (search) {
      const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { code: { $regex: escaped, $options: 'i' } },
        { barcode: { $regex: escaped, $options: 'i' } },
      ];
    }

    const skip = (page - 1) * limit;
    const validSortFields = ['createdAt', 'name', 'sellingPrice', 'stock', 'deletedAt'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

    const [products, total] = await Promise.all([
      Product.find(query)
        .populate('shop', 'name phone')
        .populate('category', 'name')
        // Who uploaded it. Stored since day one, never surfaced.
        .populate('createdBy', 'name phone role')
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

  /**
   * What a soft-deleted product is still attached to.
   *
   * ── The problem ─────────────────────────────────────────────────────────────
   *
   * Shops evaluating the app create throwaway products to try the flow, then
   * "delete" them. Deletion is a soft delete (`isDeleted`), correctly — a
   * product named on a real invoice must never vanish, or that invoice becomes
   * unreadable. But it means the catalogue accumulates test rows forever.
   *
   * ── Why this is a report, not a delete ──────────────────────────────────────
   *
   * A product is safe to erase only if nothing points at it. This returns the
   * evidence so the console can show it and a human can decide; `purgeProducts`
   * below re-runs the same check and refuses anything that fails it, so the
   * answer cannot go stale between looking and clicking.
   *
   * "Active" invoice means any sale that is not cancelled. A cancelled sale is
   * already void, so a product that appears only on cancelled invoices is
   * genuinely dead — and the caller may opt to remove those invoices too.
   *
   * Purchases, stock transactions and held carts are checked as well. They are
   * not invoices, but a purchase row naming a product that no longer exists
   * breaks the supplier ledger the same way.
   */
  async inspectProductLinks(productIds = []) {
    const Sale = require('../models/Sale.model');
    const Purchase = require('../models/Purchase.model');
    const StockTransaction = require('../models/StockTransaction.model');
    const HeldCart = require('../models/HeldCart.model');
    const mongoose = require('mongoose');

    const ids = productIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (ids.length === 0) return {};

    // One grouped query per collection rather than one per product: the purge
    // screen inspects a whole page at a time.
    const [saleRows, purchaseRows, stockRows, heldRows] = await Promise.all([
      Sale.aggregate([
        { $match: { 'items.product': { $in: ids } } },
        { $unwind: '$items' },
        { $match: { 'items.product': { $in: ids } } },
        {
          $group: {
            _id: '$items.product',
            activeCount: { $sum: { $cond: [{ $ne: ['$status', 'cancelled'] }, 1, 0] } },
            cancelledCount: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
            // Capped sample for the UI — a product on 4,000 invoices does not
            // need 4,000 invoice numbers shipped to the browser.
            samples: {
              $push: {
                _id: '$_id',
                invoiceNo: '$invoiceNo',
                status: '$status',
                total: '$total',
                createdAt: '$createdAt',
              },
            },
          },
        },
      ]),
      Purchase.aggregate([
        { $match: { 'items.product': { $in: ids } } },
        { $unwind: '$items' },
        { $match: { 'items.product': { $in: ids } } },
        { $group: { _id: '$items.product', count: { $sum: 1 } } },
      ]),
      StockTransaction.aggregate([
        { $match: { product: { $in: ids } } },
        { $group: { _id: '$product', count: { $sum: 1 } } },
      ]),
      HeldCart.aggregate([
        { $match: { 'items.product': { $in: ids } } },
        { $unwind: '$items' },
        { $match: { 'items.product': { $in: ids } } },
        { $group: { _id: '$items.product', count: { $sum: 1 } } },
      ]),
    ]);

    const index = (rows) => new Map(rows.map((r) => [String(r._id), r]));
    const purchaseBy = index(purchaseRows);
    const stockBy = index(stockRows);
    const heldBy = index(heldRows);
    const saleBy = index(saleRows);

    const result = {};
    for (const id of ids) {
      const key = String(id);
      const sale = saleBy.get(key);
      const purchases = purchaseBy.get(key)?.count || 0;
      const heldCarts = heldBy.get(key)?.count || 0;
      const activeSales = sale?.activeCount || 0;
      const cancelledSales = sale?.cancelledCount || 0;

      // Stock transactions alone do not block: every product ever stocked has
      // them, they carry no customer-facing meaning, and they are removed with
      // the product. They are reported so the confirmation can say what goes.
      const blockers = [];
      if (activeSales > 0) blockers.push(`${activeSales}টি সক্রিয় ইনভয়েসে আছে`);
      if (purchases > 0) blockers.push(`${purchases}টি ক্রয় রেকর্ডে আছে`);
      if (heldCarts > 0) blockers.push(`${heldCarts}টি হোল্ড কার্টে আছে`);

      result[key] = {
        activeSales,
        cancelledSales,
        purchases,
        heldCarts,
        stockTransactions: stockBy.get(key)?.count || 0,
        sampleInvoices: (sale?.samples || [])
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
          .slice(0, 10),
        safeToPurge: blockers.length === 0,
        blockers,
      };
    }

    return result;
  }

  /**
   * Permanently erase soft-deleted products that nothing references.
   *
   * ── The rules, and why each one is here ─────────────────────────────────────
   *
   * 1. **Soft-deleted only.** A live product is never touched, whatever the
   *    caller passes. Purging is a cleanup of things the shop already discarded,
   *    not a deletion tool.
   * 2. **Re-checked, not trusted.** `inspectProductLinks` runs again inside this
   *    call. The console showed a verdict some seconds ago; a sale could have
   *    been rung up since, and that sale must win.
   * 3. **Refused, not skipped silently.** Every product that fails returns its
   *    reason, so the operator sees "৩টি বাদ পড়েছে — সক্রিয় ইনভয়েসে আছে" rather
   *    than a count that quietly does not match.
   * 4. **`purgeCancelledInvoices` is opt-in.** A product may be free of *active*
   *    invoices but still appear on cancelled ones. Those are already void, so
   *    the caller may clear them — but that is a second, explicit decision, and
   *    it goes through `Sale.deleteOne` per document rather than `deleteMany`
   *    because `immutableGuard` blocks `deleteMany` on Sale outright.
   *
   * Rule 4 is the one to be careful with: a cancelled sale is still a record of
   * something that happened. Deleting it removes it from the shop's own history
   * too, not just the admin's view.
   *
   * ── This is the first hard delete the admin console has ─────────────────────
   *
   * `utils/deletionDisabled.util.js` disabled hard deletion panel-wide after
   * `purgeShop` destroyed a shop's catalogue and left 2,830 orphan rows. It set
   * three conditions for bringing any of it back, and all three are met here:
   *
   *   1. **Step-up authentication distinct from the admin session.** The caller
   *      re-enters their password on this call; holding a valid admin cookie is
   *      not sufficient. See `_assertStepUp`.
   *   2. **A server-computed impact preview before confirmation.**
   *      `inspectProductLinks` — and it is re-run here, so the preview cannot
   *      be replayed against changed data.
   *   3. **An audit entry written BEFORE the destructive write, with
   *      before-state.** Written below as `product_purge_begin`; the outcome is
   *      recorded separately afterwards. If the process dies mid-purge the
   *      intent survives, which is exactly what was missing last time.
   *
   * The remaining rail stays up: `assertAdminMayDelete` still refuses every
   * DELETE an admin issues. This is a POST, and it erases only rows the shop
   * itself already discarded.
   */
  async _assertStepUp(adminId, password) {
    const Admin = require('../models/Admin.model');

    if (!password) {
      const err = new AppError(
        'পাসওয়ার্ড দিয়ে নিশ্চিত করুন',
        'Re-enter your password to confirm',
        401
      );
      err.code = 'STEP_UP_REQUIRED';
      throw err;
    }

    // `password` is `select: false` on the schema, so it must be asked for.
    const admin = await Admin.findById(adminId).select('+password');
    if (!admin || !(await admin.comparePassword(password))) {
      const err = new AppError('পাসওয়ার্ড সঠিক নয়', 'Incorrect password', 401);
      err.code = 'STEP_UP_FAILED';
      throw err;
    }
  }

  async purgeProducts(adminId, { productIds = [], purgeCancelledInvoices = false, password } = {}) {
    const Product = require('../models/Product.model');
    const Sale = require('../models/Sale.model');
    const StockTransaction = require('../models/StockTransaction.model');
    const mongoose = require('mongoose');

    if (!Array.isArray(productIds) || productIds.length === 0) {
      throw new AppError('কোনো পণ্য নির্বাচন করা হয়নি', 'No products selected', 400);
    }
    if (productIds.length > 500) {
      throw new AppError('একবারে সর্বোচ্চ ৫০০টি পণ্য মুছে ফেলা যাবে', 'At most 500 products per purge', 400);
    }

    // Condition 1 — before anything is read, let alone written.
    await this._assertStepUp(adminId, password);

    // Rule 1 — the filter is `isDeleted: true`, so a live id simply does not
    // come back and is reported as not-eligible below.
    // `catalogImages` and `variants` come along so the purge can release the
    // product's photos — the document is about to stop existing, and it is the
    // only record of which images it held.
    const products = await Product.find({
      _id: { $in: productIds.filter((id) => mongoose.Types.ObjectId.isValid(id)) },
      isDeleted: true,
    }).select('name code shop catalogImages variants').lean();

    const foundIds = products.map((p) => String(p._id));
    const links = await this.inspectProductLinks(foundIds); // Rule 2

    // Condition 3 — the intent, with before-state, written BEFORE the first
    // destructive call. `purgeShop` wrote its audit entry at the end and died
    // halfway through, so there was no record of what it had been asked to do.
    await AuditLog.create({
      admin: adminId,
      action: 'product_purge_begin',
      actionBn: 'পণ্য মুছে ফেলা শুরু',
      description: `Purge requested for ${products.length} soft-deleted product(s). purgeCancelledInvoices=${purgeCancelledInvoices}`,
      descriptionBn: `${products.length}টি ডিলিট করা পণ্য স্থায়ীভাবে মুছে ফেলার অনুরোধ।`,
      entity: { type: 'product', id: null, name: `${products.length} products` },
      changes: {
        before: {
          requested: productIds.map(String),
          eligible: products.map((p) => ({ _id: String(p._id), name: p.name, code: p.code, shop: p.shop })),
          links,
          purgeCancelledInvoices,
        },
      },
    });

    const purged = [];
    const refused = [];

    for (const id of productIds.map(String)) {
      const product = products.find((p) => String(p._id) === id);
      if (!product) {
        refused.push({ productId: id, reason: 'পণ্যটি ডিলিট করা অবস্থায় নেই' });
        continue;
      }

      const link = links[id] || { safeToPurge: true, blockers: [], cancelledSales: 0 };

      if (!link.safeToPurge) {
        refused.push({ productId: id, name: product.name, reason: link.blockers.join(', ') }); // Rule 3
        continue;
      }

      // Rule 4 — only reached when there are no ACTIVE invoices.
      if (link.cancelledSales > 0) {
        if (!purgeCancelledInvoices) {
          refused.push({
            productId: id,
            name: product.name,
            reason: `${link.cancelledSales}টি বাতিল ইনভয়েসে আছে — ইনভয়েসসহ মুছতে অনুমতি দিন`,
          });
          continue;
        }

        // `deleteOne` per document: immutableGuard blocks `deleteMany` on Sale,
        // so a bulk call would throw 403 and abort the whole purge.
        const cancelled = await Sale.find({
          'items.product': new mongoose.Types.ObjectId(id),
          status: 'cancelled',
        }).select('_id invoiceNo').lean();

        for (const sale of cancelled) {
          await Sale.deleteOne({ _id: sale._id });
        }
      }

      // Stock movements are the product's own audit trail and carry no meaning
      // once it is gone. Deliberately `deleteMany` and deliberately annotated:
      // `adminNoDelete.test.js` scans this file for destructive calls and only
      // tolerates lines carrying this marker, so the next unreviewed one still
      // fails the build. Do not copy the marker to widen the hole.
      await StockTransaction.deleteMany({ product: id }); // admin-purge:reviewed
      await Product.deleteOne({ _id: id });

      // Release the product's photos. For anything soft-deleted after
      // `product.service.deleteProduct` started detaching, this is a no-op — the
      // `refCount > 0` guard makes the repeat harmless. For the backlog of
      // products soft-deleted BEFORE that, this is the ONLY thing that ever
      // decrements them, and without it a purge frees the row while leaving the
      // bytes charged to the shop forever.
      //
      // After the delete, not before: a refCount released against a product that
      // then failed to purge would leave a live product pointing at an image the
      // orphan sweep is free to collect.
      const mediaService = require('./media.service');
      await mediaService.reconcileRefs(
        product.shop,
        mediaService.mediaIdsOfProduct(product),
        []
      );

      purged.push({ productId: id, name: product.name, shop: product.shop });
    }

    // The outcome, as its own entry. Kept separate from `product_purge_begin`
    // so the pair reads as intent-then-result and a missing second entry is
    // itself a signal.
    await AuditLog.create({
      admin: adminId,
      action: 'product_purge',
      actionBn: 'পণ্য স্থায়ীভাবে মুছে ফেলা',
      description:
        `Purged ${purged.length} soft-deleted product(s)` +
        `${purgeCancelledInvoices ? ' including their cancelled invoices' : ''}. ` +
        `Refused: ${refused.length}.`,
      descriptionBn: `${purged.length}টি ডিলিট করা পণ্য স্থায়ীভাবে মুছে ফেলা হয়েছে। বাদ পড়েছে: ${refused.length}টি।`,
      entity: { type: 'product', id: null, name: `${purged.length} products` },
      changes: { after: { purged, refused } },
    });

    return {
      purged,
      refused,
      summary: {
        requested: productIds.length,
        purged: purged.length,
        refused: refused.length,
      },
    };
  }

  // Update shop status
  //
  // 'suspended' and its reversal are a BLOCK, and blocks now live in
  // billing.service where they carry an actor, a reason and a timeline entry.
  // Delegating rather than writing `isActive` here is what keeps invariant §8.1
  // true: exactly one code path can take a shop offline.
  async updateShopStatus(adminId, shopId, status, reason) {
    const billingService = require('./billing.service');
    const actor = { kind: 'admin', id: adminId };

    if (status === 'suspended') {
      await billingService.setAccess(actor, shopId, {
        action: 'block',
        reason: reason || 'Suspended from the shop status control',
      });
      return Shop.findById(shopId);
    }

    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('Shop not found', 'দোকান পাওয়া যায়নি', 404);
    }

    // Coming back from a suspension is an unblock, including the legacy
    // `isActive: false` switch — otherwise a shop suspended by the old code
    // would stay locked out no matter what status it was given.
    const wasBlocked = !!shop.access?.blockedAt || shop.isActive === false ||
      shop.subscription?.status === 'suspended';
    if (status === 'active' && wasBlocked) {
      await billingService.setAccess(actor, shopId, { action: 'unblock', reason });
      return Shop.findById(shopId);
    }

    const previousStatus = shop.subscription.status;
    shop.subscription.status = status;
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

  // Update shop subscription (admin sets an expiry date directly)
  //
  // Delegates to billing.service so the date lands at the END of the chosen
  // Bangladesh day and the change is recorded on the shop's billing timeline.
  // The old inline version also forced `plan: 'paid'` and `isActive: true`, so
  // extending a trial silently converted it and renewing a deliberately blocked
  // shop silently let it back in. Neither happens now.
  async updateShopSubscription(adminId, shopId, expiresAt) {
    const billingService = require('./billing.service');
    await billingService.extendSubscription(
      { kind: 'admin', id: adminId },
      shopId,
      {
        mode: 'until',
        value: expiresAt,
        payment: null,
        reason: 'Expiry set directly from the shop panel',
      }
    );
    return Shop.findById(shopId);
  }

  // Subscription payments, SMS allocation and payment recording now live in
  // billing.service (PlatformPayment ledger). The versions that used to sit
  // here wrote into the shops' OWN `Payment` collection with a type its enum
  // does not contain — every call threw, and platform revenue read ৳0 forever.
  // See SUBSCRIPTION_PLAN.md §2.1–2.3.

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
    const { page = 1, limit = 50, shopId, status, type, ip, source } = options;
    const SMSLog = require('../models/SMSLog.model');

    const query = {};

    // Three kinds of row live in this collection and only one has a shop. The
    // two shop-less kinds were narrowed in the browser, over whatever the
    // server happened to return for the current page — so "System (OTP)" showed
    // 4 rows out of a page of 50 and paginated against the unfiltered total.
    // Tolerable while no document had ever carried `type: 'otp'`; not now that
    // every registration writes one. Both are resolved here instead.
    if (shopId === 'system') {
      query.shop = null;
      query.sentByAdmin = null;
    } else if (shopId === 'broadcast') {
      query.shop = null;
      query.sentByAdmin = { $ne: null };
    } else if (shopId) {
      query.shop = shopId;
    }

    if (status) query.status = status;
    if (type) query.type = type;
    // "Everything this address has sent" — served by the sparse
    // { 'origin.ip': 1, createdAt: -1 } index.
    if (ip) query['origin.ip'] = ip;
    if (source) query['origin.source'] = source;

    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      SMSLog.find(query)
        .populate('shop', 'name')
        .populate('sentBy', 'name phone')
        // Platform broadcasts carry no `shop` and no `sentBy` — the operator is
        // an Admin, and pushing an Admin id through a `User` ref populates as
        // null. Without this the log page shows every broadcast as sent by
        // nobody, from nowhere, and indistinguishable from a system OTP.
        .populate('sentByAdmin', 'name')
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
    const { startOfDay: today } = getBangladeshTodayRange();

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

  /**
   * All users across all shops, with live presence.
   *
   * ── Where "last active" comes from ──────────────────────────────────────────
   *
   * `User.lastActiveAt` is a write-behind column: every authenticated request
   * pokes `userActivityService.recordActivity`, which throttles to one write
   * per user per 60s into Redis, and a job flushes the dirty set to Mongo every
   * 5 minutes (jobs/userActivitySync.job.js). So the column is correct but up
   * to five minutes stale.
   *
   * For a screen whose entire job is "who is using the app right now", five
   * minutes is the difference between useful and misleading. So the page is
   * sorted and paged in Mongo — the only place that can do it — and then the
   * Redis values are laid over the returned page, which is at most `limit`
   * keys in one MGET.
   *
   * If Redis is down `getMultipleLastActive` falls back to the same Mongo
   * column and the screen degrades to five-minute resolution instead of
   * breaking. That is the whole contract: Redis makes it sharper, never
   * necessary.
   *
   * @param {string} [options.activity] online | today | week | inactive
   * @param {string} [options.sortBy]   lastActiveAt | lastLogin | createdAt | name
   */
  async getAllUsers(options = {}) {
    const User = require('../models/User.model');
    const userActivityService = require('./userActivity.service');
    const {
      page = 1,
      limit = 30,
      shopId,
      search,
      role,
      activity,
      sortBy = 'lastActiveAt',
      sortOrder = 'desc',
    } = options;

    const query = {};
    if (shopId) query.shop = shopId;
    if (role) query.role = role;
    if (search) {
      const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { phone: { $regex: escaped, $options: 'i' } },
      ];
    }

    // Activity buckets filter on the Mongo column, so a user active in the last
    // 60 seconds but not yet flushed can fall in the bucket below the one they
    // belong to. The overlay below corrects what is *displayed*; correcting the
    // filter too would mean loading every user to sort in memory.
    const now = Date.now();
    const since = (minutes) => new Date(now - minutes * 60 * 1000);
    if (activity === 'online') query.lastActiveAt = { $gte: since(5) };
    else if (activity === 'today') query.lastActiveAt = { $gte: since(60 * 24) };
    else if (activity === 'week') query.lastActiveAt = { $gte: since(60 * 24 * 7) };
    else if (activity === 'inactive') {
      query.$and = [
        ...(query.$and || []),
        { $or: [{ lastActiveAt: { $lt: since(60 * 24 * 30) } }, { lastActiveAt: null }] },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const validSortFields = ['lastActiveAt', 'lastLogin', 'createdAt', 'name'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'lastActiveAt';
    const direction = sortOrder === 'asc' ? 1 : -1;
    // `createdAt` as tiebreaker: without it, the users who have never signed in
    // (all null) come back in a different order on every page request, so the
    // same user can appear on both page 1 and page 2.
    const sort = { [sortField]: direction, createdAt: -1 };

    const [users, total] = await Promise.all([
      User.find(query)
        .populate('shop', 'name phone subscription.status subscription.plan isActive')
        .select('-password -otp -permissions')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      User.countDocuments(query),
    ]);

    // Overlay live presence onto this page only.
    const liveMap = await userActivityService.getMultipleLastActive(users.map((u) => u._id));

    const withPresence = users.map((user) => {
      const live = liveMap[String(user._id)];
      const lastActiveAt = live || user.lastActiveAt || null;
      const minutesAgo = lastActiveAt
        ? Math.floor((now - new Date(lastActiveAt).getTime()) / 60000)
        : null;

      return {
        ...user,
        lastActiveAt,
        minutesSinceActive: minutesAgo,
        // A single field the UI can key a dot colour off, so the threshold
        // lives in one place instead of being re-guessed per screen.
        // 5 minutes, matching the 60s heartbeat plus slack for a flaky mobile
        // connection.
        presence:
          minutesAgo === null ? 'never'
            : minutesAgo <= 5 ? 'online'
            : minutesAgo <= 60 ? 'recent'
            : minutesAgo <= 60 * 24 ? 'today'
            : minutesAgo <= 60 * 24 * 7 ? 'week'
            : 'idle',
      };
    });

    return {
      data: withPresence,
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
        // Who added this customer. Already stored on every record; it was
        // simply never joined, so the console could show a customer but not
        // which staff member entered them.
        .populate('createdBy', 'name phone role')
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
  /**
   * The dashboard's activity panel: who is using the platform, and what the
   * catalogue is doing. One endpoint because it is one glance.
   *
   * ── Why not the existing `getOnlineUsers` ───────────────────────────────────
   *
   * There are two presence mechanisms in this codebase and they are not the
   * same thing:
   *
   *   `onlineTracking.service` — the `online:users` set, fed by an explicit
   *   heartbeat from the client with a 90s TTL. Accurate when the client is
   *   sending heartbeats, empty when it is not, and gone entirely if Redis
   *   restarts.
   *
   *   `userActivity.service` — `lastActiveAt`, poked by EVERY authenticated
   *   request, throttled to one write per user per 60s, cached in Redis and
   *   flushed to Mongo every 5 minutes.
   *
   * This uses the second. It cannot miss a user who is plainly using the app,
   * it survives a Redis restart (the Mongo column is the floor), and the same
   * numbers back the /users screen — so the dashboard and the list agree.
   *
   * Redis down: `getMultipleLastActive` falls through to Mongo and the whole
   * panel degrades from ~60s resolution to ~5 minutes. Nothing errors.
   *
   * ── What "today" and "this week" mean here ──────────────────────────────────
   *
   * Sales and product figures use the Bangladesh CALENDAR day for "today" and
   * a rolling 7 days for "this week". Calendar-day matters because "revenue
   * today" is a number the operator compares against what a shop's own daily
   * summary shows, and that one is BD-calendar. Getting it wrong would put the
   * first six hours of every Bangladeshi trading day in the wrong bucket on a
   * UTC host — see bdTime.util.js for the same bug in report land.
   *
   * User buckets stay rolling windows. They measure presence ("has this person
   * touched the app in the last day"), where a midnight boundary would make the
   * figure collapse every morning for no reason the operator would recognise.
   * That difference is why the dashboard labels the user buckets "Last 24h"
   * rather than letting two different spans share the word "today".
   *
   * Cancelled sales are excluded from both the counts and the revenue, and
   * reported separately, so a voided ৳50,000 invoice cannot inflate the day.
   */
  async getActivityOverview() {
    const User = require('../models/User.model');
    const Product = require('../models/Product.model');
    const userActivityService = require('./userActivity.service');

    const now = Date.now();
    const since = (minutes) => new Date(now - minutes * 60 * 1000);
    const { startOfDay: bdTodayStart } = getBangladeshTodayRange();
    const salesWindowStart = since(60 * 24 * 7);

    const [buckets, recentUsers, productCounts, recentProducts, saleBuckets, recentSales, salesTotal] =
      await Promise.all([
        // Counts come from Mongo in one pass. Up to 5 minutes stale by design —
        // a headline count does not justify reading every Redis key on the
        // platform, and the per-user list below is exact where it matters.
        User.aggregate([
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              online: { $sum: { $cond: [{ $gte: ['$lastActiveAt', since(5)] }, 1, 0] } },
              today: { $sum: { $cond: [{ $gte: ['$lastActiveAt', since(60 * 24)] }, 1, 0] } },
              week: { $sum: { $cond: [{ $gte: ['$lastActiveAt', since(60 * 24 * 7)] }, 1, 0] } },
              never: { $sum: { $cond: [{ $ifNull: ['$lastActiveAt', false] }, 0, 1] } },
            },
          },
        ]),
        User.find({ lastActiveAt: { $ne: null } })
          .select('name phone role lastActiveAt lastLogin')
          .populate('shop', 'name')
          .sort({ lastActiveAt: -1 })
          .limit(8)
          .lean(),
        Product.aggregate([
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              deleted: { $sum: { $cond: [{ $eq: ['$isDeleted', true] }, 1, 0] } },
              inactive: {
                $sum: { $cond: [{ $and: [{ $ne: ['$isDeleted', true] }, { $eq: ['$isActive', false] }] }, 1, 0] },
              },
              // BD calendar day, matching the sales figures below rather than
              // the rolling 24h this used to be. The dashboard shows "added
              // today" next to "sales today"; the two words have to mean the
              // same span or the screen is quietly lying about one of them.
              addedToday: { $sum: { $cond: [{ $gte: ['$createdAt', bdTodayStart] }, 1, 0] } },
              addedWeek: { $sum: { $cond: [{ $gte: ['$createdAt', salesWindowStart] }, 1, 0] } },
            },
          },
        ]),
        // Newest first, not most-recently-touched. This feed answers "what has
        // been uploaded", and sorting by `updatedAt` let a five-month-old
        // product whose stock ticked down a minute ago outrank a genuine new
        // upload — so the panel that claimed to show new products routinely
        // showed none. `updatedAt` is still returned so the UI can mark a row
        // that has been edited since it was created.
        Product.find({})
          .select('name code sellingPrice stock unit isDeleted isActive createdAt updatedAt')
          .populate('shop', 'name')
          .populate('branch', 'name')
          .populate('createdBy', 'name role')
          .sort({ createdAt: -1 })
          .limit(8)
          .lean(),
        // One pass over the last 7 days of sales yields both windows. Bounding
        // the $match at 7 days is what keeps this off a full collection scan:
        // Sale is one of the three collections that actually grows.
        Sale.aggregate([
          { $match: { createdAt: { $gte: salesWindowStart } } },
          {
            $group: {
              _id: null,
              weekCount: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 0, 1] } },
              weekRevenue: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 0, '$total'] } },
              weekCancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
              todayCount: {
                $sum: {
                  $cond: [
                    { $and: [{ $gte: ['$createdAt', bdTodayStart] }, { $ne: ['$status', 'cancelled'] }] },
                    1,
                    0,
                  ],
                },
              },
              todayRevenue: {
                $sum: {
                  $cond: [
                    { $and: [{ $gte: ['$createdAt', bdTodayStart] }, { $ne: ['$status', 'cancelled'] }] },
                    '$total',
                    0,
                  ],
                },
              },
              todayDue: {
                $sum: {
                  $cond: [
                    { $and: [{ $gte: ['$createdAt', bdTodayStart] }, { $ne: ['$status', 'cancelled'] }] },
                    '$due',
                    0,
                  ],
                },
              },
              todayCancelled: {
                $sum: {
                  $cond: [
                    { $and: [{ $gte: ['$createdAt', bdTodayStart] }, { $eq: ['$status', 'cancelled'] }] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ]),
        // `items` is deliberately not selected: a sale carries its whole line
        // array, and eight of them would be the heaviest thing on the endpoint
        // for a number the panel does not show.
        Sale.find({})
          .select('invoiceNo total paid due status paymentMethod customerName isOnline channel createdAt')
          .populate('shop', 'name')
          .populate('branch', 'name')
          .populate('customer', 'name phone')
          .populate('createdBy', 'name role')
          .sort({ createdAt: -1 })
          .limit(8)
          .lean(),
        // Metadata read, not a scan. "Sales ever recorded" is a scale figure,
        // not an accounting one, so an estimate is the honest cost/benefit.
        Sale.estimatedDocumentCount(),
      ]);

    // Sharpen the listed users with live Redis values — 8 keys, one MGET.
    const liveMap = await userActivityService.getMultipleLastActive(recentUsers.map((u) => u._id));

    const users = recentUsers.map((user) => {
      const lastActiveAt = liveMap[String(user._id)] || user.lastActiveAt || null;
      const minutesAgo = lastActiveAt
        ? Math.floor((now - new Date(lastActiveAt).getTime()) / 60000)
        : null;
      return {
        ...user,
        lastActiveAt,
        minutesSinceActive: minutesAgo,
        presence:
          minutesAgo === null ? 'never'
            : minutesAgo <= 5 ? 'online'
            : minutesAgo <= 60 ? 'recent'
            : minutesAgo <= 60 * 24 ? 'today'
            : minutesAgo <= 60 * 24 * 7 ? 'week'
            : 'idle',
      };
    });

    const u = buckets[0] || {};
    const p = productCounts[0] || {};
    const s = saleBuckets[0] || {};

    return {
      users: {
        recent: users,
        counts: {
          total: u.total || 0,
          online: u.online || 0,
          today: u.today || 0,
          week: u.week || 0,
          never: u.never || 0,
        },
      },
      products: {
        recent: recentProducts,
        counts: {
          total: p.total || 0,
          // Live = everything the shops still consider part of their catalogue.
          live: (p.total || 0) - (p.deleted || 0),
          deleted: p.deleted || 0,
          inactive: p.inactive || 0,
          addedToday: p.addedToday || 0,
          addedWeek: p.addedWeek || 0,
        },
      },
      sales: {
        recent: recentSales,
        counts: {
          // `total` is an estimate; every other figure here is exact.
          total: salesTotal || 0,
          todayCount: s.todayCount || 0,
          todayRevenue: s.todayRevenue || 0,
          todayDue: s.todayDue || 0,
          todayCancelled: s.todayCancelled || 0,
          weekCount: s.weekCount || 0,
          weekRevenue: s.weekRevenue || 0,
          weekCancelled: s.weekCancelled || 0,
        },
        // The UI labels its own windows, but it should not have to hardcode
        // where they start — a reader comparing this against a shop's daily
        // summary needs to know which midnight we used.
        windows: {
          todayStart: bdTodayStart,
          weekStart: salesWindowStart,
          timezone: 'Asia/Dhaka',
        },
      },
      generatedAt: new Date(),
    };
  }

  async getOnlineUsers(options = {}) {
    const onlineTrackingService = require('./onlineTracking.service');
    const cacheService = require('./cache.service');
    const { shopId } = options;

    let onlineUsers = [];

    if (shopId) {
      // Get online users for specific shop
      onlineUsers = await onlineTrackingService.getShopOnlineUsers(shopId);
    } else {
      // Get all online users from cache.
      // One pipelined MGET, not one round trip per user — same change as in
      // onlineTracking.service.js, which this loop duplicated.
      const allUserIds = await cacheService.sMembers('online:users');
      if (allUserIds && allUserIds.length > 0) {
        const userDataList = await cacheService.mGet(
          allUserIds.map((id) => `online:user:${id}`)
        );
        onlineUsers = userDataList.filter(Boolean);
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
    const Supplier = require('../models/Supplier.model');
    const SupplierBalance = require('../models/SupplierBalance.model');

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
    // HeldCart was missing from this list entirely (M-5). Order was added with
    // the online-order worklist (AGENT_WORKFLOW.md §9 item 4): without it,
    // every order taken before a shop went multi-branch would vanish from any
    // branch-selected worklist the moment the flag flipped.
    //
    // DueAdjustment and SupplierDueAdjustment were missing, and they are the
    // rows that explain a debt rather than merely carry it. Both ledgers filter
    // on `branch` the moment one is selected (`customer.service.getCustomerLedger`,
    // `supplier.service`), so every "পূর্বের বাকি (খাতা থেকে)" line and every
    // owner correction entered before enablement dropped out of the খতিয়ান —
    // the money still counted in `totalDue`, with nothing on the page left to
    // say where it came from. Nothing was deleted; it simply became unreachable,
    // which reads the same to the shop.
    const Order = require('../models/Order.model');
    const DueAdjustment = require('../models/DueAdjustment.model');
    const SupplierDueAdjustment = require('../models/SupplierDueAdjustment.model');
    const branchScopedModels = [
      Sale, Purchase, Expense, CashRegister, StockTransaction,
      Payment, SalesReturn, SMSLog, AuditLog, HeldCart, Order,
      DueAdjustment, SupplierDueAdjustment
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

    /**
     * `PaymentAccount` is deliberately NOT in the list above, and this is the
     * one collection where the blanket back-fill would be actively wrong.
     *
     * A blanket `$set: { branch: defaultBranch }` would tag every BANK account
     * and every bKash number to the Main Branch. Those are shared shop-wide by
     * design (FUND_ACCOUNT_PLAN D-3) and carry `branch: null` on purpose — the
     * shop has one bank account, not one per counter. Stamping them would hide
     * every one of them from every other branch the moment a second branch
     * existed, and the money paid from them would have nowhere to go.
     *
     * The §9.4 warning that untagged rows "become invisible" does not apply
     * here either: `accountScope.util.accountFilter` matches
     * `$or: [{branch: null}, {branch: active}]`, so a shared account stays
     * visible from everywhere by construction. It is precisely the CASH boxes
     * that need tagging, because a drawer belongs to a counter.
     */
    const PaymentAccount = require('../models/PaymentAccount.model');
    const cashBoxes = await PaymentAccount.updateMany(
      { shop: shopId, branch: null, type: 'cash' },
      { $set: { branch: defaultBranch._id } }
    );
    backfilled[PaymentAccount.modelName] = cashBoxes.modifiedCount;

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
    // `openingDue` is seeded with the rest. It was the one money column left
    // out, and it is not inert: `customer.service.setOpeningDue` measures its
    // delta against the figure the owner is LOOKING AT, which under branch
    // scope is this row. Seeded at 0 against a shop-wide ৳11,000, the branch
    // page showed পূর্বের বাকি ৳0, and an owner re-entering the true ৳11,000
    // computed `delta = 11,000 − 0` and ADDED it a second time — doubling both
    // the opening due and the total due. The Σ invariant this collection exists
    // to hold (`Σ CustomerBalance.openingDue === Customer.openingDue`) was also
    // broken from the first request, so `recalc-customer-balances.js` would
    // report the gap forever with nothing to explain it.
    const customerBalanceOps = [];
    for await (const customer of Customer.find({ shop: shopId }).select('_id totalPurchases totalPaid totalDue openingDue purchaseCount lastPurchase').lean()) {
      customerBalanceOps.push({
        updateOne: {
          filter: { shop: shopId, customer: customer._id, branch: defaultBranch._id },
          update: {
            $set: {
              totalPurchases: customer.totalPurchases || 0,
              totalPaid: customer.totalPaid || 0,
              totalDue: customer.totalDue || 0,
              openingDue: customer.openingDue || 0,
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

    // 4c. The same seeding for suppliers, which was not happening AT ALL.
    //
    // `SupplierBalance` has no scope flag — unlike customers, the figures follow
    // the active branch unconditionally (see that model's header), and
    // `overlayBranchFigures` falls back to `|| 0` for a supplier with no row. So
    // the moment the flag below flipped, EVERY supplier's payable read ৳0 at
    // branch level while the shop-wide rollup still held the real figure. The
    // shop's whole payables book disappeared from the only view its staff use.
    //
    // `Supplier` carries no `totalPaid` column — it only ever `$inc`s, so paid
    // is recovered from the identity the model documents:
    //
    //     totalDue = max(0, totalAmount + openingDue − totalPaid)
    //
    // inverted to `totalPaid = totalAmount + openingDue − totalDue`. Clamped at
    // zero: on an over-paid supplier the stored `totalDue` is the clamped value,
    // so the inversion can land slightly negative, and a negative paid figure
    // would make `recomputeDue` overstate the debt on the next purchase cancel.
    const supplierBalanceOps = [];
    for await (const supplier of Supplier.find({ shop: shopId }).select('_id totalAmount totalDue openingDue totalPurchases').lean()) {
      const amount = supplier.totalAmount || 0;
      const opening = supplier.openingDue || 0;
      const due = supplier.totalDue || 0;

      supplierBalanceOps.push({
        updateOne: {
          filter: { shop: shopId, supplier: supplier._id, branch: defaultBranch._id },
          update: {
            $set: {
              totalAmount: amount,
              totalPaid: Math.max(0, Math.round((amount + opening - due) * 100) / 100),
              totalDue: due,
              openingDue: opening,
              // Vocabulary differs from Customer on purpose: on a supplier
              // `totalPurchases` is the COUNT, and its per-branch twin is
              // `purchaseCount`. Mapping these by name would silently seed the
              // count with money.
              purchaseCount: supplier.totalPurchases || 0,
              updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          upsert: true,
        },
      });
    }
    let supplierBalancesSeeded = 0;
    if (supplierBalanceOps.length > 0) {
      const res = await SupplierBalance.bulkWrite(supplierBalanceOps, { ordered: false });
      supplierBalancesSeeded = (res.upsertedCount || 0) + (res.modifiedCount || 0);
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
        customerBalances: customerBalancesSeeded,
        supplierBalances: supplierBalancesSeeded
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

    // A key can be registered before the feature it names is built — the
    // permission, the nav entry and the frontend's `hasFeature` call all need
    // it to exist first. Enabling one of those tells the shop it has something
    // it does not. Turning it OFF is always allowed, so this can never strand a
    // shop that was switched on before the guard existed.
    const unavailable = value ? unavailableReason(key) : null;
    if (unavailable) {
      throw new AppError(
        `"${FEATURES[key].en}" cannot be enabled yet — ${unavailable}`,
        `"${FEATURES[key].bn}" এখনো চালু করা যাবে না — সুবিধাটি এখনো তৈরি হয়নি`,
        400
      );
    }

    // A capability that writes bytes needs somewhere to put them. Enabling one
    // while `storage.enabled` is false would give the shop an upload button
    // wired to a 403 — which reads as a bug to them and as a support ticket to
    // us. The mirror of this rule (disabling storage cascades these off) lives
    // in adminStorage.service.setShopStorage; between the two, the broken
    // combination is unreachable from either direction.
    const missing = missingDepsFor(shop, key);
    if (value && missing.storage) {
      throw new AppError(
        `"${FEATURES[key].en}" needs image storage. Enable storage for this shop first.`,
        `"${FEATURES[key].bn}" চালু করতে হলে আগে এই দোকানে ছবি সংরক্ষণ (স্টোরেজ) চালু করুন`,
        400
      );
    }

    // The same argument, one level up: a capability whose prerequisite is off
    // is a screen wired to a feature that is not there. `storefront` without
    // `onlineSelling` is a website with no way to put a product on it.
    //
    // Only DIRECT prerequisites are named. A shop whose grandparent flag is off
    // necessarily has its parent off too — that is what the cascade below
    // guarantees — so naming the immediate blocker gives the admin the one
    // toggle they actually have to flip next.
    if (value && missing.features.length) {
      const names = missing.features.map((k) => FEATURES[k].bn).join(', ');
      const namesEn = missing.features.map((k) => FEATURES[k].en).join(', ');
      throw new AppError(
        `"${FEATURES[key].en}" needs ${namesEn}. Enable ${missing.features.length > 1 ? 'those' : 'that'} first.`,
        `"${FEATURES[key].bn}" চালু করতে হলে আগে "${names}" চালু করুন`,
        400
      );
    }

    // Turning a capability OFF turns off everything that depends on it,
    // transitively. Without this the shop keeps a screen whose foundation has
    // been removed — the mirror of the check above, and the same shape as the
    // storage cascade in adminStorage.service. Between the two directions the
    // broken combination is unreachable.
    //
    // Only flags that are actually on are touched, so the audit entry lists
    // what really changed rather than every dependent that exists.
    const cascaded = value
      ? []
      : dependentsOf(key).filter((k) => shop.features?.[k] === true);

    if (!shop.features) shop.features = {};
    shop.features[key] = value;
    cascaded.forEach((k) => { shop.features[k] = false; });
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
        : `"${shop.name}" দোকানে "${meta.bn}" ফিচার বন্ধ করা হয়েছে`
          + (cascaded.length
            ? ` (সাথে বন্ধ হয়েছে: ${cascaded.map((k) => FEATURES[k].bn).join(', ')})`
            : ''),
      entity: { type: 'shop', id: shop._id, name: shop.name },
      changes: {
        before: { [`features.${key}`]: previous },
        after: { [`features.${key}`]: value, cascadedOff: cascaded },
      }
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
   * The AI allowance picture for one shop: the number, and where each of its
   * branches stands against it today.
   *
   * ── WHY THIS RETURNS A ROW PER BRANCH ──────────────────────────────────────
   *
   * The limit is negotiated per shop and the counter runs per branch
   * (ShopAiUsage.model.js explains why). An operator answering "their AI stopped
   * working" needs to see WHICH branch ran out — a shop-wide total would be an
   * average that is true of no branch, and would send them to look at the wrong
   * till.
   *
   * Branches with no counter document appear at 0 rather than being omitted.
   * A branch that has never used the feature and a branch that has used none of
   * its allowance today are the same thing to the person reading this screen,
   * and a missing row reads as a bug.
   */
  async getShopAi(shopId) {
    const shop = await Shop.findById(shopId).select('name features ai multiBranchEnabled').lean();
    if (!shop) {
      throw new AppError('Shop not found', 'দোকান পাওয়া যায়নি', 404);
    }

    const [effectiveLimit, settings, branches, counters] = await Promise.all([
      resolveDailyLimit(shop),
      PlatformSetting.current().catch(() => null),
      Branch.find({ shop: shopId, isActive: true }).select('name').lean(),
      ShopAiUsage.find({ shop: shopId }).lean(),
    ]);

    const dayKey = getBangladeshTodayStr();
    const byBranch = new Map(
      counters.map((c) => [c.branch ? String(c.branch) : 'null', c])
    );

    const usageRow = (id, name) => {
      const c = byBranch.get(id === null ? 'null' : String(id));
      // A stale dayKey means the branch has not used it TODAY. Reporting the
      // stored number would show yesterday's spend as today's.
      const usedToday = c && c.dayKey === dayKey ? c.usedToday : 0;
      return {
        branch: id === null ? null : String(id),
        branchName: name,
        usedToday,
        remaining: Math.max(0, effectiveLimit - usedToday),
        totalRequests: c?.totalRequests || 0,
        lastUsedAt: c?.lastUsedAt || null,
      };
    };

    // Single-branch shops count against a null branch — that is what
    // `req.branchId` is for them — so the list is one row named for the shop.
    const usage = shop.multiBranchEnabled && branches.length
      ? branches.map((b) => usageRow(b._id, b.name))
      : [usageRow(null, shop.name)];

    return {
      shop: { _id: String(shop._id), name: shop.name },
      enabled: shop.features?.aiExpense === true,
      // null = following the platform default. The panel needs to tell that
      // apart from a typed number that happens to equal it.
      dailyMessageLimit: typeof shop.ai?.dailyMessageLimit === 'number'
        ? shop.ai.dailyMessageLimit
        : null,
      isOverridden: typeof shop.ai?.dailyMessageLimit === 'number',
      effectiveLimit,
      platformDefault: settings?.defaultAiDailyMessageLimit ?? AI_DAILY_MESSAGE_LIMIT,
      limitSetAt: shop.ai?.limitSetAt || null,
      dayKey,
      usage,
    };
  }

  /**
   * Set — or clear — this shop's AI message allowance.
   *
   * `null` clears the override so the shop follows the platform default again.
   * Without an explicit way to express that, an operator who once typed 20 can
   * only get back by typing today's default as a literal, which silently pins
   * the shop to a number that stops tracking the platform for ever after. Same
   * reasoning as `Shop.storage.quotaMb`, and the panel exposes it as a
   * "প্ল্যাটফর্ম ডিফল্ট ব্যবহার করুন" button rather than an empty field the
   * operator has to guess at.
   *
   * @param {string} shopId
   * @param {string} adminId
   * @param {number|null} limit
   */
  async setShopAiLimit(shopId, adminId, limit) {
    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('Shop not found', 'দোকান পাওয়া যায়নি', 404);
    }

    // `null`, `''` and `undefined` all mean "follow the platform default" —
    // an empty input box is the panel's way of saying it, and treating an empty
    // string as 0 would silently switch the shop off instead.
    const clearing = limit === null || limit === undefined || limit === '';
    const value = clearing ? null : Number(limit);

    if (!clearing && (!Number.isInteger(value) || value < 0 || value > 200)) {
      throw new AppError(
        'dailyMessageLimit must be an integer between 0 and 200, or null',
        'দৈনিক সীমা ০ থেকে ২০০ এর মধ্যে একটি পূর্ণসংখ্যা হতে হবে',
        400
      );
    }

    const previous = typeof shop.ai?.dailyMessageLimit === 'number'
      ? shop.ai.dailyMessageLimit
      : null;

    shop.ai = {
      ...(shop.ai?.toObject ? shop.ai.toObject() : shop.ai || {}),
      dailyMessageLimit: value,
      limitSetAt: new Date(),
      limitSetBy: adminId,
    };
    // `ai` is a nested plain object like `features`; without this Mongoose can
    // miss the mutation and return 200 having saved nothing.
    shop.markModified('ai');
    await shop.save();

    await AuditLog.log({
      shop: shopId,
      admin: adminId,
      action: 'shop_ai_limit_set',
      description: clearing
        ? `"${shop.name}" দোকানের এআই সীমা প্ল্যাটফর্ম ডিফল্টে ফিরিয়ে আনা হয়েছে`
        : `"${shop.name}" দোকানের দৈনিক এআই বার্তার সীমা ${value} করা হয়েছে (প্রতি শাখায়)`,
      entity: { type: 'shop', id: shop._id, name: shop.name },
      changes: {
        before: { 'ai.dailyMessageLimit': previous },
        after: { 'ai.dailyMessageLimit': value },
      },
    });

    // The limit is read from `req.shop`, which is served from the auth cache.
    // Without this the new number does not apply until every session expires.
    await invalidateShopAuthCache(shopId);

    return this.getShopAi(shopId);
  }

  /**
   * Zero one branch's counter for today. A support action, not a routine one.
   *
   * Per branch rather than per shop: resetting the whole shop because one till
   * had a bad afternoon hands every other branch a second allowance nobody
   * asked for, and the operator would have no way to tell afterwards that they
   * had done it.
   */
  async resetShopAiUsage(shopId, branchId = null) {
    const shop = await Shop.findById(shopId).select('name').lean();
    if (!shop) {
      throw new AppError('Shop not found', 'দোকান পাওয়া যায়নি', 404);
    }

    await ShopAiUsage.updateOne(
      { shop: shopId, branch: branchId || null },
      { $set: { usedToday: 0, dayKey: getBangladeshTodayStr() } }
    );

    return this.getShopAi(shopId);
  }

  /**
   * Capability list for the admin UI: every known feature with its label and
   * this shop's current state. Built from FEATURES, never hand-listed, so a new
   * capability appears in the admin panel the moment it is registered.
   */
  async getShopFeatures(shopId) {
    const shop = await Shop.findById(shopId).select('name features storage').lean();
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    const storageEnabled = shop.storage?.enabled === true;

    return {
      shop: { _id: String(shop._id), name: shop.name },
      // Reported so the panel can render a storage-backed toggle as disabled
      // with a reason, instead of letting an admin click it and read a 400.
      storageEnabled,
      features: FEATURE_KEYS.map((key) => {
        const needsStorage = STORAGE_BACKED_FEATURES.includes(key);
        const missing = missingDepsFor(shop, key);
        // What turning this OFF would take with it. Reported so the panel can
        // warn BEFORE the click rather than letting an admin discover it from
        // the audit log — the same reason `storageEnabled` is reported above.
        const dependents = dependentsOf(key).filter((k) => shop.features?.[k] === true);

        const blockedReason = missing.storage
          ? 'আগে এই দোকানে ছবি সংরক্ষণ (স্টোরেজ) চালু করুন'
          : missing.features.length
            ? `আগে "${missing.features.map((k) => FEATURES[k].bn).join(', ')}" চালু করুন`
            : null;

        return {
          key,
          label: FEATURES[key].bn,
          labelEn: FEATURES[key].en,
          description: FEATURES[key].description,
          enabled: shop.features?.[key] === true,
          requiresStorage: needsStorage,
          requires: FEATURES[key].requires || [],
          missingRequires: missing.features,
          // Disabling this would cascade these off. Empty for every feature
          // nothing depends on, which is most of them.
          cascadesOff: dependents,
          blocked: Boolean(blockedReason),
          blockedReason,
        };
      }),
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
