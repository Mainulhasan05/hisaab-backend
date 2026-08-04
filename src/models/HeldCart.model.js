const mongoose = require('mongoose');

const heldCartItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  productName: { type: String, required: true },
  productCode: { type: String },
  variantId: { type: mongoose.Schema.Types.ObjectId },
  variantSku: { type: String },
  variantAttributes: { type: mongoose.Schema.Types.Mixed },
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true, min: 0 },
  discount: { type: Number, default: 0 }
}, { _id: true });

const heldCartSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  items: {
    type: [heldCartItemSchema],
    required: true,
    validate: [arr => arr.length > 0, 'কমপক্ষে একটি পণ্য থাকতে হবে']
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  },
  customerName: { type: String },
  customerPhone: { type: String },
  discount: { type: Number, default: 0 },
  discountType: {
    type: String,
    enum: ['fixed', 'percentage'],
    default: 'fixed'
  },
  deliveryCharge: { type: Number, default: 0, min: 0 },
  notes: { type: String, maxlength: 500 },
  label: { type: String, maxlength: 100 }, // Quick identifier like "Table 3" or customer name
  heldBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    enum: ['held', 'converted', 'expired', 'discarded'],
    default: 'held'
  },
  convertedSale: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale'
  },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
heldCartSchema.index({ shop: 1, branch: 1, status: 1, createdAt: -1 });
heldCartSchema.index({ shop: 1, expiresAt: 1, status: 1 });

// Virtual: item count
heldCartSchema.virtual('itemCount').get(function() {
  return this.items ? this.items.reduce((sum, item) => sum + item.quantity, 0) : 0;
});

// Virtual: estimated total
heldCartSchema.virtual('estimatedTotal').get(function() {
  if (!this.items) return 0;
  const subtotal = this.items.reduce((sum, item) => sum + (item.unitPrice * item.quantity - item.discount), 0);
  let discountAmount = this.discount || 0;
  if (this.discountType === 'percentage') {
    discountAmount = (subtotal * this.discount) / 100;
  }
  const delivery = this.deliveryCharge || 0;
  return Math.max(0, subtotal - discountAmount + delivery);
});

const HeldCart = mongoose.model('HeldCart', heldCartSchema);

module.exports = HeldCart;
