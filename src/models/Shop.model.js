const mongoose = require('mongoose');
const { SHOP_TYPES, SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUS, DEFAULT_SETTINGS } = require('../config/constants');

const shopSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'দোকানের নাম দিন'],
    trim: true,
    maxlength: [100, 'দোকানের নাম ১০০ অক্ষরের বেশি হতে পারবে না']
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true,
    trim: true
  },
  type: {
    type: String,
    trim: true,
    default: 'other'
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
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  subscription: {
    plan: {
      type: String,
      enum: Object.values(SUBSCRIPTION_PLANS),
      default: SUBSCRIPTION_PLANS.PAID
    },
    status: {
      type: String,
      enum: Object.values(SUBSCRIPTION_STATUS),
      default: SUBSCRIPTION_STATUS.ACTIVE
    },
    startedAt: {
      type: Date,
      default: Date.now
    },
    expiresAt: {
      type: Date
    },
    monthlyPrice: {
      type: Number,
      default: 1000
    }
  },
  settings: {
    currency: {
      type: String,
      default: DEFAULT_SETTINGS.CURRENCY
    },
    lowStockThreshold: {
      type: Number,
      default: DEFAULT_SETTINGS.LOW_STOCK_THRESHOLD
    },
    invoicePrefix: {
      type: String,
      default: 'INV'
    },
    taxEnabled: {
      type: Boolean,
      default: false
    },
    taxRate: {
      type: Number,
      default: 0
    },
    showUnitOnInvoice: {
      type: Boolean,
      default: true
    },
    enabledVariantTypes: {
      type: [String],
      default: ['size', 'color']
    },
    // SMS settings
    smsSettings: {
      autoSendOnSale: {
        type: Boolean,
        default: false
      },
      autoSendOnDuePayment: {
        type: Boolean,
        default: false
      },
      sendToCustomersWithPhone: {
        type: Boolean,
        default: true
      },
      minSaleAmountForSms: {
        type: Number,
        default: 0
      }
    }
  },
  stats: {
    totalProducts: {
      type: Number,
      default: 0
    },
    totalCustomers: {
      type: Number,
      default: 0
    },
    totalSales: {
      type: Number,
      default: 0
    },
    totalRevenue: {
      type: Number,
      default: 0
    }
  },
  logo: {
    type: String
  },
  isActive: {
    type: Boolean,
    default: true
  },
  multiBranchEnabled: {
    type: Boolean,
    default: false
  },
  // Opt-in capabilities, switched on per shop by the platform admin only.
  //
  // Read this ONLY via `features.util.hasFeature(req, '<key>')`, never directly
  // — the helper is what guarantees a missing/`undefined` flag reads as OFF
  // rather than as truthy-object, and it is the one place to look when asking
  // "what turns this on?".
  //
  // `multiBranchEnabled` above is the older, bespoke form of the same idea. It
  // is deliberately NOT moved in here: it is read in ~20 places across services,
  // tests, scripts and the frontend, and a rename buys nothing. New capabilities
  // go here so that list stops growing.
  //
  // Every key must default to `false`. A shop that has never been touched by an
  // admin must behave exactly as it did before the capability existed.
  features: {
    // Fractional quantities (kg / litre / yard) + the purchase "x how many"
    // helper + the extended unit list. See AGENT_WORKFLOW.md I-6 before
    // touching anything that reads it.
    packaging: {
      type: Boolean,
      default: false
    },
    // Customer-tier pricing: a customer marked `isWholesale` is billed each
    // product's `wholesalePrice` instead of its `sellingPrice`. Read-path only
    // — see utils/pricing.util.js. Nothing is back-filled when this flips, and
    // nothing is lost when it flips back.
    wholesale: {
      type: Boolean,
      default: false
    },
    // A managed brand list, and a brand picker on the product form. Off = the
    // product form has no brand field at all and `Product.brand` is never set,
    // which is exactly how every shop behaved before this existed.
    brands: {
      type: Boolean,
      default: false
    }
  },
  // Whether branches share one customer book or keep separate ones (Phase 7).
  //
  //   'shop'   — one customer, one balance across every branch. A branch sees
  //              the customer's invoices from every other branch too.
  //   'branch' — each branch keeps its own dues and its own customer list.
  //
  // Only ever consulted when `multiBranchEnabled` is true; single-branch shops
  // behave as 'shop' regardless of what is stored here. Platform-admin only —
  // the owner has no route that can change it. Read via
  // `branchScope.util.customerScope(req)`, never directly.
  //
  // An enum rather than a boolean so a future third mode (branch group /
  // region) does not need a migration to express.
  customerScope: {
    type: String,
    enum: ['shop', 'branch'],
    default: 'branch'
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
shopSchema.index({ owner: 1 });
shopSchema.index({ 'subscription.status': 1 });
shopSchema.index({ createdAt: -1 });

// Generate slug before saving
shopSchema.pre('save', function(next) {
  if (this.isModified('name') || !this.slug) {
    // Create slug from name
    let slug = this.name
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();

    // Add random suffix for uniqueness
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    this.slug = `${slug}-${randomSuffix}`;
  }
  next();
});

// Note: No trial auto-expiry — admin controls expiry dates manually

// Virtual: Check if subscription is valid
shopSchema.virtual('isSubscriptionValid').get(function() {
  const sub = this.subscription;
  if (!sub || sub.status !== SUBSCRIPTION_STATUS.ACTIVE) {
    return false;
  }
  if (sub.expiresAt && sub.expiresAt < new Date()) {
    return false;
  }
  return true;
});

// Virtual: Days remaining in subscription
shopSchema.virtual('subscriptionDaysRemaining').get(function() {
  const sub = this.subscription;
  if (!sub || !sub.expiresAt) return null;
  const diff = sub.expiresAt - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
});

// Static: Find by slug
shopSchema.statics.findBySlug = function(slug) {
  return this.findOne({ slug, isActive: true });
};

// Method: Update stats
shopSchema.methods.updateStats = async function(field, increment = 1) {
  const updateField = `stats.${field}`;
  await this.updateOne({ $inc: { [updateField]: increment } });
};

const Shop = mongoose.model('Shop', shopSchema);

module.exports = Shop;
