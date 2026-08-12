/**
 * PlatformSetting — the operator's own knobs. Exactly one document.
 *
 * These were constants (`TRIAL_PERIOD_DAYS`, `SUBSCRIPTION_PRICE`) and
 * hard-coded arrays in the admin frontend. Changing a trial length or an SMS
 * tier should not need a deploy, and the SMS tiers in particular have to live
 * where the negotiated per-shop rate can be applied to them.
 *
 * Per-shop negotiated figures live on `Shop.billing` and always win. These are
 * only the defaults a NEW shop starts from and the values the panel prefills.
 */

const mongoose = require('mongoose');
const { TRIAL_PERIOD_DAYS, SUBSCRIPTION_PRICE, SUBSCRIPTION_WARNING_DAYS } = require('../config/constants');

const smsTierSchema = new mongoose.Schema({
  quantity: { type: Number, required: true, min: 1 },
  // Price at the platform's standard rate. A shop with a negotiated
  // `billing.smsUnitPrice` sees quantity × its own rate instead.
  price: { type: Number, required: true, min: 0 },
  label: { type: String },
  badge: { type: String },
}, { _id: false });

const platformSettingSchema = new mongoose.Schema({
  // Singleton guard: one document, always. Every read goes through
  // `PlatformSetting.current()`, which upserts on first use.
  key: {
    type: String,
    default: 'platform',
    unique: true,
    immutable: true,
  },

  defaultTrialDays: { type: Number, default: TRIAL_PERIOD_DAYS, min: 0 },
  defaultMonthlyPrice: { type: Number, default: SUBSCRIPTION_PRICE, min: 0 },
  defaultSmsUnitPrice: { type: Number, default: 0.4, min: 0 },
  // How many days before expiry the shop starts seeing the banner.
  warningDays: { type: Number, default: SUBSCRIPTION_WARNING_DAYS, min: 0 },

  smsTiers: {
    type: [smsTierSchema],
    default: () => ([
      { quantity: 100, price: 50, label: '১০০ এসএমএস' },
      { quantity: 250, price: 100, label: '২৫০ এসএমএস', badge: 'Popular' },
      { quantity: 500, price: 200, label: '৫০০ এসএমএস' },
      { quantity: 1000, price: 400, label: '১০০০ এসএমএস', badge: 'Best value' },
      { quantity: 2500, price: 1000, label: '২৫০০ এসএমএস' },
      { quantity: 5000, price: 2000, label: '৫০০০ এসএমএস' },
    ]),
  },

  supportPhone: { type: String, default: '01757995016' },

  // Phase 2. While this is 'none' the owner-facing renew flow is a "call us"
  // card and no webhook route is mounted. Switching it on is a config change:
  // manual entry and a gateway callback already funnel through the same
  // service method. See SUBSCRIPTION_PLAN.md §7.
  billingProvider: {
    type: String,
    enum: ['none', 'bkash', 'sslcommerz', 'shurjopay'],
    default: 'none',
  },

  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
}, {
  timestamps: true,
});

/**
 * The settings document, created on first read.
 *
 * Callers must tolerate this failing — billing defaults are a convenience, and
 * a Mongo hiccup here must never be what stops a shop from logging in. Every
 * caller in this codebase passes the result through `?.` with a constant
 * fallback for that reason.
 */
platformSettingSchema.statics.current = async function current() {
  return this.findOneAndUpdate(
    { key: 'platform' },
    { $setOnInsert: { key: 'platform' } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

const PlatformSetting = mongoose.model('PlatformSetting', platformSettingSchema);

module.exports = PlatformSetting;
