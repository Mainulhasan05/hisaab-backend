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
  /**
   * The admin who granted the credits, or null when the shop bought them itself.
   *
   * Deliberately NOT required. It was, back when the only way to get SMS credit
   * was for an operator to key it in — but a self-serve gateway purchase has no
   * admin behind it, and `required: true` would have rejected every one of them
   * at the last step, after the shop had already been charged.
   *
   * Null therefore means something specific and useful: "this shop paid for this
   * itself". The `PlatformPayment` row written alongside carries the full
   * provenance (`source`, `gateway.paymentId`, the trxId), so nothing is lost by
   * this field being empty.
   */
  allocatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
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

// Index: shop is already unique via the field definition

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

/**
 * Static: Reserve quota atomically.
 *
 * `deductQuota` above reads the document, checks `remainingQuota`, then saves —
 * three steps with a gap in the middle. Two campaigns launched at once (or a
 * campaign and a till receipt) both read the same balance, both decide they can
 * afford it, and the shop sends more SMS than it paid for. Harmless for a
 * single receipt; a real hole once one request can commit thousands of
 * segments.
 *
 * This puts the check and the decrement in one `findOneAndUpdate`, so the
 * balance guard is evaluated by the database under the document lock. A `null`
 * return means "could not afford it" — there is no partial reservation.
 *
 * Bulk sends reserve the whole estimated cost UP FRONT and refund what the
 * gateway rejects. The alternative — deducting per batch as it lands — lets a
 * campaign start, spend half a shop's balance, and stop halfway with no way to
 * tell the shopkeeper in advance that it would.
 */
smsQuotaSchema.statics.reserve = async function(shopId, count = 1) {
  if (count <= 0) return null;

  return this.findOneAndUpdate(
    { shop: shopId, isEnabled: true, remainingQuota: { $gte: count } },
    {
      $inc: { usedQuota: count, remainingQuota: -count },
      $set: { lastUsedAt: new Date() },
    },
    { new: true }
  );
};

/**
 * Static: Return unspent quota.
 *
 * Counterpart to `reserve` — used when a batch the shop already paid for never
 * reached the gateway. Clamped so a double refund cannot mint quota: `usedQuota`
 * floors at zero and `remainingQuota` is recomputed from it in the same update.
 */
smsQuotaSchema.statics.refund = async function(shopId, count = 1) {
  if (count <= 0) return null;

  const quota = await this.findOne({ shop: shopId });
  if (!quota) return null;

  const refundable = Math.min(count, quota.usedQuota);
  if (refundable <= 0) return quota;

  return this.findOneAndUpdate(
    { shop: shopId },
    { $inc: { usedQuota: -refundable, remainingQuota: refundable } },
    { new: true }
  );
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
