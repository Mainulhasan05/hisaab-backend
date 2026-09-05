/**
 * The PayStation wire contract, pinned.
 *
 * Every assertion here is a mistake that is SILENT when made, and expensive:
 * each one either gives away a subscription for free or refuses one that was
 * paid for. The three that matter most were confirmed against the live sandbox
 * before being written down.
 *
 *   1. `status_code` is the STRING "200". A `=== 200` comparison reads every
 *      successful call as a failure and stops the integration dead.
 *   2. `payment_amount` ECHOES THE REQUESTED AMOUNT WHILE A TRANSACTION IS
 *      STILL UNPAID. A never-paid order returns `payment_amount: "800"` beside
 *      `trx_status: "processing"`. Any code that infers payment from the amount
 *      hands out a year of subscription to anyone who opens a checkout page and
 *      walks away.
 *   3. `trx_status` casing is inconsistent in PayStation's OWN documentation —
 *      "Success" in the v1 example, "success" in v2 — and an unrecognised value
 *      must resolve to `processing`, never to `success`.
 */

jest.mock('../utils/logger.util', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const captured = [];
const mockPost = jest.fn(async (url, payload, config) => {
  captured.push({ url, payload, config });
  if (mockPost.reject) throw mockPost.reject;
  return { data: mockPost.reply };
});

jest.mock('axios', () => ({
  create: () => ({ post: mockPost, get: jest.fn() }),
  post: mockPost,
}));

const {
  PayStationAdapter, TRX_STATUS, PAYMENT_ERROR_CATEGORY, CODE,
} = require('../services/payment/paystation.adapter');

const OLD_ENV = process.env;

function adapter(env = {}) {
  process.env = {
    ...OLD_ENV,
    PAYSTATION_ENV: 'sandbox',
    PAYSTATION_MERCHANT_ID: '104-1653730183',
    PAYSTATION_PASSWORD: 'testpass',
    SKIP_PAYMENTS: 'false',
    ...env,
  };
  return new PayStationAdapter();
}

const OK_INITIATE = {
  status_code: '200',
  status: 'success',
  message: 'Payment Link Created Successfully.',
  payment_amount: '800',
  invoice_number: 'HSBTEST1',
  payment_url: 'https://sandbox.paystation.com.bd/checkout/1/abc',
};

const initiateArgs = {
  invoiceNumber: 'HSBTEST1',
  amount: 800,
  callbackUrl: 'https://api.example.com/api/public/payments/paystation/return/64b7f9c2e1a4d3b201f5a9c8',
  customer: { name: 'Test Shop', phone: '01726315133' },
};

/** form-data instances are opaque; read back what was appended. */
function formFields(form) {
  const raw = form._streams.filter((s) => typeof s === 'string').join('\n');
  const out = {};
  const re = /name="([^"]+)"[\s\S]*?$/gm;
  let m;
  while ((m = re.exec(raw)) !== null) out[m[1]] = true;
  return { raw, has: (k) => raw.includes(`name="${k}"`), out };
}

beforeEach(() => {
  captured.length = 0;
  mockPost.mockClear();
  mockPost.reject = null;
  mockPost.reply = OK_INITIATE;
});

afterAll(() => { process.env = OLD_ENV; });

describe('status_code is a string, not a number', () => {
  test('"200" + success is accepted', () => {
    const verdict = adapter().readVerdict({ status_code: '200', status: 'success' });
    expect(verdict.ok).toBe(true);
  });

  test('a numeric 200 is still accepted — the coercion goes through String()', () => {
    const verdict = adapter().readVerdict({ status_code: 200, status: 'success' });
    expect(verdict.ok).toBe(true);
  });

  test('1008 duplicate invoice is a refusal carrying its code', () => {
    const verdict = adapter().readVerdict({
      status_code: '1008', status: 'failed', message: 'Duplicate invoice number.',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe(CODE.DUPLICATE_INVOICE);
    expect(verdict.message).toBe('Duplicate invoice number.');
  });

  test('an unreadable body is a FAILURE, not a success', () => {
    // The opposite default to the SMS adapters, deliberately: there an
    // unrecognised verdict risks one unlogged message, here it risks handing
    // over a year of subscription for nothing.
    expect(adapter().readVerdict(null).ok).toBe(false);
    expect(adapter().readVerdict('<html>502</html>').ok).toBe(false);
    expect(adapter().readVerdict({}).ok).toBe(false);
  });
});

describe('initiatePayment', () => {
  test('sends the merchant credentials in the BODY and never in a header', async () => {
    await adapter().initiatePayment(initiateArgs);

    const form = formFields(captured[0].payload);
    expect(form.has('merchantId')).toBe(true);
    expect(form.has('password')).toBe(true);
    expect(form.raw).toContain('104-1653730183');
    // transaction-status wants merchantId in a header; initiate-payment does not.
    expect(captured[0].config?.headers?.merchantId).toBeUndefined();
  });

  test('pay_with_charge is 0 — WE absorb the gateway fee', async () => {
    await adapter().initiatePayment(initiateArgs);
    const { raw } = formFields(captured[0].payload);
    // A 1 here makes PayStation add its cut at the final screen, so the shop
    // quoted ৳800 is charged more, and the amount we verify against stops
    // matching the amount charged.
    expect(raw).toMatch(/name="pay_with_charge"[\s\S]*?\r?\n\r?\n0/);
  });

  test('a 200 with no payment_url is treated as a refusal', async () => {
    mockPost.reply = { status_code: '200', status: 'success', message: 'ok' };
    await expect(adapter().initiatePayment(initiateArgs)).rejects.toThrow(/no payment_url/i);
  });

  test('refuses to call the gateway at all when unconfigured', async () => {
    const a = adapter({ PAYSTATION_MERCHANT_ID: '', PAYSTATION_PASSWORD: '' });
    expect(a.isConfigured()).toBe(false);
    await expect(a.initiatePayment(initiateArgs)).rejects.toThrow(/not configured/i);
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('opt_a carries our order id so it round-trips through the gateway', async () => {
    await adapter().initiatePayment({ ...initiateArgs, optA: '64b7f9c2e1a4d3b201f5a9c8' });
    expect(formFields(captured[0].payload).raw).toContain('64b7f9c2e1a4d3b201f5a9c8');
  });
});

describe('getTransactionStatus — the only source of truth', () => {
  const statusBody = (trxStatus, extra = {}) => ({
    status_code: '200',
    status: 'success',
    message: 'Transaction found',
    data: {
      invoice_number: 'HSBTEST1',
      trx_status: trxStatus,
      trx_id: 'CG20D8AYB4',
      payment_amount: '800',
      request_amount: '800',
      payer_mobile_no: '018*******',
      payment_method: 'bKash',
      ...extra,
    },
  });

  test('sends merchantId in the HEADER', async () => {
    mockPost.reply = statusBody('success');
    await adapter().getTransactionStatus('HSBTEST1');
    expect(captured[0].config.headers.merchantId).toBe('104-1653730183');
    expect(captured[0].payload).toEqual({ invoice_number: 'HSBTEST1' });
  });

  test('AN UNPAID TRANSACTION STILL REPORTS THE FULL AMOUNT', async () => {
    // Verified against the live sandbox. This is the single most dangerous
    // property of this API: the amount fields are populated from the REQUEST,
    // so they say ৳800 for a payment that has not happened.
    mockPost.reply = statusBody('processing');
    const result = await adapter().getTransactionStatus('HSBTEST1');

    expect(result.paidAmount).toBe(800);
    expect(result.requestedAmount).toBe(800);
    // …and the status is what stops that being mistaken for payment.
    expect(result.status).toBe(TRX_STATUS.PROCESSING);
    expect(result.status).not.toBe(TRX_STATUS.SUCCESS);
  });

  test('"Success" and "success" both mean success — the docs use both', async () => {
    for (const spelling of ['success', 'Success', 'SUCCESS', ' success ']) {
      mockPost.reply = statusBody(spelling);
      const result = await adapter().getTransactionStatus('HSBTEST1');
      expect(result.status).toBe(TRX_STATUS.SUCCESS);
    }
  });

  test('an unrecognised trx_status is processing, never success', async () => {
    mockPost.reply = statusBody('cancelled_by_bank_maybe');
    const result = await adapter().getTransactionStatus('HSBTEST1');
    expect(result.status).toBe(TRX_STATUS.PROCESSING);
  });

  test('failed and refund are distinct from processing', async () => {
    mockPost.reply = statusBody('Failed');
    expect((await adapter().getTransactionStatus('X')).status).toBe(TRX_STATUS.FAILED);
    mockPost.reply = statusBody('refund');
    expect((await adapter().getTransactionStatus('X')).status).toBe(TRX_STATUS.REFUND);
  });

  test('2001 means "no such transaction" — an answer, not an error to retry', async () => {
    mockPost.reply = { status_code: '2001', status: 'failed', message: 'Transaction not found in system' };
    const result = await adapter().getTransactionStatus('NOPE');
    expect(result.found).toBe(false);
    // Not-found must never read as failed: an order whose customer has not yet
    // reached the checkout would be killed off while they were still typing.
    expect(result.status).toBe(TRX_STATUS.PROCESSING);
  });
});

describe('categorizeError', () => {
  test('a duplicate invoice is PERMANENT — retrying sends the identical body', () => {
    const err = Object.assign(new Error('dup'), { gatewayCode: CODE.DUPLICATE_INVOICE });
    expect(adapter().categorizeError(err)).toBe(PAYMENT_ERROR_CATEGORY.PERMANENT);
  });

  test('bad credentials are AUTH', () => {
    const err = Object.assign(new Error('token'), { gatewayCode: CODE.INVALID_TOKEN });
    expect(adapter().categorizeError(err)).toBe(PAYMENT_ERROR_CATEGORY.AUTH);
  });

  test('1001 Invalid Credential is AUTH, not retryable', () => {
    // Undocumented by PayStation; found by pointing the LIVE host at sandbox
    // credentials. Unmapped it fell through to `retryable`, which would have the
    // platform retrying a credential that can never work, on every renewal.
    const err = Object.assign(new Error('Invalid Credential.'), { gatewayCode: '1001' });
    expect(adapter().categorizeError(err)).toBe(PAYMENT_ERROR_CATEGORY.AUTH);
  });

  test('timeouts and 5xx are retryable', () => {
    expect(adapter().categorizeError({ code: 'ECONNABORTED' })).toBe(PAYMENT_ERROR_CATEGORY.RETRYABLE);
    expect(adapter().categorizeError({ response: { status: 503 } })).toBe(PAYMENT_ERROR_CATEGORY.RETRYABLE);
  });

  test('an unknown error defaults to retryable', () => {
    // Same asymmetry the SMS adapters document: a wrong `retryable` costs one
    // extra call, a wrong `permanent` abandons a payment that would have worked.
    expect(adapter().categorizeError(new Error('???'))).toBe(PAYMENT_ERROR_CATEGORY.RETRYABLE);
  });
});

describe('the merchant id is never printed in full', () => {
  test('getProviderInfo masks it', () => {
    const info = adapter().getProviderInfo();
    expect(info.merchantId).not.toBe('104-1653730183');
    expect(info.merchantId).toMatch(/^104-…0183$/);
    expect(info.configured).toBe(true);
    expect(info.env).toBe('sandbox');
  });
});
