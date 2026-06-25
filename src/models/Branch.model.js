const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  name: {
    type: String,
    required: [true, 'শাখার নাম দিন'],
    trim: true,
    maxlength: [100, 'শাখার নাম ১০০ অক্ষরের বেশি হতে পারবে না']
  },
  code: {
    type: String,
    required: [true, 'শাখার কোড দিন'],
    trim: true,
    uppercase: true,
    maxlength: [10, 'কোড ১০ অক্ষরের বেশি হতে পারবে না']
  },
  address: {
    type: String,
    trim: true,
    maxlength: [500, 'ঠিকানা ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  phone: {
    type: String,
    trim: true
  },
  isDefault: {
    type: Boolean,
    default: false
  },
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

// Indexes
branchSchema.index({ shop: 1, code: 1 }, { unique: true });
branchSchema.index({ shop: 1, isActive: 1 });

// Static: Get all active branches for a shop
branchSchema.statics.getShopBranches = function(shopId) {
  return this.find({ shop: shopId, isActive: true })
    .sort({ isDefault: -1, name: 1 });
};

// Static: Get default branch for a shop
branchSchema.statics.getDefaultBranch = function(shopId) {
  return this.findOne({ shop: shopId, isDefault: true, isActive: true });
};

// Static: Validate branch belongs to shop
branchSchema.statics.validateBranchOwnership = async function(branchId, shopId) {
  const branch = await this.findOne({
    _id: branchId,
    shop: shopId,
    isActive: true
  });
  return branch;
};

const Branch = mongoose.model('Branch', branchSchema);

module.exports = Branch;
