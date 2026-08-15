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

const LandingPage = mongoose.model('LandingPage', landingPageSchema);

module.exports = LandingPage;
module.exports.PAGE_STATUS = PAGE_STATUS;
module.exports.HTML_HISTORY_LIMIT = HTML_HISTORY_LIMIT;
module.exports.EXPIRY_WARNING_DAYS = EXPIRY_WARNING_DAYS;
