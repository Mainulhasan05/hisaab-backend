const mongoose = require('mongoose');

/**
 * Service Model — represents a service offered by a service-based business
 * (e.g., haircut, facial, laser treatment)
 *
 * Unlike Product (physical inventory with stock/barcode/buying-price),
 * Service tracks duration, assigned providers, and session-based packages.
 */

// Consumable link — how much of a product is used per service session
const consumableSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  quantityPerSession: {
    type: Number,
    default: 1,
    min: 0
  }
}, { _id: false });

const serviceSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন'],
    index: true
  },
  code: {
    type: String,
    trim: true,
    uppercase: true
  },
  name: {
    type: String,
    required: [true, 'সেবার নাম দিন'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category'
  },
  // Duration in minutes
  duration: {
    type: Number,
    default: 30,
    min: [5, 'সর্বনিম্ন ৫ মিনিট']
  },
  // Pricing
  price: {
    type: Number,
    required: [true, 'সেবার মূল্য দিন'],
    min: [0, 'মূল্য ০ এর কম হতে পারবে না']
  },
  memberPrice: {
    type: Number,
    min: [0, 'সদস্য মূল্য ০ এর কম হতে পারবে না']
  },
  // Package/session support (e.g., "6 sessions of laser")
  isPackage: {
    type: Boolean,
    default: false
  },
  packageSessions: {
    type: Number,
    min: [1, 'সর্বনিম্ন ১ সেশন']
  },
  packagePrice: {
    type: Number,
    min: [0, 'প্যাকেজ মূল্য ০ এর কম হতে পারবে না']
  },
  // Consumables used per session (links to Product model for stock deduction)
  consumables: [consumableSchema],
  // Staff who can perform this service
  assignedProviders: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  // Images
  images: [{
    type: String
  }],
  // Status
  isActive: {
    type: Boolean,
    default: true
  },
  // Sort order for UI display
  sortOrder: {
    type: Number,
    default: 0
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Compound index for shop-scoped queries
serviceSchema.index({ shop: 1, isActive: 1, sortOrder: 1 });
serviceSchema.index({ shop: 1, category: 1 });
serviceSchema.index({ shop: 1, code: 1 }, { unique: true, sparse: true });

// Auto-generate code before save
serviceSchema.pre('save', async function(next) {
  if (this.isNew && !this.code) {
    const count = await this.constructor.countDocuments({ shop: this.shop });
    this.code = `SVC-${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

// Virtual: per-session price for packages
serviceSchema.virtual('perSessionPrice').get(function() {
  if (this.isPackage && this.packageSessions > 0 && this.packagePrice) {
    return Math.round(this.packagePrice / this.packageSessions);
  }
  return this.price;
});

serviceSchema.set('toJSON', { virtuals: true });
serviceSchema.set('toObject', { virtuals: true });

const Service = mongoose.model('Service', serviceSchema);

module.exports = Service;
