const mongoose = require('mongoose');
const { AUDIT_ACTIONS } = require('../config/constants');
const { getAuditMetadata, getActor } = require('../utils/requestStore.util');

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

/**
 * Fill in origin (and actor) from the request in flight.
 *
 * ── Why this is a hook and not a call-site fix ───────────────────────────────
 *
 * `AuditLog.log()` accepted a `req` and captured metadata from it. But 33 call
 * sites — every product, sale, purchase, expense, cash-register, supplier,
 * coupon and sales-return log — call `AuditLog.create()` directly, which took
 * that path nowhere near them. The result was an audit trail whose Origin panel
 * read "IP address —, Browser —, OS —" for most of the actions in the system.
 *
 * Adding `req` to 33 signatures fixes the 33 that exist and none of the ones
 * written next month, and the failure mode is silent: the row saves, it is just
 * blind. Reading the ambient request here means a call site cannot forget.
 *
 * Nothing is overwritten. A caller that passed metadata explicitly — including
 * `AuditLog.log()`, which still does — keeps exactly what it passed. Outside a
 * request (jobs, scripts, seeds, tests) `getAuditMetadata()` returns null and
 * this is a no-op, which is why `isSystemAction` rows stay clean.
 */
auditLogSchema.pre('validate', function (next) {
  if (!this.metadata || !this.metadata.ip) {
    const metadata = getAuditMetadata();
    if (metadata) this.metadata = metadata;
  }

  // The actor is normally passed explicitly and left alone. This only rescues
  // the rows where it was omitted, which otherwise show "By —" in the admin
  // trail and cannot be filtered by user at all.
  if (!this.user && !this.admin && !this.isSystemAction) {
    const actor = getActor();
    if (actor?.userId) this.user = actor.userId;
    else if (actor?.adminId) this.admin = actor.adminId;
  }

  // Same treatment for branch — a null branch makes a row invisible to every
  // branch-filtered view of the trail.
  if (this.branch === undefined || this.branch === null) {
    const actor = getActor();
    if (actor?.branchId) this.branch = actor.branchId;
  }

  next();
});

/**
 * `actionBn` is required by the schema, and roughly a third of the call sites
 * pass it by hand — which is how the same action ends up with two different
 * Bengali labels depending on which service wrote it. Derive it from the shared
 * AUDIT_ACTIONS table when it is missing, and fall back to the raw action name
 * so a new action type can never fail validation and lose the row entirely.
 */
auditLogSchema.pre('validate', function (next) {
  if (!this.actionBn && this.action) {
    const config = Object.values(AUDIT_ACTIONS).find((a) => a.en === this.action);
    this.actionBn = config?.bn || this.action;
  }
  next();
});

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
