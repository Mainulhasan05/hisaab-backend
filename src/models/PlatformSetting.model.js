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
const {
  TRIAL_PERIOD_DAYS,
  SUBSCRIPTION_PRICE,
  SUBSCRIPTION_WARNING_DAYS,
  AI_DAILY_MESSAGE_LIMIT,
} = require('../config/constants');

/**
 * One SMS pack, as offered in the allocation sheet.
 *
 * `price` is the pack's OWN price, not `quantity × defaultSmsUnitPrice`. That
 * distinction is the whole point of the tier list: a ladder where every rung
 * works out to the same per-SMS rate is a quantity picker, not a price list,
 * and the "Best value" badge on its top rung is decoration. The admin panel
 * prints the derived ৳/SMS on every tile so a flat ladder is visible as one.
 *
 * A shop with a negotiated `billing.smsUnitPrice` is quoted `quantity × its own
 * rate` instead — a bargained rate wins over the list price, which is the same
 * rule `Shop.billing` has with every other figure here.
 */
const smsTierSchema = new mongoose.Schema({
  quantity: { type: Number, required: true, min: 1 },
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

  /**
   * What one SMS costs the PLATFORM at the gateway, in taka.
   *
   * Not a price — a cost. It exists so the allocation sheet can show the margin
   * on a top-up before it is recorded, and refuse quietly-below-cost deals. It
   * was previously nowhere in the system, so every negotiated rate was agreed
   * against a number held in the operator's head.
   *
   * `null` means "not told yet", which the panel renders as an explicit prompt
   * rather than as a 100% margin. A `0` default would have been the lie.
   */
  platformSmsCost: { type: Number, default: null, min: 0 },

  /**
   * The list price ladder.
   *
   * Every rung here works out to a LOWER ৳/SMS than the one above it — that is
   * what makes it a ladder rather than a quantity picker. The previous default
   * priced 250, 500, 1000, 2500 and 5000 at exactly ৳0.40 each, which made the
   * "Best value" badge on the top rung untrue and gave a shop no reason to buy
   * more than the smallest pack that covered the month.
   *
   * ৳0.40 stays the anchor at 1000 so `defaultSmsUnitPrice` and this list agree
   * about what "the standard rate" means.
   */
  smsTiers: {
    type: [smsTierSchema],
    default: () => ([
      { quantity: 100, price: 55, label: '১০০ এসএমএস' },
      { quantity: 250, price: 120, label: '২৫০ এসএমএস', badge: 'Popular' },
      { quantity: 500, price: 220, label: '৫০০ এসএমএস' },
      { quantity: 1000, price: 400, label: '১০০০ এসএমএস' },
      { quantity: 2500, price: 900, label: '২৫০০ এসএমএস' },
      { quantity: 5000, price: 1650, label: '৫০০০ এসএমএস', badge: 'Best value' },
    ]),
  },

  supportPhone: { type: String, default: '01757995016' },

  /**
   * Should registration still pre-create the shop-type category taxonomy?
   *
   * Defaults to FALSE, which is a deliberate behaviour change. It used to be
   * unconditional, and the numbers are why it stopped: a grocery signup was
   * handed 85 categories before it had a single product, cosmetics 78, cloth
   * 63 — and roughly eight in ten of those rows never held a product for the
   * life of the account. The shopkeeper's first screen after a four-step signup
   * was a REQUIRED dropdown listing sixty-three names they had not chosen and
   * mostly did not stock.
   *
   * The same lists are still offered, from the "প্রস্তাবিত ক্যাটাগরি" panel —
   * parents first, nothing pre-ticked, and only once the shop has seen the app.
   * See `category.service.getSuggestions`.
   *
   * It is a setting rather than a deleted line so that if activation moves the
   * wrong way this is one boolean in the admin console, not a redeploy. The
   * seeder itself is untouched and still passes through `findOrCreateByName`,
   * so switching it back on is safe for a shop that has already added its own.
   */
  autoSeedCategoriesOnSignup: { type: Boolean, default: false },

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

  // ── AI (Gemini pool) ──────────────────────────────────────────────────────
  // See AI_EXPENSE_PLAN.md. Per-shop overrides live on `Shop.ai` and always
  // win, exactly as `Shop.billing` and `Shop.storage` override the figures
  // above.

  /**
   * How many AI messages ONE BRANCH may send per Bangladesh day when the shop
   * has no negotiated figure of its own.
   *
   * Branch-wise, not shop-wise: the counter is keyed `{shop, branch}` (see
   * ShopAiUsage.model.js), so a three-branch shop on the default gets five
   * messages at each counter rather than five shared between them. A shared
   * pool would mean the busiest branch spends the quiet branches' allowance
   * before they open, and neither of them can see why.
   *
   * `Shop.ai.dailyMessageLimit` is `null` by default so raising this lifts
   * every shop that has not been individually negotiated — the same
   * relationship `defaultStorageQuotaMb` has with `Shop.storage.quotaMb`.
   */
  defaultAiDailyMessageLimit: { type: Number, default: AI_DAILY_MESSAGE_LIMIT, min: 0 },

  /**
   * How `gemini.service` picks a key for the next AI call.
   *
   *   least_used  — fewest requests today. Identical to round-robin while every
   *                 account has the same daily limit, and still correct once one
   *                 of them is upgraded.
   *   round_robin — strict rotation by least-recently-used.
   *
   * Deliberately the same enum, the same default and the same reasoning as
   * `storageStrategy` above: least_used is better, round_robin is kept because
   * it is the behaviour people expect to be able to ask for.
   */
  geminiStrategy: {
    type: String,
    enum: ['least_used', 'round_robin'],
    default: 'least_used',
  },

  /**
   * Model override for the whole pool. `null` = `GEMINI_DEFAULT_MODEL`.
   *
   * Here rather than hardcoded in the service so moving to a newer flash model
   * is a settings change and not a deploy — the backend deploy is manual, and
   * a model retirement should not need one.
   */
  geminiModel: { type: String, default: null },

  // ── SMS gateway routing ───────────────────────────────────────────────────
  // Which gateway sends, and who catches it when that one refuses. Platform-wide
  // on purpose: every shop sends through the same account, so this is an
  // operator decision, not a per-shop one. The resolver that reads these
  // (services/sms/routing.js) is written so a per-shop override can be layered
  // on later without the send paths changing.
  //
  // Credentials are NOT here. They stay in env, where a settings screen cannot
  // leak them and a database dump does not contain them; these fields only
  // choose between gateways that env has already configured.

  /**
   * The gateway that sends first. `null` = whatever `SMS_DEFAULT_PROVIDER` says.
   *
   * Null rather than a literal 'mimsms' default so that the env var stays the
   * single source of truth until an operator deliberately overrides it. A stored
   * default would silently win over an env change during a gateway migration —
   * exactly when someone is relying on the env change taking effect.
   */
  smsPrimaryProvider: {
    type: String,
    enum: ['mimsms', 'automas', null],
    default: null,
  },

  /**
   * The gateway tried when the primary fails in a way another gateway could fix.
   *
   * Must differ from the primary; the service validates that on write. A backup
   * whose credentials are missing is treated as no backup at all rather than as
   * a backup that fails on every message.
   */
  smsFailoverProvider: {
    type: String,
    enum: ['mimsms', 'automas', null],
    default: null,
  },

  /**
   * Is failover armed?
   *
   * Defaults to FALSE so that adding this feature changes nothing about how the
   * platform sends until someone opts in. Turning it on doubles the number of
   * gateways that can be charged for one message, which is a decision worth
   * making explicitly rather than inheriting from a deploy.
   */
  smsFailoverEnabled: { type: Boolean, default: false },

  /**
   * What ONE segment costs the platform at each gateway, in taka.
   *
   * `platformSmsCost` above is the single-rate version of this and remains the
   * fallback for any provider not priced here — so a platform that has only ever
   * used one gateway keeps working untouched.
   *
   * Per-provider rates exist because failover makes the blended cost real: two
   * gateways at different rates mean the cost of a month's traffic depends on
   * how much of it the primary refused. A single figure cannot express that, and
   * quietly reports the wrong margin the first time failover fires in anger.
   *
   * `null` for a provider means "not told yet", and it propagates: a send on an
   * unpriced gateway records a null cost rather than a zero one, so the earnings
   * report can say "unpriced" instead of claiming a 100% margin.
   */
  smsProviderCost: {
    mimsms: { type: Number, default: null, min: 0 },
    automas: { type: Number, default: null, min: 0 },
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
