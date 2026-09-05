/**
 * PayStation — the only place this codebase speaks a payment gateway's dialect.
 *
 * Modelled on `services/sms/adapters/mimsms.adapter.js`, which solves the same
 * problem: a gateway that answers a refusal with HTTP 200 and puts the real
 * verdict in the body. Reading the HTTP status as the outcome is how a refused
 * payment gets recorded as a successful one.
 *
 * Nothing above this file knows what a `merchantId` is, that the API is
 * form-encoded, or that `transaction-status` wants its credential in a header
 * while `initiate-payment` wants it in the body. Nothing in this file knows
 * what a Shop is, what a subscription is, or that quota exists.
 *
 * ── What the API actually is ────────────────────────────────────────────────
 *
 *   POST /initiate-payment    multipart/form-data, merchantId + password in the
 *                             BODY → { status_code, payment_url }
 *   POST /transaction-status  merchantId in the HEADER, invoice_number in the
 *                             body → { status_code, data: { trx_status, … } }
 *
 * Sandbox https://sandbox.paystation.com.bd · live https://api.paystation.com.bd
 *
 * ── Three findings from probing the sandbox, each load-bearing ──────────────
 *
 * 1. `status_code` is the STRING "200", not the number 200. Every comparison
 *    here goes through `String(...).trim()`. A `=== 200` check silently treats
 *    every successful call as a failure.
 *
 * 2. `payment_amount` ECHOES THE REQUESTED AMOUNT ON AN UNPAID TRANSACTION. A
 *    freshly-created, never-paid order returns `payment_amount: "1.00"` with
 *    `trx_status: "processing"`. So the amount fields can NEVER be used to
 *    infer that money arrived — `trx_status` is the sole gate, and the amount is
 *    only a sanity check applied afterwards. This is the single easiest way to
 *    give away a year of subscription for nothing.
 *
 * 3. `trx_status` casing is inconsistent in PayStation's own documentation
 *    ("Success" in the v1 example, "success" in v2), so it is always lowercased
 *    before comparison, and anything unrecognised resolves to `processing` —
 *    never to `success`. An unknown verdict must mean "ask again later", never
 *    "hand over the goods".
 *
 * ── Why v1 /transaction-status and not v2 ───────────────────────────────────
 *
 * v1 is keyed on `invoice_number`, which we mint ourselves and therefore always
 * know. v2 is keyed on PayStation's `trxId`, which we only learn from a
 * successful payment — useless for the case this integration most needs to
 * handle, an abandoned checkout where no callback ever arrived. v2 returns a
 * little more detail and is worth adding later as an enrichment, never as the
 * primary lookup.
 */

const axios = require('axios');
const FormData = require('form-data');
const logger = require('../../utils/logger.util');

const HOSTS = {
  sandbox: 'https://sandbox.paystation.com.bd',
  live: 'https://api.paystation.com.bd',
};

const PATHS = {
  INITIATE: '/initiate-payment',
  STATUS: '/transaction-status',
};

/**
 * The transaction states PayStation reports, normalised.
 *
 * `processing` is the important one and the reason this integration needs a
 * reconciliation sweep at all: it means the customer opened the checkout and we
 * do not yet know how it ended. It is not a failure and must never be treated
 * as one — a shop whose bKash PIN screen took ninety seconds would otherwise be
 * told its payment failed while the money was on its way.
 */
const TRX_STATUS = Object.freeze({
  SUCCESS: 'success',
  PROCESSING: 'processing',
  FAILED: 'failed',
  REFUND: 'refund',
});

/**
 * Error categories, mirroring the SMS adapters' vocabulary so the two
 * integrations describe failure the same way.
 *
 *   retryable — timeout, socket reset, 5xx. Ask again.
 *   auth      — bad merchant credentials (2001). Asking again will not help.
 *   permanent — the request itself is wrong (1008 duplicate invoice). A retry
 *               reproduces it exactly.
 *
 * Unknown defaults to `retryable`, the same asymmetry the SMS side documents: a
 * wrong `retryable` costs one extra API call, a wrong `permanent` abandons a
 * payment that would have succeeded.
 */
const PAYMENT_ERROR_CATEGORY = Object.freeze({
  RETRYABLE: 'retryable',
  AUTH: 'auth',
  PERMANENT: 'permanent',
});

/**
 * PayStation's failure codes.
 *
 * `1001` is NOT in PayStation's published error table — it was found by pointing
 * the live host at sandbox credentials, which answers `1001 Invalid Credential.`
 * Left unmapped it fell through to `retryable`, which is the worst possible
 * reading: the platform would have retried a credential that can never work,
 * on every renewal, forever.
 */
const CODE = Object.freeze({
  OK: '200',
  DUPLICATE_INVOICE: '1008',
  INVALID_CREDENTIAL: '1001',
  INVALID_TOKEN: '2001',
});

class PayStationAdapter {
  constructor() {
    this.name = 'paystation';
    this.env = process.env.PAYSTATION_ENV === 'live' ? 'live' : 'sandbox';
    this.baseUrl = process.env.PAYSTATION_BASE_URL || HOSTS[this.env];

    // Secrets are never defaulted — `|| null` so `isConfigured()` can tell the
    // difference between "not set up" and "set up wrong".
    this.merchantId = process.env.PAYSTATION_MERCHANT_ID || null;
    this.password = process.env.PAYSTATION_PASSWORD || null;

    this.http = axios.create({
      timeout: Number(process.env.PAYSTATION_HTTP_TIMEOUT_MS) || 15000,
    });
  }

  /**
   * Are the credentials present?
   *
   * A gateway that answers false is refused at the checkout endpoint with a
   * clear message, rather than being allowed to fail on the customer's screen
   * after they have already committed to paying.
   */
  isConfigured() {
    return Boolean(this.merchantId && this.password);
  }

  getProviderInfo() {
    return {
      name: this.name,
      configured: this.isConfigured(),
      env: this.env,
      baseUrl: this.baseUrl,
      merchantId: this.merchantId
        // Enough to confirm which account is wired up, not enough to be a leak
        // in a screenshot of the admin settings screen.
        ? `${String(this.merchantId).slice(0, 4)}…${String(this.merchantId).slice(-4)}`
        : null,
    };
  }

  /** Dev seam mirroring `SKIP_SMS` — exercise the flow without real money. */
  get skipGateway() {
    return process.env.SKIP_PAYMENTS === 'true';
  }

  /**
   * Read the envelope every PayStation response shares.
   *
   * Never throws, and treats an unparseable body as a failure rather than a
   * success — the opposite of the SMS adapter's default, and deliberately so.
   * On the SMS side an unrecognised verdict means one message may have gone out
   * unrecorded; here it would mean handing over a year of subscription because
   * the gateway said something we did not understand.
   */
  readVerdict(data) {
    if (!data || typeof data !== 'object') {
      return { ok: false, code: null, message: 'Gateway returned an unreadable response' };
    }
    const code = String(data.status_code ?? '').trim();
    const status = String(data.status ?? '').trim().toLowerCase();
    const message = data.message || null;

    if (code === CODE.OK && status === 'success') {
      return { ok: true, code, message };
    }
    return {
      ok: false,
      code: code || null,
      message: message || `Gateway refused (status_code ${code || 'missing'})`,
    };
  }

  /**
   * Build the error a refusal throws, carrying the wire context the caller and
   * the category mapper both need.
   */
  refusalError(verdict, data) {
    const err = new Error(verdict.message);
    err.gatewayResponse = data;
    err.gatewayCode = verdict.code;
    err.provider = this.name;
    err.isRefusal = true;
    return err;
  }

  /**
   * Map a thrown error onto a category. Transport first, then documented codes,
   * then HTTP status — most specific wins.
   */
  categorizeError(error) {
    const transport = ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'];
    if (error?.code && transport.includes(error.code)) return PAYMENT_ERROR_CATEGORY.RETRYABLE;

    const gatewayCode = String(error?.gatewayCode ?? '').trim();
    // A reused invoice number is a fact about our request, not about the
    // gateway. Retrying sends the identical body and gets the identical refusal.
    if (gatewayCode === CODE.DUPLICATE_INVOICE) return PAYMENT_ERROR_CATEGORY.PERMANENT;
    // Wrong merchant id or password — most often the sandbox demo credentials
    // left in place while PAYSTATION_ENV says `live`. Retrying cannot fix it.
    if (gatewayCode === CODE.INVALID_CREDENTIAL) return PAYMENT_ERROR_CATEGORY.AUTH;
    if (gatewayCode === CODE.INVALID_TOKEN) return PAYMENT_ERROR_CATEGORY.AUTH;

    const status = error?.response?.status;
    if (status === 401 || status === 403) return PAYMENT_ERROR_CATEGORY.AUTH;
    if (status === 429 || (status && status >= 500)) return PAYMENT_ERROR_CATEGORY.RETRYABLE;

    return PAYMENT_ERROR_CATEGORY.RETRYABLE;
  }

  /**
   * Create a hosted-checkout session.
   *
   * @param {object}  o
   * @param {string}  o.invoiceNumber  ours, unique — a reused one is refused 1008
   * @param {number}  o.amount
   * @param {string}  o.callbackUrl    absolute; where the customer's BROWSER returns
   * @param {object}  o.customer       { name, phone, email, address }
   * @param {string}  [o.reference]    shown back to us on status lookup
   * @param {string}  [o.checkoutItems]
   * @param {string}  [o.optA]         round-trips through transaction-status
   * @returns {Promise<{paymentUrl, invoiceNumber, raw}>}
   */
  async initiatePayment({
    invoiceNumber,
    amount,
    callbackUrl,
    customer = {},
    reference = null,
    checkoutItems = null,
    optA = null,
  }) {
    if (!this.isConfigured()) {
      throw new Error('PayStation is not configured');
    }

    if (this.skipGateway) {
      logger.info(`[SKIP_PAYMENTS] pretending to initiate ${invoiceNumber} for ৳${amount}`);
      return {
        paymentUrl: `${this.baseUrl}/checkout/simulated/${invoiceNumber}`,
        invoiceNumber,
        raw: { simulated: true },
      };
    }

    const form = new FormData();
    form.append('merchantId', this.merchantId);
    form.append('password', this.password);
    form.append('invoice_number', String(invoiceNumber));
    form.append('currency', 'BDT');
    form.append('payment_amount', String(amount));
    // 0 = the MERCHANT bears the gateway fee. Settled deliberately: the shop is
    // quoted ৳800 and pays ৳800. Flipping this to 1 makes PayStation add its cut
    // at the last screen, which is exactly where a shopkeeper abandons — and it
    // would also break the amount sanity check, because the charged amount would
    // no longer equal the amount we asked for.
    form.append('pay_with_charge', '0');
    form.append('callback_url', callbackUrl);
    form.append('cust_name', customer.name || 'Hisaab Merchant');
    form.append('cust_phone', customer.phone || '');
    // Required by PayStation even though most shopkeepers have no email, so a
    // deliverable-looking placeholder rather than a blank that gets us refused.
    form.append('cust_email', customer.email || 'billing@hisaabbd.com');
    if (customer.address) form.append('cust_address', customer.address);
    if (reference) form.append('reference', reference);
    if (checkoutItems) form.append('checkout_items', checkoutItems);
    // Comes back on transaction-status (verified against sandbox), so our own
    // order id is recoverable from a PayStation dashboard row without a join.
    if (optA) form.append('opt_a', String(optA));

    let data;
    try {
      const res = await this.http.post(this.baseUrl + PATHS.INITIATE, form, {
        headers: form.getHeaders(),
      });
      data = res.data;
    } catch (err) {
      err.provider = this.name;
      throw err;
    }

    const verdict = this.readVerdict(data);
    if (!verdict.ok) throw this.refusalError(verdict, data);

    const paymentUrl = data.payment_url || null;
    if (!paymentUrl) {
      // A 200/success with nowhere to send the customer is not a success.
      throw this.refusalError(
        { ok: false, code: verdict.code, message: 'Gateway returned no payment_url' },
        data
      );
    }

    return { paymentUrl, invoiceNumber: data.invoice_number || invoiceNumber, raw: data };
  }

  /**
   * Ask the gateway what actually happened. THE source of truth.
   *
   * Returns a normalised verdict rather than throwing on a failed transaction —
   * "this payment failed" is an answer, not an error. It throws only when we
   * could not get an answer at all, which is the case the caller must retry.
   *
   * @returns {Promise<{status, trxId, paidAmount, requestedAmount, payerMobile,
   *                    paymentMethod, orderDateTime, optA, raw, found}>}
   */
  async getTransactionStatus(invoiceNumber) {
    if (!this.isConfigured()) {
      throw new Error('PayStation is not configured');
    }

    if (this.skipGateway) {
      logger.info(`[SKIP_PAYMENTS] pretending ${invoiceNumber} succeeded`);
      return {
        found: true,
        status: TRX_STATUS.SUCCESS,
        trxId: `SIM${invoiceNumber}`,
        paidAmount: null,
        requestedAmount: null,
        payerMobile: null,
        paymentMethod: 'simulated',
        orderDateTime: null,
        optA: null,
        raw: { simulated: true },
      };
    }

    let data;
    try {
      const res = await this.http.post(
        this.baseUrl + PATHS.STATUS,
        { invoice_number: String(invoiceNumber) },
        { headers: { merchantId: this.merchantId, 'Content-Type': 'application/json' } }
      );
      data = res.data;
    } catch (err) {
      err.provider = this.name;
      throw err;
    }

    const verdict = this.readVerdict(data);
    if (!verdict.ok) {
      // 2001 on a lookup means "no such transaction", which for an invoice we
      // definitely created means the customer never reached the checkout. That
      // is a real answer — not found — rather than an error to retry forever.
      if (verdict.code === CODE.INVALID_TOKEN) {
        return { found: false, status: TRX_STATUS.PROCESSING, raw: data, trxId: null };
      }
      throw this.refusalError(verdict, data);
    }

    const row = data.data || {};
    return {
      found: true,
      status: this.readTrxStatus(row.trx_status),
      trxId: row.trx_id ? String(row.trx_id) : null,
      // Both are echoes of the REQUESTED amount until the payment completes —
      // see the header. Returned for the sanity check, never for the decision.
      paidAmount: row.payment_amount != null ? Number(row.payment_amount) : null,
      requestedAmount: row.request_amount != null ? Number(row.request_amount) : null,
      payerMobile: row.payer_mobile_no || null,
      paymentMethod: row.payment_method || null,
      orderDateTime: row.order_date_time || null,
      optA: row.opt_a || null,
      raw: data,
    };
  }

  /**
   * Normalise `trx_status`.
   *
   * Lowercased because PayStation's own docs disagree with themselves about the
   * casing, and anything unrecognised becomes `processing` — the state that
   * means "ask again", which is always the safe answer to a verdict we do not
   * understand.
   */
  readTrxStatus(raw) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (value === TRX_STATUS.SUCCESS) return TRX_STATUS.SUCCESS;
    if (value === TRX_STATUS.FAILED) return TRX_STATUS.FAILED;
    if (value === TRX_STATUS.REFUND) return TRX_STATUS.REFUND;
    if (value === TRX_STATUS.PROCESSING) return TRX_STATUS.PROCESSING;
    if (value) {
      logger.warn(`[paystation] unrecognised trx_status '${raw}' — treating as processing`);
    }
    return TRX_STATUS.PROCESSING;
  }
}

// A singleton holding nothing but immutable construction-time config, exactly
// like the SMS adapters. Never put per-request state on it.
let instance = null;

function getAdapter() {
  if (!instance) instance = new PayStationAdapter();
  return instance;
}

/** Test seam — drops the cached singleton so env changes take effect. */
function resetAdapter() {
  instance = null;
}

module.exports = {
  PayStationAdapter,
  getAdapter,
  resetAdapter,
  TRX_STATUS,
  PAYMENT_ERROR_CATEGORY,
  CODE,
};
