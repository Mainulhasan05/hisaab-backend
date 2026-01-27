const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  name: {
    type: String,
    required: [true, 'সরবরাহকারীর নাম দিন'],
    trim: true,
    maxlength: [200, 'নাম ২০০ অক্ষরের বেশি হতে পারবে না']
  },
  phone: {
    type: String,
    trim: true
  },
  address: {
    type: String,
    trim: true,
    maxlength: [500, 'ঠিকানা ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  notes: {
    type: String,
    maxlength: [500, 'নোট ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  totalPurchases: {
    type: Number,
    default: 0
  },
  totalAmount: {
    type: Number,
    default: 0
  },
  totalDue: {
    type: Number,
    default: 0
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
supplierSchema.index({ shop: 1, name: 1 }, { unique: true });
supplierSchema.index({ shop: 1, phone: 1 }, { sparse: true });
supplierSchema.index({ shop: 1, isActive: 1 });
supplierSchema.index({ shop: 1, createdAt: -1 });

// Static: Search suppliers
supplierSchema.statics.searchSuppliers = function(shopId, query, options = {}) {
  const { page = 1, limit = 20 } = options;

  const filter = {
    shop: shopId,
    isActive: true,
    $or: [
      { name: { $regex: query, $options: 'i' } },
      { phone: { $regex: query, $options: 'i' } }
    ]
  };

  return this.find(filter)
    .sort({ name: 1 })
    .skip((page - 1) * limit)
    .limit(limit);
};

const Supplier = mongoose.model('Supplier', supplierSchema);

module.exports = Supplier;
