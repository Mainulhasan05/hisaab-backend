/**
 * Immutable Ledger Guard — Mongoose Plugin
 * 
 * Prevents hard deletion of financial records (Sales, Payments, Expenses).
 * These documents must only be voided/cancelled, never deleted.
 * 
 * Usage:
 *   const { immutableGuard } = require('../utils/immutableGuard.util');
 *   saleSchema.plugin(immutableGuard, { modelName: 'Sale' });
 */

const { AppError } = require('../middleware/error.middleware');

function immutableGuard(schema, options = {}) {
  const modelName = options.modelName || 'Document';

  const blockDelete = function (next) {
    const error = new AppError(
      `${modelName} records cannot be deleted. Use void/cancel instead.`,
      `${modelName} রেকর্ড মুছে ফেলা যায় না। বাতিল করুন।`,
      403
    );
    next(error);
  };

  // Block document-level delete
  schema.pre('deleteOne', { document: true, query: false }, blockDelete);

  // Block query-level deletes
  schema.pre('deleteOne', { document: false, query: true }, blockDelete);
  schema.pre('deleteMany', blockDelete);
  schema.pre('findOneAndDelete', blockDelete);
}

module.exports = { immutableGuard };
