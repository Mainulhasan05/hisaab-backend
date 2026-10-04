const mongoose = require('mongoose');
const { immutableGuard } = require('../utils/immutableGuard.util');

/**
 * মুছে ফেলা ইনভয়েস — the permanent record of every invoice an owner deleted.
 *
 * ── Why this collection exists at all ───────────────────────────────────────
 *
 * `Sale` carries `immutableGuard` and has never been deletable from the app:
 * a mistaken invoice could only be cancelled, and a cancelled invoice stays in
 * the list forever. Shops asked for the mistakes to be GONE. `saleService.
 * deleteSale` now allows that, owner-only, and this is the price of it: the
 * document leaves `sales`, and a complete copy lands here.
 *
 * `AuditLog` is not enough on its own. It carries a 90-day TTL, so "who
 * deleted INV-0042 and what was on it" would stop being answerable three
 * months later — which is precisely when a customer turns up holding the
 * paper. This collection has no TTL and is itself guarded against deletion.
 *
 * ── What is stored ──────────────────────────────────────────────────────────
 *
 * `snapshot` is the Sale document exactly as it stood immediately before the
 * delete — AFTER the cancellation reversal, when the sale was live, so it reads
 * `status: 'cancelled'` with `cancelledAt` set by this same request.
 * `statusBeforeDelete` keeps what the owner was looking at when they pressed
 * the button. The flat fields beside it exist so the list screen never has to
 * open a Mixed blob to render a row.
 *
 * `branch` is the SALE's branch, so the list is branch-scoped like the sales
 * list it was removed from (§9: listed in `enableMultiBranch`'s back-fill).
 */
const deletedSaleSchema = new mongoose.Schema({
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
  // The deleted Sale's own _id. Not a live ref — the document no longer exists.
  sale: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  invoiceNo: { type: String, required: true, trim: true },
  // 'completed' | 'partial' | 'due' | 'cancelled' — as the owner saw it.
  statusBeforeDelete: { type: String, required: true },
  // True when this request had to reverse the sale first (stock back, customer
  // ledger unwound, fund accounts debited). False for an already-cancelled one,
  // whose reversal happened when it was cancelled.
  reversedOnDelete: { type: Boolean, required: true },
  reason: { type: String, required: true, trim: true, maxlength: 500 },

  // Flat copies for the list screen.
  saleDate: { type: Date, default: null },
  total: { type: Number, default: 0 },
  paid: { type: Number, default: 0 },
  due: { type: Number, default: 0 },
  itemCount: { type: Number, default: 0 },
  customer: { type: mongoose.Schema.Types.ObjectId, default: null },
  customerName: { type: String, default: null },
  customerPhone: { type: String, default: null },
  soldBy: { type: mongoose.Schema.Types.ObjectId, default: null },

  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  deletedByName: { type: String, default: null },
  deletedAt: { type: Date, default: Date.now },

  // The full documents removed by this delete.
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  removedPayments: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // Whether a খাতা collection taken at this checkout was voided with it
  // (`cancelSale`'s tri-state); null when there was none to decide about.
  settlementVoided: { type: Boolean, default: null },

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

deletedSaleSchema.index({ shop: 1, branch: 1, deletedAt: -1 });
// One archive row per deleted sale — a retried request cannot write two.
deletedSaleSchema.index({ shop: 1, sale: 1 }, { unique: true });
// "Was INV-0042 deleted?" — the sale page and a search both ask this.
deletedSaleSchema.index({ shop: 1, invoiceNo: 1 });

// The record of a deletion must not itself be deletable.
deletedSaleSchema.plugin(immutableGuard, { modelName: 'DeletedSale' });

module.exports = mongoose.model('DeletedSale', deletedSaleSchema);
