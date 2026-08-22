/**
 * LandingPage — one seasonal campaign page.
 *
 * See LANDING_PAGE_PLAN.md. The short version: a platform admin authors the
 * page as ordinary HTML, assigns it to one shop with a slug and an expiry date,
 * and the shop works the orders it brings in from its own panel at `/pages`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MANY PER SHOP — THE ONE THING THIS IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Storefront.shop` is `unique`: one catalogue website per shop, forever. This
 * collection deliberately is not. A seasonal trader runs আম, লিচু and মধু at the
 * same time, each with its own URL, its own ad set, its own delivery charge and
 * its own expiry. Every one of those is a separate document here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HTML IS LAYOUT. THE CONFIG IS TRUTH. (I-13)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `html` may say "৳১৮০০" in a heading. That number is DECORATIVE. Every price
 * comes from `offers[]`, the public runtime overwrites the marked price nodes
 * from that config before first paint, and an order's totals are derived
 * server-side at placement.
 *
 * This is ECOMMERCE_PLAN.md I-10 with a sharper edge. There the untrusted input
 * was a stranger's browser; here the PAGE ITSELF is authored input, possibly by
 * a language model, and it is wrong to assume a number in it was ever checked.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE TOUCHES THE SHOP'S BOOKS (I-17)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An offer carries a name and a price, NOT a `Product` reference. Orders land in
 * `LandingOrder` and stay there: no `Customer`, no `Sale`, no stock movement, no
 * due. If a field referencing `Product`, `Customer` or `Sale` ever appears in
 * this file, the decision recorded in LANDING_PAGE_PLAN.md §2.2 has been
 * reversed without anyone saying so.
 */

const mongoose = require('mongoose');

const PAGE_STATUS = Object.freeze(['draft', 'live', 'paused', 'expired']);

/** How many `html` revisions to keep. Cheap insurance against a bad paste. */
const HTML_HISTORY_LIMIT = 5;

/** Warn the shop this far ahead of expiry. Seven days, not three — see below. */
const EXPIRY_WARNING_DAYS = 7;

/**
 * One thing the customer can buy.
 *
 * A name, a price and a picture. NOT a `Product` — see the header and D10.
 *
 * One page normally carries several: 3kg / 5kg / 10kg, or three colours in four
 * sizes. They are flat rows rather than a variant matrix, because a campaign
 * that needs a matrix has outgrown a landing page and wants the storefront.
 */
const offerSchema = new mongoose.Schema({
  /**
   * What the form posts. Stable, because it is written into the authored HTML's
   * radio values — renaming it silently breaks the page's order form, and the
   * publish-time contract check is what catches a mismatch.
   */
  key: {
    type: String,
    required: [true, 'অফারের কী দিন'],
    trim: true,
    lowercase: true,
    match: [/^[a-z0-9][a-z0-9-]{0,39}$/, 'অফারের কী ইংরেজি ছোট হাতের অক্ষর, সংখ্যা ও হাইফেন দিয়ে লিখুন'],
  },
  label: {
    type: String,
    required: [true, 'অফারের নাম দিন'],
    trim: true,
    maxlength: [160, 'নাম ১৬০ অক্ষরের বেশি হতে পারবে না'],
  },
  sublabel: { type: String, trim: true, maxlength: 160 },

  price: {
    type: Number,
    required: [true, 'অফারের দাম দিন'],
    min: [0, 'দাম ঋণাত্মক হতে পারবে না'],
  },
  // The struck-through "regular" price. Decorative, never charged — so it is
  // deliberately NOT validated against `price`: a campaign that wants to show a
  // lower "was" price is making a claim we do not police here.
  compareAtPrice: { type: Number, min: 0 },

  image: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformMedia', default: null },

  // Free text — "সীমিত স্টক", "শেষ ২০ পিস". Not a quantity, and not enforced:
  // nothing in this feature tracks stock (I-17), and a number here that did not
  // decrement would be a lie the page tells every visitor.
  stockNote: { type: String, trim: true, maxlength: 80 },

  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 100 },
}, { _id: false });

/** One delivery option. Copied onto the order, so later edits never rewrite history. */
const zoneSchema = new mongoose.Schema({
  key: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  charge: { type: Number, default: 0, min: 0 },
  /**
   * Free delivery once the goods subtotal reaches this. `0` = no threshold.
   *
   * Same field and same meaning as `Storefront.delivery.zones[].freeAbove`, and
   * deliberately per-ZONE rather than per-page: "ঢাকায় ১০০০ টাকার উপরে ফ্রি"
   * while the outside-Dhaka courier still charges is the ordinary Bangladeshi
   * offer, and a page-level threshold could not express it.
   *
   * Measured against the subtotal AFTER any coupon, because that is the number
   * the customer actually pays for goods — see `quoteDelivery()`.
   */
  freeAbove: { type: Number, default: 0, min: 0 },
  isActive: { type: Boolean, default: true },
}, { _id: false });

/**
 * One discount code for this page.
 *
 * Page-scoped rather than a `Coupon` document: that collection belongs to the
 * shop's own sales, its redemptions are counted against the shop's ledger, and
 * reaching for it here would be exactly the coupling I-17 forbids. A landing
 * campaign's "EID200" is a property of the campaign, dies with it, and is worth
 * one subdocument.
 *
 * NEVER sent to the browser as a list. The public payload carries no codes at
 * all — a customer types one and the server answers yes or no — because a page
 * whose source lists every code has no discount, it has a price cut.
 */
const couponSchema = new mongoose.Schema({
  code: {
    type: String,
    required: [true, 'কুপন কোড দিন'],
    trim: true,
    uppercase: true,
    match: [/^[A-Z0-9][A-Z0-9-]{1,23}$/, 'কুপন কোড ইংরেজি বড় হাতের অক্ষর, সংখ্যা ও হাইফেন দিয়ে লিখুন'],
  },
  type: { type: String, enum: ['flat', 'percent'], default: 'flat' },
  /** Taka for `flat`, percent of subtotal for `percent`. */
  value: { type: Number, required: true, min: 0 },
  /** Percent codes only. `0` = uncapped. A 20% code with no cap is a blank cheque. */
  maxDiscount: { type: Number, default: 0, min: 0 },
  /** Smallest goods subtotal the code applies to. */
  minSubtotal: { type: Number, default: 0, min: 0 },
  /** `0` = unlimited. Enforced with an atomic guarded increment at order time. */
  usageLimit: { type: Number, default: 0, min: 0 },
  usedCount: { type: Number, default: 0, min: 0 },
  isActive: { type: Boolean, default: true },
}, { _id: false });

const landingPageSchema = new mongoose.Schema({
  /**
   * Who works the orders. Set by the admin at assignment time (D11) and not
   * changed afterwards — moving a live page between shops would strand its
   * orders in a panel the new shop cannot see.
   */
  // Not indexed on its own — `{ shop, status, createdAt }` below has it as a
  // prefix and serves the only read that filters on it.
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
  },

  /** The admin's internal name — "আম ২০২৬". Shown to the shop as the page title. */
  title: {
    type: String,
    required: [true, 'পেজের নাম দিন'],
    trim: true,
    maxlength: [120, 'নাম ১২০ অক্ষরের বেশি হতে পারবে না'],
  },

  /**
   * The public path segment: `hisaab.bd/p/<slug>`.
   *
   * Unique platform-wide, and stable once live. An ad running against this URL
   * cannot be edited retroactively, so changing it turns every impression
   * already bought into a 404. Renewal reuses the same document precisely so a
   * second season keeps the same link (LANDING_PAGE_PLAN.md §18.3).
   */
  slug: {
    type: String,
    required: [true, 'পেজের লিংক দিন'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^[a-z0-9][a-z0-9-]{2,47}$/, 'লিংক ইংরেজি ছোট হাতের অক্ষর, সংখ্যা ও হাইফেন দিয়ে লিখুন (৩–৪৮ অক্ষর)'],
  },

  // ── Authored content ──────────────────────────────────────────────────────

  /**
   * The page itself. ADMIN-ONLY (I-16), sanitised on write (I-15).
   *
   * Stored sanitised rather than sanitised on read: a stored document must never
   * be dangerous, and a render path that forgets to sanitise is a much easier
   * mistake to make than a save path that does.
   */
  html: { type: String, default: '', maxlength: 512000 },

  /**
   * Derived from `html` on save by scanning for `data-hisaab-*` markers. This is
   * what the editor renders — one field per entry — which is why any design
   * gets a working editor without a per-design component.
   *
   * Mixed because an entry's shape depends on its kind, and typing it here would
   * mean a schema migration every time a marker gains an option. Same reasoning
   * as `Storefront.blocks`.
   */
  manifest: { type: [mongoose.Schema.Types.Mixed], default: () => [] },

  /** The subset of manifest keys the SHOP may change. Enforced server-side (I-16). */
  editableKeys: { type: [String], default: () => [] },

  /** Manifest key -> value, the edits made against it. */
  content: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  /** Manifest key -> PlatformMedia id, for image markers. */
  assets: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

  /** Last few `html` revisions. Not a publish workflow — an undo. */
  htmlHistory: {
    type: [{
      html: String,
      savedAt: { type: Date, default: Date.now },
      savedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    }],
    default: () => [],
  },

  // ── What it sells ─────────────────────────────────────────────────────────

  offers: { type: [offerSchema], default: () => [] },

  /**
   * Per-page, not per-shop, and that is deliberate (LANDING_PAGE_PLAN.md §2.1):
   * a mango campaign runs free delivery while the same shop's honey campaign
   * charges ৳৬০/৳১২০.
   */
  delivery: {
    zones: {
      type: [zoneSchema],
      default: () => ([
        { key: 'inside-dhaka', name: 'ঢাকার ভিতরে', charge: 60 },
        { key: 'outside-dhaka', name: 'ঢাকার বাইরে', charge: 120 },
      ]),
    },
  },

  /**
   * How the customer pays.
   *
   * ── WHY `cod` IS A STORED VALUE AND NOT AN ASSUMPTION ─────────────────────
   *
   * Every order this feature took before today was cash on delivery, and none
   * of them said so. That is fine right up to the first page that offers
   * anything else, at which point no past order can be told apart from a new
   * one and no report can be trusted. So the method is recorded on the order
   * even when there is only one of it.
   *
   * ── WHAT `advance` IS FOR ─────────────────────────────────────────────────
   *
   * Not a payment gateway. The customer sends the delivery charge over bKash or
   * Nagad to a number printed on the page and types the TrxID into the form;
   * the shop eyeballs it against their own statement and marks it verified.
   *
   * It exists because a COD landing page in Bangladesh loses a real share of
   * its parcels to prank and impulse orders, and asking for ৳120 up front is
   * the cheapest filter there is. Nothing here checks the TrxID — pretending to
   * would be worse than being honest that a human does it.
   */
  payment: {
    /**
     * What the form may offer. `['cod']` is the default and the status quo.
     * A page listing both renders a picker; a page listing one does not have to.
     */
    methods: {
      type: [{ type: String, enum: ['cod', 'advance'] }],
      default: () => ['cod'],
    },
    /**
     * What `advance` asks for. `delivery` = whatever this order's delivery
     * charge came to (so a free-delivery order asks for nothing and quietly
     * becomes COD), `fixed` = `advanceAmount` regardless.
     */
    advanceMode: { type: String, enum: ['delivery', 'fixed'], default: 'delivery' },
    advanceAmount: { type: Number, default: 0, min: 0 },
    /** "বিকাশ (পার্সোনাল): 01XXXXXXXXX — Send Money করে TrxID দিন". */
    advanceInstructions: { type: String, trim: true, maxlength: 500 },
  },

  /** Discount codes. Never listed publicly — see `couponSchema`. */
  coupons: { type: [couponSchema], default: () => [] },

  /** Order-number prefix — `AAM` vs `MOU` is how a shop tells campaigns apart. */
  orderPrefix: {
    type: String,
    default: 'LP',
    trim: true,
    uppercase: true,
    maxlength: [8, 'প্রিফিক্স ৮ অক্ষরের বেশি হতে পারবে না'],
  },

  notifications: {
    // Free, instant, and reaches a phone already in the owner's hand. Only sends
    // when a TelegramLink exists, so defaulting on costs nothing.
    telegram: { type: Boolean, default: true },
    // Metered and billed per shop. A default that silently spends a shop's money
    // on every order is how you earn an angry phone call.
    smsOnConfirm: { type: Boolean, default: false },
  },

  /** The SHOP's own marketing ids, per campaign — not the platform's. */
  analytics: {
    fbPixelId: { type: String, trim: true },
    fbCapiToken: { type: String, trim: true, select: false },
    gaId: { type: String, trim: true },
    tiktokPixelId: { type: String, trim: true },
  },

  seo: {
    title: { type: String, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 300 },
    ogImage: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformMedia', default: null },
  },

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  status: { type: String, enum: PAGE_STATUS, default: 'draft' },

  /** Set when an ADMIN paused it. Non-null means the shop may not resume. */
  pausedByAdmin: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  pauseReason: { type: String, maxlength: 500 },

  /** null = live the moment it is published. */
  startsAt: { type: Date, default: null },

  /**
   * When the page stops taking orders. Required in practice for a live page —
   * enforced in the service, not here, so a draft can be saved before the
   * season's dates are agreed.
   *
   * Always stored as the END of a Bangladesh day, so "paid through the 31st"
   * means the page takes orders all day on the 31st. Same convention as
   * `Shop.subscription.expiresAt`.
   */
  expiresAt: { type: Date, default: null },
  graceDays: { type: Number, default: 0, min: 0 },

  renewedAt: { type: Date },
  renewCount: { type: Number, default: 0 },

  publishedAt: { type: Date },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
}, {
  timestamps: true,
});

// The shop's own list, in its panel.
landingPageSchema.index({ shop: 1, status: 1, createdAt: -1 });

// The admin's renewal worklist — "expiring this week", "expired" — and the
// nightly sweep. Same shape as `Shop.subscription.expiresAt`'s index, and for
// the same reason: it ranges across every document with no owner predicate.
landingPageSchema.index({ status: 1, expiresAt: 1 });

/** Offers a customer may actually pick, in display order. */
landingPageSchema.methods.activeOffers = function activeOffers() {
  return (this.offers || [])
    .filter((o) => o.isActive)
    .sort((a, b) => (a.sortOrder - b.sortOrder) || String(a.key).localeCompare(String(b.key)));
};

/**
 * Resolve one offer by the key the form posted.
 *
 * The ONLY way an offer's price may reach an order (I-13). A price arriving from
 * the client is ignored; this is what it is ignored in favour of.
 */
landingPageSchema.methods.findOffer = function findOffer(key) {
  return (this.offers || []).find((o) => o.key === String(key || '').toLowerCase() && o.isActive) || null;
};

/** Resolve one delivery zone by key. Same rule as `findOffer`. */
landingPageSchema.methods.findZone = function findZone(key) {
  return (this.delivery?.zones || []).find((z) => z.key === String(key || '') && z.isActive) || null;
};

/** Zones a customer may actually pick. */
landingPageSchema.methods.activeZones = function activeZones() {
  return (this.delivery?.zones || []).filter((z) => z.isActive !== false);
};

/**
 * What one zone charges for a given goods subtotal.
 *
 * The threshold is compared against the subtotal AFTER the coupon, and that is
 * a real decision rather than an accident: a ৳1000 threshold that a ৳200 coupon
 * can be stacked under means the shop ships ৳800 of goods for free while the
 * page promised otherwise. Whichever way it went it had to be written down, and
 * "free delivery on what you actually pay" is the reading a customer would give
 * it if asked.
 *
 * Returns the charge and WHY it is what it is, so the order can record that
 * delivery was free by threshold rather than because the zone happened to be
 * ৳0 — two very different facts a month later.
 */
landingPageSchema.methods.quoteDelivery = function quoteDelivery(zone, payableSubtotal) {
  const charge = Math.max(0, Number(zone?.charge) || 0);
  const threshold = Math.max(0, Number(zone?.freeAbove) || 0);

  if (threshold > 0 && Number(payableSubtotal) >= threshold) {
    return { charge: 0, isFree: true, freeAbove: threshold };
  }
  return { charge, isFree: charge === 0, freeAbove: threshold };
};

/**
 * Resolve one coupon by the code the customer typed.
 *
 * Case- and space-insensitive, because the code is read off an advertisement
 * and retyped on a phone. Returns null for an unknown, inactive or exhausted
 * code — the caller may not tell those three apart in what it says back, since
 * "this code is used up" tells a stranger the code is real.
 */
landingPageSchema.methods.findCoupon = function findCoupon(code) {
  const needle = String(code || '').trim().toUpperCase();
  if (!needle) return null;

  const found = (this.coupons || []).find((c) => c.code === needle && c.isActive !== false);
  if (!found) return null;
  if (found.usageLimit > 0 && found.usedCount >= found.usageLimit) return null;
  return found;
};

/**
 * What a coupon takes off a given subtotal — or why it does not apply.
 *
 * Never returns more than the subtotal. A ৳500 flat code on a ৳300 order
 * discounts ৳300, not ৳500: delivery is a courier's cost and a discount code
 * must not be able to eat into it, let alone turn an order into a payout.
 */
landingPageSchema.methods.quoteCoupon = function quoteCoupon(coupon, subtotal) {
  const base = Math.max(0, Number(subtotal) || 0);
  if (!coupon) return { amount: 0, reason: 'unknown' };

  if (coupon.minSubtotal > 0 && base < coupon.minSubtotal) {
    return { amount: 0, reason: 'min-subtotal', minSubtotal: coupon.minSubtotal };
  }

  let amount = coupon.type === 'percent'
    ? Math.round((base * (Number(coupon.value) || 0)) / 100)
    : Math.round(Number(coupon.value) || 0);

  if (coupon.type === 'percent' && coupon.maxDiscount > 0) {
    amount = Math.min(amount, coupon.maxDiscount);
  }

  return { amount: Math.max(0, Math.min(amount, base)), reason: null };
};

/** Payment methods this page offers, always with at least `cod`. */
landingPageSchema.methods.paymentMethods = function paymentMethods() {
  const methods = (this.payment?.methods || []).filter((m) => m === 'cod' || m === 'advance');
  return methods.length ? [...new Set(methods)] : ['cod'];
};

/**
 * How much must be paid up front for this order.
 *
 * Zero is a legitimate answer and is what turns an `advance` selection back
 * into COD: on a free-delivery order in `delivery` mode there is nothing to
 * send, and demanding a TrxID for ৳0 would lose the order over a form field.
 */
landingPageSchema.methods.advanceDue = function advanceDue(deliveryCharge) {
  if (!this.paymentMethods().includes('advance')) return 0;

  const mode = this.payment?.advanceMode || 'delivery';
  const amount = mode === 'fixed'
    ? Number(this.payment?.advanceAmount) || 0
    : Number(deliveryCharge) || 0;

  return Math.max(0, Math.round(amount));
};

const LandingPage = mongoose.model('LandingPage', landingPageSchema);

module.exports = LandingPage;
module.exports.PAGE_STATUS = PAGE_STATUS;
module.exports.HTML_HISTORY_LIMIT = HTML_HISTORY_LIMIT;
module.exports.EXPIRY_WARNING_DAYS = EXPIRY_WARNING_DAYS;
