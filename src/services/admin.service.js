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

    return {
      data: shops,
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
