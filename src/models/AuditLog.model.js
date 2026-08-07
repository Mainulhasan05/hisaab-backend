const mongoose = require('mongoose');
const { AUDIT_ACTIONS } = require('../config/constants');

const auditLogSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop'
    // null for system-level actions
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  admin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
    // For admin actions
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    default: null
  },
  action: {
    type: String,
    required: [true, 'অ্যাকশন দিন']
  },
  actionBn: {
    type: String,
    required: [true, 'বাংলা অ্যাকশন দিন']
  },
  description: {
    type: String
  },
  descriptionBn: {
    type: String
  },
  entity: {
    type: {
      type: String // 'product', 'sale', 'customer', 'user', etc.
    },
    id: mongoose.Schema.Types.ObjectId,
    name: String
  },
  changes: {
    before: mongoose.Schema.Types.Mixed,
    after: mongoose.Schema.Types.Mixed
  },
  metadata: {
    ip: String,
    userAgent: String,
    browser: String,
    os: String,
    device: String
  },
  isSystemAction: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Indexes - Optimized for scalability
auditLogSchema.index({ shop: 1, createdAt: -1 }); // Main listing with date sort
auditLogSchema.index({ shop: 1, branch: 1, createdAt: -1 }); // Branch-filtered listing
auditLogSchema.index({ admin: 1, createdAt: -1 }); // Admin audit trail
auditLogSchema.index({ customer: 1, createdAt: -1 }); // Customer audit trail
auditLogSchema.index({ shop: 1, user: 1, createdAt: -1 }); // Per-user activity within a shop
auditLogSchema.index({ shop: 1, 'entity.type': 1, 'entity.id': 1, createdAt: -1 }); // Entity history lookup

// TTL Index - Auto-delete logs older than 90 days to prevent unbounded growth
// For compliance, export/archive logs before deletion if needed
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 }); // 90 days

// Static: Create audit log.
//
// `branch` was missing from this destructure, so every caller that passed one —
// branch create/update/deactivate, staff changes, due collection, multi-branch
// enable/disable — had it silently dropped, leaving the audit log unfilterable
// by branch. It now defaults to the request's active branch, so a call site
// cannot forget it.
auditLogSchema.statics.log = async function({
  shop,
  branch,
  user,
  admin,
  customer,
  action,
  description,
  entity,
  changes,
  req
}) {
  // Get action labels
  const actionConfig = Object.values(AUDIT_ACTIONS).find(a => a.en === action);

  const customerId = customer || (entity?.type === 'customer' && entity.id ? entity.id : null);

  const logData = {
    shop,
    branch: branch !== undefined ? branch : (req?.branchId || null),
    user,
    admin,
    customer: customerId,
    action,
    actionBn: actionConfig?.bn || action,
    description,
    descriptionBn: description, // Can be customized
    entity,
    changes
  };

  // Add metadata from request with proxy-aware IP extraction
  if (req) {
    const userAgentStr = req.get ? req.get('User-Agent') : req.headers?.['user-agent'] || '';
    const rawIp = req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
                  req.ip ||
                  req.connection?.remoteAddress ||
                  req.socket?.remoteAddress ||
                  '127.0.0.1';

    logData.metadata = {
      ip: rawIp,
      userAgent: userAgentStr,
      browser: extractBrowser(userAgentStr),
      os: extractOS(userAgentStr),
      device: extractDevice(userAgentStr)
    };
  }

  return this.create(logData);
};

// Static: Get shop audit logs
auditLogSchema.statics.getShopLogs = function(shopId, options = {}) {
  const { page = 1, limit = 50, action, userId, customerId, startDate, endDate } = options;

  const filter = { shop: shopId };

  if (action) filter.action = action;
  if (userId) filter.user = userId;
  if (customerId) filter.customer = customerId;
  if (startDate && endDate) {
    filter.createdAt = { $gte: startDate, $lte: endDate };
  }

  return this.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('user', 'name phone email')
    .populate('admin', 'name phone email')
    .populate('customer', 'name phone email');
};

// Static: Get user activity
auditLogSchema.statics.getUserActivity = function(userId, options = {}) {
  const { page = 1, limit = 50, startDate, endDate } = options;

  const filter = { user: userId };

  if (startDate && endDate) {
    filter.createdAt = { $gte: startDate, $lte: endDate };
  }

  return this.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('customer', 'name phone email');
};

// Static: Get entity history
auditLogSchema.statics.getEntityHistory = function(entityType, entityId, options = {}) {
  const { page = 1, limit = 20 } = options;

  return this.find({
    'entity.type': entityType,
    'entity.id': entityId
  })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('user', 'name phone')
    .populate('customer', 'name phone email');
};

// Static: Get admin logs
auditLogSchema.statics.getAdminLogs = function(options = {}) {
  const { page = 1, limit = 50, adminId, startDate, endDate } = options;

  const filter = { admin: { $ne: null } };

  if (adminId) filter.admin = adminId;
  if (startDate && endDate) {
    filter.createdAt = { $gte: startDate, $lte: endDate };
  }

  return this.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('admin', 'name phone')
    .populate('customer', 'name phone email')
    .populate('shop', 'name');
};

// Helper functions for user agent parsing
function extractBrowser(userAgent) {
  if (!userAgent) return 'Unknown';
  if (userAgent.includes('Chrome')) return 'Chrome';
  if (userAgent.includes('Firefox')) return 'Firefox';
  if (userAgent.includes('Safari')) return 'Safari';
  if (userAgent.includes('Edge')) return 'Edge';
  if (userAgent.includes('Opera')) return 'Opera';
  return 'Unknown';
}

function extractOS(userAgent) {
  if (!userAgent) return 'Unknown';
  if (userAgent.includes('Windows')) return 'Windows';
  if (userAgent.includes('Mac')) return 'macOS';
  if (userAgent.includes('Linux')) return 'Linux';
  if (userAgent.includes('Android')) return 'Android';
  if (userAgent.includes('iOS') || userAgent.includes('iPhone')) return 'iOS';
  return 'Unknown';
}

function extractDevice(userAgent) {
  if (!userAgent) return 'Unknown';
  if (userAgent.includes('Mobile')) return 'Mobile';
  if (userAgent.includes('Tablet')) return 'Tablet';
  return 'Desktop';
}

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;
