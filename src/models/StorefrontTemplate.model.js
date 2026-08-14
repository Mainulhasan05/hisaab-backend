/**
 * StorefrontTemplate — one design a shop's public website can be rendered in.
 *
 * PLATFORM-OWNED. Shops never create, edit or delete these; they are granted a
 * subset (`Shop.storefront.allowedTemplates`) and pick one of that subset. See
 * ECOMMERCE_PLAN.md §4.
 *
 * ── WHAT A TEMPLATE IS, AND WHY IT IS A DOCUMENT AND NOT A FOLDER ───────────
 *
 * The rendering itself is React and lives in the frontend, keyed by `key`. What
 * lives here is everything the PLATFORM needs to decide about a template
 * without a deploy: whether it is offerable, who may see it, what it is called
 * in Bengali, which slots it fills, and what its theme defaults are.
 *
 * That split is the point. Retiring a template, renaming it, reordering the
 * gallery or granting it to a shop are all admin actions on a Tuesday
 * afternoon. Changing what it LOOKS like is a code change with a review and a
 * build. Putting the first set in the database and the second set in the repo
 * keeps each on the cadence it deserves.
 *
 * ── `key` IS IMMUTABLE ONCE PUBLISHED ───────────────────────────────────────
 *
 * `Storefront.draft.template` and `Storefront.published.template` store this
 * string, and `Shop.storefront.allowedTemplates` stores it too. Renaming a
 * published key orphans every one of those references at once, and the failure
 * is silent: the shop's site renders nothing and the picker shows their
 * template as missing. The service refuses the rename; this comment is why.
 *
 * ── `retired` IS NOT `deleted` ──────────────────────────────────────────────
 *
 * A retired template is invisible in the grant picker and cannot be newly
 * applied, but it keeps rendering for every shop already on it. Same invariant
 * as the grant list itself (Shop.model.js `storefront.allowedTemplates`): a
 * platform-side tidy-up must never take a shop's website down. Deleting the
 * document is not offered at all for the same reason.
 */

const mongoose = require('mongoose');

/**
 * The slot vocabulary — ECOMMERCE_PLAN.md §4.3.
 *
 * Shared by EVERY template, which is the whole architectural claim: content is
 * stored against these names, not against a template's own layout, so
 * switching templates re-renders the same content in a new skin and loses
 * nothing.
 *
 * A slot only one template understands is content a shop loses when it switches
 * away. So widening this list is a decision for all templates at once — add the
 * name here, teach every template to render it or ignore it, and only then use
 * it. Never add a slot inside a single template.
 */
const SLOT_KEYS = Object.freeze([
  'identity',     // logo, shop name, tagline, short about
  'hero',         // slides[] + optional aside panel
  'promo',        // strip text, coupon hint
  'collections',  // ordered category / tag / virtual rails
  'featured',     // auto — isFeaturedOnline
  'newArrivals',  // auto — newest online products
  'topSelling',   // auto — totalSold desc (indexed already)
  'trust',        // COD / delivery / return / warranty badges
  'contact',      // phone, WhatsApp, Messenger, address, hours
  'policies',     // delivery / return / privacy — seeded in Bengali
  'social',       // fb, instagram, youtube, tiktok
  'seo',          // title, description, og image
]);

const TEMPLATE_STATUS = Object.freeze(['draft', 'published', 'retired']);

/**
 * A curated colour set a shop may pick without a colour wheel.
 *
 * Curated rather than free-form because BACKLOG.md B.3 §4 already flags likely
 * WCAG AA failures in the app's own palette, and handing a colour picker to
 * every shop on the platform reproduces that problem once per shop. Each
 * palette here is contrast-checked when it is authored; the shop chooses
 * between whole palettes, not between individual colours.
 */
const paletteSchema = new mongoose.Schema({
  key: { type: String, required: true },
  name: { type: String, required: true },
  nameBn: { type: String },
  tokens: { type: mongoose.Schema.Types.Mixed, required: true },
}, { _id: false });

const storefrontTemplateSchema = new mongoose.Schema({
  /**
   * Stable identifier — 'bazar', 'poshak', 'jontro'. Lowercase ASCII.
   *
   * This is what the frontend registry keys its React component off, what the
   * grant list stores, and what a live Storefront points at. See the header on
   * why it must not change after publication.
   */
  key: {
    type: String,
    required: [true, 'টেমপ্লেট কী দিন'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^[a-z][a-z0-9-]{1,31}$/, 'টেমপ্লেট কী ইংরেজি ছোট হাতের অক্ষর, সংখ্যা ও হাইফেন দিয়ে লিখুন'],
  },
  name: {
    type: String,
    required: [true, 'টেমপ্লেটের নাম দিন'],
    trim: true,
    maxlength: [80, 'নাম ৮০ অক্ষরের বেশি হতে পারবে না'],
  },
  nameBn: {
    type: String,
    required: [true, 'টেমপ্লেটের বাংলা নাম দিন'],
    trim: true,
    maxlength: [80, 'নাম ৮০ অক্ষরের বেশি হতে পারবে না'],
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'বিবরণ ৫০০ অক্ষরের বেশি হতে পারবে না'],
  },
  descriptionBn: {
    type: String,
    trim: true,
    maxlength: [500, 'বিবরণ ৫০০ অক্ষরের বেশি হতে পারবে না'],
  },

  /**
   * Which kind of shop this is drawn for — matches a `ShopCategory` loosely.
   *
   * Advisory only. It sorts and filters the gallery and nothing more: a
   * hardware shop that wants the fashion template gets the fashion template.
   * Enforcing it would mean the platform telling a shopkeeper what their shop
   * looks like, which is not a fight worth having and not one we would win.
   */
  vertical: {
    type: String,
    trim: true,
    default: 'general',
  },

  // R2 URLs. `thumbnail` is the gallery tile; `previewUrl` opens a real demo
  // storefront so the shop sees the template with content in it rather than a
  // still. A screenshot sells a template badly.
  thumbnail: { type: String },
  previewUrl: { type: String },

  /**
   * Which slots this template renders. Must be a subset of SLOT_KEYS.
   *
   * A template MAY render fewer slots than exist — `khabar` has no use for
   * `newArrivals`. Content for an unrendered slot is still stored and is
   * restored the moment the shop switches to a template that renders it, which
   * is what makes switching lossless in both directions rather than just
   * forward.
   */
  slots: {
    type: [String],
    default: () => [...SLOT_KEYS],
    validate: {
      validator: (arr) => Array.isArray(arr) && arr.every((s) => SLOT_KEYS.includes(s)),
      message: 'অজানা স্লট — SLOT_KEYS দেখুন',
    },
  },

  // Theme token defaults. The shop's overrides are merged over these at render
  // time, so a token the shop never touched follows the template when the
  // template is updated.
  themeDefaults: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({}),
  },
  palettes: {
    type: [paletteSchema],
    default: () => [],
  },

  /**
   * Capabilities a shop must hold before this template may be granted.
   *
   * Always includes `storefront` in practice. Present as a field rather than
   * hard-coded so a future template that needs, say, `packaging` (a grocery
   * template that shows ৫০০ গ্রাম pack pricing) can say so without a code
   * change. Validated against the FEATURES registry in the service, not here —
   * the model must keep accepting anything already stored, for the same reason
   * `Product.unit`'s enum is the full registry (Product.model.js:310).
   */
  minFeatures: {
    type: [String],
    default: () => ['storefront'],
  },

  status: {
    type: String,
    enum: TEMPLATE_STATUS,
    default: 'draft',
  },
  // Gallery order. Low first; ties break on `key` so the list is stable.
  sortOrder: {
    type: Number,
    default: 100,
  },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  publishedAt: { type: Date },
  retiredAt: { type: Date },
}, {
  timestamps: true,
});

// The two reads that exist: the admin's full list, and the offerable list the
// grant picker and the shop's gallery both draw from.
storefrontTemplateSchema.index({ status: 1, sortOrder: 1, key: 1 });

/** Templates an admin may newly grant, and a shop may newly apply. */
storefrontTemplateSchema.statics.offerable = function () {
  return this.find({ status: 'published' }).sort({ sortOrder: 1, key: 1 });
};

const StorefrontTemplate = mongoose.model('StorefrontTemplate', storefrontTemplateSchema);

module.exports = StorefrontTemplate;
module.exports.SLOT_KEYS = SLOT_KEYS;
module.exports.TEMPLATE_STATUS = TEMPLATE_STATUS;
