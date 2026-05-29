const mongoose = require('mongoose');

const redemptionSchema = new mongoose.Schema({
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
  },
  customerName: String,
  sale: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale',
  },
  invoiceNo: String,
  amount: {
    type: Number,
    required: true,
  },
  redeemedAt: {
    type: Date,
    default: Date.now,
  },
}, { _id: true });

const couponSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন'],
  },
  code: {
    type: String,
    required: [true, 'কুপন কোড দিন'],
    trim: true,
    uppercase: true,
  },
  description: {
    type: String,
    trim: true,
    maxlength: [200, 'বিবরণ ২০০ অক্ষরের বেশি হতে পারবে না'],
  },
  descriptionBn: {
    type: String,
    trim: true,
  },
  discountType: {
    type: String,
    enum: ['fixed', 'percentage'],
    default: 'fixed',
  },
  discountValue: {
    type: Number,
    required: [true, 'ডিসকাউন্টের পরিমাণ দিন'],
    min: [0.01, 'ডিসকাউন্ট ০ এর বেশি হতে হবে'],
  },
  minPurchase: {
    type: Number,
    default: 0,
    min: [0, 'সর্বনিম্ন ক্রয় ০ এর কম হতে পারবে না'],
  },
  maxDiscount: {
    type: Number,
    default: 0, // 0 = no cap
    min: [0, 'সর্বোচ্চ ডিসকাউন্ট ০ এর কম হতে পারবে না'],
  },
  validFrom: {
    type: Date,
    default: Date.now,
  },
  validUntil: {
    type: Date,
  },
  usageLimit: {
    type: Number,
    default: 0, // 0 = unlimited
    min: [0, 'ব্যবহার সীমা ০ এর কম হতে পারবে না'],
  },
  usageCount: {
    type: Number,
    default: 0,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  redemptions: [redemptionSchema],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

// Indexes
couponSchema.index({ shop: 1, code: 1 }, { unique: true });
couponSchema.index({ shop: 1, isActive: 1, validUntil: 1 });

// Virtual: Is expired
couponSchema.virtual('isExpired').get(function () {
  if (!this.validUntil) return false;
  return new Date() > this.validUntil;
});

// Virtual: Is usage limit reached
couponSchema.virtual('isLimitReached').get(function () {
  if (this.usageLimit === 0) return false;
  return this.usageCount >= this.usageLimit;
});

// Virtual: Is valid (active + not expired + not limit reached)
couponSchema.virtual('isValid').get(function () {
  if (!this.isActive) return false;
  if (this.isExpired) return false;
  if (this.isLimitReached) return false;
  if (this.validFrom && new Date() < this.validFrom) return false;
  return true;
});

// Static: Generate coupon code
couponSchema.statics.generateCode = async function (shopId) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  let exists = true;

  while (exists) {
    code = 'HB-';
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    exists = await this.findOne({ shop: shopId, code });
  }

  return code;
};

const Coupon = mongoose.model('Coupon', couponSchema);

module.exports = Coupon;
