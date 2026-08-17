const mongoose = require('mongoose');
const { SMS_TYPES, SMS_STATUS } = require('../config/constants');
const { getContext } = require('../utils/requestStore.util');

/**
 * Where the send was ordered from.
 *
 * An SMS costs money and goes to a real person's phone, so "who sent this, from
 * what machine, when" is the first question anyone asks about a message that
 * should not have gone out. The log recorded `sentBy` and nothing else: no IP,
 * no device, and — for a campaign — no time the message actually left, because
 * `createdAt` is stamped when the campaign is QUEUED, minutes before the first
 * batch reaches the gateway.
 *
 * Filled by the `pre('validate')` hook below from the ambient request context,
 * never by the call site. See utils/requestStore.util.js for why: the same
 * reasoning that put audit metadata on an AsyncLocalStorage hook applies here
 * with more force, because `SMSLog.create` is reached from a controller, from a
 * `setImmediate` after a sale, and from the auth service during registration —
 * three paths, none of which is handed a `req`.
 */
const originSchema = new mongoose.Schema({
  /** Proxy-aware client IP — x-forwarded-for / x-real-ip / cf-connecting-ip. */
  ip: { type: String, trim: true, default: null },
  userAgent: { type: String, trim: true, default: null },
  browser: { type: String, trim: true, default: null },
  os: { type: String, trim: true, default: null },
  device: { type: String, trim: true, default: null },
  /** Ties the send back to the request line in the access log. */
  requestId: { type: String, trim: true, default: null },
  /**
   * `web` — ordered by someone using the app, so `ip` is a real person's.
   * `system` — no request in scope: a script, a seeder, or the queue worker
   * resuming a campaign after the request that started it has gone. An IP is
   * absent here by nature, not by omission, and the two must be tellable apart:
   * a blank IP that means "nobody was on the other end" reads identically to a
   * blank IP that means "we forgot to record it".
   */
  source: {
    type: String,
    enum: ['web', 'system', 'queue', 'script'],
    default: 'system'
  }
}, { _id: false });

const recipientSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  },
  customerName: String,
  message: String, // For dynamic SMS
  status: {
    type: String,
    enum: Object.values(SMS_STATUS),
    default: SMS_STATUS.PENDING
  },
  deliveredAt: Date,
  failedReason: String
}, { _id: true });

const smsLogSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    default: null
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  recipients: {
    type: [recipientSchema],
    required: [true, 'প্রাপক দিন'],
    validate: [arr => arr.length > 0, 'অন্তত একজন প্রাপক দিন']
  },
  message: {
    type: String,
    required: [true, 'মেসেজ দিন'],
    maxlength: [1000, 'মেসেজ ১০০০ অক্ষরের বেশি হতে পারবে না']
  },
  type: {
    type: String,
    enum: {
      values: Object.values(SMS_TYPES),
      message: 'অবৈধ এসএমএস ধরন'
    },
    default: SMS_TYPES.SINGLE
  },
  transactionId: {
    type: String,
    trim: true
  },
  cost: {
    type: Number,
    default: 0,
    min: 0
  },
  status: {
    type: String,
    enum: Object.values(SMS_STATUS),
    default: SMS_STATUS.PENDING
  },
  sentCount: {
    type: Number,
    default: 0
  },
  deliveredCount: {
    type: Number,
    default: 0
  },
  failedCount: {
    type: Number,
    default: 0
  },
  apiResponse: {
    type: mongoose.Schema.Types.Mixed
  },
  errorMessage: {
    type: String
  },

  /* ── Bulk campaign bookkeeping ────────────────────────────────────────────
     A send to four thousand customers cannot be one gateway call and cannot
     finish inside one HTTP request, so it runs in batches after the response
     has already gone back. These fields are what the dashboard polls to draw
     the progress bar — without them a shopkeeper who launched a big campaign
     has no way to tell "still going" from "silently died". */

  /** Which audience produced this send: all | due | selected | manual | auto. */
  audience: {
    type: String,
    trim: true
  },

  /** Recipients dropped before sending — unusable or duplicate numbers. */
  skippedCount: {
    type: Number,
    default: 0
  },

  /**
   * Why they were dropped. Capped when written (see the service): a shop with
   * ten thousand bad numbers must not turn one log into a ten-thousand-entry
   * document, and the first fifty are enough to diagnose the pattern.
   */
  skipped: [{
    _id: false,
    phone: String,
    customerName: String,
    reason: String
  }],

  progress: {
    total: { type: Number, default: 0 },
    processed: { type: Number, default: 0 },
    batches: { type: Number, default: 0 },
    batchesDone: { type: Number, default: 0 },
    startedAt: Date,
    completedAt: Date
  },
  scheduledAt: {
    type: Date
  },
  invoiceNumber: {
    type: String,
    trim: true,
    index: true
  },
  sale: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale',
    default: null
  },
  sentBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  /**
   * Who sent it when the sender was the PLATFORM, not a shop.
   *
   * A separate field rather than a wider `sentBy`, because `sentBy` refs `User`
   * and an `Admin` id pushed through it populates as null — the SMS log page
   * would render every broadcast as sent by nobody. Exactly one of the two is
   * ever set: `sentBy` for a shop's own send, this for an operator broadcast.
   */
  sentByAdmin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null
  },

  /**
   * The sign-off this message actually went out under.
   *
   * Shop sends are signed with the shop's name, which the log already implies
   * through `shop`. A broadcast is signed with the platform's, and that string
   * is configurable — recording it means a log read a year later shows the name
   * the shopkeeper saw, not the name the setting holds today.
   */
  senderName: {
    type: String,
    trim: true
  },

  /**
   * When the gateway actually accepted the message.
   *
   * NOT the same as `createdAt`, and the difference is the whole point. A
   * campaign's log is written before the first gateway call so a crash leaves a
   * record (see sendCampaign step 5) — `createdAt` is therefore when the send
   * was ORDERED, and on a five-thousand-recipient campaign the first message
   * leaves minutes later and the last one minutes after that. A panel that
   * shows only `createdAt` cannot answer "when did this customer get texted".
   *
   * Set on the first accepted batch, so it survives a queue retry that resumes
   * mid-campaign rather than being pushed forward to the resume time. Stays
   * null when nothing ever left, which is what tells a failed send apart from
   * one still waiting in the queue.
   */
  sentAt: {
    type: Date,
    default: null
  },

  origin: {
    type: originSchema,
    default: () => ({})
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes - Optimized for scalability
smsLogSchema.index({ shop: 1, createdAt: -1 }); // Main listing
smsLogSchema.index({ shop: 1, branch: 1, createdAt: -1 }); // Branch-filtered listing
smsLogSchema.index({ shop: 1, invoiceNumber: 1 }, { sparse: true }); // Duplicate SMS prevention for invoices
smsLogSchema.index({ transactionId: 1 }, { sparse: true }); // Webhook status updates
// Platform broadcasts: `shop` is null, so the two indexes above cannot serve
// the operator's "what have we sent the shopkeepers" listing.
smsLogSchema.index({ sentByAdmin: 1, createdAt: -1 }, { sparse: true });
// "Everything sent from this address" — the query an operator runs when one
// account or one till looks like it is being used to blast messages.
//
// Not `sparse`. A sparse COMPOUND index still indexes a document that has any
// one of its keys, and `createdAt` is always there — so the flag would index
// every document while reading as though it skipped the system sends. Left
// plain, which is what it actually is; the TTL above caps the size at 60 days
// of traffic either way.
smsLogSchema.index({ 'origin.ip': 1, createdAt: -1 });

// TTL Index - Auto-delete logs older than 60 days
smsLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 }); // 60 days

/**
 * Stamp the origin from the request in flight.
 *
 * A hook rather than a parameter on every `create` call, for the reason spelled
 * out on `originSchema`: the three paths that write an SMS log have between
 * them one `req`, and the two that lack it are exactly the ones whose origin
 * matters most — the automatic receipt fired from the till, and the OTP sent
 * during registration.
 *
 * An explicitly-set origin wins. Anything writing a log on behalf of a request
 * it no longer has (a queue worker replaying a campaign) knows more than the
 * ambient context does, and must not be overwritten by a blank.
 */
smsLogSchema.pre('validate', function (next) {
  if (this.origin?.ip) return next();

  const ctx = getContext();
  const info = ctx?.clientInfo;
  if (!info) return next();

  this.origin = {
    ip: info.ip || null,
    userAgent: info.userAgent || null,
    browser: info.browser || null,
    os: info.os || null,
    device: info.device || null,
    requestId: ctx.context?.requestId || null,
    source: 'web'
  };

  next();
});

// Virtual: Total recipients
smsLogSchema.virtual('totalRecipients').get(function() {
  return this.recipients.length;
});

// Virtual: Is successful
smsLogSchema.virtual('isSuccessful').get(function() {
  return this.status === SMS_STATUS.SENT || this.status === SMS_STATUS.DELIVERED;
});

// Method: Update delivery status
smsLogSchema.methods.updateDeliveryStatus = async function(recipientPhone, status, failedReason = null) {
  const recipient = this.recipients.find(r => r.phone === recipientPhone);
  if (recipient) {
    recipient.status = status;
    if (status === SMS_STATUS.DELIVERED) {
      recipient.deliveredAt = new Date();
      this.deliveredCount += 1;
    } else if (status === SMS_STATUS.FAILED) {
      recipient.failedReason = failedReason;
      this.failedCount += 1;
    }

    // Update overall status
    if (this.deliveredCount === this.recipients.length) {
      this.status = SMS_STATUS.DELIVERED;
    } else if (this.failedCount === this.recipients.length) {
      this.status = SMS_STATUS.FAILED;
    } else if (this.deliveredCount > 0 || this.sentCount > 0) {
      this.status = SMS_STATUS.PARTIAL;
    }

    await this.save();
  }
};

// Static: Get SMS summary
smsLogSchema.statics.getSMSSummary = async function(shopId, startDate, endDate) {
  const match = {
    shop: new mongoose.Types.ObjectId(shopId),
    createdAt: { $gte: startDate, $lte: endDate }
  };

  const summary = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$type',
        totalCost: { $sum: '$cost' },
        totalRecipients: { $sum: { $size: '$recipients' } },
        totalSent: { $sum: '$sentCount' },
        totalDelivered: { $sum: '$deliveredCount' },
        totalFailed: { $sum: '$failedCount' },
        count: { $sum: 1 }
      }
    }
  ]);

  return summary;
};

// Static: Get shop SMS history
smsLogSchema.statics.getShopHistory = function(shopId, options = {}) {
  const { page = 1, limit = 20, type, status, startDate, endDate } = options;

  const filter = { shop: shopId };

  if (type) filter.type = type;
  if (status) filter.status = status;
  if (startDate && endDate) {
    filter.createdAt = { $gte: startDate, $lte: endDate };
  }

  return this.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('sentBy', 'name');
};

const SMSLog = mongoose.model('SMSLog', smsLogSchema);

module.exports = SMSLog;
