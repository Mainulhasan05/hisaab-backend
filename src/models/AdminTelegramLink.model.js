const mongoose = require('mongoose');

/**
 * A platform admin's connected Telegram account — the operator's own channel.
 *
 * ── WHY THIS IS NOT `TelegramLink` ──────────────────────────────────────────
 *
 * `TelegramLink` is keyed on (shop, user) and both fields are `required`. It
 * answers "which shop owner gets this shop's numbers". This one answers a
 * different question — "who runs the platform, and what should wake them" — and
 * shares almost none of its shape:
 *
 *   · There is no shop. A platform alert is about the platform, and forcing a
 *     synthetic shop id onto it would poison every `{shop: ...}` query in the
 *     admin panel's notification log.
 *   · The preferences are a different set entirely. An owner picks a digest
 *     time; an operator picks which CLASSES of event are worth a buzz at 2 AM.
 *   · The blast radius differs. A shop link leaks one shop's revenue. This link
 *     receives every signup, every login and the whole platform's takings, so
 *     it is minted only for an authenticated admin and is audited separately.
 *
 * Folding the two together would have meant making `shop` and `user` optional
 * on the model that guards shop revenue, to serve a caller that never has
 * either. That is the wrong trade.
 *
 * One row per admin: an operator with two Telegram accounts is not a case worth
 * carrying, and `admin` unique is what makes "am I connected?" a single lookup.
 */

const linkHistorySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: ['linked', 'unlinked', 'relinked', 'bot_blocked', 'chat_not_found'],
      required: true,
    },
    at: { type: Date, default: Date.now },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

/**
 * The alert classes an operator can switch on or off, and what each costs in
 * message volume. Exported so the API, the admin UI and the notifier all agree
 * on the key names — a preference the notifier reads under a name the UI never
 * writes is a switch that silently does nothing.
 */
const ALERT_KEYS = {
  NEW_SHOP: 'newShop',
  USER_LOGIN: 'userLogin',
  SECURITY: 'security',
  ADMIN_ACTIVITY: 'adminActivity',
  DAILY_PULSE: 'dailyPulse',
};

const adminTelegramLinkSchema = new mongoose.Schema(
  {
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: true,
      unique: true,
    },

    // Telegram identity. chatId is what we send to; userId is stable across
    // username changes and is what a genuine re-link is detected on.
    telegramChatId: { type: String, required: true },
    telegramUserId: { type: String, required: true },
    telegramUsername: { type: String, default: null },
    telegramFirstName: { type: String, default: null },

    isActive: { type: Boolean, default: true },
    linkedAt: { type: Date, default: Date.now },
    unlinkedAt: { type: Date, default: null },

    preferences: {
      /** A brand-new shop finished registration. Low volume, high value. */
      [ALERT_KEYS.NEW_SHOP]: { type: Boolean, default: true },

      /**
       * Every successful shop-user login, platform-wide.
       *
       * Honest to what was asked for, and genuinely floody: at a few hundred
       * shops this is the noisiest switch on the page. `loginCooldownMinutes`
       * below is what makes it survivable — see the note there.
       */
      [ALERT_KEYS.USER_LOGIN]: { type: Boolean, default: true },

      /**
       * Login from an unrecognised device or network, failed-password bursts,
       * and admin-panel logins. This is the class that catches a takeover, so
       * it is deliberately NOT covered by the login cooldown.
       */
      [ALERT_KEYS.SECURITY]: { type: Boolean, default: true },

      /** Admin password changes, impersonation, other operator-side actions. */
      [ALERT_KEYS.ADMIN_ACTIVITY]: { type: Boolean, default: true },

      /** One message a day: the whole platform in a card. */
      [ALERT_KEYS.DAILY_PULSE]: { type: Boolean, default: true },

      /** Bangladesh local wall-clock, "HH:MM", for the daily pulse. */
      pulseTime: {
        type: String,
        default: '09:00',
        validate: {
          validator: (v) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(v),
          message: 'সময় HH:MM ফরম্যাটে দিন',
        },
      },

      /**
       * Collapse repeat logins by the SAME user inside this many minutes into
       * one alert.
       *
       * The reason "every login" is a usable setting at all. A cashier who
       * reloads the till app six times before lunch is one event worth knowing
       * about, not six; without this the operator mutes the channel within a
       * week and the security alerts go with it. 0 disables the collapse and
       * sends every single login.
       */
      loginCooldownMinutes: { type: Number, default: 60, min: 0, max: 1440 },
    },

    /**
     * The last Bangladesh date ("YYYY-MM-DD") a pulse was claimed for.
     *
     * Same send-once guard as `TelegramLink.lastDigestSentFor`, and for the
     * same reason: a restart inside the send window must not put two different
     * sets of platform figures in the founder's pocket.
     */
    lastPulseSentFor: { type: String, default: null },

    linkHistory: { type: [linkHistorySchema], default: [] },
  },
  { timestamps: true }
);

// The fan-out query: every active channel, cheaply. Every alert send starts
// here, so it runs far more often than anything else on this collection.
adminTelegramLinkSchema.index({ isActive: 1 });
// Inbound bot messages arrive carrying a chat id and nothing else.
adminTelegramLinkSchema.index({ telegramChatId: 1 });

/**
 * Deactivate every active admin channel for a chat and record why.
 *
 * Called when Telegram reports the chat unreachable. Mirrors
 * `TelegramLink.deactivateByChatId` — the send path classifies an error once
 * and then has to be able to retire whichever kind of link produced it.
 */
adminTelegramLinkSchema.statics.deactivateByChatId = async function (chatId, reason) {
  const now = new Date();
  const result = await this.updateMany(
    { telegramChatId: String(chatId), isActive: true },
    {
      $set: { isActive: false, unlinkedAt: now },
      $push: { linkHistory: { action: reason, at: now, metadata: {} } },
    }
  );
  return result.modifiedCount || 0;
};

/** Active channels for a chat, if any. */
adminTelegramLinkSchema.statics.findActiveByChatId = function (chatId) {
  return this.find({ telegramChatId: String(chatId), isActive: true });
};

/**
 * Atomically claim today's pulse for a channel.
 *
 * Returns the link if this caller won, null if the date was already claimed.
 * Claim-before-send, like the shop digest: a failure is visible in the
 * notification log, whereas a duplicate is two contradictory reports.
 */
adminTelegramLinkSchema.statics.claimPulse = function (linkId, dateStr) {
  return this.findOneAndUpdate(
    { _id: linkId, lastPulseSentFor: { $ne: dateStr } },
    { $set: { lastPulseSentFor: dateStr } },
    { new: true }
  );
};

const AdminTelegramLink = mongoose.model('AdminTelegramLink', adminTelegramLinkSchema);

module.exports = AdminTelegramLink;
module.exports.ALERT_KEYS = ALERT_KEYS;
