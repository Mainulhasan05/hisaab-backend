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

  // ── Image storage (R2 pool) ───────────────────────────────────────────────
  // See R2_STORAGE_PLAN.md. Per-shop overrides live on `Shop.storage` and
  // always win, exactly as `Shop.billing` overrides the figures above.

  // What a shop gets when `Shop.storage.quotaMb` is null. Raising this lifts
  // every non-overridden shop at once, which is the point of the null default.
  defaultStorageQuotaMb: { type: Number, default: 100, min: 0 },

  /**
   * How `storage.service` picks a bucket for the next upload.
   *
   *   least_used  — lowest (used+reserved)/capacity ratio. Identical to
   *                 round-robin while every account is the same size, and still
   *                 correct once one of them is upgraded.
   *   round_robin — strict rotation by last-allocated cursor.
   *
   * Default is least_used; round_robin is kept because it is the behaviour
   * people expect to be able to ask for, not because it is better.
   */
  storageStrategy: {
    type: String,
    enum: ['least_used', 'round_robin'],
    default: 'least_used',
  },

  // Where the shop-facing "storage almost full" banner starts.
  storageWarnPercent: { type: Number, default: 80, min: 1, max: 99 },

  // How long an image sits at refCount 0 before it is actually deleted. The
  // grace exists so an accidental detach is recoverable.
  orphanGraceDays: { type: Number, default: 7, min: 0 },

  // Round-robin cursor. Meaningless under least_used; kept here rather than on
  // R2Account so allocation never has to write to two collections.
  storageRoundRobinCursor: { type: Number, default: 0 },

  // ── Platform media library ────────────────────────────────────────────────
  // The admin-only media library. See MEDIA_GALLERY_PLAN.md §5 and §6.3. These
  // bytes belong to no shop, so `defaultStorageQuotaMb` does not bound them, and
  // without a ceiling here the pool fills up without anyone having decided that
  // it should.

  /**
   * The whole platform library's allowance, across every folder.
   *
   * A placeholder, honestly: the right number depends on how much the library is
   * actually used, which is measurable after a few months and guesswork before
   * (MEDIA_GALLERY_PLAN.md §12.2). It is here rather than in code so raising it
   * is a settings change, not a deploy.
   */
  platformMediaQuotaMb: { type: Number, default: 2048, min: 0 },

  /**
   * Per-video size cap. A PRODUCT decision, not a technical one.
   *
   * 20MB on a 3G phone is roughly a 40-second wait before anything plays, and
   * these files are served to the public. There is no transcoding on this stack
   * (MEDIA_GALLERY_PLAN.md §6.1), so the cap is the only lever there is.
   */
  platformVideoMaxMb: { type: Number, default: 20, min: 1 },

  /**
   * What the library currently holds. The counterpart of `Shop.storage.usedBytes`
   * for the platform's own tenant.
   *
   * Stored rather than aggregated because it is the field the upload gate does
   * its compare-and-swap against: the allowance has to be re-checked against a
   * LIVE value inside the same round trip that increments it, exactly as
   * `media.service._chargeShopUsage` does for a shop. An aggregation over the
   * whole collection cannot be part of an atomic update, and reading it first
   * reopens the race it exists to close.
   *
   * Drift is repaired by `recalculatePlatformMediaUsage()`, the same way
   * `recalculateShopStorage` repairs the shop-side counters.
   */
  platformMediaUsedBytes: { type: Number, default: 0, min: 0 },
  platformMediaFileCount: { type: Number, default: 0, min: 0 },

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
