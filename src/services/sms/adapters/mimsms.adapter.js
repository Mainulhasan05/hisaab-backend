/**
 * MimSMS — the platform's default gateway.
 *
 * This is a faithful extraction of the send logic that previously lived inline
 * in sms.service.js, not a rewrite. Two behaviours in particular were learned in
 * production and are preserved verbatim; both are load-bearing.
 *
 * ── 1. A 200 is not an answer ────────────────────────────────────────────────
 *
 * MimSMS answers a REFUSAL with HTTP 200 and puts the verdict in the body:
 * `{ status: "Failed", responseResult: "..." }`. Reading the HTTP status as the
 * outcome is why campaigns that reached nobody were recorded `sent`, billed to
 * the shop, and never refunded. `readVerdict` is that fix, and every path
 * through this adapter goes through it.
 *
 * ── 2. TransactionType belongs to the ENDPOINT, not the message ──────────────
 *
 * Determined empirically against this account, each endpoint probed with an
 * undeliverable number so only the validator answered:
 *
 *   /SMS        accepts T, P and D
 *   /OneToMany  accepts T only   — P and D return "Invalid TransactionType"
 *   /DSMS       accepts D only   — T and P return "Invalid TransactionType"
 *
 * The code once sent 'P' on bulk and 'T' on dynamic, so BOTH campaign endpoints
 * were refused on every call they ever made — invisibly, because of behaviour 1.
 *
 * The consequence for callers: a promotional bulk send cannot be routed as
 * promotional on this account. The caller's intent is still recorded on the log;
 * it just cannot change the wire value.
 */

const axios = require('axios');
const { BaseSmsAdapter, ERROR_CATEGORY } = require('./base.adapter');
const logger = require('../../../utils/logger.util');

const BASE_URL = process.env.MIMSMS_BASE_URL || 'https://api.mimsms.com/api/SmsSending';

const PATHS = {
  SINGLE: '/SMS',
  BULK: '/OneToMany',
  DYNAMIC: '/DSMS',
  BALANCE: '/balanceCheck',
};

const TRANSACTION_TYPE = {
  single: process.env.MIMSMS_TXN_TYPE_SINGLE || 'T',
  bulk: process.env.MIMSMS_TXN_TYPE_BULK || 'T',
  dynamic: process.env.MIMSMS_TXN_TYPE_DYNAMIC || 'D',
};

/**
 * Refusal text → category.
 *
 * Matched against the lowercased `responseResult`. Ordered most-specific first;
 * the first hit wins, so a phrase that could match two entries must be listed
 * above the broader one.
 */
const REFUSAL_PATTERNS = [
  [/insufficient|balance|no fund|out of fund/, ERROR_CATEGORY.BALANCE],
  [/api ?key|username|password|unauthor|authentic|suspend|ip .*(not allow|block)/, ERROR_CATEGORY.AUTH],
  [/invalid mobile|invalid number|invalid msisdn|wrong number/, ERROR_CATEGORY.PERMANENT],
  [/invalid sender|sender.*(not|invalid)|masking/, ERROR_CATEGORY.PERMANENT],
  [/invalid transactiontype|invalid transaction type/, ERROR_CATEGORY.PERMANENT],
  [/spam|content.*block|message too long|invalid message/, ERROR_CATEGORY.PERMANENT],
  [/route|gateway|timeout|try again|system error/, ERROR_CATEGORY.RETRYABLE],
];

class MimSmsAdapter extends BaseSmsAdapter {
  constructor() {
    super('mimsms');
    this.baseUrl = BASE_URL;
    this.username = process.env.MIMSMS_USERNAME || null;
    this.apiKey = process.env.MIMSMS_API_KEY || null;
    this.senderId = process.env.MIMSMS_SENDER_ID || null;

    this.http = axios.create({
      timeout: Number(process.env.SMS_HTTP_TIMEOUT_MS) || 10000,
    });
  }

  isConfigured() {
    return Boolean(this.username && this.apiKey && this.senderId);
  }

  /**
   * Did the gateway actually accept this?
   *
   * Unknown shapes are treated as ACCEPTED rather than refused, deliberately: a
   * future gateway change that adds a field must not turn every successful send
   * into a false failure. Explicit refusals are what this reads, and anything it
   * cannot classify is logged so the silence stays visible.
   */
  readVerdict(data) {
    if (!data || typeof data !== 'object') return { accepted: true, reason: null, code: null };
    if (data.simulated) return { accepted: true, reason: null, code: null };

    const status = String(data.status ?? data.Status ?? '').trim().toLowerCase();
    const code = String(data.statusCode ?? data.StatusCode ?? '').trim();
    const detail = data.responseResult ?? data.ResponseResult ?? data.message ?? null;

    if (status === 'success' || code === '200') {
      return { accepted: true, reason: null, code: code || '200' };
    }

    if (status === 'failed' || status === 'error' || (code && code !== '200')) {
      return {
        accepted: false,
        reason: detail ? `Gateway refused: ${detail}` : `Gateway refused (status ${code || status})`,
        code: code || status,
      };
    }

    if (status || code) {
      logger.warn(
        `SMS[mimsms]: unrecognised gateway verdict ${JSON.stringify({ status, code })} — treating as accepted`
      );
    }
    return { accepted: true, reason: null, code: code || null };
  }

  /**
   * MimSMS reports the gateway's own id under several spellings depending on
   * endpoint. Read them all rather than picking one — this field is the only way
   * to reconcile our log against the provider's panel during a billing dispute,
   * and it was silently absent for months because nothing captured it.
   */
  extractMessageId(data) {
    if (!data || typeof data !== 'object') return null;
    return (
      data.trxnId ?? data.TrxnId ?? data.transactionId ?? data.TransactionId ??
      data.messageId ?? data.MessageId ?? data.id ?? null
    );
  }

  /** Build an Error carrying everything the dispatcher and the log row need. */
  refusalError(verdict, data) {
    const err = new Error(verdict.reason);
    err.gatewayResponse = data;
    err.gatewayCode = verdict.code;
    err.provider = this.name;
    err.isRefusal = true;
    return err;
  }

  categorizeError(error) {
    if (!error) return ERROR_CATEGORY.RETRYABLE;

    // Transport problems never reached the validator — always worth another gateway.
    if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']
      .includes(error.code)) {
      return ERROR_CATEGORY.RETRYABLE;
    }

    const httpStatus = error.response?.status;
    if (httpStatus === 401 || httpStatus === 403) return ERROR_CATEGORY.AUTH;
    if (httpStatus === 429) return ERROR_CATEGORY.RETRYABLE;
    if (httpStatus >= 500) return ERROR_CATEGORY.RETRYABLE;

    const text = String(
      error.gatewayResponse?.responseResult ?? error.gatewayResponse?.ResponseResult ?? error.message ?? ''
    ).toLowerCase();

    for (const [pattern, category] of REFUSAL_PATTERNS) {
      if (pattern.test(text)) return category;
    }

    // A 4xx that named no reason we recognise is still the gateway declining to
    // act on this request; another gateway is worth a try.
    return ERROR_CATEGORY.RETRYABLE;
  }

  /**
   * Development guard, mirroring the one this logic had before extraction.
   * Without it there is no way to exercise a four-thousand-recipient campaign
   * except by sending four thousand real messages.
   */
  simulated(count = 1) {
    return process.env.SKIP_SMS === 'true'
      ? { simulated: true, count, status: 'Success', statusCode: '200' }
      : null;
  }

  credentials(senderId) {
    return {
      UserName: this.username,
      Apikey: this.apiKey,
      SenderName: senderId || this.senderId,
    };
  }

  async sendSingle(phone, message, senderId = null) {
    const to = this.normalizePhone(phone);
    const body = this.sanitizeMessage(message);
    const sender = senderId || this.senderId;

    const sim = this.simulated(1);
    if (sim) {
      logger.info(`[SKIP_SMS] mimsms single -> ${to}`);
      return {
        success: true, messageId: null, statusCode: '200', provider: this.name,
        senderIdUsed: sender, senderType: senderId ? 'custom' : 'default', data: sim,
      };
    }

    const { data } = await this.http.post(BASE_URL + PATHS.SINGLE, {
      ...this.credentials(sender),
      MobileNumber: to,
      TransactionType: TRANSACTION_TYPE.single,
      Message: body,
    });

    const verdict = this.readVerdict(data);
    if (!verdict.accepted) throw this.refusalError(verdict, data);

    return {
      success: true,
      messageId: this.extractMessageId(data),
      statusCode: verdict.code,
      provider: this.name,
      senderIdUsed: sender,
      senderType: senderId ? 'custom' : 'default',
      data,
    };
  }

  /**
   * One message, many recipients, one call.
   *
   * MimSMS takes the recipients as a single comma-delimited string and answers
   * with ONE verdict for the whole batch — there is no per-recipient truth on
   * the wire. `expandBatchVerdict` widens that one answer to the shape the
   * contract promises, which is the honest thing to do: it says "all of these
   * share a fate" rather than inventing per-recipient detail that does not exist.
   *
   * This is also why the caller keeps batches small. All-or-nothing over a
   * shop's entire customer book means one hiccup fails every recipient at once.
   */
  async sendBulk(phones, message, senderId = null) {
    const list = phones.map((p) => this.normalizePhone(typeof p === 'string' ? p : p.phone));
    const body = this.sanitizeMessage(message);
    const sender = senderId || this.senderId;

    const sim = this.simulated(list.length);
    if (sim) {
      logger.info(`[SKIP_SMS] mimsms bulk -> ${list.length} recipients`);
      return {
        success: true, provider: this.name, method: 'one-to-many', messageId: null, data: sim,
        results: this.expandBatchVerdict(list, { success: true, statusCode: '200' }),
      };
    }

    const { data } = await this.http.post(BASE_URL + PATHS.BULK, {
      ...this.credentials(sender),
      MobileNumber: list.join(','),
      TransactionType: TRANSACTION_TYPE.bulk,
      Message: body,
    });

    const verdict = this.readVerdict(data);
    if (!verdict.accepted) throw this.refusalError(verdict, data);

    const messageId = this.extractMessageId(data);
    return {
      success: true,
      provider: this.name,
      method: 'one-to-many',
      messageId,
      senderIdUsed: sender,
      data,
      results: this.expandBatchVerdict(list, {
        success: true, statusCode: verdict.code, messageId,
      }),
    };
  }

  /** Personalised text per recipient. /DSMS accepts 'D' and nothing else. */
  async sendDynamic(messages, senderId = null) {
    const prepared = messages.map((m) => ({
      phone: this.normalizePhone(m.phone),
      message: this.sanitizeMessage(m.message),
    }));
    const sender = senderId || this.senderId;

    const sim = this.simulated(prepared.length);
    if (sim) {
      logger.info(`[SKIP_SMS] mimsms dynamic -> ${prepared.length} recipients`);
      return {
        success: true, provider: this.name, method: 'dynamic', messageId: null, data: sim,
        results: this.expandBatchVerdict(prepared, { success: true, statusCode: '200' }),
      };
    }

    const { data } = await this.http.post(BASE_URL + PATHS.DYNAMIC, {
      ...this.credentials(sender),
      TransactionType: TRANSACTION_TYPE.dynamic,
      MessageData: prepared.map((r) => ({ MobileNumber: r.phone, Message: r.message })),
    });

    const verdict = this.readVerdict(data);
    if (!verdict.accepted) throw this.refusalError(verdict, data);

    const messageId = this.extractMessageId(data);
    return {
      success: true,
      provider: this.name,
      method: 'dynamic',
      messageId,
      senderIdUsed: sender,
      data,
      results: this.expandBatchVerdict(prepared, {
        success: true, statusCode: verdict.code, messageId,
      }),
    };
  }

  async checkBalance() {
    if (!this.isConfigured()) {
      return { success: false, balance: null, provider: this.name, error: 'Not configured' };
    }
    try {
      const { data } = await this.http.post(BASE_URL + PATHS.BALANCE, {
        UserName: this.username,
        Apikey: this.apiKey,
      });
      const raw = data?.balance ?? data?.Balance ?? data?.responseResult ?? data;
      const balance = Number(String(raw).replace(/[^0-9.]/g, ''));
      return {
        success: true,
        balance: Number.isFinite(balance) ? balance : null,
        provider: this.name,
        data,
      };
    } catch (err) {
      return { success: false, balance: null, provider: this.name, error: err.message };
    }
  }
}

module.exports = MimSmsAdapter;
