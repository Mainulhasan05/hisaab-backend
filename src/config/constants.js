/**
 * Application Constants
 * Central place for all constant values used across the application
 */

module.exports = {
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
    BANK: 'bank'
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
    REFUND: 'refund'
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
    DAMAGE: 'damage',
    TRANSFER_OUT: 'transfer_out',
    TRANSFER_IN: 'transfer_in',
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
    TELEGRAM_UNLINK: { en: 'telegram_unlink', bn: 'টেলিগ্রাম সংযোগ বন্ধ' }
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
  }
};
