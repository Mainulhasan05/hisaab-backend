const crypto = require('crypto');
const axios = require('axios');

const TelegramLink = require('../models/TelegramLink.model');
const TelegramLinkToken = require('../models/TelegramLinkToken.model');
const AdminTelegramLink = require('../models/AdminTelegramLink.model');
const AdminTelegramLinkToken = require('../models/AdminTelegramLinkToken.model');
const Admin = require('../models/Admin.model');
const NotificationLog = require('../models/NotificationLog.model');
const Shop = require('../models/Shop.model');
const AuditLog = require('../models/AuditLog.model');
const logger = require('../utils/logger.util');
const { AUDIT_ACTIONS } = require('../config/constants');
const { escapeHtml, formatTime } = require('../utils/telegramFormat.util');

/**
 * Telegram Bot API client and linking flow.
 *
 * Implemented directly on axios rather than through a bot library on purpose.
 * The entire surface used here is three methods — getMe, getUpdates,
 * sendMessage — and the most popular Node wrapper pulls in ~140 transitive
 * packages via the deprecated `request` chain, including advisories this
 * project does not otherwise carry. For a POS that handles money, three
 * hand-written HTTP calls are the smaller risk.
 *
 * Everything here is best-effort. A missing token, a Telegram outage or an
 * owner blocking the bot must never surface to a caller or block a sale.
 */

const API_BASE = 'https://api.telegram.org';

// Long poll holds the connection open server-side; the client timeout must
// exceed it or every poll would abort as a client-side timeout.
const POLL_TIMEOUT_S = 25;
const POLL_HTTP_TIMEOUT_MS = (POLL_TIMEOUT_S + 10) * 1000;
const SEND_HTTP_TIMEOUT_MS = 15000;

// Polling errors fire continuously while the network is down. Log at most one
// per minute so an overnight outage costs a few lines rather than a full disk.
const POLL_ERROR_LOG_INTERVAL_MS = 60 * 1000;

const SEND_MAX_ATTEMPTS = 3;

class TelegramService {
  constructor() {
    this.token = null;
    this.botUsername = null;
    this.enabled = false;
    this.polling = false;
    this.stopped = false;
    this.updateOffset = 0;
    this.lastPollErrorLoggedAt = 0;
  }

  isEnabled() {
    return this.enabled === true;
  }

  getBotUsername() {
    return this.botUsername;
  }

  /**
   * Boot the bot. Never throws — an unconfigured or unreachable Telegram must
   * leave the rest of the app fully functional, so every failure path here
   * logs and returns.
   */
  async initialize() {
    try {
      this.token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();

      if (!this.token) {
        logger.info('Telegram: TELEGRAM_BOT_TOKEN not set — notifications disabled');
        return false;
      }

      // Validate the token and learn the bot's username, which the dashboard
      // needs to build `t.me/<username>?start=<token>` deep links.
      const me = await this._call('getMe', {}, SEND_HTTP_TIMEOUT_MS);
      this.botUsername = me?.username || (process.env.TELEGRAM_BOT_USERNAME || '').replace('@', '').trim();

      if (!this.botUsername) {
        logger.error('Telegram: getMe returned no username — notifications disabled');
        return false;
      }

      this.enabled = true;
      this.stopped = false;
      logger.info(`Telegram: connected as @${this.botUsername}`);

      // Polling runs detached. Awaiting it would never return.
      this._startPolling();
      return true;
    } catch (error) {
      this.enabled = false;
      logger.error(`Telegram: initialization failed — ${error.message}. Notifications disabled.`);
      return false;
    }
  }

  /** Stop the poll loop. Called from the SIGTERM handler. */
  shutdown() {
    this.stopped = true;
    this.polling = false;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Transport
  // ──────────────────────────────────────────────────────────────────────

  /**
   * One Telegram API call. Throws on transport failure or an `ok: false` body,
   * with `status` and `retryAfter` attached so callers can classify without
   * re-parsing the message.
   */
  async _call(method, payload = {}, timeout = SEND_HTTP_TIMEOUT_MS) {
    let response;
    try {
      response = await axios.post(`${API_BASE}/bot${this.token}/${method}`, payload, {
        timeout,
        // Telegram signals blocked users and bad chat ids with 4xx bodies that
        // carry the reason. Let them through so they can be classified rather
        // than collapsing into a generic axios "status code 403".
        validateStatus: () => true,
      });
    } catch (error) {
      const err = new Error(error.message || 'network error');
      err.status = 0;
      throw err;
    }

    const body = response.data;
    if (body && body.ok) return body.result;

    const err = new Error(body?.description || `HTTP ${response.status}`);
    err.status = response.status;
    err.retryAfter = body?.parameters?.retry_after || null;
    throw err;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Long polling
  // ──────────────────────────────────────────────────────────────────────

  async _startPolling() {
    if (this.polling) return;
    this.polling = true;

    while (!this.stopped) {
      try {
        const updates = await this._call(
          'getUpdates',
          {
            offset: this.updateOffset,
            timeout: POLL_TIMEOUT_S,
            allowed_updates: ['message'],
          },
          POLL_HTTP_TIMEOUT_MS
        );

        for (const update of updates || []) {
          // Advance the offset before handling. A handler that throws must not
          // make the same update replay forever, blocking every later one.
          this.updateOffset = update.update_id + 1;
          await this._handleUpdate(update).catch((err) =>
            logger.error(`Telegram: update handler failed — ${err.message}`)
          );
        }
      } catch (error) {
        // 409 means another process is polling this same bot token. It is the
        // single most confusing Telegram failure — the bot simply stops
        // responding to half the users — so it is named explicitly.
        if (error.status === 409) {
          this._logPollError(
            'Telegram: 409 Conflict — another process is polling this bot token. ' +
            'Only one instance may poll. Stop the other process or use a separate token.'
          );
          await this._sleep(30000);
          continue;
        }

        this._logPollError(`Telegram: polling error — ${error.message}`);
        await this._sleep(error.retryAfter ? error.retryAfter * 1000 : 5000);
      }
    }

    this.polling = false;
  }

  _logPollError(message) {
    const now = Date.now();
    if (now - this.lastPollErrorLoggedAt < POLL_ERROR_LOG_INTERVAL_MS) return;
    this.lastPollErrorLoggedAt = now;
    logger.warn(message);
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ──────────────────────────────────────────────────────────────────────
  // Inbound
  // ──────────────────────────────────────────────────────────────────────

  async _handleUpdate(update) {
    const message = update?.message;
    if (!message || !message.text) return;

    const text = message.text.trim();
    if (!text.startsWith('/start')) {
      // The bot is not conversational. Anything else gets a nudge back to the
      // dashboard rather than silence, which reads as "the bot is broken".
      await this._replyUnknown(message.chat.id);
      return;
    }

    const arg = text.slice('/start'.length).trim();
    await this._handleStart(message.chat.id, message.from || {}, arg);
  }

  async _handleStart(chatId, from, tokenArg) {
    // A bare /start carries no identity. Never let a stranger link by guessing:
    // the only way in is a token minted for a signed-in owner or admin.
    if (!tokenArg) {
      // Operator channels are reported first: an admin sending /start is asking
      // about the channel that matters most, and it is the rarer case, so a
      // shop-worded reply here would read as "your admin link is gone".
      const adminLinks = await AdminTelegramLink.findActiveByChatId(chatId).populate('admin', 'name');
      if (adminLinks.length) {
        await this.safeSend(
          chatId,
          '🛡️ <b>হিসাব প্ল্যাটফর্ম অ্যালার্ট</b> চালু আছে।\n\n' +
          'নতুন দোকান, লগইন ও নিরাপত্তা সংক্রান্ত খবর এখানেই আসবে।\n' +
          'পরিবর্তন করতে: অ্যাডমিন প্যানেল → Alerts।',
          { eventType: 'system', adminId: adminLinks[0].admin?._id || adminLinks[0].admin }
        );
        return;
      }

      const existing = await TelegramLink.findActiveByChatId(chatId).populate('shop', 'name');
      if (existing.length) {
        const names = existing.map((l) => escapeHtml(l.shop?.name || 'দোকান')).join(', ');
        await this.safeSend(
          chatId,
          `✅ আপনার অ্যাকাউন্ট যুক্ত আছে: <b>${names}</b>\n\n` +
          'প্রতিদিনের বিক্রয় রিপোর্ট এখানেই পাবেন।\n' +
          'বন্ধ করতে হিসাব ড্যাশবোর্ড → সেটিংস → টেলিগ্রাম-এ যান।',
          { eventType: 'system' }
        );
        return;
      }

      await this.safeSend(
        chatId,
        '👋 <b>হিসাব</b>-এর টেলিগ্রাম বট।\n\n' +
        'সংযোগ করতে হিসাব ড্যাশবোর্ডে লগইন করুন → <b>সেটিংস</b> → <b>টেলিগ্রাম</b> → ' +
        '<b>সংযোগ করুন</b> বাটনে চাপ দিন।',
        { eventType: 'system' }
      );
      return;
    }

    const linkToken = await TelegramLinkToken.consumeToken(tokenArg);
    if (!linkToken) {
      // Not a shop token. Try the operator collection before declaring the link
      // dead — the two are minted from different consoles and are deliberately
      // not interchangeable, so "unknown here" is not "unknown".
      const adminToken = await AdminTelegramLinkToken.consumeToken(tokenArg);
      if (adminToken) {
        await this._completeAdminLink(chatId, from, adminToken);
        return;
      }

      await this.safeSend(
        chatId,
        '⚠️ এই লিংকের মেয়াদ শেষ বা এটি আগেই ব্যবহার হয়েছে।\n\n' +
        'হিসাব ড্যাশবোর্ড → সেটিংস → টেলিগ্রাম থেকে নতুন লিংক নিন।',
        { eventType: 'system' }
      );
      return;
    }

    const shop = await Shop.findById(linkToken.shop).select('name').lean();
    const shopName = shop?.name || 'আপনার দোকান';

    const telegramFields = {
      telegramChatId: String(chatId),
      telegramUserId: String(from.id || chatId),
      telegramUsername: from.username || null,
      telegramFirstName: from.first_name || null,
    };

    const existing = await TelegramLink.findOne({
      shop: linkToken.shop,
      user: linkToken.user,
    });

    let link;
    if (existing) {
      // Capture the previous chat id BEFORE overwriting — the history entry is
      // worthless if it records the value it was replaced by.
      const previousChatId = existing.telegramChatId;
      const wasActive = existing.isActive;

      Object.assign(existing, telegramFields);
      existing.isActive = true;
      existing.unlinkedAt = null;
      existing.linkedAt = existing.linkedAt || new Date();
      existing.linkHistory.push({
        action: 'relinked',
        at: new Date(),
        metadata: { previousChatId, wasActive },
      });
      // Preferences are untouched: an owner who disconnected and came back
      // expects their digest time and mute state to still be theirs.
      link = await existing.save();
    } else {
      link = await TelegramLink.create({
        shop: linkToken.shop,
        user: linkToken.user,
        ...telegramFields,
        linkedAt: new Date(),
        linkHistory: [{ action: 'linked', at: new Date(), metadata: {} }],
      });
    }

    await this.safeSend(
      chatId,
      `🎉 <b>${escapeHtml(shopName)}</b> সফলভাবে যুক্ত হয়েছে!\n\n` +
      `প্রতিদিন <b>${formatTime(link.preferences.digestTime)}</b>-এ আপনি পাবেন:\n` +
      '🧾 আজকের মোট ইনভয়েস\n' +
      '💰 আজকের মোট বিক্রয়\n' +
      '📈 আজকের মোট লাভ\n\n' +
      '🔒 এই তথ্য শুধু আপনিই পাবেন।\n' +
      'সময় পরিবর্তন বা বন্ধ করতে: সেটিংস → টেলিগ্রাম।',
      { eventType: 'link_success', shopId: link.shop, userId: link.user }
    );

    // Mirrored into the shop's own audit trail, not just linkHistory — an
    // owner reviewing "what changed on my account" looks there, and a link
    // grants a new channel to the shop's revenue figures.
    AuditLog.log({
      shop: link.shop,
      user: link.user,
      action: AUDIT_ACTIONS.TELEGRAM_LINK.en,
      description: `টেলিগ্রাম যুক্ত হয়েছে${from.username ? ` (@${from.username})` : ''}`,
    }).catch(() => {});

    logger.info(`Telegram: linked shop ${link.shop} to chat ${chatId}`);
  }

  /**
   * Finish an operator link after the admin's deep-link token was spent.
   *
   * Mirrors the shop path deliberately — same relink-vs-create branch, same
   * "capture the old chat id BEFORE overwriting" ordering, same
   * preferences-are-untouched rule. An operator who disconnected and came back
   * expects their alert switches and pulse time to still be theirs.
   */
  async _completeAdminLink(chatId, from, adminToken) {
    const admin = await Admin.findById(adminToken.admin).select('name role phone').lean();

    if (!admin) {
      // The account was deleted between minting and pressing Start. The token
      // is already spent, so there is nothing to roll back — just say so rather
      // than creating a channel pointing at nothing.
      await this.safeSend(
        chatId,
        '⚠️ এই অ্যাডমিন অ্যাকাউন্টটি আর নেই। নতুন করে চেষ্টা করুন।',
        { eventType: 'system' }
      );
      return;
    }

    const telegramFields = {
      telegramChatId: String(chatId),
      telegramUserId: String(from.id || chatId),
      telegramUsername: from.username || null,
      telegramFirstName: from.first_name || null,
    };

    const existing = await AdminTelegramLink.findOne({ admin: adminToken.admin });

    let link;
    if (existing) {
      const previousChatId = existing.telegramChatId;
      const wasActive = existing.isActive;

      Object.assign(existing, telegramFields);
      existing.isActive = true;
      existing.unlinkedAt = null;
      existing.linkedAt = existing.linkedAt || new Date();
      existing.linkHistory.push({
        action: 'relinked',
        at: new Date(),
        metadata: { previousChatId, wasActive },
      });
      link = await existing.save();
    } else {
      link = await AdminTelegramLink.create({
        admin: adminToken.admin,
        ...telegramFields,
        linkedAt: new Date(),
        linkHistory: [{ action: 'linked', at: new Date(), metadata: {} }],
      });
    }

    await this.safeSend(
      chatId,
      `🛡️ <b>হিসাব প্ল্যাটফর্ম অ্যালার্ট</b> চালু হলো!\n\n` +
      `👤 ${escapeHtml(admin.name)} · <code>${escapeHtml(admin.phone)}</code>\n\n` +
      'এখন থেকে এখানে পাবেন:\n' +
      '🆕 নতুন দোকান রেজিস্ট্রেশন\n' +
      '🔑 ইউজার লগইন\n' +
      '🚨 নিরাপত্তা সতর্কতা (নতুন ডিভাইস, ভুল পাসওয়ার্ড)\n' +
      `📊 প্রতিদিন <b>${formatTime(link.preferences.pulseTime)}</b>-এ প্ল্যাটফর্ম রিপোর্ট\n\n` +
      '⚙️ কোনটা চালু থাকবে সেটি ঠিক করুন: অ্যাডমিন প্যানেল → Alerts।',
      { eventType: 'link_success', adminId: link.admin }
    );

    // The notifier caches "is anyone listening" for a minute, and this link was
    // made from TELEGRAM, not from the console — so nothing in the API layer
    // has had a chance to drop that cache. Without this, the operator connects,
    // watches the confirmation arrive, and then sees nothing at all for the
    // next minute, which is indistinguishable from it not working.
    //
    // Required lazily: `platformNotify` requires THIS module at load time, so a
    // top-level require here would be a cycle and would resolve to a
    // half-initialised object. By the time this line runs, both are complete.
    require('./platformNotify.service')
      .invalidateCache()
      .catch(() => {});

    // Platform-level, so it goes to the audit trail with no shop attached —
    // `AuditLog.log` treats an `admin` actor as a platform action.
    AuditLog.log({
      admin: link.admin,
      action: AUDIT_ACTIONS.ADMIN_TELEGRAM_LINK.en,
      description: `প্ল্যাটফর্ম অ্যালার্ট চ্যানেল যুক্ত হয়েছে${from.username ? ` (@${from.username})` : ''}`,
    }).catch(() => {});

    logger.info(`Telegram: linked admin ${link.admin} to chat ${chatId}`);
  }

  async _replyUnknown(chatId) {
    await this.safeSend(
      chatId,
      'ℹ️ এই বট শুধু দৈনিক বিক্রয় রিপোর্ট পাঠায়, কোনো উত্তর দেয় না।\n\n' +
      'সেটিংস পরিবর্তন করতে হিসাব ড্যাশবোর্ড → সেটিংস → টেলিগ্রাম-এ যান।',
      { eventType: 'system' }
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Outbound
  // ──────────────────────────────────────────────────────────────────────

  /**
   * The only send path. Never throws, always logs.
   *
   * Returns the Telegram message id on success and null on failure, so callers
   * branch on a value instead of wrapping every call in try/catch.
   *
   * `logMeta` carries { eventType, shopId, userId, adminId } so the admin panel
   * can filter the audit trail by shop — or, for platform alerts which have no
   * shop, by the operator they went to.
   */
  async safeSend(chatId, html, logMeta = {}) {
    const meta = {
      eventType: logMeta.eventType || 'system',
      shopId: logMeta.shopId || null,
      userId: logMeta.userId || null,
      adminId: logMeta.adminId || null,
    };

    if (!this.enabled) {
      this._log({ ...meta, chatId, message: html, status: 'failed', error: 'Telegram not configured' });
      return null;
    }

    let lastError = null;

    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
      try {
        const result = await this._call('sendMessage', {
          chat_id: String(chatId),
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });

        this._log({
          ...meta,
          chatId,
          message: html,
          status: 'sent',
          providerMessageId: result?.message_id || null,
        });
        return result?.message_id || null;
      } catch (error) {
        lastError = error;

        const reason = this._classify(error);

        // Unreachable chat: the owner blocked the bot or deleted the chat.
        // Retrying cannot help, and leaving the link active would mean
        // re-attempting a dead chat every night forever.
        if (reason) {
          this._log({ ...meta, chatId, message: html, status: 'blocked', error: error.message });
          // Both collections, not just the shop one. A chat id is a chat id —
          // if the operator blocks the bot, retrying their alerts forever is the
          // same waste as retrying an owner's digest, and leaving the admin
          // channel "active" would make the console claim alerts are flowing.
          const [shopCount, adminCount] = await Promise.all([
            TelegramLink.deactivateByChatId(chatId, reason).catch(() => 0),
            AdminTelegramLink.deactivateByChatId(chatId, reason).catch(() => 0),
          ]);
          logger.warn(
            `Telegram: chat ${chatId} unreachable (${reason}) — ` +
            `deactivated ${shopCount} shop link(s), ${adminCount} admin link(s)`
          );
          return null;
        }

        // 400s other than the unreachable ones are our fault (bad HTML, too
        // long) and will fail identically on every retry.
        if (error.status === 400) break;

        if (attempt < SEND_MAX_ATTEMPTS) {
          const waitMs = error.retryAfter ? error.retryAfter * 1000 : attempt * 2000;
          await this._sleep(waitMs);
        }
      }
    }

    this._log({
      ...meta,
      chatId,
      message: html,
      status: 'failed',
      error: lastError?.message || 'unknown error',
    });
    logger.error(`Telegram: send to ${chatId} failed — ${lastError?.message}`);
    return null;
  }

  /**
   * Map a Telegram error to a link-deactivation reason, or null if the chat is
   * still considered reachable. Telegram reports these as prose in
   * `description`, so string matching is the only option available.
   */
  _classify(error) {
    const description = String(error?.message || '').toLowerCase();
    if (description.includes('blocked by the user') || description.includes('user is deactivated')) {
      return 'bot_blocked';
    }
    if (error?.status === 403) return 'bot_blocked';
    if (description.includes('chat not found')) return 'chat_not_found';
    return null;
  }

  /**
   * Write the audit row. Fire-and-forget by design: a log failure must never
   * turn a delivered message into a failed one, and the caller has already
   * moved on.
   */
  _log({ eventType, shopId, userId, adminId, chatId, message, status, error = null, providerMessageId = null }) {
    NotificationLog.create({
      shop: shopId,
      user: userId,
      admin: adminId || null,
      channel: 'telegram',
      eventType,
      destination: String(chatId),
      message,
      status,
      error,
      providerMessageId,
      sentAt: new Date(),
    }).catch((err) => logger.error(`Telegram: audit log write failed — ${err.message}`));
  }

  // ──────────────────────────────────────────────────────────────────────
  // Linking (called from the API layer)
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Mint a single-use deep link for a signed-in owner.
   *
   * The token is 32 bytes of CSPRNG output in base64url. Telegram caps the
   * /start payload at 64 characters and allows only [A-Za-z0-9_-], which
   * base64url satisfies exactly.
   */
  async createLinkToken(userId, shopId) {
    if (!this.enabled) return null;

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await TelegramLinkToken.create({ token, user: userId, shop: shopId, expiresAt });

    return {
      deepLink: `https://t.me/${this.botUsername}?start=${token}`,
      botUsername: this.botUsername,
      expiresIn: 600,
    };
  }

  /**
   * Disconnect, and tell the owner in Telegram itself — a confirmation that
   * only appears in the dashboard leaves them unsure it actually took effect.
   */
  async unlink(userId, shopId) {
    const link = await TelegramLink.findOne({ shop: shopId, user: userId, isActive: true });
    if (!link) return false;

    link.isActive = false;
    link.unlinkedAt = new Date();
    link.linkHistory.push({ action: 'unlinked', at: new Date(), metadata: {} });
    await link.save();

    await this.safeSend(
      link.telegramChatId,
      '🔕 টেলিগ্রাম সংযোগ বন্ধ করা হয়েছে।\n\n' +
      'আপনি আর দৈনিক বিক্রয় রিপোর্ট পাবেন না।\n' +
      'আবার চালু করতে: হিসাব ড্যাশবোর্ড → সেটিংস → টেলিগ্রাম।',
      { eventType: 'unlink_notice', shopId, userId }
    );

    return true;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Operator channel (platform admins)
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Mint a single-use deep link for a signed-in platform admin.
   *
   * Same 32-byte base64url shape as the shop token — Telegram caps the /start
   * payload at 64 characters and allows only [A-Za-z0-9_-] — but written to a
   * different collection, so a token that grants the whole platform's figures
   * can never be spent as if it granted one shop's.
   */
  async createAdminLinkToken(adminId) {
    if (!this.enabled) return null;

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await AdminTelegramLinkToken.create({ token, admin: adminId, expiresAt });

    return {
      deepLink: `https://t.me/${this.botUsername}?start=${token}`,
      botUsername: this.botUsername,
      expiresIn: 600,
    };
  }

  /**
   * Disconnect an operator channel, and say so in Telegram itself.
   *
   * The confirmation matters more here than on the shop side: alerts are the
   * only thing this channel ever sends, so silence after a disconnect is
   * indistinguishable from silence because nothing has happened.
   */
  async unlinkAdmin(adminId) {
    const link = await AdminTelegramLink.findOne({ admin: adminId, isActive: true });
    if (!link) return false;

    link.isActive = false;
    link.unlinkedAt = new Date();
    link.linkHistory.push({ action: 'unlinked', at: new Date(), metadata: {} });
    await link.save();

    await this.safeSend(
      link.telegramChatId,
      '🔕 প্ল্যাটফর্ম অ্যালার্ট বন্ধ করা হয়েছে।\n\n' +
      'নতুন দোকান, লগইন বা নিরাপত্তা সংক্রান্ত কোনো খবর আর এখানে আসবে না।\n' +
      'আবার চালু করতে: অ্যাডমিন প্যানেল → Alerts।',
      { eventType: 'unlink_notice', adminId }
    );

    return true;
  }

  /**
   * Fan one alert out to every operator channel that has opted into `alertKey`.
   *
   * Returns the number of channels the message actually reached.
   *
   * Never throws and never rejects: every caller is a hot path — a login, a
   * registration, a password change — and an alert failing must not fail the
   * thing it was reporting on. Callers are expected to invoke this WITHOUT
   * awaiting, or with `.catch(() => {})`.
   *
   * Sends are sequential rather than parallel. The audience is a handful of
   * operators, so there is nothing to gain from concurrency, and serialising
   * keeps a burst of logins from stacking N parallel Telegram calls per event.
   */
  async broadcastToAdmins(alertKey, html, { eventType = 'platform_alert' } = {}) {
    if (!this.enabled) return 0;

    const links = await AdminTelegramLink.find({
      isActive: true,
      [`preferences.${alertKey}`]: true,
    })
      .select('admin telegramChatId')
      .lean();

    let delivered = 0;
    for (const link of links) {
      const messageId = await this.safeSend(link.telegramChatId, html, {
        eventType,
        adminId: link.admin,
      });
      if (messageId) delivered += 1;
    }

    return delivered;
  }
}

module.exports = new TelegramService();
