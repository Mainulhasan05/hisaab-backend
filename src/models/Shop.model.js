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
  // Billing state. Read it through `utils/subscriptionState.util.js`, never by
  // hand — that resolver is what keeps the owner's banner and the admin's chip
  // from disagreeing. See SUBSCRIPTION_PLAN.md §3.
  //
  // Subscription is deliberately SHOP-level and there is no per-branch expiry
  // field, so extending a shop covers every branch by construction. Adding one
  // would be the bug this comment exists to prevent (invariant §8.6).
  subscription: {
    plan: {
      type: String,
      enum: Object.values(SUBSCRIPTION_PLANS),
      default: SUBSCRIPTION_PLANS.PAID
    },
    // Legacy axis. The resolver still reads 'suspended' as a block so the
    // cut-over was a no-op for shops switched off the old way, but nothing
    // writes 'suspended' any more — new blocks go to `access` below, where
    // they carry an actor and a reason.
    status: {
      type: String,
      enum: Object.values(SUBSCRIPTION_STATUS),
      default: SUBSCRIPTION_STATUS.ACTIVE
    },
    startedAt: {
      type: Date,
      default: Date.now
    },
    // null / absent = never expires. Perpetual and internal shops rely on this,
    // and it is what stops a bad migration from locking out the platform.
    // Always stored as the END of a Bangladesh day (bdTime.endOfBangladeshDay)
    // so "paid through the 31st" means the shop trades all day on the 31st.
    expiresAt: {
      type: Date
    },
    /** @deprecated moved to `billing.monthlyPrice`; kept so old docs still read. */
    monthlyPrice: {
      type: Number,
      default: 1000
    },
    // Extra days of full access after expiry, granted per shop by the admin.
    // Platform-wide grace does not exist: 0 here means expiry behaves exactly
    // as it always has.
    graceDays: {
      type: Number,
      default: 0,
      min: 0
    },
    // What the trial was granted as, for funnel reporting. Any day count the
    // admin types is valid — there is no cap.
    trialDays: {
      type: Number
    },
    trialEndedAt: {
      type: Date
    },
    lastPaymentAt: {
      type: Date
    },
    // Phase 2 (payment automation). Stored from day one so auto-renew has data
    // to work with when it arrives; ignored entirely until then.
    autoRenew: {
      type: Boolean,
      default: false
    }
  },
  // The negotiated numbers. Every shop bargains its own price, so these are the
  // agreed figures and they are what every price display on BOTH sides reads —
  // the owner's billing card and the admin's payment form included.
  billing: {
    monthlyPrice: {
      type: Number,
      default: 1000,
      min: 0
    },
    // What this shop usually buys at a time (1/3/6/12). Prefills the payment
    // form; carries no enforcement.
    cycleMonths: {
      type: Number,
      default: 1,
      min: 1
    },
    // Negotiated ৳ per SMS. Prefills allocation; the price actually charged is
    // frozen onto each allocation, so history stays truthful when this changes.
    smsUnitPrice: {
      type: Number,
      default: 0.4,
      min: 0
    },
    currency: {
      type: String,
      default: 'BDT'
    },
    // Who actually pays, when that is not the owner.
    billingContact: {
      name: { type: String, trim: true },
      phone: { type: String, trim: true }
    },
    notes: {
      type: String,
      maxlength: 1000
    }
  },
  // Manual admin lockout. `blockedAt` is the single source of truth: null means
  // not blocked. A block is full — no login, no read, no write, owner and staff
  // alike; there is no read-only block mode, because softer treatment already
  // exists as the expired state.
  //
  // INVARIANT: only an explicit admin action may ever set this. No cron, no
  // expiry sweep, no failed payment, no migration. Expiry degrades a shop to
  // read-only; only a person blocks one, and unblocking is always one click
  // away. SUBSCRIPTION_PLAN.md §8.
  access: {
    blockedAt: {
      type: Date,
      default: null
    },
    blockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin'
    },
    blockReason: {
      type: String,
      maxlength: 500
    },
    unblockedAt: {
      type: Date
    },
    unblockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin'
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
// The admin worklist ("expiring in 3 days", "expired", "trials ending") sorts
// and ranges on expiry across every shop, with no shop predicate to narrow it.
shopSchema.index({ 'subscription.expiresAt': 1 });
// Blocked shops must always be findable — a shop the operator cannot find is a
// shop they cannot unblock (invariant §8.3). Sparse: most shops are not blocked.
shopSchema.index({ 'access.blockedAt': 1 }, { sparse: true });

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

// Virtual: may this shop still write?
//
// Delegates to the resolver rather than re-deriving the rule. The old inline
// version treated any non-'active' status as invalid and compared raw
// timestamps; the resolver adds the grace window and counts Bangladesh calendar
// days, and having both would mean two answers to one question.
shopSchema.virtual('isSubscriptionValid').get(function() {
  const { resolveSubscription } = require('../utils/subscriptionState.util');
  return resolveSubscription(this).canWrite;
});

// Virtual: Days remaining in subscription (Bangladesh calendar days; null when
// the shop has no expiry date, i.e. never expires)
shopSchema.virtual('subscriptionDaysRemaining').get(function() {
  const { resolveSubscription } = require('../utils/subscriptionState.util');
  const days = resolveSubscription(this).daysRemaining;
  return days === null ? null : Math.max(0, days);
});

// Virtual: the full resolved state, for anything rendering a chip or a banner
shopSchema.virtual('subscriptionState').get(function() {
  const { resolveSubscription } = require('../utils/subscriptionState.util');
  return resolveSubscription(this).state;
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
