/**
 * Founder alerts — the operator's own notification bus over Telegram.
 *
 * Every method here answers one question: "what does the person who runs this
 * platform want to know the moment it happens?" A new shop signing up, someone
 * logging in, a login from a device nobody has seen before, an admin password
 * being changed.
 *
 * ── THREE RULES THIS FILE IS BUILT AROUND ───────────────────────────────────
 *
 * 1. NOTHING HERE MAY EVER BREAK ITS CALLER. Every entry point is invoked from
 *    a hot path — a login, a registration, a password write. All of them
 *    swallow their own errors and return rather than throw. Callers fire them
 *    without awaiting. An alert that fails is a missing message; an alert that
 *    throws is a shopkeeper who cannot log in.
 *
 * 2. NOISE IS THE FAILURE MODE, NOT SILENCE. "Every login, platform-wide" was
 *    asked for and is delivered, but a channel that buzzes four hundred times a
 *    day gets muted within a week — and the security alerts get muted with it.
 *    So repeat logins by the same user collapse inside a cooldown window
 *    (`_shouldAnnounceLogin`), and the classes that cannot be collapsed are the
 *    ones that must never be missed: new device, failed-password burst, admin
 *    activity.
 *
 * 3. THE MESSAGE MUST BE ACTIONABLE ON A PHONE. Each alert leads with what
 *    happened, then who, then enough context to decide whether to care — shop
 *    name, phone, network, time. An operator reading this on a lock screen
 *    should not need to open the console to know if it matters.
 */

const AdminTelegramLink = require('../models/AdminTelegramLink.model');
const { ALERT_KEYS } = require('../models/AdminTelegramLink.model');
const Shop = require('../models/Shop.model');
const ShopCategory = require('../models/ShopCategory.model');
const telegramService = require('./telegram.service');
const cacheService = require('./cache.service');
const logger = require('../utils/logger.util');
const { escapeHtml, formatMoney, formatCount, formatDate } = require('../utils/telegramFormat.util');
const { getBangladeshTimeStr, toBangladeshDateStr } = require('../utils/bdTime.util');

/**
 * How long the resolved login cooldown is cached.
 *
 * Without this every login on the platform would read the admin link
 * collection just to learn a number that changes maybe twice a year. 60s means
 * a preference change takes effect within a minute, which is well inside what
 * "I just changed a setting" tolerates.
 */
const COOLDOWN_LOOKUP_CACHE_S = 60;

/**
 * Ceiling on the two enrichment reads behind the signup alert (shop type name,
 * platform shop count).
 *
 * Neither is worth waiting on. They decorate a message whose essential content
 * — who registered, from what number — is already in hand, so a struggling
 * database costs a line of detail rather than the alert itself.
 */
const LOOKUP_TIMEOUT_MS = 3000;

/**
 * Plan keys as an operator reads them. Unknown keys fall through to the raw
 * value, so adding a plan degrades to English rather than to a blank line.
 */
const PLAN_LABELS = {
  trial: 'ট্রায়াল',
  paid: 'পেইড',
};

/** Failed-password burst detection. */
const FAILED_LOGIN = {
  /** Failures against one phone before the operator is told. */
  THRESHOLD: 5,
  /**
   * The window failures are counted over.
   *
   * SLIDING, not fixed: each failure re-arms the TTL, so a slow drip of four
   * attempts an hour never trips, while a burst does. That is the right shape —
   * the thing worth reporting is concentration, not the raw count.
   */
  WINDOW_S: 15 * 60,
  /** After firing, stay quiet about this phone for this long. */
  MUTE_AFTER_ALERT_S: 60 * 60,
};

class PlatformNotifyService {
  /**
   * Is anyone listening at all?
   *
   * Checked first in every entry point so that on a deployment with no operator
   * channel — which is every deployment until the founder links one — an alert
   * costs one cached boolean rather than a Telegram round trip.
   */
  async _hasAudience() {
    const cacheKey = 'pnotify:audience';
    const cached = await cacheService.get(cacheKey);
    if (cached !== null && cached !== undefined) return cached === true;

    const count = await AdminTelegramLink.countDocuments({ isActive: true });
    const has = count > 0;
    await cacheService.set(cacheKey, has, COOLDOWN_LOOKUP_CACHE_S);
    return has;
  }

  /**
   * Fire and forget, with the error swallowed at the outermost layer.
   *
   * Every public method funnels through this so rule 1 is enforced in one place
   * rather than depended upon at eight call sites.
   */
  _dispatch(label, work) {
    Promise.resolve()
      .then(work)
      .catch((err) => logger.error(`Platform alert (${label}) failed — ${err.message}`));
  }

  /**
   * The shortest login cooldown any listening operator has configured.
   *
   * The MINIMUM rather than a per-channel value, deliberately. Fan-out happens
   * inside `broadcastToAdmins`, after this gate, so a single number has to serve
   * everyone — and erring towards the most talkative subscriber means nobody
   * silently misses an alert they asked to see. In practice there is one
   * operator and this is simply their setting.
   *
   * Returns 0 when nobody has the login alert on, which the caller reads as
   * "no gate needed" because it will not send anything anyway.
   */
  async _loginCooldownSeconds() {
    const cacheKey = 'pnotify:logincooldown';
    const cached = await cacheService.get(cacheKey);
    if (cached !== null && cached !== undefined) return Number(cached);

    const links = await AdminTelegramLink.find({
      isActive: true,
      [`preferences.${ALERT_KEYS.USER_LOGIN}`]: true,
    })
      .select('preferences.loginCooldownMinutes')
      .lean();

    const minutes = links.length
      ? Math.min(...links.map((l) => Number(l.preferences?.loginCooldownMinutes ?? 60)))
      : 0;

    const seconds = Math.max(0, Math.round(minutes * 60));
    await cacheService.set(cacheKey, seconds, COOLDOWN_LOOKUP_CACHE_S);
    return seconds;
  }

  /**
   * Claim the right to announce this user's login, or decline.
   *
   * `setNX` is the whole mechanism: the first caller inside the window writes
   * the key and gets true, everyone after gets false until it expires. Atomic,
   * so the four PM2 workers cannot each decide they are the first.
   */
  async _shouldAnnounceLogin(userId) {
    const seconds = await this._loginCooldownSeconds();
    if (seconds <= 0) return true;
    return cacheService.setNX(`pnotify:login:${userId}`, 1, seconds);
  }

  /**
   * Drop the cached audience/cooldown answers.
   *
   * Called when a channel is linked, unlinked or its preferences change —
   * otherwise the first minute after connecting Telegram is silent, which reads
   * as "it did not work" on the one screen where the operator is watching for
   * proof that it did.
   */
  async invalidateCache() {
    await Promise.all([
      cacheService.delete('pnotify:audience'),
      cacheService.delete('pnotify:logincooldown'),
    ]).catch(() => {});
  }

  // ────────────────────────────────────────────────────────────────────────
  // Signup
  // ────────────────────────────────────────────────────────────────────────

  /**
   * A brand-new shop finished registration.
   *
   * The highest-value message this bus sends: it is the growth number, arriving
   * before any dashboard could show it, with enough detail to place a welcome
   * call without opening the console.
   */
  newShop({ shop, user, req }) {
    this._dispatch('newShop', async () => {
      if (!(await this._hasAudience())) return;

      const sub = shop?.subscription || {};
      const billing = shop?.billing || {};
      const trialEnd = sub.expiresAt || sub.trialEndsAt || null;

      // Everything the operator would otherwise open the console to look up.
      // Blank fields are dropped rather than printed as "—": registration only
      // requires a name and a phone, so on a minimal signup half of these do
      // not exist and a column of dashes reads as broken data.
      const lines = [
        '🎉 <b>নতুন দোকান রেজিস্টার হয়েছে!</b>',
        '',
        `🏪 <b>${escapeHtml(shop?.name || '—')}</b>`,
      ];

      const typeLabel = await this._shopTypeLabel(shop);
      if (typeLabel) lines.push(`🏷️ ধরন: ${escapeHtml(typeLabel)}`);

      const address = this._shopAddress(shop);
      if (address) lines.push(`📍 ${escapeHtml(address)}`);

      // The shop's own number is worth showing only when it differs from the
      // owner's — on most signups it is defaulted to the owner's phone, and
      // the same number printed twice is noise.
      if (shop?.phone && shop.phone !== user?.phone) {
        lines.push(`☎️ দোকান: <code>${escapeHtml(shop.phone)}</code>`);
      }

      lines.push(
        '',
        `👤 মালিক: <b>${escapeHtml(user?.name || '—')}</b>`,
        `📞 <code>${escapeHtml(user?.phone || '—')}</code>`
      );

      const plan = [];
      if (sub.plan) plan.push(`💳 প্ল্যান: ${escapeHtml(PLAN_LABELS[sub.plan] || sub.plan)}`);
      if (sub.trialDays) plan.push(`🎁 ট্রায়াল: ${formatCount(sub.trialDays)} দিন`);
      if (trialEnd) plan.push(`⏳ মেয়াদ শেষ: ${escapeHtml(formatDate(toBangladeshDateStr(trialEnd)))}`);
      if (billing.monthlyPrice != null) plan.push(`💰 মাসিক: ${formatMoney(billing.monthlyPrice)}`);
      if (plan.length) lines.push('', ...plan);

      const refs = [];
      if (shop?.slug) refs.push(`🔗 <code>${escapeHtml(shop.slug)}</code>`);
      if (shop?._id) refs.push(`🆔 <code>${escapeHtml(String(shop._id))}</code>`);
      if (refs.length) lines.push('', ...refs);

      // The growth number, in the same message. A signup alert that also says
      // "that makes 118" is the whole reason to read it on a lock screen.
      const total = await this._shopCount();
      if (total !== null) lines.push('', `📊 প্ল্যাটফর্মে মোট দোকান: <b>${formatCount(total)}</b>`);

      lines.push('', `🕒 ${getBangladeshTimeStr()} · ${this._origin(req)}`);

      await telegramService.broadcastToAdmins(ALERT_KEYS.NEW_SHOP, lines.join('\n'));
    });
  }

  /**
   * A readable shop type.
   *
   * `Shop.type` stores the category KEY ("grocery", "cloth"), which is what the
   * signup form submitted and not what a human reads. The admin-managed
   * `ShopCategory` rows carry the Bengali name, so it is resolved there and
   * falls back to the raw key — a lookup miss must degrade to a slightly uglier
   * alert, never to a missing one.
   *
   * `shop.shopType` is accepted too because that is the field name the
   * registration payload uses; a caller passing the raw request body instead of
   * the saved document should not silently lose the field.
   */
  async _shopTypeLabel(shop) {
    const key = shop?.type || shop?.shopType || null;
    if (!key) return null;

    try {
      const category = await ShopCategory.findOne({ key })
        .select('name')
        .maxTimeMS(LOOKUP_TIMEOUT_MS)
        .lean();
      return category?.name || key;
    } catch {
      return key;
    }
  }

  /**
   * `Shop.address` is a free-text string. Historic callers and the storefront
   * pass an object, so both shapes are flattened here rather than at four call
   * sites.
   */
  _shopAddress(shop) {
    const address = shop?.address;
    if (!address) return null;
    if (typeof address === 'string') return address.trim() || null;

    return (
      [address.line1, address.area, address.thana, address.district, address.city]
        .filter(Boolean)
        .join(', ') || null
    );
  }

  /** Total shops on the platform, or null if the count is unavailable. */
  async _shopCount() {
    try {
      return await Shop.estimatedDocumentCount({ maxTimeMS: LOOKUP_TIMEOUT_MS });
    } catch {
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Login
  // ────────────────────────────────────────────────────────────────────────

  /**
   * A shop user logged in successfully.
   *
   * Routed to one of two alert classes depending on what the login WAS:
   *
   *   · first-ever login, or login from an unrecognised device → SECURITY,
   *     which is never collapsed and never muted by the cooldown.
   *   · anything else → USER_LOGIN, behind the cooldown.
   *
   * That split is what lets the noisy switch stay on. The routine case is
   * rate-limited into a trickle; the two cases an operator would actually act
   * on jump the queue.
   */
  userLogin({ user, shop, req, isFirstLogin = false, isNewDevice = false }) {
    this._dispatch('userLogin', async () => {
      if (!(await this._hasAudience())) return;

      const who =
        `👤 <b>${escapeHtml(user?.name || '—')}</b>` +
        `${user?.isOwner ? ' (মালিক)' : ' (স্টাফ)'}\n` +
        `🏪 ${escapeHtml(shop?.name || '—')}\n` +
        `📞 <code>${escapeHtml(user?.phone || '—')}</code>`;

      const when = `🕒 ${getBangladeshTimeStr()} · ${this._origin(req)}`;

      if (isFirstLogin) {
        await telegramService.broadcastToAdmins(
          ALERT_KEYS.SECURITY,
          `✨ <b>প্রথমবার লগইন</b>\n\n${who}\n\n` +
          'এই অ্যাকাউন্ট এই প্রথম ব্যবহার শুরু করল।\n' +
          `${when}`
        );
        return;
      }

      if (isNewDevice) {
        await telegramService.broadcastToAdmins(
          ALERT_KEYS.SECURITY,
          `🚨 <b>নতুন ডিভাইস থেকে লগইন</b>\n\n${who}\n\n` +
          'এই ডিভাইস/নেটওয়ার্ক আগে দেখা যায়নি।\n' +
          `${when}`
        );
        return;
      }

      // The routine case. Everything above this line bypassed the gate on
      // purpose; only this one is allowed to be collapsed.
      if (!(await this._shouldAnnounceLogin(user?._id))) return;

      await telegramService.broadcastToAdmins(
        ALERT_KEYS.USER_LOGIN,
        `🔑 <b>লগইন</b>\n\n${who}\n\n${when}`
      );
    });
  }

  /**
   * A password guess failed.
   *
   * Nothing is sent per failure — one wrong password is a typo, and reporting
   * typos is how a channel becomes noise. Failures are counted per phone and
   * the operator is told only once the count crosses `THRESHOLD` inside the
   * sliding window, then muted for an hour so a sustained attack is one message
   * an hour rather than one a second.
   */
  failedLogin({ phone, name = null, shopName = null, req }) {
    this._dispatch('failedLogin', async () => {
      if (!phone) return;
      if (!(await this._hasAudience())) return;

      const countKey = `pnotify:failcount:${phone}`;
      const muteKey = `pnotify:failmute:${phone}`;

      const current = Number((await cacheService.get(countKey)) || 0) + 1;
      // Writing with a fresh TTL on every failure is what makes the window
      // slide. See FAILED_LOGIN.WINDOW_S.
      await cacheService.set(countKey, current, FAILED_LOGIN.WINDOW_S);

      if (current < FAILED_LOGIN.THRESHOLD) return;

      // setNX doubles as the mute: whoever writes it first owns this hour.
      const claimed = await cacheService.setNX(muteKey, 1, FAILED_LOGIN.MUTE_AFTER_ALERT_S);
      if (!claimed) return;

      const lines = [
        '🚨 <b>বারবার ভুল পাসওয়ার্ড</b>',
        '',
        `📞 <code>${escapeHtml(phone)}</code>`,
      ];
      if (name) lines.push(`👤 ${escapeHtml(name)}`);
      if (shopName) lines.push(`🏪 ${escapeHtml(shopName)}`);
      lines.push(
        '',
        `❌ ${formatCount(current)} বার ভুল চেষ্টা (গত ${FAILED_LOGIN.WINDOW_S / 60} মিনিটে)`,
        '',
        `🕒 ${getBangladeshTimeStr()} · ${this._origin(req)}`
      );

      await telegramService.broadcastToAdmins(ALERT_KEYS.SECURITY, lines.join('\n'));
    });
  }

  /**
   * Someone signed into the ADMIN console.
   *
   * Always security class, never collapsed. There are a handful of these a week
   * and every one of them is worth an operator's glance — an admin login the
   * founder did not perform is the single worst event this system can have.
   */
  adminLogin({ admin, req }) {
    this._dispatch('adminLogin', async () => {
      if (!(await this._hasAudience())) return;

      await telegramService.broadcastToAdmins(
        ALERT_KEYS.SECURITY,
        '🛡️ <b>অ্যাডমিন প্যানেলে লগইন</b>\n\n' +
        `👤 <b>${escapeHtml(admin?.name || '—')}</b>\n` +
        `📞 <code>${escapeHtml(admin?.phone || '—')}</code>\n` +
        `🎖️ ${escapeHtml(admin?.role || '—')}\n\n` +
        `🕒 ${getBangladeshTimeStr()} · ${this._origin(req)}\n\n` +
        '⚠️ এটি আপনি না করে থাকলে এখনই পাসওয়ার্ড পরিবর্তন করুন।'
      );
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Operator-side activity
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Something happened on the admin side worth a record in the founder's chat:
   * a password OTP going out, a password actually changing, impersonation.
   *
   * Deliberately generic. The alternative was a method per event, and the
   * events are all the same shape — a title, a few labelled lines and a
   * timestamp — so a method per event would be five copies of this one.
   */
  adminActivity({ title, lines = [], req, urgent = false }) {
    this._dispatch('adminActivity', async () => {
      if (!(await this._hasAudience())) return;

      const body = [
        `${urgent ? '🚨' : '🛡️'} <b>${escapeHtml(title)}</b>`,
        '',
        ...lines,
        '',
        `🕒 ${getBangladeshTimeStr()} · ${this._origin(req)}`,
      ].join('\n');

      // Urgent operator events ride the SECURITY switch rather than the
      // activity one. An operator who muted routine admin chatter still needs
      // to hear that their own password just changed.
      await telegramService.broadcastToAdmins(
        urgent ? ALERT_KEYS.SECURITY : ALERT_KEYS.ADMIN_ACTIVITY,
        body
      );
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────

  /**
   * A short, safe "where from" for the footer of every alert.
   *
   * IP and user-agent are attacker-controlled strings that go straight into an
   * HTML-parsed Telegram message, so both are escaped and the user-agent is
   * truncated — an un-truncated one is a 400-character wall that pushes the
   * actual content off a phone screen.
   */
  _origin(req) {
    if (!req) return 'সিস্টেম';
    const ip = req.ip || req.headers?.['x-forwarded-for'] || '—';
    const agent = String(req.headers?.['user-agent'] || '');
    const device = this._describeAgent(agent);
    return `${escapeHtml(String(ip).slice(0, 45))}${device ? ` · ${escapeHtml(device)}` : ''}`;
  }

  /** Coarse device label. Enough to tell a phone from a desktop; nothing more. */
  _describeAgent(agent) {
    if (!agent) return null;
    if (/android/i.test(agent)) return 'Android';
    if (/iphone|ipad|ios/i.test(agent)) return 'iOS';
    if (/windows/i.test(agent)) return 'Windows';
    if (/macintosh|mac os/i.test(agent)) return 'Mac';
    if (/linux/i.test(agent)) return 'Linux';
    return null;
  }

  /** Re-exported so callers building pulse lines do not import two modules. */
  get format() {
    return { escapeHtml, formatMoney, formatCount };
  }
}

module.exports = new PlatformNotifyService();
module.exports.FAILED_LOGIN = FAILED_LOGIN;
