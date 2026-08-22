/**
 * Automas — the failover gateway.
 *
 * Three things about this gateway differ from MimSMS in ways that bite if you
 * assume they match. All three are handled here so nothing above this file has
 * to know about them.
 *
 * ── 1. Success is 0, not 200 ─────────────────────────────────────────────────
 *
 * Every result carries a numeric `status` where 0 means accepted and anything
 * else is a documented failure code. A truthiness check on that field is exactly
 * backwards — `if (status)` treats every success as a failure and every failure
 * as a success.
 *
 * ── 2. The auth parameter is named differently per operation ─────────────────
 *
 * This is the gateway's own inconsistency, not a typo here:
 *
 *   single   → apikey  + sender
 *   dynamic  → apikey  + sender
 *   bulk     → api_key + senderid
 *   balance  → api_key
 *
 * `credentials()` below takes the style as an argument for that reason. Sending
 * `apikey` to the bulk endpoint authenticates as nobody and returns 103.
 *
 * ── 3. `smstext` is documented "HTTP encoded" ────────────────────────────────
 *
 * Which means the gateway URL-decodes the message body server-side. A literal
 * `%`, `&`, `+` or `#` in a shop's message is then either corrupted or accepted
 * with a success status and an id, and dies silently downstream — never
 * delivered, never charged, invisible in the gateway's panel. `httpEncodeBody`
 * on the base class is applied to every message field going to this gateway.
 *
 * Because that is a claim about the gateway's behaviour rather than something we
 * can prove from here, `AUTOMAS_HTTP_ENCODE=false` turns it off without a
 * deploy. Verify it once against a real send with a `&` in the body: if the
 * recipient reads a literal `%26`, this is over-encoding and should be off.
 *
 * ── Endpoint paths ───────────────────────────────────────────────────────────
 *
 * The published docs use ONE url for every operation, distinguished only by the
 * body shape, and never state the balance path explicitly. Each path is
 * therefore env-overridable, so an account whose docs differ is a config change
 * rather than a patch.
 */

const axios = require('axios');
const { BaseSmsAdapter, ERROR_CATEGORY } = require('./base.adapter');
const { formatPhone } = require('../../../utils/phone.util');
const logger = require('../../../utils/logger.util');

const BASE_URL = process.env.AUTOMAS_BASE_URL || 'https://api.automas.com.bd/smsapiv3';

const PATHS = {
  SINGLE: process.env.AUTOMAS_PATH_SINGLE || '',
  BULK: process.env.AUTOMAS_PATH_BULK || '',
  DYNAMIC: process.env.AUTOMAS_PATH_DYNAMIC || '',
  BALANCE: process.env.AUTOMAS_PATH_BALANCE || '',
};

/**
 * The gateway's documented status codes.
 *
 * Note which ones are NOT failover-worthy. 105 (invalid msisdn), 110 (the number
 * is on the do-not-disturb register) and 111 (spam word) describe the message or
 * the recipient, not this gateway — MimSMS rejects them identically, so failing
 * over spends a second credit to be told the same thing.
 */
const STATUS_CODES = {
  0: { ok: true, message: 'Success' },
  101: { category: ERROR_CATEGORY.PERMANENT, message: 'Invalid Message Length' },
  102: { category: ERROR_CATEGORY.PERMANENT, message: 'Sender Not Valid' },
  103: { category: ERROR_CATEGORY.AUTH, message: 'Authentication Failed' },
  104: { category: ERROR_CATEGORY.AUTH, message: 'Invalid User' },
  105: { category: ERROR_CATEGORY.PERMANENT, message: 'Invalid MSISDN' },
  106: { category: ERROR_CATEGORY.AUTH, message: 'Incorrect API Key' },
  107: { category: ERROR_CATEGORY.AUTH, message: 'User Account Suspended' },
  108: { category: ERROR_CATEGORY.AUTH, message: 'IP Address Not Allowed' },
  109: { category: ERROR_CATEGORY.AUTH, message: 'API Access Not Allowed' },
  110: { category: ERROR_CATEGORY.PERMANENT, message: 'Do Not Disturb (DND)' },
  111: { category: ERROR_CATEGORY.PERMANENT, message: 'Spam Word Detected in Message' },
  1000: { category: ERROR_CATEGORY.BALANCE, message: 'Insufficient Balance' },
  2000: { category: ERROR_CATEGORY.RETRYABLE, message: 'Destination Provider Unavailable' },
  2300: { category: ERROR_CATEGORY.RETRYABLE, message: 'Destination Route Issue' },
  2400: { category: ERROR_CATEGORY.AUTH, message: 'API Access Not Allowed' },
  3000: { category: ERROR_CATEGORY.RETRYABLE, message: 'Destination Provider Unavailable' },
  3300: { category: ERROR_CATEGORY.RETRYABLE, message: 'System Error' },
  4000: { category: ERROR_CATEGORY.RETRYABLE, message: 'Destination Provider Unavailable' },
};

/** Unicode messages must be flagged; ASCII may omit the field entirely. */
const UNICODE_TYPE = '8';

class AutomasAdapter extends BaseSmsAdapter {
  constructor() {
    super('automas');
    this.baseUrl = BASE_URL;
    this.apiKey = process.env.AUTOMAS_API_KEY || null;
    this.senderId = process.env.AUTOMAS_SENDER_ID || null;
    this.httpEncode = process.env.AUTOMAS_HTTP_ENCODE !== 'false';

    this.http = axios.create({
      timeout: Number(process.env.SMS_HTTP_TIMEOUT_MS) || 10000,
    });
  }

  isConfigured() {
    return Boolean(this.apiKey && this.senderId);
  }

  url(path) {
    return BASE_URL + (path || '');
  }

  /** See the header: the parameter names differ per operation, by the gateway's design. */
  credentials(style, senderId = null) {
    const sender = senderId || this.senderId;
    return style === 'snake'
      ? { api_key: this.apiKey, senderid: sender }
      : { apikey: this.apiKey, sender };
  }

  /** Apply the gateway's expected body encoding, unless switched off. */
  encodeBody(message) {
    const clean = this.sanitizeMessage(message);
    return this.httpEncode ? this.httpEncodeBody(clean) : clean;
  }

  /**
   * Read one entry of the `response` array.
   *
   * A missing or non-numeric status is treated as UNCONFIRMED rather than as
   * success. That is the whole point: an entry we cannot read is a recipient we
   * cannot swear reached the network, and marking it sent would both overstate
   * delivery and charge the shop for it.
   */
  readEntry(entry) {
    if (!entry || typeof entry !== 'object') {
      return { success: false, statusCode: null, message: 'Missing gateway result' };
    }
    const code = Number(entry.status);
    if (!Number.isFinite(code)) {
      return { success: false, statusCode: entry.status ?? null, message: 'Unreadable gateway status' };
    }
    const known = STATUS_CODES[code];
    if (code === 0) return { success: true, statusCode: 0, message: 'Success' };
    return {
      success: false,
      statusCode: code,
      message: known ? known.message : `Gateway status ${code}`,
    };
  }

  /** The gateway echoes numbers in whatever form it likes; compare canonically. */
  matchKey(phone) {
    return formatPhone(phone) || String(phone || '');
  }

  /** Pull the `response` array out, tolerating the single-object and bare shapes. */
  responseArray(data) {
    const payload = data?.response ?? data;
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === 'object') return [payload];
    return [];
  }

  /** Build an Error the dispatcher can categorise and the log row can record. */
  failure(message, { code = null, data = null } = {}) {
    const err = new Error(message);
    err.gatewayCode = code;
    err.gatewayResponse = data;
    err.provider = this.name;
    err.isRefusal = true;
    return err;
  }

  categorizeError(error) {
    if (!error) return ERROR_CATEGORY.RETRYABLE;

    if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']
      .includes(error.code)) {
      return ERROR_CATEGORY.RETRYABLE;
    }

    const httpStatus = error.response?.status;
    if (httpStatus === 401 || httpStatus === 403) return ERROR_CATEGORY.AUTH;
    if (httpStatus === 429) return ERROR_CATEGORY.RETRYABLE;
    if (httpStatus >= 500) return ERROR_CATEGORY.RETRYABLE;

    // The documented code is the authoritative answer when we have one.
    const code = Number(error.gatewayCode);
    if (Number.isFinite(code) && STATUS_CODES[code]?.category) {
      return STATUS_CODES[code].category;
    }

    return ERROR_CATEGORY.RETRYABLE;
  }

  simulated(count = 1) {
    return process.env.SKIP_SMS === 'true'
      ? { simulated: true, count, response: [] }
      : null;
  }

  async sendSingle(phone, message, senderId = null) {
    const to = this.normalizePhone(phone);
    const text = this.encodeBody(message);
    const sender = senderId || this.senderId;

    const sim = this.simulated(1);
    if (sim) {
      logger.info(`[SKIP_SMS] automas single -> ${to}`);
      return {
        success: true, messageId: null, statusCode: 0, provider: this.name,
        senderIdUsed: sender, senderType: senderId ? 'custom' : 'default', data: sim,
      };
    }

    const payload = {
      ...this.credentials('camel', sender),
      msisdn: to,
      smstext: text,
    };
    // The flag is only meaningful for UCS-2; sending it for ASCII text would
    // charge Unicode segment rates on a message that does not need them.
    if (this.isUnicode(message)) payload.type = UNICODE_TYPE;

    const { data } = await this.http.post(this.url(PATHS.SINGLE), payload);

    const entry = this.readEntry(this.responseArray(data)[0]);
    if (!entry.success) {
      throw this.failure(`Gateway refused: ${entry.message}`, { code: entry.statusCode, data });
    }

    return {
      success: true,
      messageId: this.responseArray(data)[0]?.id ?? null,
      statusCode: entry.statusCode,
      provider: this.name,
      senderIdUsed: sender,
      senderType: senderId ? 'custom' : 'default',
      data,
    };
  }

  /**
   * One message to many, one call.
   *
   * Unlike MimSMS this gateway returns REAL per-recipient results, so they are
   * mapped back by msisdn rather than by position — position is not promised and
   * a reordered response would otherwise attribute one recipient's failure to
   * another. Anyone the response does not mention stays `success: false` with an
   * explicit reason, so the caller retries only them and charges only for the
   * confirmed.
   */
  async sendBulk(phones, message, senderId = null) {
    const list = phones.map((p) => this.normalizePhone(typeof p === 'string' ? p : p.phone));
    const text = this.encodeBody(message);
    const sender = senderId || this.senderId;

    const sim = this.simulated(list.length);
    if (sim) {
      logger.info(`[SKIP_SMS] automas bulk -> ${list.length} recipients`);
      return {
        success: true, provider: this.name, method: 'one-to-many', messageId: null, data: sim,
        results: this.expandBatchVerdict(list, { success: true, statusCode: 0 }),
      };
    }

    const payload = {
      ...this.credentials('snake', sender),
      type: this.isUnicode(message) ? 'unicode' : 'text',
      scheduledDateTime: '',
      msg: text,
      contacts: list.join(','),
    };

    const { data } = await this.http.post(this.url(PATHS.BULK), payload);
    const entries = this.responseArray(data);

    // A batch that produced no readable results at all is a batch-level refusal.
    // Surfacing it as a throw lets the dispatcher fail the whole chunk over to
    // the other gateway, rather than silently reporting every recipient failed.
    if (entries.length === 0) {
      throw this.failure('Gateway returned no results for bulk send', { data });
    }

    const byPhone = new Map();
    for (const entry of entries) {
      byPhone.set(this.matchKey(entry?.msisdn), entry);
    }

    const results = list.map((phone) => {
      const entry = byPhone.get(this.matchKey(phone));
      const verdict = this.readEntry(entry);
      return {
        phone,
        success: verdict.success,
        statusCode: verdict.statusCode,
        messageId: entry?.id ?? null,
        error: verdict.success ? null : verdict.message,
      };
    });

    return {
      success: results.some((r) => r.success),
      provider: this.name,
      method: 'one-to-many',
      messageId: null,
      senderIdUsed: sender,
      data,
      results,
    };
  }

  /**
   * Personalised text per recipient.
   *
   * The gateway echoes our own `id` back as `cid`, which is a stronger join key
   * than the phone number — two recipients can legitimately share a number in a
   * badly-deduped list, and `cid` still tells them apart. Falls back to the
   * msisdn when `cid` is absent.
   */
  async sendDynamic(messages, senderId = null) {
    const prepared = messages.map((m, i) => ({
      cid: i + 1,
      phone: this.normalizePhone(m.phone),
      message: this.encodeBody(m.message),
      unicode: this.isUnicode(m.message),
    }));
    const sender = senderId || this.senderId;

    const sim = this.simulated(prepared.length);
    if (sim) {
      logger.info(`[SKIP_SMS] automas dynamic -> ${prepared.length} recipients`);
      return {
        success: true, provider: this.name, method: 'dynamic', messageId: null, data: sim,
        results: this.expandBatchVerdict(prepared, { success: true, statusCode: 0 }),
      };
    }

    const payload = {
      ...this.credentials('camel', sender),
      messages: prepared.map((r) => {
        const row = { id: r.cid, msisdn: r.phone, smstext: r.message };
        if (r.unicode) row.type = UNICODE_TYPE;
        return row;
      }),
    };

    const { data } = await this.http.post(this.url(PATHS.DYNAMIC), payload);
    const entries = this.responseArray(data);

    if (entries.length === 0) {
      throw this.failure('Gateway returned no results for dynamic send', { data });
    }

    const byCid = new Map();
    const byPhone = new Map();
    for (const entry of entries) {
      if (entry?.cid !== undefined && entry?.cid !== null) byCid.set(Number(entry.cid), entry);
      byPhone.set(this.matchKey(entry?.msisdn), entry);
    }

    const results = prepared.map((r) => {
      const entry = byCid.get(r.cid) ?? byPhone.get(this.matchKey(r.phone));
      const verdict = this.readEntry(entry);
      return {
        phone: r.phone,
        success: verdict.success,
        statusCode: verdict.statusCode,
        messageId: entry?.sid ?? entry?.id ?? null,
        error: verdict.success ? null : verdict.message,
      };
    });

    return {
      success: results.some((r) => r.success),
      provider: this.name,
      method: 'dynamic',
      messageId: null,
      senderIdUsed: sender,
      data,
      results,
    };
  }

  /** Answers `{ response: "1234.56" }` — a bare string, not an object. */
  async checkBalance() {
    if (!this.isConfigured()) {
      return { success: false, balance: null, provider: this.name, error: 'Not configured' };
    }
    try {
      const { data } = await this.http.post(this.url(PATHS.BALANCE), { api_key: this.apiKey });
      const raw = data?.response ?? data?.balance ?? data;
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

module.exports = AutomasAdapter;
