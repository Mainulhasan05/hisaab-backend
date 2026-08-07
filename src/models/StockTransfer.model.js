const mongoose = require('mongoose');

const transferItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: [true, 'পণ্য নির্বাচন করুন'],
  },
  productName: {
    type: String,
    required: true,
  },
  productCode: {
    type: String,
  },
  variantId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  variantSku: {
    type: String,
  },
  variantAttributes: {
    type: mongoose.Schema.Types.Mixed,
  },
  quantity: {
    type: Number,
    required: [true, 'পরিমাণ দিন'],
    min: [1, 'পরিমাণ কমপক্ষে ১ হতে হবে'],
  },
  received: {
    type: Number,
    default: 0,
    min: 0,
  },
}, { _id: true });

const stockTransferSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন'],
  },
  transferNo: {
    type: String,
    required: true,
  },
  fromBranch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, 'উৎস শাখা নির্বাচন করুন'],
  },
  toBranch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, 'গন্তব্য শাখা নির্বাচন করুন'],
  },
  items: {
    type: [transferItemSchema],
    validate: {
      validator: (v) => v.length > 0,
      message: 'কমপক্ষে একটি পণ্য যোগ করুন',
    },
  },
  status: {
    type: String,
    enum: ['pending', 'in_transit', 'received', 'rejected'],
    default: 'pending',
  },
  notes: {
    type: String,
    maxlength: [500, 'নোট ৫০০ অক্ষরের বেশি হতে পারবে না'],
  },
  rejectionReason: {
    type: String,
  },
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  receivedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedAt: {
    type: Date,
  },
  receivedAt: {
    type: Date,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

// Indexes
stockTransferSchema.index({ shop: 1, status: 1, createdAt: -1 });
stockTransferSchema.index({ shop: 1, fromBranch: 1 });
stockTransferSchema.index({ shop: 1, toBranch: 1 });
// transferNo is generated per shop (see the pre-validate hook below), so it must
// be unique per shop — not globally. A plain `unique: true` on the field made
// two different shops collide on their first transfer (TRF-000001).
stockTransferSchema.index({ shop: 1, transferNo: 1 }, { unique: true });

// Auto-generate transfer number
stockTransferSchema.pre('validate', async function (next) {
  if (this.isNew && !this.transferNo) {
    const count = await mongoose.model('StockTransfer').countDocuments({ shop: this.shop });
    this.transferNo = `TRF-${String(count + 1).padStart(6, '0')}`;
  }
  next();
});

// Virtual: total items count
stockTransferSchema.virtual('totalItems').get(function () {
  return this.items?.reduce((sum, item) => sum + item.quantity, 0) || 0;
});

const StockTransfer = mongoose.model('StockTransfer', stockTransferSchema);

module.exports = StockTransfer;
