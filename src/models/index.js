// Export all models for easy importing
module.exports = {
  Admin: require('./Admin.model'),
  Shop: require('./Shop.model'),
  Branch: require('./Branch.model'),
  BranchStock: require('./BranchStock.model'),
  User: require('./User.model'),
  Role: require('./Role.model'),
  Customer: require('./Customer.model'),
  Category: require('./Category.model'),
  Product: require('./Product.model'),
  Sale: require('./Sale.model'),
  Payment: require('./Payment.model'),
  StockTransaction: require('./StockTransaction.model'),
  AuditLog: require('./AuditLog.model'),
  SMSLog: require('./SMSLog.model'),
  SMSQuota: require('./SMSQuota.model'),
  ShopCategory: require('./ShopCategory.model')
};

