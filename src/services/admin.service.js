const Shop = require('../models/Shop.model');
const User = require('../models/User.model');
const Admin = require('../models/Admin.model');
const Sale = require('../models/Sale.model');
const SMSQuota = require('../models/SMSQuota.model');
const AuditLog = require('../models/AuditLog.model');
const Payment = require('../models/Payment.model');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { AppError } = require('../middleware/error.middleware');

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
      { expiresIn: '7d' }
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
    const [
      totalShops,
      activeShops,
      trialShops,
      expiredShops,
      totalUsers,
    ] = await Promise.all([
      Shop.countDocuments(),
      Shop.countDocuments({ 'subscription.status': 'active' }),
      Shop.countDocuments({ 'subscription.plan': 'trial' }),
      Shop.countDocuments({ 'subscription.status': 'expired' }),
      User.countDocuments({ isActive: true }),
    ]);

    // Calculate revenue (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Get month's start
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    // Calculate total revenue from subscription payments
    const revenueResult = await Payment.aggregate([
      {
        $match: {
          type: 'subscription',
        },
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$amount' },
        },
      },
    ]);

    const monthlyRevenueResult = await Payment.aggregate([
      {
        $match: {
          type: 'subscription',
          createdAt: { $gte: monthStart },
        },
      },
      {
        $group: {
          _id: null,
          monthlyRevenue: { $sum: '$amount' },
        },
      },
    ]);

    return {
      totalShops,
      activeShops,
      trialShops,
      expiredShops,
      totalUsers,
      totalRevenue: revenueResult[0]?.totalRevenue || 0,
      monthlyRevenue: monthlyRevenueResult[0]?.monthlyRevenue || 0,
    };
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

    // Filter by subscription status
    if (status) {
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
    const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

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

    // Merge SMS quota data with shops
    const shopsWithQuota = shops.map(shop => ({
      ...shop,
      smsQuota: quotaMap.get(shop._id.toString()) || null,
    }));

    return {
      data: shopsWithQuota,
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
      .populate('owner', 'name phone role');

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

    return {
      ...shop.toObject(),
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

  // Update shop status
  async updateShopStatus(adminId, shopId, status, reason) {
    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    const previousStatus = shop.subscription.status;
    shop.subscription.status = status;
    shop.isActive = status === 'active';
    await shop.save();

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

  // Update shop subscription
  async updateShopSubscription(adminId, shopId, plan, expiresAt) {
    const shop = await Shop.findById(shopId);
    if (!shop) {
      throw new AppError('দোকান পাওয়া যায়নি', 'Shop not found', 404);
    }

    const previousPlan = shop.subscription.plan;
    const previousExpiry = shop.subscription.expiresAt;

    shop.subscription.plan = plan;
    shop.subscription.expiresAt = new Date(expiresAt);
    shop.subscription.status = 'active';
    shop.isActive = true;
    await shop.save();

    // Create audit log
    await AuditLog.create({
      admin: adminId,
      action: 'subscription_update',
      actionBn: 'সাবস্ক্রিপশন আপডেট',
      description: `Updated subscription for ${shop.name}: ${previousPlan} → ${plan}`,
      descriptionBn: `${shop.name} এর সাবস্ক্রিপশন আপডেট: ${previousPlan} → ${plan}`,
      entity: {
        type: 'shop',
        id: shop._id,
        name: shop.name,
      },
      changes: {
        before: { plan: previousPlan, expiresAt: previousExpiry },
        after: { plan, expiresAt },
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

  // Record subscription payment
  async recordSubscriptionPayment(adminId, paymentData) {
    const { shopId, amount, plan, method, transactionId, notes } = paymentData;

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
      notes: `Subscription: ${plan}. ${notes || ''}`,
      receivedBy: adminId,
    });

    // Calculate new expiry date
    let months;
    switch (plan) {
      case 'monthly':
        months = 1;
        break;
      case 'quarterly':
        months = 3;
        break;
      case 'yearly':
        months = 12;
        break;
      default:
        months = 1;
    }

    const currentExpiry = shop.subscription.expiresAt > new Date()
      ? shop.subscription.expiresAt
      : new Date();
    const newExpiry = new Date(currentExpiry);
    newExpiry.setMonth(newExpiry.getMonth() + months);

    // Update shop subscription
    shop.subscription.plan = plan === 'yearly' ? 'premium' : 'standard';
    shop.subscription.expiresAt = newExpiry;
    shop.subscription.status = 'active';
    shop.isActive = true;
    await shop.save();

    // Create audit log
    await AuditLog.create({
      admin: adminId,
      action: 'payment_recorded',
      actionBn: 'পেমেন্ট রেকর্ড',
      description: `Recorded payment ৳${amount} for ${shop.name}`,
      descriptionBn: `${shop.name} এর জন্য ৳${amount} পেমেন্ট রেকর্ড করা হয়েছে`,
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
    const { page = 1, limit = 50, shopId, action, userId } = options;

    const query = {};
    if (shopId) query.shop = shopId;
    if (action) query.action = action;
    if (userId) query.user = userId;

    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      AuditLog.find(query)
        .populate('user', 'name phone')
        .populate('admin', 'name phone')
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

  // Create admin user
  async createAdmin(creatorId, adminData) {
    const { phone, password, name, role } = adminData;

    // Check if admin exists
    const existingAdmin = await Admin.findOne({ phone });
    if (existingAdmin) {
      throw new AppError('এই ফোন নম্বর দিয়ে ইতিমধ্যে অ্যাডমিন আছে', 'Admin with this phone already exists', 400);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

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
}

module.exports = new AdminService();
