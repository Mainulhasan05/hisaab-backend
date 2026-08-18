const mongoose = require('mongoose');

/**
 * Every outbound notification the platform sends over a self-service channel,
 * successful or not — the admin panel's audit trail.
 *
 * Named for the channel-agnostic case even though Telegram is the only one
 * today: `channel` is a field rather than part of the collection name so a
 * second channel (WhatsApp is on the roadmap) is a new enum value, not a new
 * model, a new admin page and a second set of queries.
 *
 * SMS is deliberately NOT folded in here — it has quota accounting, per
 * recipient delivery state and a gateway response body, none of which belong
 * in a flat log. SMSLog stays where it is.
 */

const NOTIFICATION_CHANNELS = ['telegram'];

/**
 * The `platform_*` events go to the OPERATOR's own channel
 * (`AdminTelegramLink`), not to a shop owner. They are listed here rather than
 * in a separate collection because the question the admin panel asks of this
 * log — "was it delivered, and if not why" — is identical for both audiences,
 * and `shop: null` already distinguishes them at a glance.
 */
const NOTIFICATION_EVENTS = [
  'daily_summary',
  'link_success',
  'unlink_notice',
  'system',
  'order_placed',
  /** Founder alert: signup, login, security, admin activity. */
  'platform_alert',
  /** The operator's own once-a-day platform report. */
  'platform_pulse',
];
const NOTIFICATION_STATUS = ['sent', 'failed', 'blocked'];

const notificationLogSchema = new mongoose.Schema(
  {
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shop',
      default: null,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    /**
     * The platform admin this went to, for `platform_*` events.
     *
     * A separate field rather than overloading `user`: `user` is a ref to the
     * shop-user collection, and pointing it at an Admin id would make every
     * `.populate('user')` in the panel silently resolve to null while the row
     * still looked attributed.
     */
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
      index: true,
    },

    channel: { type: String, enum: NOTIFICATION_CHANNELS, required: true },
    eventType: { type: String, enum: NOTIFICATION_EVENTS, required: true },

    // Where it went, in channel terms — a Telegram chat id today.
    destination: { type: String, required: true },

    // The exact rendered text. Support questions are unanswerable without it,
    // and re-rendering from the data later gives a different message than the
    // one the owner actually received.
    message: { type: String, required: true },

    status: { type: String, enum: NOTIFICATION_STATUS, required: true },
    error: { type: String, default: null },
    providerMessageId: { type: Number, default: null },

    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Self-purging after 90 days. The admin Clear button is for tidying a view,
// not for keeping this collection from growing without bound.
notificationLogSchema.index({ sentAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
// Admin panel: newest first, optionally filtered to one shop.
notificationLogSchema.index({ shop: 1, sentAt: -1 });
notificationLogSchema.index({ status: 1, sentAt: -1 });

module.exports = mongoose.model('NotificationLog', notificationLogSchema);
module.exports.NOTIFICATION_CHANNELS = NOTIFICATION_CHANNELS;
module.exports.NOTIFICATION_EVENTS = NOTIFICATION_EVENTS;
module.exports.NOTIFICATION_STATUS = NOTIFICATION_STATUS;
