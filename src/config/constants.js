/**
 * Application Constants
 * Central place for all constant values used across the application
 */

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SESSION LIFETIMES — how long a signed-in browser stays signed in
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── WHY THESE ARE HERE AND NOT FOUR SEPARATE process.env READS ──────────────
 *
 * A session has TWO clocks and they must agree:
 *
 *   1. the JWT's own `expiresIn`  — the server stops trusting the token
 *   2. the cookie's `maxAge`      — the browser stops sending it
 *
 * Whichever is SHORTER is the real session length, and nothing anywhere reports
 * the mismatch. Before this, the two were set in six different places from three
 * different sources: `JWT_EXPIRES_IN`, `JWT_ACCESS_EXPIRES_IN`, a hardcoded
 * `'30d'` fallback in each of `Admin.generateToken`, `User.generateAccessToken`,
 * `User.generateRefreshToken` and `admin.service.login`, plus a hardcoded
 * `maxAgeDays = 30` in `cookie.util` and a hardcoded `7 * 24 * 60 * 60 * 1000`
 * on the refresh cookie. Any one of them edited alone silently shortens or
 * lengthens the session, and the symptom — "it logs me out" — points at none of
 * them.
 *
 * So: one number per audience, and both clocks are derived from it.
 *
 * ── THE TWO AUDIENCES ARE DIFFERENT ON PURPOSE ──────────────────────────────
 *
 * ADMIN is the platform console — it can suspend shops, impersonate users and
 * read every tenant's data. A shorter session bounds the damage from a laptop
 * left open at a desk. 7 days is the floor the operator asked for ("at least 1
 * day") with a wide margin, so nobody is signing in daily.
 *
 * USER is a shopkeeper or their staff, on a phone, at a counter, all day. Being
 * signed out mid-sale is not a security win — it is a queue. A week.
 *
 * Both are env-overridable so tightening admin to a true 24 hours is a config
 * change and not a deploy: set `ADMIN_SESSION_DAYS=1`.
 */
const readDays = (raw, fallback) => {
  const n = parseInt(raw, 10);
  // A malformed or non-positive value must never mean "expire immediately".
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const ADMIN_SESSION_DAYS = readDays(process.env.ADMIN_SESSION_DAYS, 7);
const USER_SESSION_DAYS = readDays(process.env.USER_SESSION_DAYS, 7);

module.exports = {
  ADMIN_SESSION_DAYS,
  USER_SESSION_DAYS,
  /** `expiresIn` strings for jwt.sign, derived so they cannot drift from the cookies. */
  ADMIN_JWT_EXPIRES_IN: `${ADMIN_SESSION_DAYS}d`,
  USER_JWT_EXPIRES_IN: `${USER_SESSION_DAYS}d`,

  // Admin Roles
  ADMIN_ROLES: {
    SUPER_ADMIN: 'super_admin',
    ADMIN: 'admin',
    SUPPORT: 'support'
  },

  // Shop Types — keys must match ShopCategory.key (see seeds/shopCategorySeeder.js).
  // Admins can add more at runtime, so this list is a reference, not a whitelist.
  SHOP_TYPES: {
    CLOTH: 'cloth',
    GROCERY: 'grocery',
    ELECTRONICS: 'electronics',
    PHARMACY: 'pharmacy',
    HARDWARE: 'hardware',
    COSMETICS: 'cosmetics',
    BOOKSHOP: 'bookshop',
    COMPUTER: 'computer',
    DEALERSHIP: 'dealership',
    ECOMMERCE: 'ecommerce',
    FURNITURE: 'furniture',
    MANUFACTURING: 'manufacturing',
    MEDICAL_SURGICAL: 'medical-surgical',
    MOBILE: 'mobile',
    GENERAL_TRADING: 'general-trading',
    SHOE: 'shoe',
    SUPERSHOP: 'supershop',
    STATIONERY: 'stationery',
    OTHER: 'other'
  },

  // Subscription Plans — Single flat plan, all features included
  SUBSCRIPTION_PLANS: {
    TRIAL: 'trial',
    PAID: 'paid'
  },

  // Trial Period in Days
  TRIAL_PERIOD_DAYS: 14,

  // Subscription Status
  SUBSCRIPTION_STATUS: {
    ACTIVE: 'active',
    EXPIRED: 'expired',
    SUSPENDED: 'suspended'
  },

  // Payment Methods
  PAYMENT_METHODS: {
    CASH: 'cash',
    BKASH: 'bkash',
    NAGAD: 'nagad',
    CARD: 'card',
    BANK: 'bank',
    /**
     * Money a COURIER is holding for us on a COD parcel.
     *
     * Not a way the customer paid — it is where the money sits between the
     * parcel going out and the courier settling up. See COD_PLAN.md.
     *
     * It has to be its own method for two reasons, and the second is the
     * load-bearing one:
     *
     *   · `PaymentAccount.method` is required and drawn from this enum, so a
     *     courier account needs a value here to exist at all;
     *   · every cash-register query filters `method: 'cash'`. A courier leg
     *     must never reach the drawer — the money is not in the box, it is in
     *     a van. Reusing 'cash' would report the till over by the day's
     *     dispatches.
     */
    COURIER: 'courier'
  },

  // Sale Status
  SALE_STATUS: {
    COMPLETED: 'completed',
    PARTIAL: 'partial',
    UNPAID: 'unpaid',
    CANCELLED: 'cancelled'
  },

  // Payment Types — money a shop's CUSTOMERS pay the shop (models/Payment).
  // Money a SHOP pays HisaabBD is a different collection with its own types
  // below; do not add 'subscription' here (see PlatformPayment.model.js).
  PAYMENT_TYPES: {
    SALE_PAYMENT: 'sale_payment',
    PURCHASE_PAYMENT: 'purchase_payment',
    DUE_COLLECTION: 'due_collection',
    /**
     * Money taken from a customer with no debt for it to settle — a deposit
     * against future purchases (অগ্রিম জমা).
     *
     * ── Why not just another `due_collection` ────────────────────────────────
     *
     * Reusing that type would have been cheaper: the reallocation pool, the
     * cash register and three reports already match on it, so an advance would
     * have worked with no changes at all. It is still wrong, and the reason is
     * economic rather than technical.
     *
     * A `due_collection` REDUCES A RECEIVABLE — money the shop had already
     * earned, finally arriving. An advance CREATES A LIABILITY — money the shop
     * has not earned and is merely holding. Folded together, "মোট বাকি আদায়
     * ৳12,700" would report a day's debt collection that silently included
     * ৳700 of deposit, and a shopkeeper judging whether their customers are
     * paying up would be reading a number that answers a different question.
     *
     * Where the two genuinely belong in one bucket — the reallocation pool, and
     * the cash drawer, both of which care only that money arrived — the match
     * is an explicit `$in` naming both, so the joining is visible at the point
     * it happens rather than hidden in a shared label.
     *
     * A payment that straddles the boundary (owes ৳2,000, pays ৳3,000) is
     * written as TWO rows, not one mixed row. See dueSettlement.service.
     */
    ADVANCE: 'advance',
    REFUND: 'refund',
    /**
     * Money coming back IN from a SUPPLIER, against a কেনা ফেরত.
     *
     * ── Why not reuse `REFUND` ───────────────────────────────────────────────
     *
     * `refund` is money going OUT — the shop handing a customer their money
     * back. Every reader of it treats it that way: the cash register books it
     * under `cashOut.refunds`, and the customer statement prints it as a DEBIT
     * that raises what the customer owes. A supplier refund is the exact
     * opposite in both places — cash INTO the drawer, and nothing to do with
     * any customer at all. Reusing the type would have made the till read short
     * by every returned taka and put supplier money on customer ledgers.
     *
     * So it is its own type, and every aggregation keyed on `type` had to be
     * checked (PURCHASE_RETURN_PLAN.md §7):
     *
     *   cash register    → nets against `cashOut.purchases`; the money came
     *                      back down the same pipe it went out
     *   customer flows   → absent, correctly: these rows carry no `customer`
     *   supplier statement → absent, deliberately. A refund is a DRAWER
     *                      movement; the debt never changed (only an
     *                      `adjustment` return moves the খাতা, and that is
     *                      recorded on the return document, not here).
     */
    PURCHASE_REFUND: 'purchase_refund'
  },

  // Platform billing — money a shop pays HisaabBD (models/PlatformPayment)
  PLATFORM_PAYMENT_TYPES: {
    SUBSCRIPTION: 'subscription',
    SMS: 'sms',
    SETUP: 'setup',
    OTHER: 'other',
    ADJUSTMENT: 'adjustment'
  },

  PLATFORM_PAYMENT_METHODS: {
    CASH: 'cash',
    BKASH: 'bkash',
    NAGAD: 'nagad',
    ROCKET: 'rocket',
    BANK: 'bank',
    CARD: 'card',
    ONLINE: 'online'
  },

  // Warn a shop this many calendar days before its subscription expires.
  // The enforcement threshold lives in utils/subscriptionState.util.js; this is
  // the platform default the admin panel shows and the worklist filters on.
  SUBSCRIPTION_WARNING_DAYS: 3,

  // Stock Transaction Types
  STOCK_TRANSACTION_TYPES: {
    PURCHASE: 'purchase',
    SALE: 'sale',
    ADJUSTMENT: 'adjustment',
    RETURN: 'return',
    // Goods going BACK to the supplier (কেনা ফেরত). Deliberately not `RETURN`,
    // which is the CUSTOMER giving goods back and therefore stock coming IN.
    // The two point in opposite directions, and a stock-history screen that
    // labelled them the same word would be telling a shopkeeper the shelf grew
    // when it shrank.
    PURCHASE_RETURN: 'purchase_return',
    DAMAGE: 'damage',
    TRANSFER_OUT: 'transfer_out',
    TRANSFER_IN: 'transfer_in',
  },

  /**
   * Why stock was written off (ক্ষতি). Required on every `damage` row.
   *
   * ── Why a reason is mandatory ────────────────────────────────────────────
   *
   * A write-off is the one movement that destroys value with no counter-party:
   * no customer, no supplier, no invoice, nothing to reconcile it against
   * later. The same argument `AccountEntry` makes about `adjustment` applies
   * exactly — an unexplained figure is one nobody can account for six months
   * on, and without a reason the write-off becomes the tidy way a stock
   * discrepancy (or a theft) disappears.
   *
   * ── Why these four and not a free-text box ───────────────────────────────
   *
   * Because the whole point is the report. "৳12,000 lost this quarter" is a
   * number an owner can do nothing with; "৳9,000 of it expired" tells them to
   * order smaller and more often, and "৳9,000 of it walked" is a different
   * conversation entirely. A free-text box collects neither. `notes` is still
   * there for the detail.
   */
  WRITE_OFF_REASONS: {
    /** Broken, spoiled, crushed in transit — physically unsellable. */
    DAMAGED: 'damaged',
    /** Past its date. The one the batch/expiry screen leads to. */
    EXPIRED: 'expired',
    /** Missing and not explainable — theft, or a count that never reconciled. */
    LOST: 'lost',
    /**
     * Given away or consumed by the shop: samples, staff use, the packet the
     * owner took home. Real stock leaving for a real reason that is not a sale.
     */
    USED: 'used',
  },

  // SMS Types
  SMS_TYPES: {
    SINGLE: 'single',
    BULK: 'bulk',
    DYNAMIC: 'dynamic',
    OTP: 'otp'
  },

  // SMS Status
  SMS_STATUS: {
    PENDING: 'pending',
    SENT: 'sent',
    DELIVERED: 'delivered',
    PARTIAL: 'partial',
    FAILED: 'failed'
  },

  // Audit Actions (English and Bengali)
  AUDIT_ACTIONS: {
    // Auth
    USER_REGISTER: { en: 'user_register', bn: 'নিবন্ধন' },
    USER_LOGIN: { en: 'user_login', bn: 'লগইন' },
    USER_LOGOUT: { en: 'user_logout', bn: 'লগআউট' },
    AUTH_FAILED: { en: 'auth_failed', bn: 'লগইন ব্যর্থ' },
    PASSWORD_CHANGE: { en: 'password_change', bn: 'পাসওয়ার্ড পরিবর্তন' },
    PASSWORD_RESET: { en: 'password_reset', bn: 'পাসওয়ার্ড রিসেট' },
    PROFILE_UPDATE: { en: 'profile_update', bn: 'প্রোফাইল আপডেট' },

    // Products
    PRODUCT_CREATE: { en: 'product_create', bn: 'নতুন পণ্য যোগ' },
    PRODUCT_UPDATE: { en: 'product_update', bn: 'পণ্য সম্পাদনা' },
    PRODUCT_DELETE: { en: 'product_delete', bn: 'পণ্য মুছে ফেলা' },
    STOCK_UPDATE: { en: 'stock_update', bn: 'স্টক আপডেট' },

    // Sales
    SALE_CREATE: { en: 'sale_create', bn: 'নতুন বিক্রয়' },
    SALE_UPDATE: { en: 'sale_update', bn: 'বিক্রয় সম্পাদনা' },
    SALE_CANCEL: { en: 'sale_cancel', bn: 'বিক্রয় বাতিল' },
    PAYMENT_RECEIVED: { en: 'payment_received', bn: 'পেমেন্ট গ্রহণ' },

    // Customers
    CUSTOMER_CREATE: { en: 'customer_create', bn: 'নতুন কাস্টমার যোগ' },
    CUSTOMER_UPDATE: { en: 'customer_update', bn: 'কাস্টমার তথ্য সম্পাদনা' },
    CUSTOMER_DELETE: { en: 'customer_delete', bn: 'কাস্টমার মুছে ফেলা' },
    CUSTOMER_RESTORE: { en: 'customer_restore', bn: 'কাস্টমার ফিরিয়ে আনা' },
    DUE_COLLECTION: { en: 'due_collection', bn: 'বাকি আদায়' },

    // Team
    TEAM_MEMBER_ADD: { en: 'team_member_add', bn: 'টিম মেম্বার যোগ' },
    TEAM_MEMBER_UPDATE: { en: 'team_member_update', bn: 'টিম মেম্বার সম্পাদনা' },
    TEAM_MEMBER_REMOVE: { en: 'team_member_remove', bn: 'টিম মেম্বার সরানো' },

    // SMS
    SMS_SENT: { en: 'sms_sent', bn: 'এসএমএস পাঠানো' },

    // Expenses
    EXPENSE_CREATE: { en: 'expense_create', bn: 'নতুন খরচ যোগ' },
    EXPENSE_UPDATE: { en: 'expense_update', bn: 'খরচ আপডেট' },
    EXPENSE_DELETE: { en: 'expense_delete', bn: 'খরচ মুছে ফেলা' },

    // Suppliers
    SUPPLIER_CREATE: { en: 'supplier_create', bn: 'নতুন সরবরাহকারী যোগ' },
    SUPPLIER_UPDATE: { en: 'supplier_update', bn: 'সরবরাহকারী আপডেট' },
    SUPPLIER_DELETE: { en: 'supplier_delete', bn: 'সরবরাহকারী মুছে ফেলা' },

    // Purchases
    PURCHASE_CREATE: { en: 'purchase_create', bn: 'নতুন ক্রয়' },
    PURCHASE_CANCEL: { en: 'purchase_cancel', bn: 'ক্রয় বাতিল' },

    // Sales Returns
    SALES_RETURN_CREATE: { en: 'sales_return_create', bn: 'মাল ফেরত' },

    // Purchase Returns (RTV) — goods going back to the supplier. The Bengali
    // label is deliberately NOT 'মাল ফেরত': that is the customer-side wording
    // and the audit log is read by people who need to know which direction the
    // goods went.
    PURCHASE_RETURN_CREATE: { en: 'purchase_return_create', bn: 'কেনা ফেরত' },
    PURCHASE_RETURN_SETTLE: { en: 'purchase_return_settle', bn: 'কেনা ফেরতের টাকা গ্রহণ' },

    // Cash Register
    CASH_REGISTER_OPEN: { en: 'cash_register_open', bn: 'ক্যাশ রেজিস্টার খোলা' },
    CASH_REGISTER_UPDATE: { en: 'cash_register_update', bn: 'ক্যাশ রেজিস্টার আপডেট' },
    CASH_REGISTER_CLOSE: { en: 'cash_register_close', bn: 'ক্যাশ রেজিস্টার বন্ধ' },
    CASH_REGISTER_REOPEN: { en: 'cash_register_reopen', bn: 'ক্যাশ রেজিস্টার পুনরায় খোলা' },

    // Branch Management
    BRANCH_CREATE: { en: 'branch_create', bn: 'নতুন শাখা যোগ' },
    BRANCH_UPDATE: { en: 'branch_update', bn: 'শাখা আপডেট' },
    BRANCH_DEACTIVATE: { en: 'branch_deactivate', bn: 'শাখা নিষ্ক্রিয়' },
    MULTI_BRANCH_ENABLED: { en: 'multi_branch_enabled', bn: 'মাল্টি-ব্রাঞ্চ সক্রিয়' },
    MULTI_BRANCH_DISABLED: { en: 'multi_branch_disabled', bn: 'মাল্টি-ব্রাঞ্চ নিষ্ক্রিয়' },

    // Shop Settings
    SHOP_UPDATE: { en: 'shop_update', bn: 'দোকান তথ্য সম্পাদনা' },
    SETTINGS_UPDATE: { en: 'settings_update', bn: 'সেটিংস আপডেট' },

    // Telegram notifications
    TELEGRAM_LINK: { en: 'telegram_link', bn: 'টেলিগ্রাম সংযুক্ত' },
    TELEGRAM_UNLINK: { en: 'telegram_unlink', bn: 'টেলিগ্রাম সংযোগ বন্ধ' },

    // Platform operator channel + admin credential changes.
    //
    // Registered here rather than passed as `actionBn` at each call site for
    // the reason AuditLog.model.js gives: a hand-passed label is how one action
    // ends up with two different Bengali names depending on which service
    // happened to write the row. These are the rows an operator reads when
    // answering "who changed the platform password", so they must be findable
    // under one name.
    ADMIN_TELEGRAM_LINK: { en: 'admin_telegram_link', bn: 'প্ল্যাটফর্ম অ্যালার্ট সংযুক্ত' },
    ADMIN_TELEGRAM_UNLINK: { en: 'admin_telegram_unlink', bn: 'প্ল্যাটফর্ম অ্যালার্ট বন্ধ' },
    ADMIN_ALERT_PREFS_UPDATE: { en: 'admin_alert_prefs_update', bn: 'অ্যালার্ট সেটিংস আপডেট' },
    ADMIN_PASSWORD_OTP_SENT: { en: 'admin_password_otp_sent', bn: 'অ্যাডমিন পাসওয়ার্ড কোড পাঠানো' },
    ADMIN_PASSWORD_CHANGED: { en: 'admin_password_changed', bn: 'অ্যাডমিন পাসওয়ার্ড পরিবর্তন' },

    // Image storage (R2 pool). Registered here so the audit screen shows a
    // Bengali label instead of the raw key — see AuditLog.statics.log.
    STORAGE_ENABLED: { en: 'storage_enabled', bn: 'ছবি সংরক্ষণ চালু' },
    STORAGE_DISABLED: { en: 'storage_disabled', bn: 'ছবি সংরক্ষণ বন্ধ' },
    STORAGE_QUOTA_CHANGED: { en: 'storage_quota_changed', bn: 'স্টোরেজ কোটা পরিবর্তন' },
    STORAGE_ACCOUNT_CREATE: { en: 'storage_account_create', bn: 'স্টোরেজ অ্যাকাউন্ট যোগ' },
    // Covers edits, draining and deactivation. There is no delete action —
    // storage accounts are retired, never erased. See adminStorage.service.
    STORAGE_ACCOUNT_UPDATE: { en: 'storage_account_update', bn: 'স্টোরেজ অ্যাকাউন্ট আপডেট' },

    // Online storefront. Registered here rather than passed as `actionBn` at
    // each call site, for the reason AuditLog.model.js gives: a hand-passed
    // label is how one action ends up with two different Bengali names
    // depending on which service happened to write the row.
    STOREFRONT_TEMPLATE_CREATED: { en: 'storefront_template_created', bn: 'টেমপ্লেট তৈরি' },
    STOREFRONT_TEMPLATE_PUBLISHED: { en: 'storefront_template_published', bn: 'টেমপ্লেট প্রকাশ' },
    STOREFRONT_TEMPLATE_RETIRED: { en: 'storefront_template_retired', bn: 'টেমপ্লেট প্রত্যাহার' },
    STOREFRONT_TEMPLATES_GRANTED: { en: 'storefront_templates_granted', bn: 'টেমপ্লেট বরাদ্দ' },
    STOREFRONT_TEMPLATE_APPLIED: { en: 'storefront_template_applied', bn: 'টেমপ্লেট প্রয়োগ' },
    STOREFRONT_PUBLISHED: { en: 'storefront_published', bn: 'ওয়েবসাইট প্রকাশ' },
    STOREFRONT_ROLLBACK: { en: 'storefront_rollback', bn: 'ওয়েবসাইট পুনরুদ্ধার' },
    STOREFRONT_PAUSED_BY_ADMIN: { en: 'storefront_paused_by_admin', bn: 'অনলাইন দোকান বন্ধ' },
    STOREFRONT_RESUMED_BY_ADMIN: { en: 'storefront_resumed_by_admin', bn: 'অনলাইন দোকান চালু' },
    ONLINE_CATALOG_BULK_UPDATE: { en: 'online_catalog_bulk_update', bn: 'অনলাইন পণ্য একসাথে হালনাগাদ' }
  },

  // Sales Return Refund Methods
  REFUND_METHODS: {
    CASH: 'cash',
    ADJUSTMENT: 'adjustment',
    STORE_CREDIT: 'store_credit'
  },

  // Pagination Defaults
  PAGINATION: {
    DEFAULT_PAGE: 1,
    DEFAULT_LIMIT: 20,
    MAX_LIMIT: 100
  },

  // Subscription Price (BDT/month) — the LIST price, and it must equal what the
  // marketing site says. It was 1000 while the landing page, the signup screen
  // and the public help centre all advertised ৳800, so every shop that did not
  // bargain saw one number before signing up and another on their billing card.
  // This seeds `PlatformSetting.defaultMonthlyPrice` and every new shop's
  // `billing.monthlyPrice`; per-shop negotiation still overrides it.
  SUBSCRIPTION_PRICE: 800,

  // JWT Token Expiry
  JWT_EXPIRES_IN: '30d',

  // OTP Settings
  OTP: {
    LENGTH: 6,
    EXPIRES_IN_MINUTES: 5
  },

  // Default Settings
  DEFAULT_SETTINGS: {
    CURRENCY: 'BDT',
    LOW_STOCK_THRESHOLD: 5
  },

  /**
   * How many AI messages one BRANCH may send per Bangladesh day, by default.
   *
   * Deliberately small: every message is a real Gemini call against a shared
   * free-tier pool, and five is comfortably more than a shop that logs its
   * expenses once at closing time needs.
   *
   * ── THIS IS THE ONLY PLACE THE NUMBER 5 IS WRITTEN ────────────────────────
   *
   * `PlatformSetting.defaultAiDailyMessageLimit` defaults to it, and
   * `aiQuota.util.resolveDailyLimit` falls back to it if that document cannot
   * be read. `Shop.ai.dailyMessageLimit` is `null` by default and NOT 5 — a
   * literal on every shop means raising the platform default later lifts
   * nobody. Same reasoning `Shop.storage.quotaMb` already committed to.
   *
   * Per-shop overrides are set by the platform admin and always win.
   */
  AI_DAILY_MESSAGE_LIMIT: 5,

  /**
   * Model preference order, best first.
   *
   * ── WHY A LIST AND NOT ONE NAME ────────────────────────────────────────────
   *
   * This used to be the single string 'gemini-1.5-flash', and Google retired it.
   * The whole feature returned "models/gemini-1.5-flash is not found for API
   * version v1beta" — from a constant that was correct on the day it was
   * written and silently wrong afterwards, with no signal until a shopkeeper hit
   * it. Google retires models on their own schedule and this backend deploys
   * manually, so ANY single hardcoded name is a scheduled outage.
   *
   * `gemini.service.resolveModel` asks the key which models it can actually
   * reach (`ListModels`, the same call that already validates a key on
   * creation), then takes the first entry here that appears in that list. An
   * unknown future model is picked up by the fallback rule below without a code
   * change; a retired one simply stops being offered and the next preference
   * wins.
   *
   * Flash tiers first, deliberately: expense extraction is a short structured
   * task, the free tier is generous on flash and stingy on pro, and pro's extra
   * reasoning buys nothing when the output is a fixed JSON schema.
   */
  GEMINI_MODEL_PREFERENCES: [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-flash-latest',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
  ],

  /**
   * Used only when ListModels cannot be reached at all (network down mid-call).
   * Not authoritative — `resolveModel` prefers what the key actually reports.
   */
  GEMINI_DEFAULT_MODEL: 'gemini-2.0-flash',

  /**
   * Substring that marks any model usable for text generation. Google's
   * ListModels reports `supportedGenerationMethods` per model; embedding and
   * image models do not carry this one and must never be picked.
   */
  GEMINI_GENERATE_METHOD: 'generateContent',

  /** Hard ceiling on rows one AI message may produce. See aiExpense.service. */
  AI_MAX_EXPENSE_LINES: 20
};
