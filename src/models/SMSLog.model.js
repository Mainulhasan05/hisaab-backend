const mongoose = require('mongoose');
const { SMS_TYPES, SMS_STATUS } = require('../config/constants');

const recipientSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  },
  customerName: String,
  message: String, // For dynamic SMS
  status: {
    type: String,
    enum: Object.values(SMS_STATUS),
    default: SMS_STATUS.PENDING
  },
  deliveredAt: Date,
  failedReason: String
}, { _id: true });

const smsLogSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    default: null
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  recipients: {
    type: [recipientSchema],
    required: [true, 'প্রাপক দিন'],
    validate: [arr => arr.length > 0, 'অন্তত একজন প্রাপক দিন']
  },
  message: {
    type: String,
    required: [true, 'মেসেজ দিন'],
    maxlength: [1000, 'মেসেজ ১০০০ অক্ষরের বেশি হতে পারবে না']
  },
  type: {
    type: String,
    enum: {
      values: Object.values(SMS_TYPES),
      message: 'অবৈধ এসএমএস ধরন'
    },
    default: SMS_TYPES.SINGLE
  },
  transactionId: {
    type: String,
    trim: true
  },
  cost: {
    type: Number,
    default: 0,
    min: 0
  },
  status: {
    type: String,
    enum: Object.values(SMS_STATUS),
    default: SMS_STATUS.PENDING
  },
  sentCount: {
    type: Number,
    default: 0
  },
  deliveredCount: {
    type: Number,
    default: 0
  },
  failedCount: {
    type: Number,
    default: 0
  },
  apiResponse: {
    type: mongoose.Schema.Types.Mixed
  },
  errorMessage: {
    type: String
  },
  scheduledAt: {
    type: Date
  },
  invoiceNumber: {
    type: String,
    trim: true,
    index: true
  },
  sale: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale',
    default: null
  },
  sentBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes - Optimized for scalability
smsLogSchema.index({ shop: 1, createdAt: -1 }); // Main listing
smsLogSchema.index({ shop: 1, branch: 1, createdAt: -1 }); // Branch-filtered listing
smsLogSchema.index({ shop: 1, invoiceNumber: 1 }, { sparse: true }); // Duplicate SMS prevention for invoices
smsLogSchema.index({ transactionId: 1 }, { sparse: true }); // Webhook status updates

// TTL Index - Auto-delete logs older than 60 days
smsLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 }); // 60 days

// Virtual: Total recipients
smsLogSchema.virtual('totalRecipients').get(function() {
  return this.recipients.length;
});

// Virtual: Is successful
smsLogSchema.virtual('isSuccessful').get(function() {
  return this.status === SMS_STATUS.SENT || this.status === SMS_STATUS.DELIVERED;
});

// Method: Update delivery status
smsLogSchema.methods.updateDeliveryStatus = async function(recipientPhone, status, failedReason = null) {
  const recipient = this.recipients.find(r => r.phone === recipientPhone);
  if (recipient) {
    recipient.status = status;
    if (status === SMS_STATUS.DELIVERED) {
      recipient.deliveredAt = new Date();
      this.deliveredCount += 1;
    } else if (status === SMS_STATUS.FAILED) {
      recipient.failedReason = failedReason;
      this.failedCount += 1;
    }

    // Update overall status
    if (this.deliveredCount === this.recipients.length) {
      this.status = SMS_STATUS.DELIVERED;
    } else if (this.failedCount === this.recipients.length) {
      this.status = SMS_STATUS.FAILED;
    } else if (this.deliveredCount > 0 || this.sentCount > 0) {
      this.status = SMS_STATUS.PARTIAL;
    }

    await this.save();
  }
};

// Static: Get SMS summary
smsLogSchema.statics.getSMSSummary = async function(shopId, startDate, endDate) {
  const match = {
    shop: new mongoose.Types.ObjectId(shopId),
    createdAt: { $gte: startDate, $lte: endDate }
  };

  const summary = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$type',
        totalCost: { $sum: '$cost' },
        totalRecipients: { $sum: { $size: '$recipients' } },
        totalSent: { $sum: '$sentCount' },
        totalDelivered: { $sum: '$deliveredCount' },
        totalFailed: { $sum: '$failedCount' },
        count: { $sum: 1 }
      }
    }
  ]);

  return summary;
};

// Static: Get shop SMS history
smsLogSchema.statics.getShopHistory = function(shopId, options = {}) {
  const { page = 1, limit = 20, type, status, startDate, endDate } = options;

  const filter = { shop: shopId };

  if (type) filter.type = type;
  if (status) filter.status = status;
  if (startDate && endDate) {
    filter.createdAt = { $gte: startDate, $lte: endDate };
  }

  return this.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('sentBy', 'name');
};

const SMSLog = mongoose.model('SMSLog', smsLogSchema);

module.exports = SMSLog;
