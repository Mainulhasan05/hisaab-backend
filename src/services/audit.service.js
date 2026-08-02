const AuditLog = require('../models/AuditLog.model');
const mongoose = require('mongoose');

class AuditService {
  // Get audit logs with filtering and pagination
  async getAuditLogs(shopId, options = {}) {
    const {
      page = 1,
      limit = 50,
      userId,
      action,
      entityType,
      startDate,
      endDate,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;

    const query = { shop: shopId };

    // Branch scoping
    if (options.branchId) {
      query.branch = options.branchId;
    }

    // Filter by user
    if (userId) {
      query.user = userId;
    }

    // Filter by action
    if (action) {
      query.action = action;
    }

    // Filter by entity type
    if (entityType) {
      query['entity.type'] = entityType;
    }

    // Filter by date range
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const skip = (page - 1) * limit;
    const sortField = ['createdAt', 'action'].includes(sortBy) ? sortBy : 'createdAt';
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

    const [logs, total] = await Promise.all([
      AuditLog.find(query)
        .populate('user', 'name phone')
        .sort(sort)
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

  // Get audit log by ID
  async getAuditLogById(shopId, logId) {
    const log = await AuditLog.findOne({ _id: logId, shop: shopId })
      .populate('user', 'name phone');

    return log;
  }

  // Create audit log
  async createAuditLog(data) {
    const log = await AuditLog.create(data);
    return log;
  }

  // Get activity summary
  async getActivitySummary(shopId, options = {}) {
    const { startDate, endDate } = options;

    const matchStage = { shop: new mongoose.Types.ObjectId(shopId) };

    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) matchStage.createdAt.$gte = new Date(startDate);
      if (endDate) matchStage.createdAt.$lte = new Date(endDate);
    }

    // Group by action type
    const byAction = await AuditLog.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$action',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Group by user
    const byUser = await AuditLog.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$user',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'userDetails',
        },
      },
      {
        $project: {
          count: 1,
          userName: { $arrayElemAt: ['$userDetails.name', 0] },
        },
      },
    ]);

    // Group by day (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const byDay = await AuditLog.aggregate([
      {
        $match: {
          ...matchStage,
          createdAt: { $gte: sevenDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return {
      byAction,
      byUser,
      byDay,
    };
  }

  // Get user activity
  async getUserActivity(shopId, userId, options = {}) {
    const { page = 1, limit = 20 } = options;

    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      AuditLog.find({ shop: shopId, user: userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      AuditLog.countDocuments({ shop: shopId, user: userId }),
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

  // Get entity history
  async getEntityHistory(shopId, entityType, entityId) {
    const logs = await AuditLog.find({
      shop: shopId,
      'entity.type': entityType,
      'entity.id': entityId,
    })
      .populate('user', 'name phone')
      .sort({ createdAt: -1 })
      .lean();

    return logs;
  }
}

module.exports = new AuditService();
