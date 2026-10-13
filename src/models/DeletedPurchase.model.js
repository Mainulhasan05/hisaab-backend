const mongoose = require('mongoose');
const { immutableGuard } = require('../utils/immutableGuard.util');

/**
 * মুছে ফেলা ক্রয় — the permanent record of every purchase an owner deleted.
 *
 * The purchase-side twin of `DeletedSale`; read that header first, every
 * reason it gives holds here. `Purchase` carries `immutableGuard` and could
 * only ever be cancelled; a cancelled bill stays in the list forever.
 * `purchaseService.deletePurchase` now removes it, owner-only, and a complete
 * copy lands here. `AuditLog` is not enough: it expires after 90 days, and a
 * supplier turns up with the challan long after that.
 *
 * `snapshot` is the Purchase exactly as it stood immediately before removal —
 * AFTER the cancellation reversal when it was live, so it reads
 * `status: 'cancelled'`. `statusBeforeDelete` keeps what the owner saw.
 *
 * There is no `removedPayments`, unlike `DeletedSale`: a purchase's checkout
 * money lives on the bill itself (`payments[]`, inside the snapshot), and any
 * `Payment` row that names the bill refuses the delete instead of leaving
 * with it (`deleteBlockedReason`).
 *
 * `branch` is the PURCHASE's branch, so the list is branch-scoped like the
 * purchase list it came from (§9: listed in `enableMultiBranch`'s back-fill).
 */
const deletedPurchaseSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন'],
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null,
  },
  // The deleted Purchase's own _id. Not a live ref — the document no longer exists.
  purchase: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  invoiceNo: { type: String, required: true, trim: true },
  // 'completed' | 'partial' | 'unpaid' | 'cancelled' — as the owner saw it.
  statusBeforeDelete: { type: String, required: true },
  // True when this request had to reverse the bill first (stock out, supplier
  // খাতা unwound, money back to the accounts). False for an already-cancelled
  // one, whose reversal happened when it was cancelled.
  reversedOnDelete: { type: Boolean, required: true },
  reason: { type: String, required: true, trim: true, maxlength: 500 },

  // Flat copies for the list screen.
  purchaseDate: { type: Date, default: null },
  totalAmount: { type: Number, default: 0 },
  paid: { type: Number, default: 0 },
  due: { type: Number, default: 0 },
  itemCount: { type: Number, default: 0 },
  supplier: { type: mongoose.Schema.Types.ObjectId, default: null },
  supplierName: { type: String, default: null },
  supplierInvoiceNo: { type: String, default: null },
  purchasedBy: { type: mongoose.Schema.Types.ObjectId, default: null },

  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  deletedByName: { type: String, default: null },
  deletedAt: { type: Date, default: Date.now },

  snapshot: { type: mongoose.Schema.Types.Mixed, required: true },

  metadata: {
    ip: String,
    userAgent: String,
    browser: String,
    os: String,
    device: String,
  },
}, {
  timestamps: true,
});

deletedPurchaseSchema.index({ shop: 1, branch: 1, deletedAt: -1 });
// One archive row per deleted purchase — a retried request cannot write two.
deletedPurchaseSchema.index({ shop: 1, purchase: 1 }, { unique: true });
// "Was PUR2026100007 deleted?" — the detail page and the number seeding ask this.
deletedPurchaseSchema.index({ shop: 1, invoiceNo: 1 });

// The record of a deletion must not itself be deletable.
deletedPurchaseSchema.plugin(immutableGuard, { modelName: 'DeletedPurchase' });

module.exports = mongoose.model('DeletedPurchase', deletedPurchaseSchema);
