const mongoose = require('mongoose');

/**
 * Order — a request from a stranger on the internet. NOT a sale.
 *
 * ── INVARIANT I-9, WHICH THIS WHOLE FILE EXISTS TO PROTECT ──────────────────
 *
 * An order touches NOTHING until a human at the shop confirms it. No stock
 * movement, no `Sale`, no `StockTransaction`, no `CustomerBalance`, no entry in
 * the daily summary or the P&L. Placing an order writes exactly one document —
 * this one — and sends a notification.
 *
 * That is not caution for its own sake. This is the only write in the system a
 * stranger can trigger, and it is reachable by anyone with the URL. If placing
 * an order moved stock, then a bored teenager with a loop could empty a shop's
 * shelves on paper, corrupt its P&L and fill its due-aging report, and the
 * shopkeeper's only recourse would be `cancelSale` — which, at the time of
 * writing, is not wrapped in a transaction (ECOMMERCE_PLAN.md §18.1). The
 * confirm step is what keeps a spam wave costing rows in a worklist rather than
 * costing the shop its books.
 *
 * `sale` below is the proof. It is null on every order until confirmation, and
 * it is the only link between this collection and the accounting ones.
 *
 * ── EVERY PRICE HERE IS SERVER-DERIVED ──────────────────────────────────────
 *
 * Nothing in `items[]` is taken from the request body except the product id,
 * the variant sku and the quantity. Name, unit, unit price and line total are
 * all resolved server-side from the `Product` document by the same pricing rule
 * the catalogue renders with (`publicStorefront.service._effective` — online
 * price if set, otherwise selling price). A client that posts
 * `{unitPrice: 1}` gets charged the real price.
 *
 * They are SNAPSHOTS, not references. A shop that raises a price next week must
 * not restate what a customer was quoted, for the same reason `Sale` snapshots
 * `customerName` and `item.unit`.
 *
 * ── THE CUSTOMER IS NOT A `Customer` ────────────────────────────────────────
 *
 * Guest checkout: name, phone and address are stored flat on the order. No
 * `Customer` document is created and none is looked up at placement time,
 * because creating one would be a write to the shop's own address book on
 * behalf of someone who may not exist. Matching or creating the real customer
 * happens at CONFIRM, alongside the `Sale` — which is where a due is created
 * and where the shop has decided this person is real.
 */

/**
 * One line. A snapshot of what was quoted, plus enough identity to deduct the
 * right stock at confirm time.
 */
const orderItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  /**
   * Which variant, for a product that has them. The SKU rather than an index or
   * a subdocument id: `Product.variants[]` is an array a shop reorders and edits
   * from the product form, so a positional reference would silently point at a
   * different size after any edit. The SKU is the variant's own stable name and
   * is what `_variants` publishes.
   *
   * Null for a product with no variants.
   */
  variantSku: { type: String, default: null, trim: true },

  // Snapshots. See the header on why these are copied rather than populated.
  name: { type: String, required: true, trim: true },
  code: { type: String, trim: true },
  variantLabel: { type: String, trim: true },
  unit: { type: String, trim: true },
  image: { type: String, trim: true },

  quantity: {
    type: Number,
    required: true,
    min: [1, 'পরিমাণ কমপক্ষে ১ হতে হবে'],
  },
  /** Server-derived. The effective price at the moment the order was placed. */
  unitPrice: {
    type: Number,
    required: true,
    min: [0, 'দাম ০ এর কম হতে পারবে না'],
  },
  /**
   * The shelf price, kept only so the shopkeeper and the customer can both see
   * what the discount was. Never used to compute anything.
   */
  compareAtPrice: { type: Number, default: null },
  lineTotal: {
    type: Number,
    required: true,
    min: [0, 'মোট ০ এর কম হতে পারবে না'],
  },

  /**
   * What the shop paid for this unit. THE COST SNAPSHOT, and it must never
   * leave the server.
   *
   * Named `buyingPrice` rather than `cost` deliberately: it is the same name
   * `Sale.items[].buyingPrice` uses, so confirming an order hands its lines
   * straight to `createSale` and profit is computed by the EXISTING `pre('save')`
   * arithmetic on `Sale` — `(unitPrice - buyingPrice) * quantity - discount`.
   * A second profit implementation over here would eventually disagree with the
   * first, and the disagreement would surface as a shopkeeper's daily summary
   * not matching their order list.
   *
   * Snapshotted at placement for the same reason the selling price is: a
   * restock at a higher cost next week must not retroactively make last week's
   * orders look less profitable.
   *
   * ── IT IS NOT PUBLIC ──────────────────────────────────────────────────────
   *
   * This is the single most sensitive number in the system — it is what the
   * shop paid its supplier. The order confirmation page is served to an
   * unauthenticated stranger, so the public projection names its keys
   * explicitly and this is not among them. Same allowlist discipline as
   * `publicStorefront.service.PUBLIC_PRODUCT_FIELDS`, and for the same reason.
   */
  buyingPrice: { type: Number, default: 0, min: 0 },
}, { _id: false });

/**
 * The lifecycle.
 *
 * `pending` is where every order lands and where most of the junk stays.
 * `confirmed` is the one transition with consequences — it creates the `Sale`,
 * deducts stock and books the due. Everything after it is fulfilment tracking
 * and moves no money.
 *
 * `cancelled` is reachable from anywhere before `delivered`. Cancelling a
 * CONFIRMED order has to unwind the sale, which is why §18.1 wants
 * `cancelSale` transactional before this feature carries real volume.
 */
const ORDER_STATUSES = Object.freeze([
  'pending',
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
]);

/** Statuses in which no `Sale` exists yet, so nothing has touched the books. */
const PRE_CONFIRM_STATUSES = Object.freeze(['pending', 'cancelled']);

const orderSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },
  /**
   * Which branch fulfils. ECOMMERCE_PLAN.md §18.2 asks for the field shape to
   * be settled now even though routing is P4, so that adding "route by delivery
   * zone" later is a service change and not a migration over live orders.
   *
   * Today it is copied from the storefront's own branch at placement time and
   * is null for a single-branch shop — the same convention `InvoiceCounter`
   * uses, so the confirm path can pass it straight through to `createSale`.
   */
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null,
  },

  /** Human-readable, unique per shop. Issued by `OrderCounter`. */
  orderNo: {
    type: String,
    required: true,
    trim: true,
  },

  /**
   * How the order arrived.
   *
   * `storefront` — a stranger posted it from the public website. Untrusted:
   *   rate limited, abuse tracked, every price re-derived server-side, and
   *   `meta.ip` recorded.
   *
   * `manual` — a member of shop staff typed it in from a Facebook message, a
   *   phone call or a WhatsApp thread. This is how most Bangladeshi small shops
   *   actually sell online today, and an order system that only accepts orders
   *   from its own website would leave the shop keeping the rest on paper —
   *   which means the worklist, the SMS updates and the profit figures would
   *   each describe a fraction of the business and be quietly wrong.
   *
   * The two share one collection, one lifecycle and one set of reports on
   * purpose. What differs is only the trust boundary at the point of entry:
   * a manual order skips the public rate limiter (it arrives on an
   * authenticated route) and carries `createdBy` instead of `meta.ip`. Prices
   * are still server-derived — a typo by a tired shop assistant is not
   * malicious, but it is still wrong, and the same resolver catches both.
   */
  source: {
    type: String,
    enum: ['storefront', 'manual'],
    default: 'storefront',
    index: true,
  },
  /**
   * Which staff member entered a `manual` order. Null for storefront orders,
   * where the whole point is that nobody at the shop was involved.
   */
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  /**
   * Where a manual order came from, in the shop's own words — "Facebook",
   * "ফোন", "WhatsApp". Free text rather than an enum because the channels a
   * small shop sells through change faster than a deploy, and an enum would
   * mean a code change to record a new one.
   */
  sourceNote: { type: String, trim: true, maxlength: 120 },

  // ── Who ordered ──────────────────────────────────────────────────────────
  customer: {
    name: {
      type: String,
      required: [true, 'নাম দিন'],
      trim: true,
      maxlength: [120, 'নাম ১২০ অক্ষরের বেশি হতে পারবে না'],
    },
    /**
     * Normalised through `phone.util.normalizePhone` before it is stored, so
     * `+8801712345678` and `01712345678` are the same customer to every later
     * query — the per-phone abuse caps and the confirm-time customer match both
     * depend on that being true.
     */
    phone: {
      type: String,
      required: [true, 'মোবাইল নম্বর দিন'],
      trim: true,
      index: true,
    },
    address: {
      type: String,
      required: [true, 'ঠিকানা দিন'],
      trim: true,
      maxlength: [500, 'ঠিকানা ৫০০ অক্ষরের বেশি হতে পারবে না'],
    },
    /** Free text from the customer — "call before delivery", a landmark. */
    note: {
      type: String,
      trim: true,
      maxlength: [500, 'নোট ৫০০ অক্ষরের বেশি হতে পারবে না'],
    },
  },

  items: {
    type: [orderItemSchema],
    required: true,
    validate: [(arr) => arr.length > 0, 'অন্তত একটি পণ্য থাকতে হবে'],
  },

  // ── Delivery ─────────────────────────────────────────────────────────────
  //
  // Snapshotted from `Storefront.delivery.zones[]` for the same reason prices
  // are: a shop that raises its Dhaka charge from ৳৬০ to ৳৮০ must not change
  // what an already-placed order said it would cost.
  delivery: {
    zoneKey: { type: String, trim: true },
    zoneName: { type: String, trim: true },
    charge: { type: Number, default: 0, min: 0 },
    etaDaysMin: { type: Number, default: null },
    etaDaysMax: { type: Number, default: null },
    isPickup: { type: Boolean, default: false },
  },

  // ── Money ────────────────────────────────────────────────────────────────
  subtotal: { type: Number, required: true, min: 0 },
  deliveryCharge: { type: Number, default: 0, min: 0 },
  total: { type: Number, required: true, min: 0 },

  /**
   * Cash on delivery only, and the enum has one member on purpose.
   *
   * A field with a single value looks redundant until the alternative is
   * inspected: the alternative is no field, and then adding manual bKash means
   * a migration over every order ever placed to say what they were. §15's P2
   * scope is COD plus manual MFS, so the second member is already known.
   */
  paymentMethod: {
    type: String,
    enum: ['cod'],
    default: 'cod',
  },

  // ── Lifecycle ────────────────────────────────────────────────────────────
  status: {
    type: String,
    enum: ORDER_STATUSES,
    default: 'pending',
    index: true,
  },
  /**
   * The `Sale` this order became. NULL until confirmed, and that is invariant
   * I-9 expressed as a field: an order with no `sale` has touched no stock, no
   * balance and no report, and that can be asserted directly in a test.
   */
  sale: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale',
    default: null,
  },
  confirmedAt: { type: Date, default: null },
  confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  cancelledAt: { type: Date, default: null },
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  cancelReason: { type: String, trim: true, maxlength: 500 },
  deliveredAt: { type: Date, default: null },

  /**
   * Every transition, in order. The shopkeeper's answer to "what happened to
   * this order and when".
   *
   * Kept as an embedded log rather than derived from the `*At` fields above,
   * because those record only the transitions with consequences and a customer
   * ringing up to ask where their parcel is wants the whole trail — including
   * the ones that moved no money. Bounded implicitly by the lifecycle: an order
   * has at most a handful of states and cannot cycle.
   */
  statusHistory: {
    type: [{
      status: { type: String, enum: ORDER_STATUSES, required: true },
      at: { type: Date, default: Date.now },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      note: { type: String, trim: true, maxlength: 300 },
    }],
    default: () => [],
  },

  /**
   * What was actually sent to the customer, and when.
   *
   * ── WHY SENDING IS A LOG AND NOT A SETTING ────────────────────────────────
   *
   * SMS is metered and billed to the shop per message (`SMSQuota`,
   * `billing.smsUnitPrice`). `Storefront.notifications` already carries the
   * shop's DEFAULTS — `smsOnConfirm`, `smsOnShip`, both off — and those decide
   * what is offered, never what is spent. Every send is an explicit act by a
   * person, on one order, and this is the record of it.
   *
   * That distinction is the whole design. A per-status automatic toggle would
   * mean a shop enabling "SMS on shipped" once and then spending money on every
   * order forever, discovering the bill at the end of the month. Making the
   * send explicit costs one tap and makes the spend visible at the moment it
   * happens — which is what a shopkeeper counting taka actually wants.
   *
   * The log also answers the two questions support gets asked: "did the
   * customer get told" and "why was I charged for four messages on one order".
   */
  notifications: {
    type: [{
      channel: { type: String, enum: ['sms', 'telegram'], required: true },
      /** Which transition this message announced. */
      status: { type: String, enum: ORDER_STATUSES },
      to: { type: String, trim: true },
      text: { type: String, trim: true, maxlength: 800 },
      sentAt: { type: Date, default: Date.now },
      sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      /** False with a reason rather than a thrown error — a failed SMS must
       *  never roll back the status change it was announcing. */
      ok: { type: Boolean, default: true },
      error: { type: String, trim: true, maxlength: 300 },
    }],
    default: () => [],
  },

  /**
   * Where it came from. Forensics, not analytics.
   *
   * The IP and user agent are here because the abuse controls on the checkout
   * endpoint need something to reason about AFTER the fact: a rate limiter
   * stops a burst in the moment, but working out that forty orders across two
   * hours came from one machine is a question you can only ask of stored data.
   *
   * Retention is a real question and the honest answer is that this is personal
   * data under most readings — it is kept because a shop being defrauded has a
   * legitimate interest in it, and it should be swept on the same schedule the
   * orders themselves are archived on rather than kept forever.
   */
  meta: {
    ip: { type: String, trim: true },
    userAgent: { type: String, trim: true, maxlength: 400 },
    idempotencyKey: { type: String, trim: true, default: null },
  },
}, {
  timestamps: true,
});

// The shopkeeper's worklist: newest first, filtered by status.
orderSchema.index({ shop: 1, status: 1, createdAt: -1 });
// "Has this person ordered before" — the confirm screen and the abuse caps.
orderSchema.index({ shop: 1, 'customer.phone': 1, createdAt: -1 });
// Order numbers are unique per shop, not globally.
orderSchema.index({ shop: 1, orderNo: 1 }, { unique: true });

/**
 * The idempotency backstop.
 *
 * `idempotency.middleware` is explicitly NON-BLOCKING — it skips entirely when
 * the client sends no header, and it falls through on any cache error rather
 * than refusing the request. That is the right call for a checkout (a Redis
 * blip must not stop a shop taking orders), but it means the middleware alone
 * cannot promise that a double-tap on a flaky 3G connection produces one order.
 *
 * This index can. Sparse, so the many orders placed without a key do not all
 * collide on null; unique per shop, so a retry carrying the same key is refused
 * by the database itself. ECOMMERCE_PLAN.md §16 calls this out as its own test.
 */
orderSchema.index(
  { shop: 1, 'meta.idempotencyKey': 1 },
  { unique: true, sparse: true }
);

orderSchema.statics.ORDER_STATUSES = ORDER_STATUSES;
orderSchema.statics.PRE_CONFIRM_STATUSES = PRE_CONFIRM_STATUSES;

const Order = mongoose.model('Order', orderSchema);

module.exports = Order;
module.exports.ORDER_STATUSES = ORDER_STATUSES;
module.exports.PRE_CONFIRM_STATUSES = PRE_CONFIRM_STATUSES;
