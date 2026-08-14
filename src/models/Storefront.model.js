/**
 * Storefront — one shop's public website.
 *
 * One document per shop, created lazily the first time the shop opens the
 * /online panel. See ECOMMERCE_PLAN.md §4 and §5.2.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DRAFT AND PUBLISHED ARE TWO COPIES OF THE SAME SHAPE, AND THAT IS DELIBERATE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The editor writes `draft`. The public page reads `published` and nothing
 * else. "প্রকাশ করুন" copies one onto the other and pushes the old one onto
 * `history`.
 *
 * The alternative — edit live, no staging — was rejected because a shopkeeper
 * rewriting their hero at 9pm would be doing it in front of customers, and
 * because there would be no rollback. Two copies of one schema costs a few
 * hundred bytes per shop and buys instant, deploy-free revert.
 *
 * ── WHAT IS *NOT* STAGED: PRODUCTS ──────────────────────────────────────────
 *
 * A product marked `isAvailableOnline` appears on the live site immediately,
 * with no publish step. That is the requirement ("immediately their online
 * products will be visible there") and it is also the right split: a price
 * correction at 9pm must not require the shopkeeper to understand what
 * "publish" means, and editing the hero must not be able to take yesterday's
 * price list live by accident.
 *
 * So: PRESENTATION is staged, CATALOGUE is live. If you find yourself adding a
 * product id to `presentationSchema`, that is the line being crossed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `blocks` IS Mixed AND NOT A TYPED SUB-SCHEMA
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `blocks` is keyed by slot name (StorefrontTemplate SLOT_KEYS) and each slot's
 * value is shaped by what that slot means. Typing all twelve here would mean a
 * schema migration every time a slot gains a field — on a document whose whole
 * job is to be edited freely — and Mongoose would strip anything not yet
 * declared, silently, on the next save. That is the exact failure the
 * `variants` array had (Product.model.js:446): an undeclared path dropped on
 * every write, invisible until something read it back.
 *
 * Validation lives in the service, against the active template's `slots`, where
 * the template is actually known. The model's job here is to store what it is
 * given without losing any of it.
 */

const mongoose = require('mongoose');

const STOREFRONT_STATUS = Object.freeze(['unpublished', 'live', 'paused']);

/** How many published versions to keep for rollback. */
const HISTORY_LIMIT = 10;

/**
 * The staged payload. Identical shape in `draft`, `published` and each
 * `history` entry — one schema, three uses, so a field can never exist in the
 * draft and be lost on publish.
 */
const presentationSchema = new mongoose.Schema({
  // A StorefrontTemplate `key`. Validated against the shop's grant list on
  // APPLY, never on read — see the invariant on Shop.storefront.allowedTemplates.
  template: { type: String, trim: true, default: null },
  // Theme token overrides, merged over the template's `themeDefaults`. Sparse
  // by design: a token the shop never touched follows the template forever.
  theme: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  // Slot key -> content. See the header on why this is Mixed.
  blocks: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  // Ordered nav entries: [{ type: 'category'|'offers'|'page'|'link', ... }].
  nav: { type: [mongoose.Schema.Types.Mixed], default: () => [] },
  seo: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
}, { _id: false });

const publishedSchema = new mongoose.Schema({
  template: { type: String, trim: true, default: null },
  theme: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  blocks: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  nav: { type: [mongoose.Schema.Types.Mixed], default: () => [] },
  seo: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  version: { type: Number, default: 0 },
  publishedAt: { type: Date },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { _id: false });

const storefrontSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    unique: true,
  },

  /**
   * The FULFILLING branch. `null` for single-branch shops, which is nearly all
   * of them, and which makes every downstream query collapse to exactly the
   * query a single-branch shop already issues (I-1).
   *
   * It is stored rather than derived because online stock, online prices and
   * eventually online orders all have to resolve to ONE branch's catalogue: a
   * customer must not be shown stock that branch B holds and branch A has to
   * ship. Routing by delivery zone is a later phase (§18.2); the field shape is
   * settled now so that phase is not a migration.
   */
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null,
  },

  /**
   * `unpublished` — never published; the public page 404s.
   * `live`        — serving.
   * `paused`      — deliberately dark.
   *
   * Distinct from `Shop.features.storefront`, which is the platform's switch.
   * This is the shop's own, plus the platform's kill switch (`pausedBy` says
   * which). A shop going on Eid holiday pauses; an admin taking a storefront
   * down for abuse also pauses, and the shop cannot clear that one.
   */
  status: {
    type: String,
    enum: STOREFRONT_STATUS,
    default: 'unpublished',
  },
  // Set when an ADMIN paused it. Non-null means the shop may not un-pause —
  // otherwise the kill switch is a suggestion.
  pausedByAdmin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null,
  },
  pauseReason: { type: String, maxlength: 500 },

  draft: { type: presentationSchema, default: () => ({}) },
  published: { type: publishedSchema, default: () => ({}) },
  history: { type: [publishedSchema], default: () => [] },

  /**
   * Delivery zones. Seeded with the two every Bangladeshi shop uses
   * (ঢাকার ভিতরে / ঢাকার বাইরে) so a shop that configures nothing still has a
   * working checkout when P2 lands.
   *
   * Inert until `features.onlineOrders`. Stored now because the storefront
   * shows delivery information ("ঢাকায় ৳৬০, সারাদেশে ৳১২০") on a catalogue
   * site too, where it is one of the two things a customer actually wants to
   * know before they call.
   */
  delivery: {
    zones: {
      type: [{
        key: { type: String, required: true, trim: true },
        name: { type: String, required: true, trim: true },
        nameBn: { type: String, trim: true },
        charge: { type: Number, default: 0, min: 0 },
        // 0 = no free-delivery threshold.
        freeAbove: { type: Number, default: 0, min: 0 },
        etaDaysMin: { type: Number, default: 1, min: 0 },
        etaDaysMax: { type: Number, default: 3, min: 0 },
        isActive: { type: Boolean, default: true },
      }],
      default: () => ([
        { key: 'inside-dhaka', name: 'Inside Dhaka', nameBn: 'ঢাকার ভিতরে', charge: 60, etaDaysMin: 1, etaDaysMax: 2 },
        { key: 'outside-dhaka', name: 'Outside Dhaka', nameBn: 'ঢাকার বাইরে', charge: 120, etaDaysMin: 2, etaDaysMax: 4 },
      ]),
    },
    pickupEnabled: { type: Boolean, default: false },
  },

  /**
   * Out-of-stock behaviour on the public catalogue.
   *
   * 'hide' is the default because nothing is reserved for an unconfirmed order
   * (ECOMMERCE_PLAN.md §6.3), so an out-of-stock product that stays visible is
   * an order the shop will have to cancel. 'show' exists for shops that restock
   * predictably and would rather keep the page full.
   */
  outOfStockBehaviour: {
    type: String,
    enum: ['hide', 'show'],
    default: 'hide',
  },

  notifications: {
    // Free, instant, and reaches a phone already in the owner's hand. Defaults
    // ON — but the service only sends when a TelegramLink actually exists, so
    // this being true for a shop that never linked costs nothing.
    telegram: { type: Boolean, default: true },
    // Both default FALSE. SMS is metered and billed per shop (SMSQuota,
    // billing.smsUnitPrice); a default that silently spends a shop's money on
    // every order is how you earn an angry phone call. The settings screen
    // shows the per-message price next to each toggle.
    smsOnConfirm: { type: Boolean, default: false },
    smsOnShip: { type: Boolean, default: false },
  },

  // The shop's OWN marketing ids, not the platform's. Kept separate from the
  // platform-wide Pixel in the frontend env so a shop's ads report on the
  // shop's own dataset.
  analytics: {
    fbPixelId: { type: String, trim: true },
    gaId: { type: String, trim: true },
  },

  // Order numbering prefix. Orders do NOT consume invoice numbers — the
  // invoice is issued by createSale at confirm, so a cancelled order burns an
  // order number and no invoice number. See ECOMMERCE_PLAN.md §6.4.
  orderPrefix: {
    type: String,
    default: 'ORD',
    trim: true,
    uppercase: true,
    maxlength: [8, 'প্রিফিক্স ৮ অক্ষরের বেশি হতে পারবে না'],
  },

  stats: {
    totalOrders: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    lastOrderAt: { type: Date },
  },
}, {
  timestamps: true,
});

// `shop` already carries a unique index from the field definition. The public
// page resolves by Shop.slug and then by shop id, so no second index is needed
// yet; a `domain` lookup index arrives with the Domain collection in P4.

/** Is the public page allowed to serve right now? */
storefrontSchema.methods.isServable = function () {
  return this.status === 'live' && Boolean(this.published?.template);
};

/**
 * Are there unpublished changes?
 *
 * Compared by serialisation rather than field by field: `blocks` is Mixed and
 * arbitrarily deep, so any hand-rolled diff would go stale the first time a
 * slot gained a field. This runs on one document in a panel screen, not on a
 * hot path.
 */
storefrontSchema.methods.hasUnpublishedChanges = function () {
  const pick = (p) => JSON.stringify({
    template: p?.template ?? null,
    theme: p?.theme ?? {},
    blocks: p?.blocks ?? {},
    nav: p?.nav ?? [],
    seo: p?.seo ?? {},
  });
  return pick(this.draft) !== pick(this.published);
};

const Storefront = mongoose.model('Storefront', storefrontSchema);

module.exports = Storefront;
module.exports.STOREFRONT_STATUS = STOREFRONT_STATUS;
module.exports.HISTORY_LIMIT = HISTORY_LIMIT;
