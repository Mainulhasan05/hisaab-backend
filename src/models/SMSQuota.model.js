const mongoose = require('mongoose');

const allocationSchema = new mongoose.Schema({
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  allocatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    required: true
  },
  paymentMethod: {
    type: String,
    trim: true
  },
  transactionId: {
    type: String,
    trim: true
  },
  notes: {
    type: String
  }
}, {
  timestamps: { createdAt: 'allocatedAt', updatedAt: false }
});

const smsQuotaSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন'],
    unique: true
  },
  totalQuota: {
    type: Number,
    default: 0,
    min: 0
  },
  usedQuota: {
    type: Number,
    default: 0,
    min: 0
  },
  remainingQuota: {
    type: Number,
    default: 0,
    min: 0
  },
  isEnabled: {
    type: Boolean,
    default: false
  },
  allocations: [allocationSchema],
  lastUsedAt: {
    type: Date
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
smsQuotaSchema.index({ shop: 1 }, { unique: true });

// Calculate remaining quota before saving
smsQuotaSchema.pre('save', function(next) {
  this.remainingQuota = Math.max(0, this.totalQuota - this.usedQuota);
  next();
});

// Virtual: Has quota
smsQuotaSchema.virtual('hasQuota').get(function() {
  return this.isEnabled && this.remainingQuota > 0;
});

// Virtual: Usage percentage
smsQuotaSchema.virtual('usagePercentage').get(function() {
  if (this.totalQuota === 0) return 0;
  return ((this.usedQuota / this.totalQuota) * 100).toFixed(2);
});

// Method: Check and deduct quota
smsQuotaSchema.methods.deductQuota = async function(count = 1) {
  if (!this.isEnabled) {
    throw new Error('SMS service is not enabled for this shop');
  }

  if (this.remainingQuota < count) {
    throw new Error('Insufficient SMS quota');
  }

  this.usedQuota += count;
  this.remainingQuota = this.totalQuota - this.usedQuota;
  this.lastUsedAt = new Date();

  await this.save();
  return this.remainingQuota;
};

// Method: Add quota allocation
smsQuotaSchema.methods.addAllocation = async function(allocation) {
  this.allocations.push(allocation);
  this.totalQuota += allocation.quantity;
  this.remainingQuota = this.totalQuota - this.usedQuota;

  if (!this.isEnabled) {
    this.isEnabled = true;
  }

  await this.save();
  return this;
};

// Method: Refund quota
smsQuotaSchema.methods.refundQuota = async function(count) {
  this.usedQuota = Math.max(0, this.usedQuota - count);
  this.remainingQuota = this.totalQuota - this.usedQuota;
  await this.save();
  return this.remainingQuota;
};

// Static: Get or create quota for shop
smsQuotaSchema.statics.getOrCreate = async function(shopId) {
  let quota = await this.findOne({ shop: shopId });

  if (!quota) {
    quota = await this.create({ shop: shopId });
  }

  return quota;
};

// Static: Get shops with low quota
smsQuotaSchema.statics.getShopsWithLowQuota = function(threshold = 10) {
  return this.find({
    isEnabled: true,
    remainingQuota: { $lte: threshold }
  })
    .populate('shop', 'name phone')
    .sort({ remainingQuota: 1 });
};

// Static: Get quota summary for all shops
smsQuotaSchema.statics.getQuotaSummary = async function() {
  const summary = await this.aggregate([
    {
      $group: {
        _id: null,
        totalAllocated: { $sum: '$totalQuota' },
        totalUsed: { $sum: '$usedQuota' },
        totalRemaining: { $sum: '$remainingQuota' },
        enabledShops: { $sum: { $cond: ['$isEnabled', 1, 0] } },
        totalShops: { $sum: 1 }
      }
    }
  ]);

  return summary[0] || {
    totalAllocated: 0,
    totalUsed: 0,
    totalRemaining: 0,
    enabledShops: 0,
    totalShops: 0
  };
};

const SMSQuota = mongoose.model('SMSQuota', smsQuotaSchema);

module.exports = SMSQuota;
