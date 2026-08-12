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
  TelegramLink: require('./TelegramLink.model'),
  TelegramLinkToken: require('./TelegramLinkToken.model'),
  NotificationLog: require('./NotificationLog.model')
};


