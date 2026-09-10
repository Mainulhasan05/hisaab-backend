/**
 * Automas — the primary gateway.
 *
 * Everything below was verified against the live account on 2026-09-10, because
 * the published docs describe an API this account does not serve. Where the two
 * disagree, the wire won. The differences are not cosmetic — three of them fail
 * SILENTLY, returning HTTP 200 with a success-shaped body while delivering
 * nothing.
 *
 * ── 1. The body must be form-encoded. JSON is accepted and ignored ───────────
 *
 * A JSON POST returns HTTP 200 and `{"response":[{"status":105,"id":95413,
 * "msisdn":"NA"}]}`. `msisdn: "NA"` is the tell: the gateway never parsed our
 * body, so it saw no recipient, and 105 ("Invalid MSISDN") is it saying so. It
 * still allocates an id, so the call looks like it did something.
 *
 * The same parameters sent as `application/x-www-form-urlencoded` return
 * `{"status":0,"id":6591452,"msisdn":"8801757995016"}` and the message arrives.
 * This is why `form()` exists and why nothing here posts an object.
 *
 * ── 2. There is ONE endpoint, and it takes many recipients ───────────────────
 *
 * The docs describe separate single / bulk / dynamic endpoints with different
 * parameter names per operation. On this account those paths 404. Only
 * `/smsapiv3` answers, and `msisdn` accepts a comma-separated list, returning
 * one result row per recipient:
 *
 *   msisdn=8801757995016,8801700000000
 *   -> response: [ {status:0, id:6591460, msisdn:"8801757995016"},
 *                  {status:0, id:6591461, msisdn:"8801700000000"} ]
 *
 * So `sendBulk` is that call, and `sendDynamic` — which the gateway has no
 * endpoint for at all — is emulated by grouping recipients who share a body.
 * The docs' `api_key`/`senderid`/`contacts`/`msg` shape returns 105 here; it is
 * not used.
 *
 * ── 3. The body is NOT URL-decoded server-side ───────────────────────────────
 *
 * The docs call `smstext` "HTTP encoded", which would mean percent-encoding
 * collision characters on the way out. Verified by sending `A&B 50% #1 +2` raw:
 * it arrived on the handset exactly as written. Form encoding already escapes
 * the body in transit, so encoding it a second time would deliver a literal
 * `%26` to customers.
 *
 * `AUTOMAS_HTTP_ENCODE=true` restores the old behaviour if an account is ever
 * seen to behave the way the docs describe. It defaults OFF on that test.
 *
 * ── 4. There is no working balance endpoint ──────────────────────────────────
 *
 * `/smsapiv3/balance` and every other documented spelling 404s. `/getbalance`
 * answers `{"response":"104"}` — but it answers exactly that with a bogus key,
 * and with no parameters at all, and the figure does not move after a send. 104
 * is a status code ("Invalid User"), not taka.
 *
 * Balance therefore reports UNSUPPORTED rather than guessing. That matters more
 * than it sounds: the previous code posted the balance request to the send URL,
 * so every load of the admin providers screen fired a send-shaped request at the
 * gateway. Set `AUTOMAS_BALANCE_URL` if Automas ever provides a real one.
 */

const axios = require('axios');
const { BaseSmsAdapter, ERROR_CATEGORY } = require('./base.adapter');
const { formatPhone } = require('../../../utils/phone.util');
const logger = require('../../../utils/logger.util');

const BASE_URL = process.env.AUTOMAS_BASE_URL || 'https://api.automas.com.bd/smsapiv3';

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

const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' };

class AutomasAdapter extends BaseSmsAdapter {
  constructor() {
    super('automas');
    this.baseUrl = BASE_URL;
    this.apiKey = process.env.AUTOMAS_API_KEY || null;
    this.senderId = process.env.AUTOMAS_SENDER_ID || null;
    // Off by default — see note 3 in the header. This is the opposite of what
    // the docs say and the same as what the handset showed.
    this.httpEncode = process.env.AUTOMAS_HTTP_ENCODE === 'true';
    this.balanceUrl = process.env.AUTOMAS_BALANCE_URL || null;

    /* How many recipients ride in one call. The gateway does not document a
     * ceiling and did not refuse the sizes tested; the cap exists so that a
     * 5,000-recipient campaign is not one request whose failure loses every
     * result — a chunk that fails costs us only that chunk. */
    this.maxRecipients = Number(process.env.AUTOMAS_MAX_RECIPIENTS) || 500;

    /* Parallel calls when a send fans out over several chunks or bodies. */
    this.concurrency = Number(process.env.AUTOMAS_CONCURRENCY) || 4;

    this.http = axios.create({
      timeout: Number(process.env.SMS_HTTP_TIMEOUT_MS) || 10000,
    });
  }

  isConfigured() {
    return Boolean(this.apiKey && this.senderId);
  }

  /** One endpoint serves every send operation on this account. */
  sendUrl() {
    return BASE_URL + (process.env.AUTOMAS_SEND_PATH || '');
  }

  /**
   * POST as a form, never as JSON.
   *
   * The single most consequential line in this file: a JSON body here is
   * accepted with HTTP 200 and delivers nothing. See note 1 in the header.
   */
  async form(url, params) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      body.append(key, String(value));
    }
    const { data } = await this.http.post(url, body.toString(), { headers: FORM_HEADERS });
    return data;
  }

  /** Apply the gateway's expected body encoding. Off unless explicitly enabled. */
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

  /** Bounded-concurrency map. Keeps a large campaign from opening 500 sockets. */
  async mapLimit(items, worker) {
    const out = new Array(items.length);
    let cursor = 0;
    const width = Math.min(this.concurrency, items.length) || 0;
    const runners = Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        out[index] = await worker(items[index], index);
      }
    });
    await Promise.all(runners);
    return out;
  }

  /**
   * Send one body to a list of already-normalised numbers, in chunks.
   *
   * Results come back in the order given. A chunk that throws marks only ITS
   * recipients failed — the rest of the campaign still went out, and re-sending
   * everyone would double-charge the people who did receive it. If every chunk
   * throws, the caller turns that into a batch-level throw so the dispatcher can
   * fail the whole thing over.
   */
  async fanOut(numbers, text, sender, unicode) {
    const chunks = [];
    for (let i = 0; i < numbers.length; i += this.maxRecipients) {
      chunks.push(numbers.slice(i, i + this.maxRecipients));
    }

    const byChunk = await this.mapLimit(chunks, async (chunk) => {
      const params = {
        apikey: this.apiKey,
        sender,
        msisdn: chunk.join(','),
        smstext: text,
      };
      // The flag is only meaningful for UCS-2; sending it for ASCII text would
      // charge Unicode segment rates on a message that does not need them.
      if (unicode) params.type = UNICODE_TYPE;

      try {
        return { data: await this.form(this.sendUrl(), params), error: null };
      } catch (err) {
        logger.warn(`[sms] automas chunk of ${chunk.length} failed: ${err.message}`);
        return { data: null, error: err };
      }
    });

    /* Duplicates are why this is a queue per number rather than a map to one
     * entry. The same number can legitimately appear twice in a campaign list,
     * and both copies must get their own result — mapping to a single entry
     * would report one gateway id twice and hide a failure behind a success. */
    const queues = new Map();
    const responses = [];
    let readable = 0;
    let transportFailures = 0;

    for (const { data, error } of byChunk) {
      if (error) { transportFailures += 1; continue; }
      responses.push(data);
      for (const entry of this.responseArray(data)) {
        const key = this.matchKey(entry?.msisdn);
        if (!queues.has(key)) queues.set(key, []);
        queues.get(key).push(entry);
        readable += 1;
      }
    }

    const results = numbers.map((phone) => {
      const queue = queues.get(this.matchKey(phone));
      const entry = queue && queue.length ? queue.shift() : null;
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
      results,
      responses,
      readable,
      allChunksFailed: byChunk.length > 0 && transportFailures === byChunk.length,
      firstError: byChunk.find((c) => c.error)?.error || null,
    };
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

    const params = { apikey: this.apiKey, sender, msisdn: to, smstext: text };
    if (this.isUnicode(message)) params.type = UNICODE_TYPE;

    const data = await this.form(this.sendUrl(), params);

    const first = this.responseArray(data)[0];
    const entry = this.readEntry(first);
    if (!entry.success) {
      throw this.failure(`Gateway refused: ${entry.message}`, { code: entry.statusCode, data });
    }

    return {
      success: true,
      messageId: first?.id ?? null,
      statusCode: entry.statusCode,
      provider: this.name,
      senderIdUsed: sender,
      senderType: senderId ? 'custom' : 'default',
      data,
    };
  }

  /**
   * One message to many, in as few calls as the recipient cap allows.
   *
   * Results are mapped back by msisdn rather than by position — position is not
   * promised, and a reordered response would otherwise attribute one recipient's
   * failure to another. Anyone the response does not mention stays
   * `success: false` with an explicit reason, so the caller retries only them
   * and charges only for the confirmed.
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

    const fan = await this.fanOut(list, text, sender, this.isUnicode(message));

    /* A batch that produced no readable results at all is a batch-level refusal.
     * Surfacing it as a throw lets the dispatcher fail the whole chunk over to
     * the other gateway, rather than silently reporting every recipient failed. */
    if (fan.allChunksFailed) throw fan.firstError;
    if (fan.readable === 0) {
      throw this.failure('Gateway returned no results for bulk send', { data: fan.responses[0] ?? null });
    }

    return {
      success: fan.results.some((r) => r.success),
      provider: this.name,
      method: 'one-to-many',
      messageId: null,
      senderIdUsed: sender,
      data: fan.responses.length === 1 ? fan.responses[0] : fan.responses,
      results: fan.results,
    };
  }

  /**
   * Personalised text per recipient.
   *
   * The gateway has no dynamic endpoint (see note 2), so this groups recipients
   * who share an identical body and sends one call per distinct body. For the
   * common campaign — one template, thousands of recipients — that collapses to
   * the same single call `sendBulk` would make. For a genuinely per-recipient
   * body it is one call each, which is the true cost of the missing endpoint and
   * not something a different grouping can avoid.
   */
  async sendDynamic(messages, senderId = null) {
    const prepared = messages.map((m, i) => ({
      index: i,
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

    // Group by the exact body that will go on the wire. The unicode flag is part
    // of the key because it changes the request, not just the text.
    const groups = new Map();
    for (const row of prepared) {
      const key = `${row.unicode ? 'u' : 'a'}:${row.message}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const grouped = [...groups.values()];
    const fans = await this.mapLimit(grouped, (rows) => this.fanOut(
      rows.map((r) => r.phone),
      rows[0].message,
      sender,
      rows[0].unicode,
    ));

    const results = new Array(prepared.length);
    const responses = [];
    let readable = 0;
    let failedGroups = 0;

    grouped.forEach((rows, g) => {
      const fan = fans[g];
      readable += fan.readable;
      if (fan.allChunksFailed) failedGroups += 1;
      responses.push(...fan.responses);
      rows.forEach((row, i) => { results[row.index] = fan.results[i]; });
    });

    if (fans.length > 0 && failedGroups === fans.length) {
      throw fans[0].firstError;
    }
    if (readable === 0) {
      throw this.failure('Gateway returned no results for dynamic send', { data: responses[0] ?? null });
    }

    return {
      success: results.some((r) => r.success),
      provider: this.name,
      method: 'dynamic',
      messageId: null,
      senderIdUsed: sender,
      data: responses.length === 1 ? responses[0] : responses,
      results,
    };
  }

  /**
   * Balance — unsupported unless a real endpoint is configured.
   *
   * See note 4. Reporting "unsupported" is not a gap being papered over; it is
   * the only honest answer, and it is strictly better than the alternative,
   * which was posting a balance request to the SEND url on every admin page
   * load.
   */
  async checkBalance() {
    if (!this.isConfigured()) {
      return { success: false, balance: null, provider: this.name, error: 'Not configured' };
    }
    if (!this.balanceUrl) {
      return {
        success: false,
        balance: null,
        provider: this.name,
        supported: false,
        error: 'Automas does not expose a balance endpoint on this account',
      };
    }
    try {
      const data = await this.form(this.balanceUrl, { api_key: this.apiKey });
      const raw = data?.response ?? data?.balance ?? data;
      const balance = Number(String(raw).replace(/[^0-9.]/g, ''));

      /* A bare status code is not a balance. `/getbalance` answers "104" — the
       * code for Invalid User — to any request including an empty one, and a
       * naive parse turns that into 104 taka of credit that does not exist. */
      if (balance !== 0 && STATUS_CODES[balance]) {
        return {
          success: false,
          balance: null,
          provider: this.name,
          error: `Balance endpoint returned status ${balance} (${STATUS_CODES[balance].message})`,
          data,
        };
      }

      return {
        success: Number.isFinite(balance),
        balance: Number.isFinite(balance) ? balance : null,
        provider: this.name,
        error: Number.isFinite(balance) ? undefined : 'Unreadable balance response',
        data,
      };
    } catch (err) {
      return { success: false, balance: null, provider: this.name, error: err.message };
    }
  }
}

module.exports = AutomasAdapter;
