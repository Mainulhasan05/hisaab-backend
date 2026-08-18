const mongoose = require('mongoose');

/**
 * A short-lived, single-use token carrying an ADMIN's identity through
 * Telegram's deep link: the console mints one, embeds it in
 * `t.me/<bot>?start=<token>`, and the bot resolves it back to an Admin when the
 * operator presses Start.
 *
 * ── WHY A SECOND TOKEN COLLECTION ───────────────────────────────────────────
 *
 * `TelegramLinkToken` already exists and does the same job for shop owners. Its
 * `user` and `shop` are both `required`, so serving admins from it would mean
 * relaxing those to optional and adding a validator to put the constraint back
 * — weakening the model that guards shop revenue in order to serve a caller
 * that has neither field.
 *
 * The cost of not doing that is this file: forty lines and one more `findOne`
 * in the bot's /start handler, which tries the shop token first and this one
 * second. That is the cheaper side of the trade, and it keeps the two grants
 * separable — an admin token hands out the whole platform's figures, a shop
 * token hands out one shop's, and they should never be spendable against each
 * other's collection by accident.
 *
 * Stored in Mongo rather than Redis for the reason the shop token gives: Redis
 * is optional in this project (USE_REDIS), and linking must work without it.
 */
const adminTelegramLinkTokenSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
    used: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Mongo purges expired tokens on its own; nothing sweeps this collection.
adminTelegramLinkTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Consume a token, or return null if it is unknown, spent, or expired.
 *
 * One findOneAndUpdate so the check and the spend cannot interleave. Telegram
 * genuinely redelivers updates, and a double-tapped deep link must not be able
 * to create two channels.
 */
adminTelegramLinkTokenSchema.statics.consumeToken = function (token) {
  return this.findOneAndUpdate(
    { token: String(token || ''), used: false, expiresAt: { $gt: new Date() } },
    { $set: { used: true } },
    { new: true }
  );
};

module.exports = mongoose.model('AdminTelegramLinkToken', adminTelegramLinkTokenSchema);
