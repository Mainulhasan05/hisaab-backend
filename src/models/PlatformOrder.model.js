/**
 * PlatformOrder — one attempt by a shop to pay HisaabBD through the gateway.
 *
 * An INTENT, not money. `PlatformPayment` is the revenue ledger and stays that
 * way; this is the thing that exists between "the owner tapped ৳4000 / 6 months"
 * and "the money arrived", which for a hosted-checkout gateway is a real
 * interval containing a browser, a bKash app and a customer who may close both.
 *
 * ── Why this is not just a pending PlatformPayment ──────────────────────────
 *
 * Three reasons, any one of which is sufficient:
 *
 *   1. ABANDONMENT IS THE NORM. Most checkouts are not completed. Writing them
 *      into the ledger would mean most ledger rows were not money.
 *      `billing.service.getShopBilling` computes `lifetimeValue` by summing
 *      `PlatformPayment.amount` across every status, so a walked-away ৳8000
 *      attempt written there inflates a figure an operator quotes to a customer.
 *   2. THE CALLBACK CANNOT BE TRUSTED TO SAY WHAT WAS BOUGHT. PayStation's
 *      `callback_url` is an unsigned browser redirect. The only safe design is
 *      to have written down what was asked for BEFORE sending the customer
 *      away, and to treat everything that comes back as a lookup key.
 *   3. A RETRY NEEDS A NEW INVOICE NUMBER. PayStation refuses a reused one with
 *      `1008 Duplicate invoice number` (verified against sandbox). So an
 *      attempt is a document, not a field on a longer-lived one.
 *
 * ── The status ladder ───────────────────────────────────────────────────────
 *
 *   initiated  a payment_url exists; the customer may or may not be looking at it
 *   paid       `transaction-status` returned success. MONEY IS OURS.
 *   fulfilled  the subscription was extended / the SMS credits were added
 *   underpaid  paid, but for less than we asked. Never auto-fulfilled.
 *   failed     the gateway said failed, or initiation never got a URL
 *   abandoned  never completed, and old enough that it never will be
 *
 * `paid` and `fulfilled` are deliberately two states and not one. If the money
 * landed but the extension threw, that is a shop we owe time to and an operator
 * must be able to see it. Collapsing them would make that case indistinguishable
 * from a payment that never happened.
 *
 * No TTL index. These are the record an operator reads during a payment dispute,
 * which is exactly the conversation that happens months later.
 */

const mongoose = require('mongoose');

const PLATFORM_ORDER_STATUS = Object.freeze({
  INITIATED: 'initiated',
  PAID: 'paid',
  FULFILLED: 'fulfilled',
  UNDERPAID: 'underpaid',
  FAILED: 'failed',
  ABANDONED: 'abandoned',
});

const PLATFORM_ORDER_KIND = Object.freeze({
  SUBSCRIPTION: 'subscription',
  SMS: 'sms',
});

const platformOrderSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
  },
  kind: {
    type: String,
    enum: Object.values(PLATFORM_ORDER_KIND),
    required: true,
  },

  /**
   * What we sent the gateway as `invoice_number`, and the key we query
   * `transaction-status` with.
   *
   * Ours, not theirs, and that is the point: it is the one identifier we can
   * still ask about when the customer closed the tab and no callback ever
   * arrived. Unique so a mint collision fails loudly here rather than becoming
   * a `1008` at the gateway.
   */
  invoiceNumber: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },

  /**
   * Derived on the server from the package the owner chose. NEVER read from a
   * request body — a client-supplied price is a client-supplied discount
   * (services/order.service.js says the same thing about the storefront).
   */
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  currency: {
    type: String,
    default: 'BDT',
  },

  // ── subscription orders ──
  months: { type: Number, min: 1 },

  // ── SMS orders ──
  smsQuantity: { type: Number, min: 1 },
  // The rate this purchase was quoted at, frozen. The shop's standing rate can
  // move afterwards without rewriting what this top-up bought — the same rule
  // `PlatformPayment.smsUnitPrice` follows.
  smsUnitPrice: { type: Number, min: 0 },

  status: {
    type: String,
    enum: Object.values(PLATFORM_ORDER_STATUS),
    default: PLATFORM_ORDER_STATUS.INITIATED,
    required: true,
  },

  gateway: {
    provider: { type: String, default: 'paystation' },
    // 'sandbox' | 'live'. Stamped per order so a sandbox row can never be
    // mistaken for revenue after the environment is switched.
    env: { type: String },
    paymentUrl: { type: String },
    // PayStation's own id, only present once a payment actually succeeded. This
    // is what goes into `PlatformPayment.gateway.paymentId`, which carries the
    // partial-unique index that makes fulfilment idempotent platform-wide.
    trxId: { type: String },
    payerMobile: { type: String },
    paymentMethod: { type: String },
    // The last `transaction-status` body, verbatim. The only place the gateway
    // says WHY, and the first thing read during a dispute.
    raw: { type: mongoose.Schema.Types.Mixed },
    lastCheckedAt: { type: Date },
    // Rising without the status moving means something is re-querying in a loop.
    checkCount: { type: Number, default: 0 },
  },

  paidAt: { type: Date },
  /**
   * Claimed BEFORE fulfilment runs, released never.
   *
   * Two things can try to fulfil one order at the same moment — the customer's
   * browser returning and the reconciliation sweep — and the claim is what makes
   * the loser a no-op. Set by an atomic `findOneAndUpdate`; see
   * `platformCheckout.service.fulfilOrder`.
   */
  fulfilmentClaimedAt: { type: Date },
  fulfilledAt: { type: Date },
  platformPayment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PlatformPayment',
  },

  createdBy: {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    ip: { type: String },
  },

  failureReason: { type: String, maxlength: 500 },
}, {
  timestamps: true,
});

// The shop's own "my payments" list, newest first.
platformOrderSchema.index({ shop: 1, createdAt: -1 });
// The reconciliation sweep's only query: everything still `initiated`, oldest
// first. Without this the sweep is a collection scan every five minutes.
platformOrderSchema.index({ status: 1, createdAt: 1 });
// The admin worklist, and the "did this trxId already land" cross-check.
platformOrderSchema.index({ 'gateway.trxId': 1 }, { sparse: true });

const PlatformOrder = mongoose.model('PlatformOrder', platformOrderSchema);

module.exports = PlatformOrder;
module.exports.PLATFORM_ORDER_STATUS = PLATFORM_ORDER_STATUS;
module.exports.PLATFORM_ORDER_KIND = PLATFORM_ORDER_KIND;
