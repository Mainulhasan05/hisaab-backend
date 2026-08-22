/**
 * The contract every SMS gateway implements.
 *
 * ── Why this layer exists ────────────────────────────────────────────────────
 *
 * Before this, MimSMS credentials were built into the request body at the point
 * of sending, so "which gateway" was not a decision the code could make — it was
 * a fact baked into four separate payload literals. Adding a second gateway that
 * way means duplicating the campaign engine, the quota accounting and the log
 * writing alongside it.
 *
 * The rule that keeps that from happening again: THIS is the only layer that
 * knows a gateway's HTTP dialect. Everything above it — the dispatcher, the
 * campaign engine, the quota ledger — deals only in the normalised shapes
 * described below. An adapter must never read a Shop, touch SMSLog, or know that
 * quota exists.
 *
 * ── The normalised result shapes ─────────────────────────────────────────────
 *
 * Single send resolves:
 *   { success, messageId, statusCode, provider, senderIdUsed, data }
 *
 * Batch send resolves:
 *   { success, provider, method, results: [{ phone, success, statusCode,
 *                                            messageId, error }] }
 *
 * `results` MUST be the same length as the input array and in the same order.
 * Gateways that answer a batch with one verdict for the whole thing (MimSMS
 * does) expand that verdict per recipient HERE, so every caller above is
 * entitled to assume per-recipient truth exists. Callers that guess instead are
 * how a batch that reached nobody gets recorded as delivered and billed to the
 * shop.
 *
 * `method` names the transport actually used ('one-to-many', 'dynamic',
 * 'individual_fallback'). It lands on the log row and is the first thing worth
 * reading when a campaign costs more than it should have.
 */

const { countSms, isUnicode } = require('../../../utils/smsCounter.util');
const { formatPhone } = require('../../../utils/phone.util');

/**
 * The four categories every gateway error collapses into.
 *
 * The dispatcher reads ONLY the category and never a raw gateway code — that is
 * what lets a second gateway be added without touching the failover logic.
 *
 *   retryable — timeout, socket reset, 5xx, route failure. Try the other gateway.
 *   balance   — this account is out of funds. Try the other gateway; it has its
 *               own wallet.
 *   auth      — bad key, blocked IP, suspended account. Try the OTHER gateway
 *               (different credentials), but never retry the same one.
 *   permanent — invalid number, unapproved sender, spam rejection, over-length.
 *               Do NOT fail over. The second gateway rejects it identically and
 *               the shop is charged twice for one undeliverable message.
 *
 * Unknown errors default to `retryable`. That asymmetry is deliberate: a wrong
 * `retryable` costs one extra API call, while a wrong `permanent` silently drops
 * a message the shop believes it sent.
 */
const ERROR_CATEGORY = {
  RETRYABLE: 'retryable',
  BALANCE: 'balance',
  AUTH: 'auth',
  PERMANENT: 'permanent',
};

/** Categories that justify reaching for a different gateway. */
const FAILOVER_CATEGORIES = new Set([
  ERROR_CATEGORY.RETRYABLE,
  ERROR_CATEGORY.BALANCE,
  ERROR_CATEGORY.AUTH,
]);

class BaseSmsAdapter {
  /**
   * @param {string} name  Registry key. Also the value stamped on every log row,
   *                       so it must stay stable once messages reference it.
   */
  constructor(name) {
    if (new.target === BaseSmsAdapter) {
      throw new Error('BaseSmsAdapter is abstract — extend it');
    }
    this.name = name;
  }

  /* ── Subclass contract ─────────────────────────────────────────────────── */

  /** @returns {Promise<object>} normalised single-result */
  async sendSingle() { throw new Error(`${this.name}: sendSingle not implemented`); }

  /**
   * One identical message to many recipients, in ONE API call.
   *
   * Kept separate from sendDynamic on purpose — this is the cheap path, and
   * collapsing the two loses that saving on every promotional blast.
   *
   * @returns {Promise<object>} normalised batch-result
   */
  async sendBulk() { throw new Error(`${this.name}: sendBulk not implemented`); }

  /**
   * A personalised message per recipient.
   *
   * @returns {Promise<object>} normalised batch-result
   */
  async sendDynamic() { throw new Error(`${this.name}: sendDynamic not implemented`); }

  /** @returns {Promise<{success, balance, provider, error?}>} */
  async checkBalance() { throw new Error(`${this.name}: checkBalance not implemented`); }

  /**
   * Are this gateway's credentials present?
   *
   * A gateway that answers false is excluded from failover selection rather than
   * throwing at send time — an unconfigured backup must look like "no backup",
   * not like a backup that fails on every message.
   *
   * @returns {boolean}
   */
  isConfigured() { return false; }

  /**
   * Map a thrown error onto one of ERROR_CATEGORY.
   *
   * @returns {string}
   */
  categorizeError() { return ERROR_CATEGORY.RETRYABLE; }

  /* ── Shared utilities ──────────────────────────────────────────────────── */

  getProviderInfo() {
    return {
      name: this.name,
      configured: this.isConfigured(),
      baseUrl: this.baseUrl || null,
      senderId: this.senderId || null,
    };
  }

  /**
   * Bangladesh msisdn in the 8801XXXXXXXXX form both gateways accept.
   *
   * Delegates to the existing shared helper so the adapters, the customer
   * records and the dedupe logic cannot drift apart.
   */
  normalizePhone(phone) {
    return formatPhone(phone);
  }

  /**
   * Strip what gateways choke on before it ever reaches the wire.
   *
   * CRLF becomes LF (a bare CR is counted as a GSM character but displays as
   * nothing), smart quotes and dashes become their ASCII equivalents, and
   * control characters go.
   *
   * The quote substitution is not cosmetic. A single curly apostrophe is outside
   * GSM-7, which flips the WHOLE message to Unicode and cuts its capacity from
   * 160 characters to 70 — more than doubling the cost of every message in a
   * campaign. Copy-pasted marketing text is full of them, and the shopkeeper
   * pasting it has no way to see why the price doubled.
   *
   * Bengali text is of course Unicode already and nothing here changes that;
   * this only stops an ASCII message from being tipped over by punctuation.
   */
  sanitizeMessage(message) {
    if (message === null || message === undefined) {
      throw new Error('Message is empty');
    }

    const cleaned = String(message)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”‟]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/…/g, '...')
      // Control characters, except the newline and tab a message may carry.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .trim();

    if (!cleaned) {
      throw new Error('Message is empty after sanitizing');
    }
    return cleaned;
  }

  /** Does this text force UCS-2? Drives both segment cost and gateway flags. */
  isUnicode(message) {
    return isUnicode(message);
  }

  /** { encoding, characterCount, segments, ... } — the one shared counter. */
  countSegments(message) {
    return countSms(message);
  }

  /**
   * Percent-encode the characters a gateway may URL-decode out from under us.
   *
   * Some gateways document the message field as "HTTP encoded" and decode it
   * server-side even on a JSON POST. A literal `%`, `&`, `+` or `#` then either
   * corrupts the body or — worse — is accepted with a success status and a
   * message id, and dies silently downstream: never delivered, never charged,
   * invisible in the gateway's own panel.
   *
   * `%` MUST be replaced first. Encoding it after the others would re-encode the
   * `%` signs those substitutions just introduced, and the recipient reads
   * `%2526` instead of `&`.
   *
   * Only adapters whose gateway actually does this should call it — running it
   * against a gateway that does NOT decode delivers literal `%26` to customers.
   */
  httpEncodeBody(message) {
    return String(message)
      .replace(/%/g, '%25')
      .replace(/&/g, '%26')
      .replace(/\+/g, '%2B')
      .replace(/#/g, '%23');
  }

  /**
   * Expand one batch-level verdict into the per-recipient array the contract
   * promises, for gateways that only answer once for the whole batch.
   */
  expandBatchVerdict(recipients, { success, statusCode = null, messageId = null, error = null }) {
    return recipients.map((r) => ({
      phone: typeof r === 'string' ? r : r.phone,
      success,
      statusCode,
      messageId,
      error,
    }));
  }
}

module.exports = { BaseSmsAdapter, ERROR_CATEGORY, FAILOVER_CATEGORIES };
