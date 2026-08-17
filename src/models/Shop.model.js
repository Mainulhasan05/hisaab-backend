const mongoose = require('mongoose');
const {
  SHOP_TYPES,
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUS,
  DEFAULT_SETTINGS,
  SUBSCRIPTION_PRICE,
} = require('../config/constants');

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
      default: SUBSCRIPTION_PRICE
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
      default: SUBSCRIPTION_PRICE,
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
    /**
     * Hard ceiling on a single line's discount, as a percent off the list rate.
     * Only consulted when `features.lineDiscount` is on.
     *
     * `null` (the default) = no cap, which is every shop that has never set
     * one. A percent rather than a taka figure so one number stays meaningful
     * across a ৳১০ pen and a ৳১০,০০০ বস্তা.
     *
     * Owner-set, not admin-set — the admin sells the capability, the owner
     * decides how far their own staff may go with it.
     */
    maxLineDiscountPercent: {
      type: Number,
      default: null,
      min: 0,
      max: 100
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
    },
    // Photos on products and their variants. Requires `storage.enabled` below —
    // admin.service refuses to turn this on without it, and turning storage off
    // turns this off too. Off = no image control anywhere on the product form,
    // and nothing is ever written to catalogImages by the R2 pipeline.
    productImages: {
      type: Boolean,
      default: false
    },
    // The same, for category photos. A separate axis on purpose: a shop that
    // wants a tidy category grid does not necessarily want 500 product photos,
    // and the storage cost of the two is an order of magnitude apart.
    categoryImages: {
      type: Boolean,
      default: false
    },
    // Per-product "sell this online" settings, the online price override and the
    // featured flag. Off = the product form has no online section at all and
    // `isAvailableOnline` is forced false, which is how every shop behaved
    // before the capability existed. Was a build-time constant in the
    // frontend's lib/uiFlags.js; it became a real per-shop flag the moment one
    // shop needed it and another did not.
    onlineSelling: {
      type: Boolean,
      default: false
    },
    // The public website and the separate /online panel that manages it.
    // Requires `onlineSelling` + `productImages` — see the `requires` chain in
    // utils/features.util.js, which is what stops a shop being handed a
    // storefront it has no products or photos for. Off = the panel does not
    // render and the public page 404s; the Storefront document is kept.
    storefront: {
      type: Boolean,
      default: false
    },
    // Cart, checkout and the order worklist. A separate axis from `storefront`
    // on purpose: a catalogue site with call/WhatsApp buttons is the FINISHED
    // product for a shop that will not run a parcel operation, and forcing a
    // cart on them means orders arrive that nobody processes.
    onlineOrders: {
      type: Boolean,
      default: false
    },
    // Seasonal campaign pages the PLATFORM builds and assigns to this shop,
    // each with its own public link and expiry date. Independent of
    // `storefront` on purpose: a trader who wants one campaign page must not
    // have to configure a catalogue website first.
    //
    // The orders these bring in live in their own collection and never enter
    // the customer book or the sales ledger (LANDING_PAGE_PLAN.md I-17), which
    // is why this flag gates a whole separate panel rather than adding anything
    // to the shop's existing screens. Off = no panel, no nav entry; the pages
    // and their orders are kept, so the switch is reversible.
    landingPages: {
      type: Boolean,
      default: false
    },
    // Combo/offer products: a sellable bundle of other products (buy-1-get-1,
    // gift packs) whose sale deducts each component's own stock. Off = the
    // product form has no combo option, `type: 'combo'` is refused on create,
    // and existing combos stop being sellable — their documents and every
    // sale/ledger row are kept, so the switch is reversible.
    combos: {
      type: Boolean,
      default: false
    },
    // Per-line negotiated pricing at the till — "৳১০০ each, but ৳৯০ for you".
    // The cashier types a RATE and the server derives the concession; see
    // utils/lineDiscount.util.js for why both are stored. Bounded by
    // `settings.maxLineDiscountPercent` below and by the `sales.discount`
    // permission, which are three separate axes on purpose: the platform sells
    // the capability, the owner says who may use it, and the cap is the leash.
    //
    // Off = no rate control in the POS and a posted `agreedUnitPrice` is
    // refused. Sales that already carry one keep it, so the switch is
    // reversible.
    lineDiscount: {
      type: Boolean,
      default: false
    },
    // The shop numbers its own invoices — a trader copying from a manual
    // invoice book, or carrying an existing series across from whatever they
    // used before. Off (every shop) = `INV-<BRANCH>-<YYYYMMDD>-####` from the
    // atomic counter, and a posted `invoiceNo` is REFUSED rather than ignored,
    // so a number the owner typed can never differ from the one printed.
    //
    // TWO axes, and unlike `lineDiscount` there is no permission among them:
    // the platform sells the capability, and the `{shop, invoiceNo}` unique
    // index is what actually guarantees uniqueness. This flag is the whole
    // gate — once it is on, anyone who may ring up a sale may number it, because
    // the number is copied off the customer's carbon copy rather than chosen at
    // the till. See `utils/invoiceNo.util.js` for the full argument, and note
    // that `sales.invoice_no` was retired for it (config/permissions.js
    // DEPRECATED_ACTIONS).
    // Numbering is never handed to the client — only the CHOICE of number is.
    //
    // Off again = the `INV-` series resumes exactly where it stopped, because a
    // typed number never advances the counter. Sales already carrying one keep
    // it, so the switch is reversible in both directions.
    customInvoiceNo: {
      type: Boolean,
      default: false
    }
  },

  /**
   * Which storefront templates this shop has been GRANTED.
   *
   * The platform admin ticks templates here; the shop picks one of them from
   * its own panel. Two separate acts, and they must stay separate — "which
   * templates exist" is a platform decision and "which one are we running" is
   * the shop's.
   *
   * ── THE INVARIANT THIS FIELD EXISTS TO CARRY ────────────────────────────────
   * Revoking a grant NEVER takes a live site down. `allowedTemplates` is
   * checked when a shop APPLIES a template, and never when one is RENDERED —
   * the applied key lives on the Storefront document and the public page reads
   * it from there. So an admin tidying up the template list cannot blank a
   * shop's website, discover it from a support call, and be unable to say which
   * shops they broke.
   *
   * Same shape as the rule in Product.model.js that the `unit` enum accepts the
   * full registry regardless of which units a shop may currently CHOOSE: a
   * validation list has to keep accepting anything already stored.
   *
   * Empty (the default) = no templates granted, which is every shop that an
   * admin has never touched.
   */
  storefront: {
    allowedTemplates: {
      type: [String],
      default: []
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
  },

  /**
   * Image storage: whether this shop may keep photos at all, and how much.
   *
   * ── THREE DISTINCT STATES, AND THEY ARE NOT INTERCHANGEABLE ────────────────
   *   enabled: false   the shop was never given the storage feature.
   *                    Upload → 403 "এই দোকানে ছবি সংরক্ষণ চালু নেই"
   *   quotaMb: 0       it has the feature, and an allowance of nothing.
   *                    Upload → 413 "স্টোরেজ কোটা শেষ"
   *   quotaMb: null    it has the feature and follows the platform default.
   *
   * Conflating any two of those produces an error message that sends the shop
   * owner to the wrong person for help, so the checks and the copy stay
   * separate all the way down. `null` is the default rather than a number so
   * raising `PlatformSetting.defaultStorageQuotaMb` lifts every shop that has
   * not been individually negotiated — the same relationship `billing` has with
   * the platform's standard prices.
   *
   * `enabled` is the master switch: turning it off also turns off the
   * `productImages` / `categoryImages` capabilities, because a shop that can
   * see an upload button but cannot store anything is a support ticket. That
   * cascade lives in `admin.service`, which is the only writer here. Nothing is
   * ever deleted by flipping this off.
   */
  storage: {
    enabled: { type: Boolean, default: false },
    enabledAt: { type: Date, default: null },
    enabledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },

    // null = use PlatformSetting.defaultStorageQuotaMb
    quotaMb: { type: Number, default: null, min: 0 },

    // Sum of ShopMedia.totalBytes for this shop. Mongo is the source of truth;
    // Redis only ever caches it. Can drift if a refCount goes wrong, which is
    // what the admin panel's "recalculate" button is for.
    usedBytes: { type: Number, default: 0, min: 0 },
    fileCount: { type: Number, default: 0, min: 0 },

    lastUploadAt: { type: Date, default: null },
    // High-water mark. Survives deletions, so "this shop needed 400MB once" is
    // still answerable after they clean up — useful when negotiating a quota.
    peakUsedBytes: { type: Number, default: 0, min: 0 },
    lastRecalculatedAt: { type: Date, default: null }
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
