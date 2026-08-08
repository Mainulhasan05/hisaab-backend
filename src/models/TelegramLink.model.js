const mongoose = require('mongoose');

/**
 * A shop owner's connected Telegram account.
 *
 * One row per (shop, user). A person who owns two shops therefore has two
 * links, both pointing at the same `telegramChatId` — that is supported on
 * purpose: `{phone, shop}` is unique on User, so the same human legitimately
 * has an account in each shop, and linking the second must not silently kill
 * the first. Every message carries the shop name for that reason.
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

const telegramLinkSchema = new mongoose.Schema(
  {
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shop',
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Telegram identity. chatId is what we send to; userId is stable across
    // username changes and is what we compare on to detect a genuine re-link.
    telegramChatId: { type: String, required: true },
    telegramUserId: { type: String, required: true },
    telegramUsername: { type: String, default: null },
    telegramFirstName: { type: String, default: null },

    isActive: { type: Boolean, default: true },
    linkedAt: { type: Date, default: Date.now },
    unlinkedAt: { type: Date, default: null },

    preferences: {
      // Kept as an object rather than a bare boolean so a second event type
      // later is a field, not a migration.
      dailySummary: { type: Boolean, default: true },
      // Bangladesh local wall-clock, "HH:MM". Owners who close late move it.
      digestTime: {
        type: String,
        default: '22:00',
        validate: {
          validator: (v) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(v),
          message: 'সময় HH:MM ফরম্যাটে দিন',
        },
      },
    },

    /**
     * The last Bangladesh date ("YYYY-MM-DD") a digest was claimed for.
     *
     * This is the send-once guard. The job claims the date atomically before
     * sending, so a restart at 10:01 PM — or two ticks landing in the same
     * minute — cannot send the owner two conflicting sets of figures.
     */
    lastDigestSentFor: { type: String, default: null },

    linkHistory: { type: [linkHistorySchema], default: [] },
  },
  { timestamps: true }
);

// One link per owner per shop.
telegramLinkSchema.index({ shop: 1, user: 1 }, { unique: true });
// Digest sweep: every active link, cheaply.
// digestTime is part of the key because the digest job now pre-filters on it:
// only links whose send time falls inside the current catch-up window are
// fetched, instead of every active link on the platform once a minute.
telegramLinkSchema.index({ isActive: 1, 'preferences.dailySummary': 1, 'preferences.digestTime': 1 });
// Inbound bot messages arrive with a chat id and nothing else.
telegramLinkSchema.index({ telegramChatId: 1 });

/** Active link for a chat, if any. A chat may hold several (multi-shop owner). */
telegramLinkSchema.statics.findActiveByChatId = function (chatId) {
  return this.find({ telegramChatId: String(chatId), isActive: true });
};

/**
 * Deactivate every active link for a chat and record why.
 *
 * Called when Telegram tells us the chat is unreachable (user blocked the bot,
 * or deleted the chat). Without this we would retry a dead chat every night
 * forever and eventually get rate-limited on the whole bot.
 */
telegramLinkSchema.statics.deactivateByChatId = async function (chatId, reason) {
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

/**
 * Atomically claim today's digest for a link.
 *
 * Returns the link if this caller won the claim, null if the digest for
 * `dateStr` was already claimed. Claiming BEFORE sending is deliberate: a
 * failed send is logged and visible in the admin panel, whereas a duplicate
 * send puts two different revenue figures in the owner's pocket.
 */
telegramLinkSchema.statics.claimDigest = function (linkId, dateStr) {
  return this.findOneAndUpdate(
    { _id: linkId, lastDigestSentFor: { $ne: dateStr } },
    { $set: { lastDigestSentFor: dateStr } },
    { new: true }
  );
};

module.exports = mongoose.model('TelegramLink', telegramLinkSchema);
