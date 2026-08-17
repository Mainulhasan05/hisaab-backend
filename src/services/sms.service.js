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

// MimSMS API Configuration
const MIMSMS = {
  BASE_URL: 'https://api.mimsms.com/api/SmsSending',
  SINGLE: '/SMS',
  BULK: '/OneToMany',
  DYNAMIC: '/DSMS',
  BALANCE: '/balanceCheck'
};

/* ── TransactionType is a property of the ENDPOINT, not of the message ────────
 *
 * Determined empirically against this account (each endpoint probed with an
 * undeliverable number, so only the validator answered):
 *
 *   /SMS        accepts T, P and D
 *   /OneToMany  accepts T only      — P and D return "Invalid TransactionType"
 *   /DSMS       accepts D only      — T and P return "Invalid TransactionType"
 *
 * This code previously sent 'P' on bulk and 'T' on dynamic, so BOTH campaign
 * endpoints were refused by the gateway on every call they ever made. Nobody
 * noticed because `sendBatch` read only the HTTP status: MimSMS answers a
 * refusal with HTTP 200 and the verdict in the body, so every rejected campaign
 * was recorded `sent`, billed to the shop, and never refunded. See
 * `readGatewayVerdict` below — that is the other half of this fix.
 *
 * The consequence for callers: a promotional bulk send cannot be routed as
 * promotional, because the gateway does not offer that on /OneToMany for this
 * account. The caller's intent is still recorded on the log; it just cannot
 * change the wire value. Override per endpoint if the account is later
 * provisioned differently.
 */
const TRANSACTION_TYPE = {
  single: process.env.MIMSMS_TXN_TYPE_SINGLE || 'T',
  bulk: process.env.MIMSMS_TXN_TYPE_BULK || 'T',
  dynamic: process.env.MIMSMS_TXN_TYPE_DYNAMIC || 'D',
};

/**
 * Did the gateway actually accept this?
 *
 * MimSMS returns HTTP 200 for refusals — an invalid number, a bad
 * TransactionType and a flat-out rejection all arrive as a 200 whose body says
 * `{ status: "Failed", responseResult: "..." }`. Treating the HTTP status as
 * the answer is why a campaign that reached nobody reported itself sent.
 *
 * Unknown shapes are treated as ACCEPTED rather than refused, deliberately: a
 * future gateway change that adds a field must not turn every successful send
 * into a false failure. Explicit refusals are what this reads, and anything it
 * cannot classify is logged so the silence is visible.
 */
function readGatewayVerdict(data) {
  if (!data || typeof data !== 'object') {
    return { accepted: true, reason: null };
  }

  // The simulated response from SKIP_SMS, which carries no verdict.
  if (data.simulated) return { accepted: true, reason: null };

  const status = String(data.status ?? data.Status ?? '').trim().toLowerCase();
  const code = String(data.statusCode ?? data.StatusCode ?? '').trim();
  const detail = data.responseResult ?? data.ResponseResult ?? data.message ?? null;

  if (status === 'success' || code === '200') {
    return { accepted: true, reason: null };
  }

  if (status === 'failed' || status === 'error' || (code && code !== '200')) {
    return {
      accepted: false,
      reason: detail ? `Gateway refused: ${detail}` : `Gateway refused (status ${code || status})`,
    };
  }

  if (status || code) {
    logger.warn(`SMS: unrecognised gateway verdict ${JSON.stringify({ status, code })} — treating as accepted`);
  }
  return { accepted: true, reason: null };
}

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
  }) {
    const sent = status === SMS_STATUS.SENT;
    try {
      return await SMSLog.create({
        shop: null,
        branch: null,
        recipients: [{ phone, status }],
        message,
        type,
        audience,
        transactionId,
        // No quota is charged, but the segments are still what the platform is
        // billed by MimSMS — and an OTP in Bangla is two of them, not one.
        cost: countSms(message).segments || 1,
        status,
        sentCount: sent ? 1 : 0,
        failedCount: sent ? 0 : 1,
        sentAt: sent ? new Date() : null,
        apiResponse,
        errorMessage,
        senderName,
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
      const response = await smsHttp.post(MIMSMS.BASE_URL + MIMSMS.SINGLE, {
        UserName: process.env.MIMSMS_USERNAME,
        Apikey: process.env.MIMSMS_API_KEY,
        MobileNumber: formattedPhone,
        SenderName: process.env.MIMSMS_SENDER_ID,
        TransactionType: 'T', // Transactional
        Message: message
      });

      // The same HTTP-200-refusal trap the other two send paths already guard.
      // Without it the panel would record `sent` for every OTP the gateway
      // turned away — a dead number, an exhausted platform float — and the one
      // screen built to answer "why did this user never get their code" would
      // answer it wrongly.
      const verdict = readGatewayVerdict(response.data);
      if (!verdict.accepted) {
        const refusal = new Error(verdict.reason);
        refusal.gatewayResponse = response.data;
        throw refusal;
      }

      await this.recordSystemLog({
        phone: formattedPhone,
        message,
        audience,
        status: SMS_STATUS.SENT,
        transactionId: response.data?.TransactionId,
        apiResponse: response.data,
      });

      logger.info(`OTP sent to ${formattedPhone}: ${JSON.stringify(response.data)}`);
      return response.data;
    } catch (error) {
      await this.recordSystemLog({
        phone: formattedPhone,
        message,
        audience,
        status: SMS_STATUS.FAILED,
        errorMessage: error.message,
        apiResponse: error.gatewayResponse || null,
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
      const response = await smsHttp.post(MIMSMS.BASE_URL + MIMSMS.SINGLE, {
        UserName: process.env.MIMSMS_USERNAME,
        Apikey: process.env.MIMSMS_API_KEY,
        MobileNumber: formattedPhone,
        SenderName: process.env.MIMSMS_SENDER_ID,
        TransactionType: TRANSACTION_TYPE.single,
        Message: body,
      });

      const verdict = readGatewayVerdict(response.data);
      if (!verdict.accepted) {
        const refusal = new Error(verdict.reason);
        refusal.gatewayResponse = response.data;
        throw refusal;
      }

      const smsLog = await this.recordSystemLog({
        phone: formattedPhone, message: body, type: SMS_TYPES.SINGLE, audience,
        status: SMS_STATUS.SENT, transactionId: response.data?.TransactionId,
        apiResponse: response.data, senderName,
      });

      logger.info(`System SMS sent to ${formattedPhone} (${audience})`);
      return { success: true, smsLog, response: response.data };
    } catch (error) {
      await this.recordSystemLog({
        phone: formattedPhone, message: body, type: SMS_TYPES.SINGLE, audience,
        status: SMS_STATUS.FAILED, errorMessage: error.message,
        apiResponse: error.gatewayResponse || null, senderName,
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
      const response = await smsHttp.post(MIMSMS.BASE_URL + MIMSMS.SINGLE, {
        UserName: process.env.MIMSMS_USERNAME,
        Apikey: process.env.MIMSMS_API_KEY,
        MobileNumber: formattedPhone,
        SenderName: process.env.MIMSMS_SENDER_ID,
        TransactionType: TRANSACTION_TYPE.single,
        Message: body
      });

      // Same trap as the campaign path: MimSMS refuses with HTTP 200 and the
      // verdict in the body. Without this a receipt the gateway rejected — a
      // dead number, an exhausted gateway float — is logged `sent` and charged
      // to the shop, with the refund below never running.
      const verdict = readGatewayVerdict(response.data);
      if (!verdict.accepted) {
        const refusal = new Error(verdict.reason);
        refusal.gatewayResponse = response.data;
        throw refusal;
      }

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
        transactionId: response.data?.TransactionId,
        cost: segmentCost,
        status: SMS_STATUS.SENT,
        sentCount: 1,
        // A single send finishes inside the call, so this is within
        // milliseconds of `createdAt` — recorded anyway so the panel reads one
        // field for "when did it leave" across single, campaign and OTP rows.
        sentAt: new Date(),
        apiResponse: response.data,
        sentBy: userId,
        invoiceNumber: options.invoiceNumber || null,
        sale: options.saleId || null
      });

      logger.info(`SMS sent to ${formattedPhone} for shop ${shopId}`);
      return { success: true, smsLog, response: response.data };
    } catch (error) {
      // The shop paid for a message that never left. Give it back before
      // anything else — a throw on the way out must not strand the reservation.
      await SMSQuota.refund(shopId, segmentCost).catch((refundErr) =>
        logger.error(`SMS: quota refund failed for shop ${shopId}: ${refundErr.message}`)
      );

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
        sentBy: userId
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
   * Push one batch at the gateway, with a single retry.
   *
   * Never throws: a batch that cannot be sent is a fact about that batch, not a
   * reason to abandon the thirty-nine after it.
   */
  async sendBatch(batch, { sharedBody, personalized, transactionType }) {
    // Mirrors the guard in `sendOTP`. Without it there is no way to exercise a
    // four-thousand-recipient campaign in development except by sending four
    // thousand real messages.
    if (process.env.SKIP_SMS === 'true') {
      logger.info(`[SKIP_SMS] Pretending to send batch of ${batch.length}`);
      return { ok: true, response: { simulated: true, count: batch.length } };
    }

    // The wire value is decided by the endpoint, not by the caller's intent —
    // see TRANSACTION_TYPE. `transactionType` is still carried through the
    // campaign so the log records what the send was FOR, but /OneToMany and
    // /DSMS each accept exactly one value and refuse everything else.
    const wireType = personalized ? TRANSACTION_TYPE.dynamic : TRANSACTION_TYPE.bulk;

    const payload = personalized
      ? {
          UserName: process.env.MIMSMS_USERNAME,
          Apikey: process.env.MIMSMS_API_KEY,
          SenderName: process.env.MIMSMS_SENDER_ID,
          TransactionType: wireType,
          MessageData: batch.map((r) => ({ MobileNumber: r.phone, Message: r.message })),
        }
      : {
          UserName: process.env.MIMSMS_USERNAME,
          Apikey: process.env.MIMSMS_API_KEY,
          MobileNumber: batch.map((r) => r.phone).join(','),
          SenderName: process.env.MIMSMS_SENDER_ID,
          TransactionType: wireType,
          Message: sharedBody,
        };

    const url = MIMSMS.BASE_URL + (personalized ? MIMSMS.DYNAMIC : MIMSMS.BULK);

    let lastError;
    for (let attempt = 0; attempt <= BULK.BATCH_RETRIES; attempt++) {
      try {
        const response = await smsHttp.post(url, payload);

        // A 200 is not an answer. MimSMS refuses with HTTP 200 and puts the
        // verdict in the body, so this is where a rejected batch is caught —
        // without it the batch is marked sent, the shop is billed for messages
        // that reached nobody, and the refund path never runs.
        const verdict = readGatewayVerdict(response.data);
        if (verdict.accepted) {
          return { ok: true, response: response.data };
        }

        lastError = new Error(verdict.reason);
        // A refusal is a verdict, not a hiccup. Retrying an "Invalid
        // TransactionType" or an "Invalid Mobile Number" returns the identical
        // answer a second later and only delays the batches behind it.
        return { ok: false, error: lastError, response: response.data };
      } catch (error) {
        lastError = error;
        if (attempt < BULK.BATCH_RETRIES) {
          await sleep(BULK.RETRY_DELAY_MS * (attempt + 1));
        }
      }
    }

    return { ok: false, error: lastError };
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

    for (let index = startBatch; index < batches.length; index++) {
      const batch = batches[index];
      const result = await this.sendBatch(batch, { sharedBody, personalized, transactionType });

      const status = result.ok ? SMS_STATUS.SENT : SMS_STATUS.FAILED;
      const failedReason = result.ok ? null : (result.error?.message || 'Gateway error');

      const set = {};
      batch.forEach((recipient, i) => {
        const position = offset + i;
        set[`recipients.${position}.status`] = status;
        if (failedReason) set[`recipients.${position}.failedReason`] = failedReason;
      });

      if (result.ok) {
        sentCount += batch.length;
        lastResponse = result.response;
        // The first batch the gateway takes IS when this campaign started
        // reaching people — written now rather than at completion, because a
        // campaign that dies at batch 30 of 40 still reached three thousand
        // customers and the log has to be able to say when.
        if (!sentAt) {
          sentAt = new Date();
          set.sentAt = sentAt;
        }
        if (!transactionId && result.response?.TransactionId) {
          transactionId = result.response.TransactionId;
        }
      } else {
        failedCount += batch.length;
        lastError = failedReason;
        // Keep the refusal body too. It is the only place the gateway says WHY,
        // and the admin log's "Raw gateway response" panel is what an operator
        // reads when a campaign fails — showing the last SUCCESS there while
        // the status says failed is how a wrong diagnosis starts.
        if (result.response) lastResponse = result.response;
        // Give back exactly what this batch was priced at, not a flat one per
        // recipient — a two-segment message to a hundred people cost two hundred.
        refundSegments += personalized
          ? batch.reduce((sum, r) => sum + (countSms(r.message).segments || 1), 0)
          : (countSms(sharedBody).segments || 1) * batch.length;
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
   * Check MimSMS balance
   */
  async checkBalance() {
    try {
      const response = await smsHttp.get(MIMSMS.BASE_URL + MIMSMS.BALANCE, {
        params: {
          UserName: process.env.MIMSMS_USERNAME,
          Apikey: process.env.MIMSMS_API_KEY
        }
      });
      return response.data;
    } catch (error) {
      logger.error(`Failed to check SMS balance: ${error.message}`);
      throw error;
    }
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

        // Built from the shared template so the till's preview and this message
        // cannot disagree — see smsTemplates.util.js.
        const message = buildSaleReceipt({
          invoiceNo,
          total: saleData.total,
          paid: saleData.paid,
          due: saleData.due,
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
