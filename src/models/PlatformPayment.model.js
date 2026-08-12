/**
 * PlatformPayment — money the SHOP pays HisaabBD.
 *
 * Deliberately a separate collection from `Payment`, which is money a shop's
 * CUSTOMERS pay the shop. The two were briefly the same collection, and that
 * was wrong twice over:
 *
 *   1. `Payment.type` has no 'subscription' member, so every write threw a
 *      validation error — the admin panel's "record payment" never worked and
 *      platform revenue read ৳0 forever.
 *   2. Even fixed, `Payment.getPaymentsSummary()` and the daily-collection
 *      queries filter by shop + date with no type predicate, so a ৳1000
 *      subscription payment would have surfaced inside the shop's own cash
 *      report. My income is not their income.
 *
 * Append-only, like the shop's ledger: corrections are reversal rows
 * (`reversalOf`), never edits. `receivedAt` is when the money actually arrived,
 * which is routinely not when it was keyed in.
 */

const mongoose = require('mongoose');
const { immutableGuard } = require('../utils/immutableGuard.util');
const { PLATFORM_PAYMENT_TYPES, PLATFORM_PAYMENT_METHODS } = require('../config/constants');

const platformPaymentSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন'],
  },
  type: {
    type: String,
    enum: Object.values(PLATFORM_PAYMENT_TYPES),
    required: true,
  },
  amount: {
    type: Number,
    required: [true, 'পরিমাণ দিন'],
    // 0 is legal: a waived/complimentary period is recorded as a ৳0 row so the
    // free months are visible in history instead of being invisible.
    min: [0, 'পরিমাণ ঋণাত্মক হতে পারবে না'],
  },
  currency: {
    type: String,
    default: 'BDT',
  },
  method: {
    type: String,
    enum: Object.values(PLATFORM_PAYMENT_METHODS),
    default: PLATFORM_PAYMENT_METHODS.CASH,
  },
  // bKash/Nagad TrxID. Also the idempotency key for gateway callbacks — see the
  // sparse unique index below.
  transactionId: {
    type: String,
    trim: true,
  },
  reference: {
    type: String,
    trim: true,
  },
  // When the money arrived, not when it was keyed in. A payment taken on the
  // 1st and entered on the 5th belongs to the 1st in every report.
  receivedAt: {
    type: Date,
    default: Date.now,
    required: true,
  },

  // ── What this payment bought ────────────────────────────────────────────
  // An amount with no reason is unanswerable a year later, so every row says
  // what it was for: a period (subscription) or a quantity × rate (SMS).
  periodStart: { type: Date },
  periodEnd: { type: Date },
  months: { type: Number, min: 0 },
  smsQuantity: { type: Number, min: 0 },
  // The rate ACTUALLY charged on this purchase, not the shop's standing rate.
  // Frozen here so history stays truthful after a renegotiation.
  smsUnitPrice: { type: Number, min: 0 },

  status: {
    type: String,
    enum: ['paid', 'pending', 'refunded', 'waived'],
    default: 'paid',
  },
  // 'manual' = keyed in by an admin; 'gateway' = a verified provider callback.
  // Both arrive through the same service method (billing.service
  // applySubscriptionPayment), which is what keeps phase 2 to one adapter.
  source: {
    type: String,
    enum: ['manual', 'gateway'],
    default: 'manual',
  },
  recordedBy: {
    kind: {
      type: String,
      enum: ['admin', 'system'],
      default: 'admin',
    },
    // Not a `ref` with populate: this points at an Admin, and the shop-side
    // ledger's `receivedBy: ref 'User'` mismatch is exactly the bug that
    // motivated splitting these collections.
    id: { type: mongoose.Schema.Types.ObjectId },
    name: { type: String },
  },
  // Phase 2. Empty until a provider is configured.
  gateway: {
    provider: { type: String },
    paymentId: { type: String },
    raw: { type: mongoose.Schema.Types.Mixed },
  },
  // A payment that should never have existed is undone with a new row pointing
  // at it. The original is never deleted — hard deletion is refused for admins
  // platform-wide (utils/deletionDisabled.util.js) and this model carries
  // immutableGuard besides.
  reversalOf: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PlatformPayment',
    default: null,
  },
  // A payment that DID happen but was keyed in wrong — usually the received
  // date — is corrected in place and the correction is kept here.
  //
  // Deliberately not a reversal: a mistyped date is one event, and recording it
  // as +৳800 / -৳800 / +৳800 makes a shop's history harder to read than the
  // typo ever was. What may be corrected is fixed in the service, and `amount`
  // and `shop` are not in that list — anything that moves money is a reversal.
  amendments: [{
    at: { type: Date, default: Date.now },
    by: {
      kind: { type: String, enum: ['admin', 'system'], default: 'admin' },
      id: { type: mongoose.Schema.Types.ObjectId },
      name: { type: String },
    },
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
    reason: { type: String, maxlength: 500 },
  }],
  notes: {
    type: String,
    maxlength: 1000,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

// Shop billing timeline — the most common read.
platformPaymentSchema.index({ shop: 1, receivedAt: -1 });
// Platform revenue by kind and by month (subscription vs SMS have very
// different margins, so they are always reported apart).
platformPaymentSchema.index({ type: 1, receivedAt: -1 });
platformPaymentSchema.index({ status: 1, receivedAt: -1 });
// Idempotency for gateway callbacks: a retried webhook must be a no-op, not a
// second extension. Sparse + partial so the many manual rows without a TrxID
// do not collide with each other.
platformPaymentSchema.index(
  { gateway: 1, transactionId: 1 },
  {
    unique: true,
    partialFilterExpression: { transactionId: { $type: 'string' }, source: 'gateway' },
  }
);

platformPaymentSchema.virtual('isReversal').get(function () {
  return !!this.reversalOf;
});

// Same rule as the shop's ledger: financial records are never hard-deleted.
platformPaymentSchema.plugin(immutableGuard, { modelName: 'PlatformPayment' });

const PlatformPayment = mongoose.model('PlatformPayment', platformPaymentSchema);

module.exports = PlatformPayment;
