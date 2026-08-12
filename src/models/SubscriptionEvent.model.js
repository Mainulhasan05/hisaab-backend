/**
 * SubscriptionEvent — the billing narrative for one shop, append-only.
 *
 * `AuditLog` already records THAT something happened, in prose, mixed in with
 * every other admin action on the platform. This records WHY a shop's expiry
 * is what it is, in a shape the timeline UI can render without parsing
 * sentences, and it is what makes "why is this shop free until December?"
 * answerable a year later.
 *
 * The field that earns this collection its keep is `paid`. A free extension —
 * goodwill, an outage credit, a bargain struck on the phone — must be visible
 * as free forever, or ৳0 days quietly become indistinguishable from revenue.
 * That is why the service refuses to grant one without a reason.
 */

const mongoose = require('mongoose');

const EVENT_TYPES = [
  'trial_started',
  'trial_extended',
  'extended',
  'payment_recorded',
  'payment_reversed',
  'payment_amended',
  'sms_allocated',
  'blocked',
  'unblocked',
  'expired',
  'plan_changed',
  'price_changed',
  'grace_changed',
];

const subscriptionEventSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
  },
  type: {
    type: String,
    enum: EVENT_TYPES,
    required: true,
  },
  actor: {
    // 'system' covers the expiry sweep, which is the ONLY automated writer —
    // and it may only ever record an expiry, never a block (invariant §8.1).
    kind: {
      type: String,
      enum: ['admin', 'system', 'gateway'],
      default: 'admin',
    },
    id: { type: mongoose.Schema.Types.ObjectId },
    name: { type: String },
  },
  before: {
    expiresAt: { type: Date },
    plan: { type: String },
    state: { type: String },
  },
  after: {
    expiresAt: { type: Date },
    plan: { type: String },
    state: { type: String },
  },
  // false = days granted without money changing hands. Requires `reason`.
  paid: {
    type: Boolean,
    default: false,
  },
  amount: { type: Number },
  payment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PlatformPayment',
  },
  // Net calendar days granted (negative when an operator corrects an expiry
  // backwards).
  days: { type: Number },
  reason: { type: String, maxlength: 500 },
  note: { type: String, maxlength: 1000 },
  at: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

// The shop's billing timeline, newest first — the only read that matters.
subscriptionEventSchema.index({ shop: 1, at: -1 });
// "Show me every free extension this quarter" — the reason this is a typed
// collection rather than prose in the audit log.
subscriptionEventSchema.index({ type: 1, at: -1 });

const SubscriptionEvent = mongoose.model('SubscriptionEvent', subscriptionEventSchema);

module.exports = SubscriptionEvent;
