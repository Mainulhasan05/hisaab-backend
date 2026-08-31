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
  /**
   * EXTRA numbers printed on the invoice header, under `phone`.
   *
   * `phone` above stays the shop's ONE canonical number and is not part of this
   * list: the storefront's tel:/WhatsApp link, the billing record, the admin
   * console and the founder's Telegram alert all read it, and not one of them
   * can take a list. Folding them together would have meant every one of those
   * callers picking a number out of an array, which is how a shop ends up with
   * its fax on a WhatsApp button.
   *
   * So this is additive and print-only. A shop with one number leaves it empty
   * and nothing about the invoice changes; a shop with a landline beside the
   * mobile puts it here and both print. Normalised by
   * `phone.util.normalizeInvoicePhones` — deliberately NOT by `normalizePhone`,
   * see the note there.
   */
  invoicePhones: {
    type: [{ type: String, trim: true, maxlength: 32 }],
    default: [],
    // Capped in the schema as well as in the normaliser, because the normaliser
    // only guards the routes that call it and the header has finite room.
    validate: {
      validator: (v) => !Array.isArray(v) || v.length <= 4,
      message: 'সর্বোচ্চ ৪টি অতিরিক্ত নম্বর দেওয়া যাবে',
    },
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
    /**
     * খাতা বন্ধ — the last day whose books the owner has signed off on.
     *
     * ── The gap this fills ───────────────────────────────────────────────────
     *
     * Backdating is permission-gated and honest: a sale backdated to Thursday
     * IS a Thursday sale everywhere, which is the whole model
     * (`utils/saleDate.util.js`). What it was not, was BOUNDED. Anyone holding
     * `sales.backdate` or `customers.backdate` could post into any prior month
     * or year, and `saleDate.util` names the consequence in its own header:
     *
     *     "you read it on Friday; after a Saturday backdate it is ৳45,000."
     *
     * For a product whose entire proposition is a number the owner trusts, a
     * figure that changes retroactively is the fastest available way to lose
     * that trust — and the owner has no way to notice, because the report simply
     * reads differently the next time they open it.
     *
     * ── This is NOT the policy window `saleDate.util` rule 5 rejects ─────────
     *
     * That comment is right and stands: "an owner entering last year's books is
     * doing something legitimate", so there is no rolling limit on how far back
     * a date may reach. This is the opposite kind of thing — not a window that
     * moves on its own, but an explicit line the OWNER draws once they are done
     * with a period. A shop entering last year's books sets it to nothing until
     * they have finished, then closes the year in one move.
     *
     * ── `null` is the default and means nothing is closed ───────────────────
     *
     * Every shop on the platform, until an owner deliberately draws the line.
     * The dated-write paths return early on `null`, so the feature costs a shop
     * that has never used it exactly one falsy check.
     *
     * Stored as an instant, compared against the END of that Bangladesh day —
     * closing "31 July" must close all of 31 July, not everything before its
     * midnight. `utils/periodLock.util.js` is the single place that comparison
     * is made, so no caller can get the boundary a taka wrong on its own.
     */
    booksClosedThrough: {
      type: Date,
      default: null
    },
    enabledVariantTypes: {
      type: [String],
      default: ['size', 'color']
    },
    /**
     * ── The shop's own variant vocabulary ─────────────────────────────────────
     *
     * What this is NOT: the list of options a shop can pick from. That list is
     * DERIVED — built-in presets, plus every value this shop's own products
     * already use, read straight out of `Product.variants[].attributes` by
     * `variantCatalog.service`. A shop that types "৩৬" into the product form
     * has it back as a button on the next product because the product it was
     * saved on is the record. There is no second copy to keep in step, nothing
     * to migrate, and nothing that can drift from what the shop actually sells.
     *
     * What lives HERE is only the part that cannot be inferred from products:
     *
     *   `customTypes` — variant types this shop invented. The eight built-in
     *     types are a guess about Bangladeshi retail and they are wrong for
     *     plenty of it: a shop selling oil needs ভলিউম (১০০ml / ৫০০ml), and no
     *     amount of looking at their products can tell us they wanted to call
     *     that dimension something. `_formatVariants` files any unrecognised
     *     key under `attributes.custom`, so a custom type needs no schema
     *     change and no migration — only a name.
     *
     *   `labels` — `{ typeId: 'কোমরের মাপ' }`. A পাঞ্জাবি shop's "সাইজ" is a
     *     waist measurement and a grocer's is a packet weight. Renaming the
     *     type is far cheaper than inventing one, and it is the single most
     *     common thing a shop will want.
     *
     *   `hidden` — `{ typeId: ['XXXL'] }`. The one thing derivation genuinely
     *     cannot do: forget a typo. A value mistyped onto one product would
     *     otherwise sit in the chip list until that product is edited, and
     *     asking a shopkeeper to hunt down the product to remove a bad chip is
     *     not a fix. Hiding never touches the products themselves — the variant
     *     that carries the value keeps carrying it, it simply stops being
     *     OFFERED. Anything else would silently rewrite sold stock.
     *
     * All three are small, bounded and written only from the settings screen,
     * which is what makes them safe to carry on this document — it is loaded on
     * every authenticated request.
     */
    variantCatalog: {
      customTypes: {
        type: [
          {
            _id: false,
            // Slug, ASCII, no dots — it becomes a key under
            // `attributes.custom`, so it has to be a legal Mongo field name.
            id: { type: String, trim: true },
            label: { type: String, trim: true },
            icon: { type: String, trim: true, default: '🏷️' },
          },
        ],
        default: () => [],
      },
      // Mixed rather than Map: these are keyed by type id, they are read on
      // every product form, and a plain object survives the JSON round trip to
      // the client and back without the caller having to know it was a Map.
      labels: {
        type: mongoose.Schema.Types.Mixed,
        default: () => ({}),
      },
      hidden: {
        type: mongoose.Schema.Types.Mixed,
        default: () => ({}),
      },
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
      },
      /**
       * The language of the receipt the CUSTOMER receives.
       *
       * Bangla by default — it is what a customer in Bangladesh reads, and for
       * the half of the platform whose shop name is already Bangla it is free:
       * the message was UCS-2 either way.
       *
       * `en` exists for the other half. A receipt from a shop named in ASCII is
       * one GSM-7 segment today and becomes two the moment a Bangla character
       * enters it, so this is a real per-message cost and the shop's to choose,
       * not ours to impose. See smsTemplates.util.js.
       */
      language: {
        type: String,
        enum: ['bn', 'en'],
        default: 'bn'
      },
      /**
       * This shop's own wording for the sale receipt.
       *
       * Empty — the default, and what every existing shop has — means the
       * platform body in `smsTemplates.util.js` is used, unchanged. So this
       * field is inert until an operator fills it in, and clearing the box is
       * the off switch.
       *
       * ADMIN-ONLY BY CONSTRUCTION. `PATCH /api/auth/shop/settings` writes from
       * an allowlist that has never contained `smsSettings`, so a shopkeeper
       * cannot reach this even though it lives on their document. Deliberate:
       * a bad template here is charged to the shop's quota on every sale they
       * make, and the segment ceiling that prevents that is enforced in the
       * admin service. Widening the shop-side allowlist would route around it.
       *
       * The placeholders, the empty-line rule and the segment ceiling are all
       * documented in `utils/smsTemplates.util.js` — read that before changing
       * anything here. `maxlength` mirrors MAX_INVOICE_TEMPLATE_LENGTH; the
       * schema is the backstop, the util is the message the operator sees.
       */
      invoiceTemplate: {
        type: String,
        default: '',
        trim: true,
        maxlength: 480
      },
      /**
       * The same, for the চালান confirmation sent to a SUPPLIER.
       *
       * Its own field rather than reusing `invoiceTemplate` because the two
       * documents have different parties and different token sets: a body
       * naming `{customer_name}` on a purchase would text a vendor the word
       * কাস্টমার, and one naming `{supplier_name}` on a sale would do the
       * reverse. `PURCHASE_SMS_TOKENS` is what keeps them apart, and a shared
       * field would have no way to know which set to validate against.
       *
       * Admin-only by construction, exactly like its twin: the shop-side
       * settings allowlist must NOT learn `smsSettings`, or a shop could route
       * around the segment ceiling and multiply its own bill.
       */
      purchaseTemplate: {
        type: String,
        default: '',
        trim: true,
        maxlength: 480
      },
      /**
       * Which digits the figures in that template are printed with.
       *
       * `en` by default so a shop that never gets a custom template renders
       * byte-for-byte what it rendered before this field existed. A shop that
       * asks for a Bangla receipt almost always means `৳১,৮০,৩৫০` rather than
       * `৳1,80,350`, and it costs nothing — the body is UCS-2 either way.
       *
       * Separate from `language` above, which picks between two BUILT-IN
       * vocabularies and is a real per-segment cost decision. This one only
       * affects a custom template's numbers.
       */
      numerals: {
        type: String,
        enum: ['en', 'bn'],
        default: 'en'
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
    },
    // One typed or dictated sentence — "আজ দোকান ভাড়া ৫০০০, বিদ্যুৎ বিল ১২০০" —
    // becomes several DRAFT expense rows, each matched to one of the shop's own
    // categories, which a person then confirms.
    //
    // The AI never writes. `Expense` carries `immutableGuard`, so a wrong row
    // can only be voided and the void is permanent and visible; an unattended
    // model writing into that ledger is a defect with no undo. See
    // AI_EXPENSE_PLAN.md I-1.
    //
    // Bounded by a per-BRANCH daily message allowance (`ai.dailyMessageLimit`
    // above, default 5). Off = no AI box on the expenses page and the parse
    // route 404s; expenses already created this way are ordinary expenses and
    // are kept, so the switch is reversible.
    aiExpense: {
      type: Boolean,
      default: false
    },
    // Named places money sits — bank accounts, bKash numbers, the cash box —
    // each carrying its own balance, plus transfers between them. Off = the
    // shop sees exactly what it always has: a payment METHOD on each row and a
    // balance for the cash drawer alone. See FUND_ACCOUNT_PLAN.md.
    //
    // Most shops do not need this. A single counter taking cash and bKash has
    // one drawer and one number, and asking them to pick an account on every
    // sale is a tax on the majority for the benefit of the few — the same
    // reasoning that gates `packaging` and `wholesale`.
    fundAccounts: {
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
  },

  /**
   * AI: how many messages this shop's branches may each send per day.
   *
   * ── THE ALLOWANCE IS PER BRANCH, THE SETTING IS PER SHOP ───────────────────
   *
   * One number, negotiated once with the shop, applied to EACH of its branches
   * independently. The counter lives in `ShopAiUsage`, keyed `{shop, branch}`.
   * A three-branch shop on the default therefore gets five messages at each of
   * three counters, not five shared between them.
   *
   * A shared pool would mean the busy branch spends the quiet branches'
   * allowance before they open their shutters, and nothing on the quiet
   * branch's screen would explain why its AI stopped working. Single-branch
   * shops never notice the distinction — `req.branchId` is null for them and
   * there is exactly one counter.
   *
   * ── THREE DISTINCT STATES, AND THEY ARE NOT INTERCHANGEABLE ────────────────
   *   features.aiExpense false  the shop was never given the capability.
   *                             Parse → 404 (the route does not exist for them)
   *   dailyMessageLimit: 0      it has the feature, and an allowance of nothing.
   *                             Parse → 429 "আজকের বার্তা শেষ"
   *   dailyMessageLimit: null   it has the feature and follows the platform
   *                             default (PlatformSetting, seeded from
   *                             AI_DAILY_MESSAGE_LIMIT = 5).
   *
   * `null` is the default rather than a literal 5 for the reason
   * `storage.quotaMb` gives: a number written onto every shop means raising the
   * platform default later lifts nobody and needs a migration.
   *
   * Read this ONLY via `utils/aiQuota.util.resolveDailyLimit`.
   */
  ai: {
    dailyMessageLimit: { type: Number, default: null, min: 0, max: 200 },
    limitSetAt: { type: Date, default: null },
    limitSetBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null }
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
