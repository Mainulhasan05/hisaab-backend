const mongoose = require('mongoose');

/**
 * A short-lived, single-use token that carries identity through Telegram's
 * deep link: the dashboard mints one, embeds it in `t.me/<bot>?start=<token>`,
 * and the bot resolves it back to a (shop, user) when the owner presses Start.
 *
 * Stored in Mongo rather than Redis because Redis is optional in this project
 * (USE_REDIS) — a shop must be able to connect Telegram on a deployment that
 * never turns Redis on.
 */
const telegramLinkTokenSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
    used: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Mongo purges expired tokens on its own; nothing sweeps this table.
telegramLinkTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Consume a token, or return null if it is unknown, spent, or expired.
 *
 * A single findOneAndUpdate so the check and the spend cannot be interleaved.
 * Telegram genuinely delivers duplicate updates, and a double-tapped deep link
 * must not be able to create two links.
 */
telegramLinkTokenSchema.statics.consumeToken = function (token) {
  return this.findOneAndUpdate(
    { token: String(token || ''), used: false, expiresAt: { $gt: new Date() } },
    { $set: { used: true } },
    { new: true }
  );
};

module.exports = mongoose.model('TelegramLinkToken', telegramLinkTokenSchema);
