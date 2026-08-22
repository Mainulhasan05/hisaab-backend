const axios = require('axios');
// All gateway calls share a hard timeout — Node's default is none, so a hung
// gateway would otherwise leak sockets and pending promises indefinitely
const smsHttp = axios.create({ timeout: Number(process.env.SMS_HTTP_TIMEOUT_MS) || 10000 });
const SMSLog = require('../models/SMSLog.model');
const SMSQuota = require('../models/SMSQuota.model');
const { formatPhone } = require('../utils/phone.util');
const { SMS_TYPES, SMS_STATUS } = require('../config/constants');
const logger = require('../utils/logger.util');
const { countSms, isUnicode } = require('../utils/smsCounter.util');
const { branchFilter, requireBranch, isBranchCustomerScope } = require('../utils/branchScope.util');
// Message bodies live in one place because the dashboard previews them to the
// shopkeeper before sending — see the header of smsTemplates.util.js.
const {
  formatSmsAmount,
  gsmSafeShopName: getGsmSafeShopName,
  buildSaleReceipt,
  buildPaymentReceipt,
  buildDueReminder,
  buildOtp,
  buildPasswordResetOtp,
  appendShopSignature,
} = require('../utils/smsTemplates.util');
const { normalizeRecipients, chunk, MAX_SKIPPED_STORED } = require('../utils/smsRecipients.util');
const { isPersonalized, personalizeMessage } = require('../utils/smsPersonalize.util');
// Which gateway sends, what happens when it refuses, and what it cost us. The
// service below no longer speaks any gateway's dialect — see services/sms/.
const dispatcher = require('./sms/dispatcher');
const smsRouting = require('./sms/routing');
const smsEarnings = require('./sms/earnings');

/* ── The gateway dialect moved out ───────────────────────────────────────────
 *
 * MimSMS's endpoints, its per-endpoint TransactionType matrix and its habit of
 * answering a refusal with HTTP 200 all now live in
 * services/sms/adapters/mimsms.adapter.js, alongside the Automas adapter that
 * has its own, different, set of quirks. This service asks the dispatcher to
 * send and no longer knows which gateway will.
 *
 * The two values below are re-exported for the contract tests that pin MimSMS's
 * behaviour. They DELEGATE rather than duplicate: a second copy of the verdict
 * reader would be a copy that drifts, and this one is the difference between
 * "the campaign reached nobody" and "the campaign reported itself sent".
 */
const MimSmsAdapter = require('./sms/adapters/mimsms.adapter');
const registry = require('./sms/registry');

const mimsmsContract = new MimSmsAdapter();
const readGatewayVerdict = (data) => mimsmsContract.readVerdict(data);
const TRANSACTION_TYPE = {
  single: process.env.MIMSMS_TXN_TYPE_SINGLE || 'T',
  bulk: process.env.MIMSMS_TXN_TYPE_BULK || 'T',
  dynamic: process.env.MIMSMS_TXN_TYPE_DYNAMIC || 'D',
};

/* ── Bulk sending shape ───────────────────────────────────────────────────────
 *
 * MimSMS takes bulk recipients as one comma-delimited string. Handing it a
 * shop's entire customer book in a single call is a ~70KB field against a
 * gateway that slows under load, behind a 10s client timeout — and it is
 * all-or-nothing: one hiccup fails every recipient at once, and a timeout
 * leaves the shop unable to tell whether the messages went. Batching turns that
 * into a failure of one hundred, with the rest still delivered and the log
 * saying exactly which hundred.
 *
 * `SYNC_LIMIT` is the line between "answer with the result" and "answer with a
 * receipt". A send small enough to finish inside one request should — the
 * shopkeeper gets a real confirmation instead of a progress bar to babysit.
 * Above it, the HTTP request would outlive proxy and browser timeouts, so the
 * response carries a campaign id and the work continues behind it.
 */
const BULK = {
  BATCH_SIZE: Number(process.env.SMS_BULK_BATCH_SIZE) || 100,
  BATCH_DELAY_MS: Number(process.env.SMS_BULK_BATCH_DELAY_MS) || 250,
  SYNC_LIMIT: Number(process.env.SMS_BULK_SYNC_LIMIT) || 100,
  // One retry, not three. A gateway that just refused a hundred numbers is
  // usually down rather than flaky, and hammering it delays the batches behind.
  BATCH_RETRIES: Number(process.env.SMS_BULK_BATCH_RETRIES) || 1,
  RETRY_DELAY_MS: Number(process.env.SMS_BULK_RETRY_DELAY_MS) || 1000,
  // The controller's own guard for a single message. Repeated here because the
  // campaign path builds bodies the controller never saw — a personalised one
  // grows by whatever the longest customer name is.
  MAX_SEGMENTS: Number(process.env.SMS_MAX_SEGMENTS) || 10,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tally a campaign's traffic per gateway.
 *
 * A campaign is not necessarily one gateway's work: failover can move it
 * part-way through, and the two gateways charge different rates. Summing the
 * whole run against whichever provider answered last would misstate the cost by
 * exactly the amount failover was responsible for — which is the number worth
 * knowing.
 */
function createProviderTally() {
  const byProvider = new Map();

  return {
    add(provider, { sentSegments = 0, failedSegments = 0, failedOver = false, method = null,
      failedProvider = null, failedReason = null } = {}) {
      if (!provider) return;
      const row = byProvider.get(provider) || {
        provider, sentSegments: 0, failedSegments: 0, batches: 0,
        failedOverBatches: 0, method: null, failedProvider: null, failedReason: null,
      };
      row.sentSegments += sentSegments;
      row.failedSegments += failedSegments;
      row.batches += 1;
      if (failedOver) {
        row.failedOverBatches += 1;
        row.failedProvider = failedProvider || row.failedProvider;
        row.failedReason = failedReason || row.failedReason;
      }
      row.method = method || row.method;
      byProvider.set(provider, row);
    },

    rows() {
      return [...byProvider.values()];
    },

    /** The provider that carried most of the campaign — what the log row names. */
    primary() {
      let best = null;
      for (const row of byProvider.values()) {
        if (!best || row.sentSegments > best.sentSegments) best = row;
      }
      return best;
    },

    anyFailedOver() {
      return [...byProvider.values()].some((r) => r.failedOverBatches > 0);
    },
  };
}

class SMSService {
  /**
   * The name every message this shop sends signs off with.
   *
   * Read from the shop rather than taken from the caller on purpose: the
   * sign-off is not a field a request gets to fill in. A client that could
   * choose it could send a message signed as somebody else's shop.
   */
  async getShopName(shopId) {
    const Shop = require('../models/Shop.model');
    try {
      const shop = await Shop.findById(shopId).select('name').lean();
      return shop?.name || '';
    } catch (err) {
      logger.error(`SMS: Failed to read shop name for ${shopId}: ${err.message}`);
      return '';
    }
  }

  /**
   * Take `cost` segments out of the shop's balance, or refuse.
   *
   * Every paid send goes through here. It reserves BEFORE the gateway call, so
   * two concurrent campaigns cannot both spend the same last hundred segments —
   * see `SMSQuota.reserve` for why the old read-check-save could.
   *
   * @returns {Promise<number>} the balance left after the reservation
   */
  async reserveQuota(shopId, cost) {
    const quota = await SMSQuota.getOrCreate(shopId);

    if (!quota.isEnabled) {
      throw new Error('SMS service is not enabled for this shop');
    }

    const reserved = await SMSQuota.reserve(shopId, cost);
    if (!reserved) {
      throw new Error(
        `Insufficient SMS quota. Need ${cost}, have ${quota.remainingQuota}`
      );
    }

    return reserved.remainingQuota;
  }

  /**
   * Turn a dispatch outcome into the log's `gateway` record, and book the money.
   *
   * One helper for every send path so that provider attribution and earnings
   * cannot drift apart between them — a campaign that books its margin and an
   * OTP that does not is exactly how a monthly total ends up unexplainable.
   *
   * `result` is the dispatcher's normalised success shape; `error` is what it
   * threw. Either may be absent. Never throws: the accounting is downstream of
   * a message that has already gone (or already failed), and must not change
   * that outcome.
   *
   * @returns {Promise<object>} the SMSLog.gateway subdocument
   */
  async buildGatewayRecord({
    shopId = null,
    segments = 0,
    result = null,
    error = null,
    sent = true,
    errorMessage = null,
    method = null,
  }) {
    // On failure the provider still matters — we may have been charged by the
    // gateway that refused, and "which one refused" is the first question.
    const provider = result?.provider
      || error?.provider
      || error?.failoverProvider
      || null;

    const record = {
      provider,
      method: result?.method || method || null,
      messageId: result?.messageId != null ? String(result.messageId) : null,
      statusCode: result?.statusCode != null ? String(result.statusCode) : null,
      senderId: result?.senderIdUsed || null,
      failedOver: Boolean(result?.failedOver),
      failedProvider: result?.failedProvider || error?.primaryProvider || null,
      failedReason: result?.failedReason || error?.primaryError || null,
      billedSegments: segments,
      unitCost: null,
      totalCost: null,
      revenue: null,
      raw: result?.data || error?.gatewayResponse || null,
    };

    if (!provider || segments <= 0) return record;

    const priced = await smsEarnings.priceAndRecord({
      shopId,
      provider,
      segments,
      failedOver: record.failedOver,
      failed: !sent,
      at: new Date(),
    });

    record.unitCost = priced.unitCost;
    record.totalCost = priced.totalCost;
    record.revenue = priced.revenue;

    if (!sent && errorMessage && !record.failedReason) {
      record.failedReason = errorMessage;
    }
    return record;
  }

  /* ── Logging a send that belongs to no shop ───────────────────────────────
   *
   * OTPs and platform notices are sent on the platform's own gateway account,
   * so there is no `SMSQuota` to reserve and no shop to bill. That is why they
   * were never logged: every other path writes its log next to a quota
   * movement, and these have none.
   *
   * The consequence was that the single highest-volume message the product
   * sends — the registration OTP — appeared nowhere. `SMS_TYPES.OTP` existed,
   * the admin panel had an "OTP" filter and a "System OTP" pill, and not one
   * document had ever carried that type. An operator asking "did this number
   * get its code, and when" had only the process log to go on, which rotates.
   *
   * `shop: null` is how a shop-less send has always been represented (see the
   * platform-broadcast block), so this needs no migration and the shop-facing
   * history — which filters on a concrete `shop` — cannot pick these up.
   */

  /**
   * Record a platform-account send. Never throws.
   *
   * A failure to write the log must not fail the thing that caused it: an
   * SMSLog write that rejects during registration would roll a new shop owner
   * back over a bookkeeping row. The origin (IP, device, request id) is stamped
   * by the model's hook, so nothing needs to be threaded in here.
   */
  async recordSystemLog({
    phone,
    message,
    type = SMS_TYPES.OTP,
    audience,
    status,
    transactionId = null,
    apiResponse = null,
    errorMessage = null,
    senderName = null,
    result = null,
    error = null,
  }) {
    const sent = status === SMS_STATUS.SENT;
    // No quota is charged, but the segments are still what the platform is
    // billed by the gateway — and an OTP in Bangla is two of them, not one.
    const segments = countSms(message).segments || 1;
    try {
      // Platform sends have no shop to earn from, so this is pure cost. Booking
      // it is the only way the margin report accounts for the single
      // highest-volume message the product sends.
      const gateway = await this.buildGatewayRecord({
        shopId: null, segments, result, error, sent, errorMessage, method: 'single',
      });

      return await SMSLog.create({
        shop: null,
        branch: null,
        recipients: [{ phone, status }],
        message,
        type,
        audience,
        transactionId: transactionId || gateway.messageId || null,
        cost: segments,
        status,
        sentCount: sent ? 1 : 0,
        failedCount: sent ? 0 : 1,
        sentAt: sent ? new Date() : null,
        apiResponse,
        errorMessage,
        senderName,
        gateway,
      });
    } catch (err) {
      logger.error(`SMS: failed to write ${type} log for ${phone}: ${err.message}`);
      return null;
    }
  }

  /**
   * Send OTP (no quota check for registration)
   *
   * Logged like any other send. The body is stored verbatim, OTP digits and
   * all — a deliberate call, taken knowing that anyone with SMS-panel access
   * can therefore read a live code for the 60 days the TTL keeps the row.
   * Treat panel access accordingly.
   */
  async sendOTP(phone, otp, { message: bodyOverride = null, audience = 'system_otp' } = {}) {
    const formattedPhone = formatPhone(phone);
    const message = bodyOverride || buildOtp(otp);

    // OTPs are secrets — only log them in development, never in production logs
    if (process.env.NODE_ENV === 'development' || process.env.SKIP_SMS === 'true') {
      logger.info(`[DEVELOPMENT OTP] Phone: ${formattedPhone} | OTP Code: ${otp}`);
      // Logged even though nothing left the building. A development run that
      // records nothing gives the panel no way to be exercised before it meets
      // production traffic, and `{ simulated: true }` is already how the batch
      // path marks a pretended send.
      await this.recordSystemLog({
        phone: formattedPhone,
        message,
        audience,
        status: SMS_STATUS.SENT,
        apiResponse: { simulated: true },
      });
      return { success: true, message: 'OTP logged to console' };
    }

    try {
      /* Failover is deliberately LEFT ON for OTPs.
       *
       * The usual argument against it — that a double-send hands the user two
       * different codes and invalidates the one they are typing — does not apply
       * here: `otp` is generated by the caller and passed in, so both attempts
       * carry the SAME code. The worst case is a duplicate message, and the best
       * case is that a shopkeeper still gets into their account while the
       * primary gateway is down. For the highest-volume message the product
       * sends, that trade is worth taking.
       *
       * The gateway's refusal-with-HTTP-200 trap is handled inside the adapter
       * now, so a refusal arrives here as a throw like any other failure.
       */
      const result = await dispatcher.sendSingle(formattedPhone, message);

      await this.recordSystemLog({
        phone: formattedPhone,
        message,
        audience,
        status: SMS_STATUS.SENT,
        transactionId: result.messageId,
        apiResponse: result.data,
        result,
      });

      if (result.failedOver) {
        logger.warn(
          `OTP to ${formattedPhone} delivered by ${result.provider} after ${result.failedProvider} failed: ${result.failedReason}`
        );
      }
      logger.info(`OTP sent to ${formattedPhone} via ${result.provider}`);
      return result.data;
    } catch (error) {
      await this.recordSystemLog({
        phone: formattedPhone,
        message,
        audience,
        status: SMS_STATUS.FAILED,
        errorMessage: error.message,
        apiResponse: error.gatewayResponse || null,
        error,
      });

      logger.error(`Failed to send OTP: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send a password-reset code.
   *
   * Same platform account, same unbilled path, same log shape as `sendOTP` —
   * two things differ, and both matter:
   *
   *   · THE BODY says what the code is for. See `buildPasswordResetOtp`.
   *   · THE AUDIENCE is `system_password_reset`, so the SMS panel can answer
   *     "was this number's reset code actually delivered" without that question
   *     being buried among every registration OTP ever sent.
   */
  async sendPasswordResetOtp(phone, otp) {
    return this.sendOTP(phone, otp, {
      message: buildPasswordResetOtp(otp),
      audience: 'system_password_reset',
    });
  }

  /**
   * A one-off message on the platform's own account.
   *
   * For the platform notifying itself or an operator — not for shop traffic,
   * which must go through `sendSingle` so it is priced and charged. No quota is
   * touched, the platform's sign-off is used rather than a shop's, and the log
   * lands with `shop: null` beside the OTPs and broadcasts.
   */
  async sendSystemSingle({ phone, message, audience = 'system_notice' }) {
    const formattedPhone = formatPhone(phone);
    const senderName = process.env.PLATFORM_SMS_SENDER_NAME || 'Hisaab';
    const body = appendShopSignature(message, senderName);

    if (process.env.SKIP_SMS === 'true') {
      logger.info(`[SKIP_SMS] Pretending to send system SMS to ${formattedPhone}`);
      await this.recordSystemLog({
        phone: formattedPhone, message: body, type: SMS_TYPES.SINGLE, audience,
        status: SMS_STATUS.SENT, apiResponse: { simulated: true }, senderName,
      });
      return { success: true, simulated: true };
    }

    try {
      const result = await dispatcher.sendSingle(formattedPhone, body);

      const smsLog = await this.recordSystemLog({
        phone: formattedPhone, message: body, type: SMS_TYPES.SINGLE, audience,
        status: SMS_STATUS.SENT, transactionId: result.messageId,
        apiResponse: result.data, senderName, result,
      });

      logger.info(`System SMS sent to ${formattedPhone} (${audience}) via ${result.provider}`);
      return { success: true, smsLog, response: result.data, provider: result.provider };
    } catch (error) {
      await this.recordSystemLog({
        phone: formattedPhone, message: body, type: SMS_TYPES.SINGLE, audience,
        status: SMS_STATUS.FAILED, errorMessage: error.message,
        apiResponse: error.gatewayResponse || null, senderName, error,
      });

      logger.error(`Failed to send system SMS to ${formattedPhone}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send single SMS
   */
  async sendSingle(shopId, userId, phone, message, customerId = null, req = null, options = {}) {
    // Sign it off with the shop's name. Idempotent, so the templated messages
    // that already end in "- Shop Name" are untouched; a free-text one written
    // on the SMS page gets the tail it needs to not read as spam.
    //
    // This happens BEFORE the segment count, because the sign-off is part of
    // what the shop is billed for. Counting the draft and sending the signed
    // version is how a one-segment message becomes a two-segment invoice.
    const shopName = options.shopName ?? (await this.getShopName(shopId));
    const body = appendShopSignature(message, shopName);

    const smsInfo = countSms(body);
    const segmentCost = smsInfo.segments || 1;

    // Reserve up front — see reserveQuota. Refunded below if the send fails, so
    // a gateway outage never quietly eats a shop's balance.
    await this.reserveQuota(shopId, segmentCost);

    const formattedPhone = formatPhone(phone);

    try {
      // The gateway's dialect, its refusal-with-HTTP-200 trap and the choice of
      // which gateway to use all live below the dispatcher now. What comes back
      // is normalised and already stamped with the provider that sent it.
      const result = await dispatcher.sendSingle(formattedPhone, body);

      const gateway = await this.buildGatewayRecord({
        shopId, segments: segmentCost, result, sent: true, method: 'single',
      });

      // Log SMS
      const smsLog = await SMSLog.create({
        shop: shopId,
        branch: req ? requireBranch(req) : null,
        recipients: [{
          phone: formattedPhone,
          customer: customerId,
          status: SMS_STATUS.SENT
        }],
        message: body,
        type: SMS_TYPES.SINGLE,
        transactionId: result.messageId,
        cost: segmentCost,
        status: SMS_STATUS.SENT,
        sentCount: 1,
        // A single send finishes inside the call, so this is within
        // milliseconds of `createdAt` — recorded anyway so the panel reads one
        // field for "when did it leave" across single, campaign and OTP rows.
        sentAt: new Date(),
        apiResponse: result.data,
        sentBy: userId,
        invoiceNumber: options.invoiceNumber || null,
        sale: options.saleId || null,
        gateway
      });

      if (result.failedOver) {
        logger.warn(
          `SMS to ${formattedPhone} delivered by ${result.provider} after ${result.failedProvider} failed: ${result.failedReason}`
        );
      }
      logger.info(`SMS sent to ${formattedPhone} for shop ${shopId} via ${result.provider}`);
      return { success: true, smsLog, response: result.data, provider: result.provider };
    } catch (error) {
      // The shop paid for a message that never left. Give it back before
      // anything else — a throw on the way out must not strand the reservation.
      await SMSQuota.refund(shopId, segmentCost).catch((refundErr) =>
        logger.error(`SMS: quota refund failed for shop ${shopId}: ${refundErr.message}`)
      );

      // The shop was refunded, so this send earned nothing — but the gateway
      // that refused may still have charged us, and `failed: true` is what keeps
      // that cost in the margin report instead of losing it.
      const gateway = await this.buildGatewayRecord({
        shopId, segments: segmentCost, error, sent: false,
        errorMessage: error.message, method: 'single',
      });

      // Log failed attempt
      await SMSLog.create({
        shop: shopId,
        branch: req ? requireBranch(req) : null,
        recipients: [{ phone: formattedPhone, customer: customerId, status: SMS_STATUS.FAILED }],
        message: body,
        type: SMS_TYPES.SINGLE,
        status: SMS_STATUS.FAILED,
        failedCount: 1,
        errorMessage: error.message,
        // Present when the gateway refused rather than the request failing —
        // it is the only record of what it objected to.
        apiResponse: error.gatewayResponse || null,
        sentBy: userId,
        gateway
      });

      logger.error(`Failed to send SMS: ${error.message}`);
      throw error;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * BULK CAMPAIGNS
   *
   * One entry point behind both "the same message to everyone" (bulk) and "a
   * different message each" (dynamic), because everything except the shape of
   * the gateway payload is identical between them: clean the list, sign every
   * body with the shop's name, price it, reserve the balance, send in batches,
   * refund what never left, and keep a progress record the dashboard can watch.
   *
   * What this replaced sent every recipient in a single call and logged the
   * whole campaign `sent` on one 200 or `failed` on one error. At forty
   * recipients that is fine. At four thousand it is a 70KB request against a
   * 10s timeout where a single hiccup marks four thousand customers failed,
   * bills the shop for all of them, and leaves nobody able to say which — if
   * any — actually arrived.
   * ═══════════════════════════════════════════════════════════════════════════ */

  /**
   * Run a campaign.
   *
   * @param {string|ObjectId} shopId
   * @param {string|ObjectId} userId
   * @param {object}  options
   * @param {Array}   options.recipients   `[{ phone, customerId, customerName, message? }]`
   * @param {string}  [options.message]    One body for everyone (bulk sends).
   * @param {boolean} [options.personalized=false] Each recipient carries its own
   *        `message` instead (dynamic sends).
   * @param {string}  [options.audience='manual'] Recorded on the log for history.
   * @param {'T'|'P'} [options.transactionType]  Transactional or promotional.
   * @param {boolean} [options.forceSync=false]  Finish before returning, however
   *        large. Used by callers that have no way to poll for progress.
   * @param {object}  [req] For branch scoping. Read now, not later — the worker
   *        outlives the request.
   *
   * @returns {Promise<object>} For a small send, the finished result. For a
   *          large one, `{ queued: true, campaignId }` and the work continues.
   */
  async sendCampaign(shopId, userId, options, req = null) {
    const {
      recipients = [],
      message = '',
      personalized = false,
      audience = 'manual',
      transactionType = personalized ? 'T' : 'P',
      forceSync = false,
    } = options;

    const shopName = options.shopName ?? (await this.getShopName(shopId));
    const branch = req ? requireBranch(req) : null;

    // 1. Clean the list before anything is priced or reserved. Dropping a bad
    //    number after the quota is taken means charging for it.
    const { valid, skipped, skippedCount } = normalizeRecipients(recipients, {
      requireMessage: personalized,
    });

    if (valid.length === 0) {
      logger.warn(`SMS campaign for shop ${shopId} had no usable recipients (${skippedCount} skipped)`);
      return {
        success: false,
        reason: 'no_valid_recipients',
        sentCount: 0,
        failedCount: 0,
        skippedCount,
        skipped: skipped.slice(0, MAX_SKIPPED_STORED),
      };
    }

    // 2. Sign every body. `appendShopSignature` is idempotent, so a template
    //    that already ends in "- Shop Name" is left exactly as it is.
    const sharedBody = personalized ? '' : appendShopSignature(message, shopName);
    const targets = personalized
      ? valid.map((r) => ({ ...r, message: appendShopSignature(r.message, shopName) }))
      : valid;

    // 3. Price it — after signing, so the quote covers what actually goes out.
    let totalCost = 0;
    let maxSegments = 0;
    if (personalized) {
      for (const r of targets) {
        const info = countSms(r.message);
        const segments = info.segments || 1;
        totalCost += segments;
        if (segments > maxSegments) maxSegments = segments;
      }
    } else {
      maxSegments = countSms(sharedBody).segments || 1;
      totalCost = maxSegments * targets.length;
    }

    // A body this long is almost always a mistake — a pasted paragraph, or a
    // stray Bangla character that dropped the budget from 160 characters to 70.
    // Catching it here costs one refusal; not catching it costs the whole
    // campaign multiplied by the recipient count.
    if (maxSegments > BULK.MAX_SEGMENTS) {
      throw new Error(
        `Message is too long: ${maxSegments} segments, maximum ${BULK.MAX_SEGMENTS}`
      );
    }

    // 4. Reserve the whole cost up front. Deducting per batch would let a
    //    campaign start, spend half the balance and stop halfway — with no way
    //    to have warned the shopkeeper that it would.
    await this.reserveQuota(shopId, totalCost);

    const batches = chunk(targets, BULK.BATCH_SIZE);

    // 5. The log is written BEFORE the first gateway call, not after the last.
    //    A crash mid-campaign then leaves a record that says what was attempted
    //    and how far it got, instead of leaving no trace of a spent balance.
    const smsLog = await SMSLog.create({
      shop: shopId,
      branch,
      recipients: targets.map((r) => ({
        phone: r.phone,
        customer: r.customerId,
        customerName: r.customerName,
        message: personalized ? r.message : undefined,
        status: SMS_STATUS.PENDING,
      })),
      // Dynamic sends have no single body; the per-recipient ones are on the
      // recipients. Storing the first as a sample beats the old placeholder
      // string "Dynamic SMS - Multiple personalized messages", which told a
      // shopkeeper reading their history nothing about what they had sent.
      message: personalized ? targets[0].message : sharedBody,
      type: personalized ? SMS_TYPES.DYNAMIC : SMS_TYPES.BULK,
      audience,
      cost: totalCost,
      status: SMS_STATUS.PENDING,
      sentCount: 0,
      failedCount: 0,
      skippedCount,
      skipped: skipped.slice(0, MAX_SKIPPED_STORED),
      sentBy: userId,
      progress: {
        total: targets.length,
        processed: 0,
        batches: batches.length,
        batchesDone: 0,
        startedAt: new Date(),
      },
    });

    const runOptions = {
      logId: smsLog._id,
      shopId,
      batches,
      sharedBody,
      personalized,
      transactionType,
      totalCost,
    };

    // 6. Small enough to finish inside the request? Then finish it, and hand
    //    back a real answer rather than a progress bar to babysit.
    if (forceSync || targets.length <= BULK.SYNC_LIMIT) {
      const summary = await this.runCampaign(runOptions);
      return {
        success: summary.sentCount > 0,
        queued: false,
        campaignId: smsLog._id,
        smsLog: await SMSLog.findById(smsLog._id).lean(),
        skippedCount,
        ...summary,
      };
    }

    // 7. Too big for one request — hand it to the durable queue.
    //
    //    This used to be `setImmediate`, which ran the batches in-process after
    //    the response. Under PM2 that is not a rare-crash risk, it is EVERY
    //    DEPLOY: `pm2 reload` stops workers gracefully, and an in-flight
    //    campaign dies with them, leaving the log stuck at `pending` forever
    //    with the shop's quota already spent.
    await this.enqueueCampaign(runOptions, {
      logId: smsLog._id,
      shopId,
      reservedSegments: totalCost,
    });

    return {
      success: true,
      queued: true,
      campaignId: smsLog._id,
      totalRecipients: targets.length,
      batches: batches.length,
      estimatedCost: totalCost,
      skippedCount,
      sentCount: 0,
      failedCount: 0,
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * PLATFORM BROADCASTS
   *
   * The operator texting the shopkeepers, rather than a shopkeeper texting
   * their customers. Same gateway, same batching, same progress record — and
   * three deliberate differences, each of which is a bug if it is forgotten:
   *
   *   1. NO QUOTA. `SMSQuota` is a shop's prepaid balance, bought with their
   *      money. Charging an expiry notice or a feature announcement to it bills
   *      the shop for the platform's own messaging. Worse, quota starts
   *      `isEnabled: false`, so a quota-gated broadcast would silently skip
   *      every shop that has never bought credits — which is exactly the set
   *      most likely to need chasing.
   *   2. THE PLATFORM SIGNS IT. `appendShopSignature` with the shop's name
   *      would sign an announcement as the shop that received it.
   *   3. `shop: null` ON THE LOG. These sends belong to no tenant. `SMSLog.shop`
   *      has always been nullable, so this needs no migration — but it does mean
   *      the shop-facing history must never widen its filter to include them.
   * ═══════════════════════════════════════════════════════════════════════════ */

  /**
   * Run a broadcast on the platform's own account.
   *
   * @param {object}  options
   * @param {Array}   options.recipients  `[{ phone, name, shopId, message? }]`
   * @param {string}  [options.message]   One body for everyone.
   * @param {boolean} [options.personalized=false] Each recipient carries its own.
   * @param {string}  options.senderName  What the message signs off as.
   * @param {string}  [options.audience]  Recorded on the log for history.
   * @param {'T'|'P'} [options.transactionType='T']
   * @param {object}  [options.admin]     `{ id, name }` — who pressed send.
   *
   * @returns {Promise<object>} Finished result for a small send, or
   *          `{ queued: true, campaignId }` with the work continuing behind it.
   */
  async sendPlatformCampaign(options = {}) {
    const {
      recipients = [],
      message = '',
      personalized = false,
      senderName = 'Hisaab',
      audience = 'platform_manual',
      transactionType = 'T',
      admin = null,
      forceSync = false,
    } = options;

    const { valid, skipped, skippedCount } = normalizeRecipients(recipients, {
      requireMessage: personalized,
    });

    if (valid.length === 0) {
      return {
        success: false,
        reason: 'no_valid_recipients',
        sentCount: 0,
        failedCount: 0,
        skippedCount,
        skipped: skipped.slice(0, MAX_SKIPPED_STORED),
      };
    }

    const sharedBody = personalized ? '' : appendShopSignature(message, senderName);
    const targets = personalized
      ? valid.map((r) => ({ ...r, message: appendShopSignature(r.message, senderName) }))
      : valid;

    // Priced for reporting only — nothing is reserved, because the platform is
    // billed by MimSMS directly rather than out of a balance held here. The
    // figure still matters: it is what the operator is told a broadcast will
    // cost before they confirm it, and what the log records afterwards.
    let totalCost = 0;
    let maxSegments = 0;
    if (personalized) {
      for (const r of targets) {
        const segments = countSms(r.message).segments || 1;
        totalCost += segments;
        if (segments > maxSegments) maxSegments = segments;
      }
    } else {
      maxSegments = countSms(sharedBody).segments || 1;
      totalCost = maxSegments * targets.length;
    }

    // The same ceiling a shop's campaign gets, for the same reason — except the
    // blast radius here is every shopkeeper on the platform at once.
    if (maxSegments > BULK.MAX_SEGMENTS) {
      throw new Error(
        `Message is too long: ${maxSegments} segments, maximum ${BULK.MAX_SEGMENTS}`
      );
    }

    const batches = chunk(targets, BULK.BATCH_SIZE);

    const smsLog = await SMSLog.create({
      shop: null,
      branch: null,
      recipients: targets.map((r) => ({
        phone: r.phone,
        customerName: r.customerName || r.name,
        message: personalized ? r.message : undefined,
        status: SMS_STATUS.PENDING,
      })),
      message: personalized ? targets[0].message : sharedBody,
      type: personalized ? SMS_TYPES.DYNAMIC : SMS_TYPES.BULK,
      audience,
      cost: totalCost,
      status: SMS_STATUS.PENDING,
      sentCount: 0,
      failedCount: 0,
      skippedCount,
      skipped: skipped.slice(0, MAX_SKIPPED_STORED),
      // NOT `sentBy`. That field refs `User`, and an Admin id put through it
      // populates as null — the SMS log page would show every broadcast as sent
      // by nobody.
      sentByAdmin: admin?.id || null,
      senderName,
      progress: {
        total: targets.length,
        processed: 0,
        batches: batches.length,
        batchesDone: 0,
        startedAt: new Date(),
      },
    });

    const runOptions = {
      logId: smsLog._id,
      shopId: null,
      batches,
      sharedBody,
      personalized,
      transactionType,
      totalCost,
    };

    if (forceSync || targets.length <= BULK.SYNC_LIMIT) {
      const summary = await this.runCampaign(runOptions);
      return {
        success: summary.sentCount > 0,
        queued: false,
        campaignId: smsLog._id,
        skippedCount,
        skipped: skipped.slice(0, MAX_SKIPPED_STORED),
        ...summary,
      };
    }

    // Durable, same as a shop campaign. Nothing is reserved here, so there is
    // no quota to unwind if the queue refuses — but the log still has to say so
    // rather than sit at `pending` forever, which `enqueueCampaign` handles.
    await this.enqueueCampaign(runOptions, {
      logId: smsLog._id,
      shopId: null,
      reservedSegments: 0,
    });

    return {
      success: true,
      queued: true,
      campaignId: smsLog._id,
      totalRecipients: targets.length,
      batches: batches.length,
      estimatedCost: totalCost,
      skippedCount,
      skipped: skipped.slice(0, MAX_SKIPPED_STORED),
      sentCount: 0,
      failedCount: 0,
    };
  }

  /**
   * Progress of a platform broadcast.
   *
   * Deliberately separate from `getCampaign`, which scopes by shop. A broadcast
   * has no shop to scope to, so this one is reachable only from behind the
   * admin guard — which is why it must never be mounted on the shop router.
   */
  async getPlatformCampaign(campaignId) {
    const log = await SMSLog.findOne({ _id: campaignId, shop: null }).lean();
    if (!log) return null;

    const progress = log.progress || {};
    const total = progress.total || log.recipients?.length || 0;
    const processed = progress.processed || 0;

    return {
      campaignId: log._id,
      status: log.status,
      audience: log.audience,
      message: log.message,
      senderName: log.senderName,
      total,
      processed,
      percent: total > 0 ? Math.round((processed / total) * 100) : 0,
      sentCount: log.sentCount || 0,
      failedCount: log.failedCount || 0,
      skippedCount: log.skippedCount || 0,
      skipped: log.skipped || [],
      cost: log.cost || 0,
      batches: progress.batches || 0,
      batchesDone: progress.batchesDone || 0,
      isComplete: Boolean(progress.completedAt),
      startedAt: progress.startedAt || log.createdAt,
      completedAt: progress.completedAt || null,
      errorMessage: log.errorMessage || null,
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * DURABLE QUEUEING
   *
   * Everything above builds a campaign and writes its log. This is what makes
   * the work survive the process that created it.
   *
   * The rule when Redis is unavailable is REFUSE, not fall back. A campaign
   * that quietly reverts to `setImmediate` is one that quietly dies on the next
   * `pm2 reload` — the exact failure the queue exists to remove, reintroduced
   * as an untested path. So the reservation is returned, the log is marked
   * failed, and the caller is told plainly. A shopkeeper who is told "try again
   * in a minute" is better served than one whose campaign vanishes.
   * ═══════════════════════════════════════════════════════════════════════════ */

  /**
   * Hand a prepared campaign to the queue.
   *
   * @param {object} runOptions   Exactly what `runCampaign` needs.
   * @param {object} meta         `{ logId, shopId, reservedSegments }` — used to
   *                              unwind cleanly if the queue will not take it.
   */
  async enqueueCampaign(runOptions, { logId, shopId, reservedSegments = 0 } = {}) {
    const { isQueueEnabled, getSmsQueue } = require('../config/queue.config');

    const queue = isQueueEnabled() ? getSmsQueue() : null;

    if (!queue) {
      // Give the money back before anything else, then make the log say what
      // happened. A campaign that cannot start must not leave a shop paying for
      // it, and must not leave a document stuck at `pending` forever.
      if (shopId && reservedSegments > 0) {
        await SMSQuota.refund(shopId, reservedSegments).catch((err) =>
          logger.error(`SMS campaign ${logId} refund failed: ${err.message}`)
        );
      }
      await SMSLog.updateOne(
        { _id: logId },
        {
          $set: {
            status: SMS_STATUS.FAILED,
            cost: 0,
            errorMessage: 'Queue unavailable — Redis is not reachable',
            'progress.completedAt': new Date(),
          },
        }
      ).catch(() => {});

      logger.error(`SMS campaign ${logId} refused: queue unavailable`);
      throw new Error(
        'Cannot start a large campaign right now — the job queue is unavailable. Please try again shortly.'
      );
    }

    // The job carries ONLY the log id. Everything else is rehydrated from the
    // SMSLog when the worker picks it up, for three reasons:
    //
    //   · size — a 5,000-recipient campaign is ~600KB of recipient data, and
    //     putting that in Redis (on shared hosting, alongside the cache) to
    //     describe a document that already holds it is pure duplication;
    //   · truth — a retry reads the log as it is NOW, so it cannot act on a
    //     stale snapshot of a campaign that has since moved on;
    //   · resumption — `progress.batchesDone` lives on the log, which is what
    //     lets a retry continue instead of starting over.
    //
    // `jobId` is the log id too, so BullMQ dedupes for free: a double-submitted
    // campaign cannot enqueue twice, because the second add finds the id taken.
    const job = await queue.add('run-campaign', { logId: String(logId) }, {
      jobId: String(logId),
    });

    logger.info(
      `SMS campaign ${logId} enqueued as job ${job.id}: ` +
      `${runOptions.batches.length} batches, ${runOptions.totalCost} segments`
    );

    return job;
  }

  /**
   * The queue's processor. One job = one campaign.
   *
   * Rebuilds the run from the log, and — crucially — RESUMES rather than
   * restarts. BullMQ retries on failure, and a worker killed at batch 30 of 40
   * that restarted from batch 0 would re-send to the first 3,000 recipients.
   * Re-sending is worse than not sending: the shop pays twice and the customer
   * reads the same message twice.
   */
  async processCampaignJob({ logId }) {
    const log = await SMSLog.findById(logId).lean();

    if (!log) {
      logger.warn(`SMS campaign job for ${logId} has no log — nothing to run`);
      return { skipped: 'no_log' };
    }

    // A worker killed after the final write but before the job was acked gets
    // its job redelivered. Re-sending an entire finished campaign because an
    // ack was lost is the worst outcome a retry can have.
    if (log.progress?.completedAt) {
      logger.warn(`SMS campaign ${logId} already complete — refusing to re-send`);
      return { skipped: 'already_complete' };
    }

    const personalized = log.type === SMS_TYPES.DYNAMIC;
    const targets = (log.recipients || []).map((r) => ({
      phone: r.phone,
      customerName: r.customerName,
      message: r.message,
    }));

    const batches = chunk(targets, BULK.BATCH_SIZE);
    const startBatch = Math.min(log.progress?.batchesDone || 0, batches.length);

    if (startBatch > 0) {
      logger.info(
        `SMS campaign ${logId} resuming at batch ${startBatch + 1} of ${batches.length}`
      );
    }

    return this.runCampaign({
      logId: log._id,
      shopId: log.shop || null,
      batches,
      sharedBody: personalized ? '' : log.message,
      personalized,
      totalCost: log.cost || 0,
      startBatch,
      // Counts carry across a resume so the final tally covers the whole
      // campaign, not just the batches this attempt happened to run.
      sentCount: log.sentCount || 0,
      failedCount: log.failedCount || 0,
      // Likewise the first-send time. A resume that re-stamped it would move
      // "when did this campaign start reaching people" forward to whenever the
      // worker was restarted, which is the one thing the field exists to say.
      sentAt: log.sentAt || null,
    });
  }

  /**
   * Book a finished campaign's cost and revenue, per gateway, and build the
   * `gateway` record the campaign's log row carries.
   *
   * Never throws — the campaign has already happened, and a bookkeeping failure
   * must not turn a delivered campaign into a failed one.
   *
   * @returns {Promise<object>} the SMSLog.gateway subdocument
   */
  async recordCampaignEarnings({ shopId, tally, lastResponse = null }) {
    const rows = tally.rows();
    const winner = tally.primary();

    const record = {
      provider: winner?.provider || null,
      method: winner?.method || null,
      messageId: null,
      statusCode: null,
      senderId: null,
      failedOver: tally.anyFailedOver(),
      failedProvider: winner?.failedProvider || null,
      failedReason: winner?.failedReason || null,
      billedSegments: rows.reduce((s, r) => s + r.sentSegments + r.failedSegments, 0),
      unitCost: null,
      totalCost: null,
      revenue: null,
      raw: lastResponse,
    };

    let totalCost = 0;
    let revenue = 0;
    let priced = false;

    for (const row of rows) {
      try {
        // Delivered segments: cost AND revenue.
        if (row.sentSegments > 0) {
          const sent = await smsEarnings.priceAndRecord({
            shopId, provider: row.provider, segments: row.sentSegments,
            failedOver: row.failedOverBatches > 0, failed: false,
          });
          if (sent.totalCost !== null) { totalCost += sent.totalCost; priced = true; }
          if (sent.revenue !== null) revenue += sent.revenue;
        }

        // Failed segments: cost only. The shop got its quota back.
        if (row.failedSegments > 0) {
          const failed = await smsEarnings.priceAndRecord({
            shopId, provider: row.provider, segments: row.failedSegments,
            failedOver: row.failedOverBatches > 0, failed: true,
          });
          if (failed.totalCost !== null) { totalCost += failed.totalCost; priced = true; }
        }
      } catch (err) {
        logger.error(`SMS: campaign earnings booking failed for ${row.provider}: ${err.message}`);
      }
    }

    if (priced) {
      record.totalCost = Number(totalCost.toFixed(4));
      record.unitCost = record.billedSegments > 0
        ? Number((totalCost / record.billedSegments).toFixed(4))
        : null;
    }
    record.revenue = Number(revenue.toFixed(4));

    return record;
  }

  /**
   * Push one batch at the gateway, failing over if the primary refuses.
   *
   * Never throws: a batch that cannot be sent is a fact about that batch, not a
   * reason to abandon the thirty-nine after it.
   *
   * ── What changed when the second gateway arrived ────────────────────────────
   *
   * This used to hold its own single-retry loop against MimSMS. That retry is
   * gone, and deliberately: when a batch fails for a transport reason, the far
   * better second attempt is the OTHER gateway, not the one that just timed out.
   * The dispatcher makes that call, and a `permanent` refusal — an unapproved
   * sender, a spam rejection — still gets exactly one attempt, because the
   * second gateway would refuse it identically.
   *
   * ── Per-recipient results ───────────────────────────────────────────────────
   *
   * `results` comes back one entry per recipient, in input order, whichever
   * gateway answered. Automas reports each recipient individually; MimSMS
   * answers once for the whole batch and its adapter widens that verdict. The
   * caller may therefore rely on the array existing — and MUST mark sent only
   * the entries it confirms, which is what stops a batch-level success from
   * blanket-marking recipients the gateway never accepted.
   */
  async sendBatch(batch, { sharedBody, personalized, transactionType, routingConfig = null }) {
    // The SKIP_SMS guard now lives in each adapter, so a simulated run exercises
    // the real dispatch path — including failover — rather than short-circuiting
    // before it. Campaigns can be rehearsed at full size without sending.
    try {
      const result = personalized
        ? await dispatcher.sendDynamic(
          batch.map((r) => ({ phone: r.phone, message: r.message })),
          { routingConfig }
        )
        : await dispatcher.sendBulk(
          batch.map((r) => r.phone),
          sharedBody,
          { routingConfig }
        );

      // A gateway that accepted nobody is a failed batch, even though the call
      // itself returned. Without this the refund path never runs for a batch
      // that was refused per-recipient rather than outright.
      const confirmed = (result.results || []).filter((r) => r.success).length;
      if (confirmed === 0) {
        const firstReason = (result.results || []).find((r) => r.error)?.error;
        return {
          ok: false,
          error: new Error(firstReason || 'Gateway accepted no recipients in this batch'),
          response: result.data,
          results: result.results || [],
          provider: result.provider,
          method: result.method,
        };
      }

      return {
        ok: true,
        response: result.data,
        results: result.results || [],
        provider: result.provider,
        method: result.method,
        failedOver: Boolean(result.failedOver),
        failedProvider: result.failedProvider || null,
        failedReason: result.failedReason || null,
        confirmed,
      };
    } catch (error) {
      return {
        ok: false,
        error,
        response: error.gatewayResponse || null,
        results: [],
        provider: error.provider || error.failoverProvider || null,
      };
    }
  }

  /**
   * Walk the batches, recording the outcome of each as it lands.
   *
   * The log is updated per batch rather than once at the end for two reasons:
   * the dashboard's progress bar has nothing to read otherwise, and a process
   * that dies at batch thirty of forty leaves thirty batches' worth of truth
   * behind instead of a document still claiming `pending`.
   *
   * Only the batch's own slice of `recipients` is written each time — a
   * positional `$set` rather than a rewrite of the whole array, which on a
   * five-thousand-recipient campaign would mean re-serialising ~600KB fifty
   * times over.
   */
  async runCampaign({
    logId,
    shopId,
    batches,
    sharedBody,
    personalized,
    transactionType,
    totalCost,
    // Resumption state. A retried job restarts at the first batch that never
    // ran, carrying forward what the previous attempt already achieved — see
    // `processCampaignJob`. Defaulted so a first run is unaffected.
    startBatch = 0,
    sentCount: initialSent = 0,
    failedCount: initialFailed = 0,
    sentAt: initialSentAt = null,
  }) {
    // Where in the recipient array the starting batch begins. Derived from the
    // batches themselves rather than assumed to be `startBatch × BATCH_SIZE`,
    // because the final batch is short and an assumed stride would write the
    // per-recipient statuses to the wrong positions on a resume.
    let offset = batches
      .slice(0, startBatch)
      .reduce((sum, batch) => sum + batch.length, 0);

    let sentCount = initialSent;
    let failedCount = initialFailed;
    let sentAt = initialSentAt;
    let refundSegments = 0;
    let transactionId = null;
    let lastResponse = null;
    let lastError = null;

    /* Resolve the routing ONCE for the whole campaign.
     *
     * Not once per batch and emphatically not once per recipient: a
     * five-thousand-recipient campaign would otherwise re-read the same settings
     * document five thousand times to be told the same answer. The resolved
     * config is handed down to every batch instead.
     *
     * A lookup failure is not fatal — `resolve` never throws and falls back to
     * the platform default, which is the behaviour this had before routing was
     * configurable at all.
     */
    const routingConfig = await smsRouting.resolve();

    // Which gateway carried how much of this campaign. Failover can move a
    // single campaign between gateways part-way through, so the accounting has
    // to be per provider rather than one figure for the run.
    const providerTally = createProviderTally();

    for (let index = startBatch; index < batches.length; index++) {
      const batch = batches[index];
      const result = await this.sendBatch(batch, {
        sharedBody, personalized, transactionType, routingConfig,
      });

      const batchReason = result.ok ? null : (result.error?.message || 'Gateway error');

      /* Per-recipient truth, not a batch-level guess.
       *
       * `results` is one entry per recipient in input order. Automas answers per
       * recipient; MimSMS answers once and its adapter widens that verdict. When
       * the array is missing or the wrong length — a shape we do not recognise —
       * the batch-level verdict stands in for everyone, which is the honest
       * fallback.
       *
       * What must never happen is the reverse: a batch-level success marking
       * recipients sent whose own entry says otherwise. That overstates delivery,
       * charges the shop for messages nobody received, and leaves no way to tell
       * who actually missed out.
       */
      const perRecipient = Array.isArray(result.results) && result.results.length === batch.length
        ? result.results
        : null;

      const set = {};
      let batchSent = 0;
      let batchFailedSegments = 0;

      batch.forEach((recipient, i) => {
        const position = offset + i;
        const entry = perRecipient ? perRecipient[i] : null;
        const ok = entry ? entry.success : result.ok;
        const reason = ok ? null : (entry?.error || batchReason || 'Gateway error');

        set[`recipients.${position}.status`] = ok ? SMS_STATUS.SENT : SMS_STATUS.FAILED;
        if (reason) set[`recipients.${position}.failedReason`] = reason;

        if (ok) {
          batchSent += 1;
        } else {
          // Give back exactly what this recipient was priced at, not a flat one
          // each — a two-segment message costs two.
          batchFailedSegments += personalized
            ? (countSms(recipient.message).segments || 1)
            : (countSms(sharedBody).segments || 1);
        }
      });

      sentCount += batchSent;
      failedCount += (batch.length - batchSent);
      refundSegments += batchFailedSegments;

      if (batchSent > 0) {
        lastResponse = result.response;
        // The first batch the gateway takes IS when this campaign started
        // reaching people — written now rather than at completion, because a
        // campaign that dies at batch 30 of 40 still reached three thousand
        // customers and the log has to be able to say when.
        if (!sentAt) {
          sentAt = new Date();
          set.sentAt = sentAt;
        }
        if (!transactionId) {
          transactionId = result.response?.TransactionId
            || perRecipient?.find((r) => r.messageId)?.messageId
            || null;
        }
      }

      if (batchSent < batch.length) {
        lastError = batchReason || 'Gateway rejected some recipients';
        // Keep the refusal body too. It is the only place the gateway says WHY,
        // and the admin log's "Raw gateway response" panel is what an operator
        // reads when a campaign fails — showing the last SUCCESS there while
        // the status says failed is how a wrong diagnosis starts.
        if (result.response) lastResponse = result.response;
      }

      // Book what this batch cost and earned, per gateway. Done per batch rather
      // than once at the end because failover can move a single campaign between
      // gateways mid-run, and a campaign-level figure would attribute the whole
      // thing to whichever one happened to answer last.
      if (result.provider) {
        providerTally.add(result.provider, {
          sentSegments: personalized
            ? batch.reduce((sum, r, i) => {
              const ok = perRecipient ? perRecipient[i].success : result.ok;
              return ok ? sum + (countSms(r.message).segments || 1) : sum;
            }, 0)
            : (countSms(sharedBody).segments || 1) * batchSent,
          failedSegments: batchFailedSegments,
          failedOver: Boolean(result.failedOver),
          method: result.method,
          failedProvider: result.failedProvider,
          failedReason: result.failedReason,
        });
      }

      offset += batch.length;

      await SMSLog.updateOne(
        { _id: logId },
        {
          $set: {
            ...set,
            status: SMS_STATUS.PENDING,
            sentCount,
            failedCount,
            'progress.processed': offset,
            'progress.batchesDone': index + 1,
          },
        }
      ).catch((err) => logger.error(`SMS campaign ${logId} progress write failed: ${err.message}`));

      // Space the calls out. A gateway handed forty back-to-back batches is a
      // gateway that starts rate-limiting halfway through the campaign.
      if (index < batches.length - 1) {
        await sleep(BULK.BATCH_DELAY_MS);
      }
    }

    const finalStatus =
      failedCount === 0 ? SMS_STATUS.SENT
        : sentCount === 0 ? SMS_STATUS.FAILED
        : SMS_STATUS.PARTIAL;

    // `shopId` is null for a platform broadcast, which was never charged to a
    // quota in the first place — there is nothing to give back, and calling
    // refund with a null shop would scan the collection for a document that
    // cannot exist. The segment total is still reported so the operator sees
    // what the failed batches would have cost.
    if (shopId && refundSegments > 0) {
      await SMSQuota.refund(shopId, refundSegments).catch((err) =>
        logger.error(`SMS campaign ${logId} refund failed: ${err.message}`)
      );
    }

    /* Book the campaign's money, one entry per gateway that carried part of it.
     *
     * Per provider rather than per campaign because failover splits a run across
     * two gateways at two different rates. Sent and failed segments are booked
     * separately: the shop is refunded for what failed, so it earns nothing, but
     * the gateway may still have charged us — dropping that cost would flatter
     * the margin by exactly the amount a bad night cost.
     */
    const gatewayRecord = await this.recordCampaignEarnings({
      shopId, tally: providerTally, lastResponse,
    });

    await SMSLog.updateOne(
      { _id: logId },
      {
        $set: {
          status: finalStatus,
          // Bill for what went, not for what was reserved.
          cost: Math.max(0, totalCost - refundSegments),
          transactionId,
          apiResponse: lastResponse,
          errorMessage: lastError,
          'progress.completedAt': new Date(),
          gateway: gatewayRecord,
        },
      }
    );

    logger.info(
      `SMS campaign ${logId} finished: ${sentCount} sent, ${failedCount} failed, ` +
      `${refundSegments} segments refunded`
    );

    return {
      status: finalStatus,
      sentCount,
      failedCount,
      refundedSegments: refundSegments,
      cost: Math.max(0, totalCost - refundSegments),
    };
  }

  /**
   * Send bulk SMS (same message to multiple recipients).
   *
   * Kept as the name every existing caller already uses; the batching, the
   * sign-off and the refunds all live in `sendCampaign` now.
   */
  async sendBulk(shopId, userId, recipients, message, req = null, options = {}) {
    return this.sendCampaign(
      shopId,
      userId,
      { recipients, message, personalized: false, transactionType: 'P', ...options },
      req
    );
  }

  /**
   * Send dynamic SMS (a personalised body per recipient).
   */
  async sendDynamic(shopId, userId, recipients, req = null, options = {}) {
    return this.sendCampaign(
      shopId,
      userId,
      { recipients, personalized: true, transactionType: 'T', ...options },
      req
    );
  }

  /**
   * Progress of a campaign, for the dashboard to poll.
   *
   * Scoped to the shop rather than looked up by id alone — a campaign id is a
   * guessable ObjectId, and this endpoint returns customer phone numbers.
   */
  async getCampaign(shopId, campaignId) {
    const log = await SMSLog.findOne({ _id: campaignId, shop: shopId }).lean();
    if (!log) return null;

    const progress = log.progress || {};
    const total = progress.total || log.recipients?.length || 0;
    const processed = progress.processed || 0;

    return {
      campaignId: log._id,
      status: log.status,
      type: log.type,
      audience: log.audience,
      message: log.message,
      total,
      processed,
      percent: total > 0 ? Math.round((processed / total) * 100) : 0,
      sentCount: log.sentCount || 0,
      failedCount: log.failedCount || 0,
      skippedCount: log.skippedCount || 0,
      skipped: log.skipped || [],
      cost: log.cost || 0,
      batches: progress.batches || 0,
      batchesDone: progress.batchesDone || 0,
      // A campaign is done when the worker stamped it done. Inferring it from
      // `processed === total` would read the last batch's progress write as
      // completion a moment before the refund and final status land.
      isComplete: Boolean(progress.completedAt),
      startedAt: progress.startedAt || log.createdAt,
      completedAt: progress.completedAt || null,
      errorMessage: log.errorMessage || null,
    };
  }

  /**
   * Who a campaign would go to.
   *
   * The audience is resolved on the SERVER, from an audience *name*, rather
   * than the dashboard downloading every customer and posting back a list of
   * phone numbers. Three reasons, in order of how much they matter:
   *
   *   1. Correctness. Under separate books a customer's due is a per-branch
   *      figure held in `CustomerBalance`. The client's copy of `totalDue` is
   *      the shop-wide total, so a "শুধু বাকিদার" campaign built client-side
   *      texts people who owe another branch — and quotes them that branch's
   *      number.
   *   2. Trust. A client that names its own recipients can name anyone.
   *   3. Scale. A shop with eight thousand customers should not have to load
   *      eight thousand records into a phone browser to text them.
   *
   * NEVER branch-scope the customer query itself: `Customer` has no `branch`
   * field, so `branch: <id>` matches zero documents and the campaign silently
   * sends nothing (FEATURE_AUDIT.md H-7). Branch scoping belongs on the dues.
   */
  async resolveAudience(shopId, audience, customerIds = [], req = null) {
    const Customer = require('../models/Customer.model');
    const CustomerBalance = require('../models/CustomerBalance.model');

    const filter = { shop: shopId, isActive: true };
    if (audience === 'selected') {
      if (!customerIds.length) return [];
      filter._id = { $in: customerIds };
    }

    const customers = await Customer.find(filter)
      .select('name phone totalDue')
      .lean();

    const branchScoped = isBranchCustomerScope(req);

    // Under separate books the amount in the message must be what the customer
    // owes THIS branch — the shop-wide figure would both overstate the debt and
    // disclose another branch's business.
    let dueByCustomer = null;
    if (branchScoped) {
      const rows = await CustomerBalance.find({
        shop: shopId,
        branch: req.branchId,
        customer: { $in: customers.map((c) => c._id) },
      })
        .select('customer totalDue')
        .lean();
      dueByCustomer = new Map(rows.map((r) => [String(r.customer), r.totalDue]));
    }

    const withDue = customers.map((customer) => ({
      phone: customer.phone,
      customerId: customer._id,
      customerName: customer.name,
      name: customer.name,
      due: branchScoped
        ? (dueByCustomer.get(String(customer._id)) || 0)
        : (customer.totalDue || 0),
    }));

    if (audience === 'due') {
      return withDue.filter((r) => r.due > 0);
    }

    return withDue;
  }

  /**
   * How many customers each audience holds, and how many carry a usable number.
   *
   * The composer needs the second figure to quote an honest cost: "সব কাস্টমার
   * — ৮২০ জন" next to a send that reaches 780 of them is a quote that is wrong
   * by forty segments, and the shopkeeper only finds out afterwards.
   */
  async getAudienceCounts(shopId, req = null) {
    // One pass, filtered twice. Asking `resolveAudience` for 'all' and then for
    // 'due' would read the whole customer book — and, on a branch-scoped shop,
    // the whole balance collection — a second time to answer a question the
    // first pass already contains.
    const all = await this.resolveAudience(shopId, 'all', [], req);
    const due = all.filter((r) => r.due > 0);

    const reachable = (list) => normalizeRecipients(list).valid.length;

    return {
      all: { total: all.length, reachable: reachable(all) },
      due: { total: due.length, reachable: reachable(due) },
    };
  }

  /**
   * Balance at the gateway currently routing traffic.
   *
   * Kept single-provider in shape because that is what its callers expect. The
   * operator's view — every gateway's balance side by side — is
   * `checkAllBalances` below, which is what the admin providers screen reads.
   */
  async checkBalance() {
    try {
      const { primaryProvider } = await smsRouting.resolve();
      const result = await registry.getAdapter(primaryProvider).checkBalance();
      if (!result.success) {
        throw new Error(result.error || 'Balance check failed');
      }
      return result.data ?? { balance: result.balance, provider: result.provider };
    } catch (error) {
      logger.error(`Failed to check SMS balance: ${error.message}`);
      throw error;
    }
  }

  /** Every registered gateway's balance. Never throws — see the dispatcher. */
  async checkAllBalances() {
    return dispatcher.checkAllBalances();
  }

  /**
   * Get SMS history for shop
   */
  async getHistory(shopId, options = {}) {
    return SMSLog.getShopHistory(shopId, options);
  }

  /**
   * Get shop quota
   */
  async getQuota(shopId) {
    let quota = await SMSQuota.findOne({ shop: shopId });
    if (!quota) {
      quota = {
        totalQuota: 0,
        usedQuota: 0,
        remainingQuota: 0,
        isEnabled: false,
      };
    }
    return quota;
  }

  /**
   * Send single SMS (wrapper for controller)
   */
  async sendSingleSMS(shopId, userId, data, req = null) {
    const { phone, message, customerId } = data;
    return this.sendSingle(shopId, userId, phone, message, customerId, req);
  }

  /**
   * Send bulk SMS (wrapper for controller)
   */
  async sendBulkSMS(shopId, userId, data, req = null) {
    const { recipients, message } = data;
    return this.sendBulk(shopId, userId, recipients, message, req, { audience: 'manual' });
  }

  /**
   * Send dynamic SMS (wrapper for controller)
   */
  async sendDynamicSMS(shopId, userId, recipients, req = null) {
    return this.sendDynamic(shopId, userId, recipients, req, { audience: 'manual' });
  }

  /**
   * Launch a campaign from an audience name and a template.
   *
   * This is what the SMS page posts: a body with `{placeholders}` in it and the
   * word "all" or "due" — not a list of phone numbers. Everything between those
   * two facts and the gateway happens here and in `sendCampaign`, on the server,
   * where the branch-scoped dues live and where the shop's sign-off cannot be
   * left off.
   */
  async createCampaign(shopId, userId, { message, audience = 'all', customerIds = [] }, req = null) {
    const shopName = await this.getShopName(shopId);
    const contacts = await this.resolveAudience(shopId, audience, customerIds, req);

    // One body for everyone, or one each? `{shop_name}` alone does not make it
    // personal — see isPersonalized — so a plain promo still goes out as a
    // single cheap bulk call rather than as N addressed sends.
    const personalized = isPersonalized(message);

    const recipients = personalized
      ? contacts.map((c) => ({ ...c, message: personalizeMessage(message, c, shopName) }))
      : contacts;

    return this.sendCampaign(
      shopId,
      userId,
      {
        recipients,
        message: personalized ? '' : personalizeMessage(message, {}, shopName),
        personalized,
        audience,
        shopName,
        transactionType: personalized ? 'T' : 'P',
      },
      req
    );
  }

  /**
   * Send due reminder SMS to customers
   */
  async sendDueReminder(shopId, userId, customerIds, req = null) {
    const Customer = require('../models/Customer.model');
    const CustomerBalance = require('../models/CustomerBalance.model');
    const Shop = require('../models/Shop.model');

    const shop = await Shop.findById(shopId);

    // NEVER wrap this in branch scoping. The Customer model has no `branch`
    // field, so `branch: <id>` matched zero documents and due reminders
    // silently sent nothing for every staff member and for any owner with a
    // branch selected (FEATURE_AUDIT.md H-7).
    const customers = await Customer.find({
      _id: { $in: customerIds },
      shop: shopId,
    });

    // Under separate books the amount in the message must be what the customer
    // owes THIS branch — texting them the shop-wide figure would both overstate
    // the debt and disclose another branch's business. The due > 0 filter moves
    // here for the same reason: a customer who owes another branch but not this
    // one must not be reminded by this one.
    const branchScoped = isBranchCustomerScope(req);
    let dueByCustomer = null;
    if (branchScoped) {
      const rows = await CustomerBalance.find({
        shop: shopId,
        branch: req.branchId,
        customer: { $in: customerIds },
        totalDue: { $gt: 0 },
      }).lean();
      dueByCustomer = new Map(rows.map((r) => [String(r.customer), r.totalDue]));
    }

    const owing = customers
      .map((customer) => ({
        customer,
        due: branchScoped
          ? (dueByCustomer.get(String(customer._id)) || 0)
          : (customer.totalDue || 0),
      }))
      .filter((entry) => entry.due > 0);

    if (owing.length === 0) {
      return { success: true, message: 'No customers with due found', sentCount: 0 };
    }

    // Prepare dynamic messages
    const recipients = owing.map(({ customer, due }) => ({
      phone: customer.phone,
      customerId: customer._id,
      customerName: customer.name,
      message: buildDueReminder({
        customerName: customer.name,
        due,
        shopName: shop.name,
      }),
    }));

    return this.sendDynamic(shopId, userId, recipients, req, {
      audience: 'due',
      shopName: shop?.name || '',
    });
  }

  /**
   * Get SMS history for shop
   */
  async getSMSHistory(shopId, options = {}, req = null) {
    const { page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;
    const filter = req ? branchFilter(req, { shop: shopId }) : { shop: shopId };

    const [history, total] = await Promise.all([
      SMSLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      SMSLog.countDocuments(filter),
    ]);

    return {
      data: history,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Send sale receipt SMS (non-blocking - runs async in background)
   * This method returns immediately and sends SMS in the background
   */
  sendSaleReceiptAsync(shopId, userId, saleData) {
    const Shop = require('../models/Shop.model');
    const Customer = require('../models/Customer.model');
    const Sale = require('../models/Sale.model');

    // Run in background (non-blocking) using setImmediate
    setImmediate(async () => {
      try {
        const invoiceNo = saleData?.invoiceNumber || saleData?.invoiceNo;
        if (!invoiceNo) return;

        // Deduplication Guard 1: Check if Sale document has smsSent = true
        const saleId = saleData?.id || saleData?._id;
        let saleDoc = null;
        if (saleId) {
          saleDoc = await Sale.findById(saleId);
        } else {
          saleDoc = await Sale.findOne({ shop: shopId, invoiceNo });
        }

        if (saleDoc?.smsSent) {
          logger.warn(`SMS: Duplicate send attempt prevented for invoice ${invoiceNo}`);
          return;
        }

        // Deduplication Guard 2: Check if an SMSLog already exists for this invoice
        const existingLog = await SMSLog.findOne({
          shop: shopId,
          invoiceNumber: invoiceNo,
          status: { $in: [SMS_STATUS.SENT, SMS_STATUS.DELIVERED, SMS_STATUS.PENDING] }
        });
        if (existingLog) {
          logger.warn(`SMS: Duplicate SMSLog prevented for invoice ${invoiceNo}`);
          if (saleDoc && !saleDoc.smsSent) {
            await Sale.updateOne({ _id: saleDoc._id }, { $set: { smsSent: true, smsSentAt: existingLog.createdAt } });
          }
          return;
        }

        // Get shop with settings
        const shop = await Shop.findById(shopId);
        if (!shop) {
          logger.warn(`SMS: Shop not found for sale receipt: ${shopId}`);
          return;
        }

        // Check if auto SMS is enabled OR if forced by sendSms flag
        const smsSettings = shop.settings?.smsSettings || {};
        const forceSend = saleData.sendSms === true;
        if (!forceSend && !smsSettings.autoSendOnSale) {
          logger.info(`SMS: Auto-send disabled for shop ${shop.name} and not forced.`);
          return;
        }

        // Check minimum sale amount (ignore if forced)
        if (!forceSend && smsSettings.minSaleAmountForSms > 0 && saleData.total < smsSettings.minSaleAmountForSms) {
          logger.info(`SMS: Sale amount ${saleData.total} below minimum ${smsSettings.minSaleAmountForSms}`);
          return;
        }

        // Get customer phone
        let customerPhone = saleData.customerPhone;
        let customerName = saleData.customerName || 'Customer';

        if (!customerPhone && saleData.customerId) {
          const customer = await Customer.findById(saleData.customerId);
          if (customer) {
            customerPhone = customer.phone;
            customerName = customer.name;
          }
        }

        // Check if we should send (customer has phone)
        if (!customerPhone) {
          logger.info(`SMS: No phone number for customer in sale ${invoiceNo}`);
          return;
        }

        // Check SMS quota
        const quota = await SMSQuota.findOne({ shop: shopId });
        if (!quota || !quota.isEnabled || quota.remainingQuota < 1) {
          logger.warn(`SMS: Insufficient quota for shop ${shop.name}`);
          return;
        }

        /**
         * What the customer still owes the shop once this visit is settled.
         *
         * Derived from the invoice's own SNAPSHOTS rather than read live off
         * the customer document, and that is deliberate: a receipt describes
         * one transaction at one moment. Between the sale committing and this
         * background send firing, another branch can collect, a return can
         * settle, or the same customer can buy again — and a live read would
         * text them a balance that has nothing to do with the slip in their
         * hand.
         *
         * `previousDue` is absent on sales written before the snapshots
         * existed, which is exactly the set of sales that can never have
         * settled anything, so the fallback is unreachable in practice and
         * harmless when it is not.
         */
        const dueSettled = saleDoc?.dueSettled || 0;
        const totalDueAfter = Math.max(
          0,
          (saleDoc?.previousDue || 0) - dueSettled + (saleDoc?.due ?? saleData.due ?? 0)
        );

        // Built from the shared template so the till's preview and this message
        // cannot disagree — see smsTemplates.util.js.
        const message = buildSaleReceipt({
          invoiceNo,
          total: saleData.total,
          paid: saleData.paid,
          due: saleData.due,
          // Adds two lines to the receipt ONLY when a খাতা was actually settled
          // at this checkout; an ordinary receipt is unchanged to the byte.
          dueSettled,
          totalDue: totalDueAfter,
          shopName: shop.name,
        });

        // Send SMS with invoice metadata. The shop name rides along because it
        // is already in hand — `sendSingle` would otherwise re-read the same
        // document to sign a body that `buildSaleReceipt` has already signed.
        const sendResult = await this.sendSingle(shopId, userId, customerPhone, message, saleData.customerId, null, {
          invoiceNumber: invoiceNo,
          saleId: saleDoc?._id || null,
          shopName: shop.name
        });

        // Mark Sale document as smsSent: true
        if (sendResult?.success && saleDoc) {
          await Sale.updateOne(
            { _id: saleDoc._id },
            { $set: { smsSent: true, smsSentAt: new Date() } }
          );
        }

        logger.info(`SMS: Sale receipt sent for ${invoiceNo} to ${customerPhone}`);

      } catch (error) {
        logger.error(`SMS: Failed to send sale receipt: ${error.message}`);
        // Don't throw - this is background processing
      }
    });

    // Return immediately - SMS sends in background
    return { queued: true };
  }

  /**
   * Send payment receipt SMS (non-blocking)
   */
  sendPaymentReceiptAsync(shopId, userId, paymentData) {
    const Shop = require('../models/Shop.model');
    const Customer = require('../models/Customer.model');

    setImmediate(async () => {
      try {
        const shop = await Shop.findById(shopId);
        if (!shop) return;

        const smsSettings = shop.settings?.smsSettings || {};
        if (!smsSettings.autoSendOnDuePayment) return;

        const customer = await Customer.findById(paymentData.customerId);
        if (!customer || !customer.phone) return;

        const quota = await SMSQuota.findOne({ shop: shopId });
        if (!quota || !quota.isEnabled || quota.remainingQuota < 1) return;

        // `customer` is re-read here, after the collection has settled, so
        // `totalDue` is already the post-payment balance. The client preview
        // subtracts the amount itself to arrive at the same number.
        const message = buildPaymentReceipt({
          customerName: customer.name,
          amount: paymentData.amount,
          remainingDue: customer.totalDue,
          shopName: shop.name,
        });

        await this.sendSingle(shopId, userId, customer.phone, message, customer._id, null, {
          shopName: shop.name,
        });
        logger.info(`SMS: Payment receipt sent to ${customer.phone}`);

      } catch (error) {
        logger.error(`SMS: Failed to send payment receipt: ${error.message}`);
      }
    });

    return { queued: true };
  }

  /**
   * Get SMS templates with dynamic shop name
   */
  async getTemplates(shopId = null) {
    let shopName = 'Your Shop';
    if (shopId) {
      try {
        const Shop = require('../models/Shop.model');
        const shop = await Shop.findById(shopId).select('name').lean();
        if (shop?.name) {
          shopName = getGsmSafeShopName(shop.name);
        }
      } catch (err) {
        logger.error(`SMS: Failed to fetch shop name for templates: ${err.message}`);
      }
    }

    // Built by passing placeholders THROUGH the real builders, so a template
    // offered on the SMS page always has the same shape as the message the
    // automatic flows send. Editing a body in smsTemplates.util.js updates the
    // picker for free; forgetting to update the picker is no longer possible.
    return [
      {
        id: 'due_reminder',
        name: 'Due Reminder',
        nameEn: 'Due Reminder',
        template: buildDueReminder({
          customerName: '{customer_name}',
          due: '{due_amount}',
          shopName,
        }),
        variables: ['customer_name', 'due_amount', 'shop_name'],
      },
      {
        id: 'payment_received',
        // This one used to open "Dear {customer_name}," while the message the
        // app actually sends on a due collection opens with the bare name. The
        // template now IS that message, so the picker stops advertising a
        // greeting the automatic flow never sends.
        name: 'Payment Received',
        nameEn: 'Payment Received',
        template: buildPaymentReceipt({
          customerName: '{customer_name}',
          amount: '{amount}',
          remainingDue: '{remaining_due}',
          shopName,
        }),
        variables: ['customer_name', 'amount', 'remaining_due', 'shop_name'],
      },
      {
        id: 'sale_receipt',
        name: 'Sale Receipt',
        nameEn: 'Sale Receipt',
        template: buildSaleReceipt({
          invoiceNo: '{invoice_no}',
          total: '{total}',
          paid: '{paid}',
          due: '{due}',
          shopName,
        }),
        variables: ['shop_name', 'invoice_no', 'total', 'paid', 'due'],
      },
      {
        id: 'custom',
        name: 'Custom Message',
        nameEn: 'Custom Message',
        // No sign-off written in. Every message gets one appended on the way
        // out (`appendShopSignature`), so writing it here too would have the
        // composer show a tail the shopkeeper cannot delete — and deleting it
        // would change nothing, which is worse than not offering the handle.
        template: 'Dear Customer, thank you for shopping with us!',
        variables: ['shop_name'],
      },
    ];
  }
}

module.exports = new SMSService();
// Exported for the tests that pin the gateway contract. `readGatewayVerdict` is
// the difference between "the campaign reached nobody" and "the campaign
// reported itself sent", so its behaviour is pinned rather than trusted.
module.exports.readGatewayVerdict = readGatewayVerdict;
module.exports.TRANSACTION_TYPE = TRANSACTION_TYPE;
