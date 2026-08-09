const mongoose = require('mongoose');
const { normalizePhone } = require('../utils/phone.util');

const customerSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  phone: {
    type: String,
    required: [true, 'ফোন নম্বর দিন'],
    trim: true
  },
  name: {
    type: String,
    trim: true,
    maxlength: [100, 'নাম ১০০ অক্ষরের বেশি হতে পারবে না']
  },
  address: {
    type: String,
    trim: true,
    maxlength: [500, 'ঠিকানা ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  // Financial summary
  totalPurchases: {
    type: Number,
    default: 0
  },
  totalPaid: {
    type: Number,
    default: 0
  },
  totalDue: {
    type: Number,
    default: 0
  },
  // Due that no invoice of ours produced — the balance carried over from the
  // shop's paper খাতা at onboarding, plus any later owner correction. Kept as
  // its own term rather than folded into `totalPurchases` so that "মোট কেনাকাটা"
  // stays honest: it means goods actually bought here, and nothing else.
  //
  // `totalDue` already includes this. The two are maintained together — see
  // DueAdjustment.model.js for the formula every recompute path must use.
  openingDue: {
    type: Number,
    default: 0
  },
  purchaseCount: {
    type: Number,
    default: 0
  },
  lastPurchase: {
    type: Date
  },
  notes: {
    type: String,
    maxlength: [1000, 'নোট ১০০০ অক্ষরের বেশি হতে পারবে না']
  },
  tags: [{
    type: String,
    trim: true
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes - Optimized for scalability
customerSchema.index({ shop: 1, phone: 1 }, { unique: true }); // Phone lookup
customerSchema.index({ shop: 1, totalDue: -1 }); // Due customers list
customerSchema.index({ shop: 1, createdAt: -1 }); // Listing by date
// Note: Text search removed - use regex for name search or implement Elasticsearch

// Normalize phone before saving
customerSchema.pre('save', function(next) {
  if (this.isModified('phone')) {
    this.phone = normalizePhone(this.phone);
  }
  next();
});

// Virtual: Display name (returns phone if name is empty)
customerSchema.virtual('displayName').get(function() {
  return this.name || this.phone;
});

// Virtual: Has due
customerSchema.virtual('hasDue').get(function() {
  return this.totalDue > 0;
});

/**
 * The one formula. Every path that RE-DERIVES due (rather than `$inc`-ing it)
 * must go through here, so the `openingDue` term can never be dropped on one
 * side and kept on the other — which is exactly how two books silently drift.
 *
 * Mirrored by `CustomerBalance.recomputeDue` for the per-branch rows and by
 * `scripts/recalc-customer-balances.js`, which checks both against source
 * documents. See DueAdjustment.model.js for why the term exists at all.
 */
customerSchema.statics.deriveDue = function(doc) {
  return Math.max(
    0,
    (doc?.totalPurchases || 0) + (doc?.openingDue || 0) - (doc?.totalPaid || 0)
  );
};

// Method: Add purchase
customerSchema.methods.addPurchase = async function(amount, paid) {
  this.totalPurchases += amount;
  this.totalPaid += paid;
  this.totalDue = this.constructor.deriveDue(this);
  this.purchaseCount += 1;
  this.lastPurchase = new Date();
  await this.save();
};

// Method: Add payment
customerSchema.methods.addPayment = async function(amount) {
  this.totalPaid += amount;
  this.totalDue = this.constructor.deriveDue(this);
  await this.save();
};

// Method: Refund
customerSchema.methods.refund = async function(amount) {
  this.totalPurchases -= amount;
  this.totalDue = this.constructor.deriveDue(this);
  this.purchaseCount = Math.max(0, this.purchaseCount - 1);
  await this.save();
};

// Static: Find by phone in shop
customerSchema.statics.findByPhoneInShop = function(phone, shopId) {
  const normalizedPhone = normalizePhone(phone);
  return this.findOne({ phone: normalizedPhone, shop: shopId, isActive: true });
};

// Static: Get customers with due
customerSchema.statics.getCustomersWithDue = function(shopId, options = {}) {
  const { page = 1, limit = 20, sortBy = 'totalDue', sortOrder = -1 } = options;

  return this.find({ shop: shopId, totalDue: { $gt: 0 }, isActive: true })
    .sort({ [sortBy]: sortOrder })
    .skip((page - 1) * limit)
    .limit(limit);
};

// Static: Get top customers
customerSchema.statics.getTopCustomers = function(shopId, limit = 10) {
  return this.find({ shop: shopId, isActive: true })
    .sort({ totalPurchases: -1 })
    .limit(limit);
};

// Static: Search customers
customerSchema.statics.searchCustomers = function(shopId, query, options = {}) {
  const { page = 1, limit = 20 } = options;
  const normalizedQuery = normalizePhone(query) || query;

  return this.find({
    shop: shopId,
    isActive: true,
    $or: [
      { phone: { $regex: normalizedQuery, $options: 'i' } },
      { name: { $regex: query, $options: 'i' } }
    ]
  })
    .sort({ name: 1 })
    .skip((page - 1) * limit)
    .limit(limit);
};

const Customer = mongoose.model('Customer', customerSchema);

module.exports = Customer;
