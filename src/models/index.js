// Export all models for easy importing
module.exports = {
  Admin: require('./Admin.model'),
  Shop: require('./Shop.model'),
  Branch: require('./Branch.model'),
  User: require('./User.model'),
  Role: require('./Role.model'),
  Customer: require('./Customer.model'),
  CustomerBalance: require('./CustomerBalance.model'),
  DueAdjustment: require('./DueAdjustment.model'),
  Supplier: require('./Supplier.model'),
  SupplierBalance: require('./SupplierBalance.model'),
  Category: require('./Category.model'),
  Product: require('./Product.model'),
  Sale: require('./Sale.model'),
  Payment: require('./Payment.model'),
  // Platform billing — what shops pay HisaabBD. Separate from `Payment`, which
  // is what a shop's customers pay the shop.
  PlatformPayment: require('./PlatformPayment.model'),
  SubscriptionEvent: require('./SubscriptionEvent.model'),
  PlatformSetting: require('./PlatformSetting.model'),
  StockTransaction: require('./StockTransaction.model'),
  AuditLog: require('./AuditLog.model'),
  SMSLog: require('./SMSLog.model'),
  SMSQuota: require('./SMSQuota.model'),
  ShopCategory: require('./ShopCategory.model'),
  GeminiKey: require('./GeminiKey.model'),
  // The R2 storage pool. One document per Cloudflare bucket; see
  // services/storage.service.js for how one is chosen per upload.
  R2Account: require('./R2Account.model'),
  // One uploaded image. Carries the dedupe hash, the refCount that makes
  // reclamation possible, and the account+key that make URLs rebuildable.
  ShopMedia: require('./ShopMedia.model'),
  // The online storefront. `StorefrontTemplate` is the platform-owned catalogue
  // of designs; `Storefront` is one shop's site, granted a subset of them.
  // Neither is read by any pre-existing query — see ECOMMERCE_PLAN.md I-8.
  StorefrontTemplate: require('./StorefrontTemplate.model'),
  Storefront: require('./Storefront.model'),
  TelegramLink: require('./TelegramLink.model'),
  TelegramLinkToken: require('./TelegramLinkToken.model'),
  NotificationLog: require('./NotificationLog.model')
};


