/**
 * LandingOrder — one order placed through a landing page.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS COLLECTION IS SEALED OFF FROM THE SHOP'S BOOKS (I-17)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nothing in this feature may write to `Customer`, `CustomerBalance`, `Sale`,
 * `StockTransaction`, `Payment`, `InvoiceCounter`, or the shared `Order`
 * collection. Not on confirm, not on delivery, not from a job, not from a bulk
 * action.
 *
 * The reason is the platform's shape rather than a technical one: nearly every
 * shop here is an offline seller whose customer list and sales ledger are what
 * they actually rely on, and a stranger who filled in a Facebook ad form is not
 * a customer of that shop in any sense they would recognise. The failure being
 * prevented is not a crash — it is a shopkeeper opening their customer list and
 * finding four hundred strangers in it, or a P&L that no longer matches the
 * till. Neither is reversible once seeded across a live tenant.
 *
 * A `require` of any of those models inside the landing module is the violation,
 * and it is visible in review without running anything. See
 * LANDING_PAGE_PLAN.md §2.2 for the decision and what it cost.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NOT `Order` WITH A `source` FIELD
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Order` is the storefront's worklist and its confirm path writes a `Sale`. One
 * extra `source` value would put landing orders in front of every existing query,
 * projection and screen over that collection — and every one of them would need
 * a filter added, correctly, forever. Missing one is not a crash either; it is a
 * landing order quietly appearing in the shop's online-orders list.
 *
 * Two collections cost one model file. One collection costs a filter on every
 * future query anyone writes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERYTHING IS A SNAPSHOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The customer, the offer labels, the prices and the delivery charge are all
 * copied onto the order at placement. Editing an offer's price for tomorrow's
 * traffic must never rewrite what yesterday's customers agreed to — the same
 * rule `Sale.items` follows, kept here for honesty rather than for accounting.
 */

const mongoose = require('mongoose');

/**
 * The status flow.
 *
 * Borrowed from `Order.model.js` on purpose — it is how a parcel operation
 * actually works, and inventing a second vocabulary would help nobody. What is
 * NOT borrowed is the meaning of `confirmed`: here it means "I rang them and
 * they are real", not "post this to the ledger". No transition writes anything
 * outside this collection.
 */
const LANDING_ORDER_STATUSES = Object.freeze([
  'pending',
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
]);

/** Statuses from which any other status is still reachable. */
const OPEN_STATUSES = Object.freeze(['pending', 'confirmed', 'packed', 'shipped']);

const itemSchema = new mongoose.Schema({
  // `LandingPage.offers[].key`. Kept so a report can group by offer even after
  // the label has been edited.
  offerKey: { type: String, required: true, trim: true },
  // Snapshotted label — what the customer actually saw when they chose.
  label: { type: String, required: true, trim: true },
  unitPrice: { type: Number, required: true, min: 0 },
  quantity: { type: Number, required: true, min: 1 },
  lineTotal: { type: Number, required: true, min: 0 },
}, { _id: false });

const landingOrderSchema = new mongoose.Schema({
  // Neither is indexed on its own: each is the prefix of a compound index below
  // that serves the reads which actually happen.
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
  },
  page: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LandingPage',
    required: true,
  },

  /** Human-readable, unique per shop. Issued by `LandingOrderCounter`. */
  orderNo: { type: String, required: true, trim: true },

  /**
   * The customer, as a SNAPSHOT. There is no `Customer` record and no join.
   *
   * The page's "customers" view is an aggregation over `customer.phone` within
   * one page — distinct buyers, order counts, totals — computed on read and
   * stored nowhere. That is the whole of I-17 in one field.
   */
  customer: {
    name: { type: String, required: [true, 'নাম দিন'], trim: true, maxlength: 120 },
    // Normalised through `phone.util` before it is stored, so the duplicate
    // check and the customers view group the same person together whether they
    // typed 01712..., +8801712... or 8801712...
    //
    // Deliberately NOT indexed alone. Every lookup is shop-scoped — a
    // cross-tenant search by phone is not a query this feature has, and offering
    // an index for it invites one.
    phone: { type: String, required: [true, 'মোবাইল নম্বর দিন'], trim: true },
    address: { type: String, required: [true, 'ঠিকানা দিন'], trim: true, maxlength: 500 },
    note: { type: String, trim: true, maxlength: 500 },
  },

  items: {
    type: [itemSchema],
    validate: {
      validator: (arr) => Array.isArray(arr) && arr.length > 0,
      message: 'অর্ডারে অন্তত একটি পণ্য থাকতে হবে',
    },
  },

  delivery: {
    zoneKey: { type: String, trim: true },
    zoneName: { type: String, trim: true },
    charge: { type: Number, default: 0, min: 0 },
    /**
     * Delivery came out free because the order cleared the zone's threshold —
     * as opposed to the zone simply being ৳0. Recorded because a month later
     * "why did this parcel ship free" has two possible answers and the shop
     * will want the right one.
     */
    freeByThreshold: { type: Boolean, default: false },
    /** The threshold in force when this order was placed. Snapshot, like the rest. */
    freeAbove: { type: Number, default: 0, min: 0 },
  },

  /**
   * The coupon, as a SNAPSHOT of what it did — not a reference to a code that
   * may be edited or deleted tomorrow. `amount` is what actually came off.
   */
  discount: {
    code: { type: String, trim: true, uppercase: true },
    label: { type: String, trim: true, maxlength: 120 },
    amount: { type: Number, default: 0, min: 0 },
  },

  /**
   * How the money arrives.
   *
   * Stored on every order including the plain COD ones (see the `payment` block
   * in LandingPage.model.js for why an assumed value is not good enough).
   */
  paymentMethod: {
    type: String,
    enum: ['cod', 'advance'],
    default: 'cod',
  },

  /**
   * The up-front payment, when there is one.
   *
   * `verified` is a HUMAN's mark. Nothing in this system talks to bKash, and a
   * field that looked automatic would be read as one — the shop must check the
   * TrxID against their own statement before dispatching.
   */
  advance: {
    amount: { type: Number, default: 0, min: 0 },
    /** What the customer typed. Never trusted, never parsed, only shown. */
    senderNumber: { type: String, trim: true, maxlength: 40 },
    trxId: { type: String, trim: true, maxlength: 60 },
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },

  // Every figure below is derived server-side from the page's config at
  // placement (I-13). A total posted by the client is ignored; these are what
  // it is ignored for.
  //
  //   total     = subtotal − discount.amount + deliveryCharge
  //   codAmount = total − advance.amount        ← what the courier collects
  subtotal: { type: Number, required: true, min: 0 },
  deliveryCharge: { type: Number, default: 0, min: 0 },
  total: { type: Number, required: true, min: 0 },
  /**
   * What is still to be collected at the door.
   *
   * Equal to `total` for a COD order, and that redundancy is on purpose: the
   * packing slip prints ONE number, and computing it at each of the four places
   * that print one is how they end up disagreeing.
   */
  codAmount: { type: Number, default: 0, min: 0 },

  status: {
    type: String,
    enum: LANDING_ORDER_STATUSES,
    default: 'pending',
  },
  statusHistory: {
    type: [{
      status: { type: String, enum: LANDING_ORDER_STATUSES, required: true },
      at: { type: Date, default: Date.now },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      note: { type: String, maxlength: 300 },
    }],
    default: () => [],
  },

  /**
   * Marked by the shop after a prank or a refused parcel.
   *
   * Separate from `cancelled` because the two answer different questions: a
   * cancellation may be the customer changing their mind, which is ordinary,
   * while this feeds the duplicate check and the blocklist. Lumping them
   * together would make the confirmation rate — the number a trader judges a
   * campaign by — meaningless.
   */
  isFake: { type: Boolean, default: false },

  /** Where the visitor came from. Captured from the session, never from the form. */
  attribution: {
    utmSource: { type: String, trim: true },
    utmMedium: { type: String, trim: true },
    utmCampaign: { type: String, trim: true },
    utmContent: { type: String, trim: true },
    fbclid: { type: String, trim: true },
    referrer: { type: String, trim: true, maxlength: 500 },
  },

  // For abuse tracing. `ip` is recorded because this is an unauthenticated
  // write path — see ECOMMERCE_PLAN.md §13.
  meta: {
    ip: { type: String, trim: true },
    userAgent: { type: String, trim: true, maxlength: 300 },
  },
}, {
  timestamps: true,
});

// The worklist: one shop's orders, filtered by status, newest first.
landingOrderSchema.index({ shop: 1, status: 1, createdAt: -1 });

// Per-campaign reporting and the header totals.
landingOrderSchema.index({ page: 1, createdAt: -1 });

// The duplicate-phone check (§10) and the "customers" aggregation.
landingOrderSchema.index({ shop: 1, 'customer.phone': 1, createdAt: -1 });

// Order numbers are unique per shop, not globally — two shops may both run an
// `AAM-0001`, and neither would expect the other to affect their series.
landingOrderSchema.index({ shop: 1, orderNo: 1 }, { unique: true });

/** Is any further status change still possible? */
landingOrderSchema.methods.isOpen = function isOpen() {
  return OPEN_STATUSES.includes(this.status);
};

/**
 * Which statuses may follow the current one.
 *
 * Returned rather than enforced by a guard scattered across the service, so the
 * panel and the API agree about what is offerable. `cancelled` is reachable from
 * anything before `delivered`; a delivered order is finished.
 */
landingOrderSchema.methods.nextStatuses = function nextStatuses() {
  const order = ['pending', 'confirmed', 'packed', 'shipped', 'delivered'];
  const at = order.indexOf(this.status);
  if (at === -1 || this.status === 'delivered') return [];
  return [...order.slice(at + 1), 'cancelled'];
};

const LandingOrder = mongoose.model('LandingOrder', landingOrderSchema);

module.exports = LandingOrder;
module.exports.LANDING_ORDER_STATUSES = LANDING_ORDER_STATUSES;
module.exports.OPEN_STATUSES = OPEN_STATUSES;
