/**
 * The Automas wire contract, pinned.
 *
 * Automas differs from MimSMS in three ways that are silent when wrong, which is
 * exactly why they are asserted here rather than trusted:
 *
 *   1. Success is `status: 0`. A truthiness check on that field is backwards —
 *      it reads every success as a failure and every failure as a success.
 *   2. The auth parameter is named differently PER ENDPOINT. Sending `apikey` to
 *      the bulk endpoint authenticates as nobody and returns 103.
 *   3. The message field is URL-decoded server-side, so collision characters
 *      must be percent-encoded on the way out.
 */

jest.mock('../utils/logger.util', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const captured = [];
const mockPost = jest.fn(async (url, payload) => {
  captured.push({ url, payload });
  return { data: mockPost.reply };
});

jest.mock('axios', () => ({
  create: () => ({ post: mockPost, get: jest.fn() }),
  post: mockPost,
}));

const AutomasAdapter = require('../services/sms/adapters/automas.adapter');
const { ERROR_CATEGORY } = require('../services/sms/adapters/base.adapter');

const OLD_ENV = process.env;

function adapter(env = {}) {
  process.env = {
    ...OLD_ENV,
    AUTOMAS_API_KEY: 'KEY123',
    AUTOMAS_SENDER_ID: '8809617632463',
    SKIP_SMS: 'false',
    ...env,
  };
  return new AutomasAdapter();
}

beforeEach(() => {
  captured.length = 0;
  mockPost.mockClear();
  mockPost.reply = { response: [] };
});

afterAll(() => { process.env = OLD_ENV; });

describe('auth parameter naming differs per endpoint', () => {
  test('single send uses apikey + sender', async () => {
    mockPost.reply = { response: [{ status: 0, id: 296334, msisdn: '8801712345678' }] };
    await adapter().sendSingle('01712345678', 'Hello');

    expect(captured[0].payload).toMatchObject({ apikey: 'KEY123', sender: '8809617632463' });
    expect(captured[0].payload.api_key).toBeUndefined();
  });

  /** The one that silently authenticates as nobody if it is got wrong. */
  test('bulk send uses api_key + senderid', async () => {
    mockPost.reply = { response: [{ status: 0, id: 1, msisdn: '8801712345678' }] };
    await adapter().sendBulk(['01712345678'], 'Hello');

    expect(captured[0].payload).toMatchObject({ api_key: 'KEY123', senderid: '8809617632463' });
    expect(captured[0].payload.apikey).toBeUndefined();
  });

  test('dynamic send uses apikey + sender', async () => {
    mockPost.reply = { response: [{ status: 0, cid: 1, sid: 11, msisdn: '8801712345678' }] };
    await adapter().sendDynamic([{ phone: '01712345678', message: 'Hi' }]);

    expect(captured[0].payload).toMatchObject({ apikey: 'KEY123', sender: '8809617632463' });
  });

  test('balance uses api_key', async () => {
    mockPost.reply = { response: '1234.56' };
    const result = await adapter().checkBalance();

    expect(captured[0].payload).toEqual({ api_key: 'KEY123' });
    expect(result.balance).toBeCloseTo(1234.56, 2);
  });
});

describe('status 0 is success', () => {
  test('status 0 resolves', async () => {
    mockPost.reply = { response: [{ status: 0, id: 296334, msisdn: '8801712345678' }] };
    const result = await adapter().sendSingle('01712345678', 'Hello');

    expect(result.success).toBe(true);
    expect(result.messageId).toBe(296334);
    expect(result.provider).toBe('automas');
  });

  test('a non-zero status throws, carrying the documented meaning', async () => {
    mockPost.reply = { response: [{ status: 105, msisdn: '8801712345678' }] };

    await expect(adapter().sendSingle('01712345678', 'Hello'))
      .rejects.toThrow(/Invalid MSISDN/);
  });
});

describe('error categories drive failover correctly', () => {
  const cases = [
    [103, ERROR_CATEGORY.AUTH, 'Authentication Failed'],
    [106, ERROR_CATEGORY.AUTH, 'Incorrect API Key'],
    [108, ERROR_CATEGORY.AUTH, 'IP Address Not Allowed'],
    [1000, ERROR_CATEGORY.BALANCE, 'Insufficient Balance'],
    [2300, ERROR_CATEGORY.RETRYABLE, 'Destination Route Issue'],
    [3300, ERROR_CATEGORY.RETRYABLE, 'System Error'],
    // These describe the MESSAGE or the RECIPIENT, not the gateway — the other
    // gateway rejects them identically, so failing over spends a second credit
    // to be told the same thing.
    [101, ERROR_CATEGORY.PERMANENT, 'Invalid Message Length'],
    [102, ERROR_CATEGORY.PERMANENT, 'Sender Not Valid'],
    [105, ERROR_CATEGORY.PERMANENT, 'Invalid MSISDN'],
    [110, ERROR_CATEGORY.PERMANENT, 'Do Not Disturb'],
    [111, ERROR_CATEGORY.PERMANENT, 'Spam Word'],
  ];

  test.each(cases)('status %i is %s (%s)', async (code, expected) => {
    const a = adapter();
    mockPost.reply = { response: [{ status: code, msisdn: '8801712345678' }] };

    const err = await adapter().sendSingle('01712345678', 'Hello').catch((e) => e);
    expect(a.categorizeError(err)).toBe(expected);
  });

  test('a transport timeout is retryable', () => {
    const err = new Error('timeout');
    err.code = 'ECONNABORTED';
    expect(adapter().categorizeError(err)).toBe(ERROR_CATEGORY.RETRYABLE);
  });
});

describe('per-recipient results', () => {
  /**
   * The single most important correctness rule for batches: a recipient the
   * gateway did not confirm must not be marked sent. Doing so overstates
   * delivery, charges the shop for messages nobody received, and leaves no way
   * to tell who actually missed out.
   */
  test('a recipient missing from the response is NOT marked sent', async () => {
    mockPost.reply = {
      response: [{ status: 0, id: 1, msisdn: '8801712345678' }],
      // The second number is absent entirely.
    };

    const result = await adapter().sendBulk(['01712345678', '01812345678'], 'Hi');

    expect(result.results).toHaveLength(2);
    expect(result.results[0].success).toBe(true);
    expect(result.results[1].success).toBe(false);
    expect(result.results[1].error).toMatch(/Missing gateway result/);
  });

  /** Position is not promised by the gateway; the msisdn is the join key. */
  test('results are matched by number, not by position', async () => {
    mockPost.reply = {
      response: [
        { status: 105, msisdn: '8801812345678' },
        { status: 0, id: 7, msisdn: '8801712345678' },
      ],
    };

    const result = await adapter().sendBulk(['01712345678', '01812345678'], 'Hi');

    expect(result.results[0]).toMatchObject({ phone: '8801712345678', success: true, messageId: 7 });
    expect(result.results[1]).toMatchObject({ phone: '8801812345678', success: false });
  });

  test('dynamic results join on the cid we supplied', async () => {
    mockPost.reply = {
      response: [
        { status: 0, cid: 2, sid: 22, msisdn: '8801812345678' },
        { status: 0, cid: 1, sid: 11, msisdn: '8801712345678' },
      ],
    };

    const result = await adapter().sendDynamic([
      { phone: '01712345678', message: 'A' },
      { phone: '01812345678', message: 'B' },
    ]);

    expect(result.results[0]).toMatchObject({ phone: '8801712345678', messageId: 11 });
    expect(result.results[1]).toMatchObject({ phone: '8801812345678', messageId: 22 });
  });

  test('an empty response throws so the batch can fail over as a whole', async () => {
    mockPost.reply = { response: [] };
    await expect(adapter().sendBulk(['01712345678'], 'Hi'))
      .rejects.toThrow(/no results/);
  });
});

describe('body encoding', () => {
  /**
   * The gateway URL-decodes the body. A literal "&" would otherwise be either
   * corrupted or accepted with an id and silently never delivered.
   */
  test('collision characters are percent-encoded, with % encoded first', async () => {
    mockPost.reply = { response: [{ status: 0, id: 1, msisdn: '8801712345678' }] };
    await adapter().sendSingle('01712345678', '100% off A&B +1 #sale');

    // "%" first: encoding it after the others would re-encode the % signs they
    // just introduced, and the recipient would read %2526 instead of &.
    expect(captured[0].payload.smstext).toBe('100%25 off A%26B %2B1 %23sale');
  });

  test('encoding can be switched off without a deploy', async () => {
    mockPost.reply = { response: [{ status: 0, id: 1, msisdn: '8801712345678' }] };
    await adapter({ AUTOMAS_HTTP_ENCODE: 'false' }).sendSingle('01712345678', 'A&B');

    expect(captured[0].payload.smstext).toBe('A&B');
  });

  test('a Unicode message is flagged; an ASCII one is not', async () => {
    mockPost.reply = { response: [{ status: 0, id: 1, msisdn: '8801712345678' }] };
    const a = adapter();

    await a.sendSingle('01712345678', 'Hello');
    expect(captured[0].payload.type).toBeUndefined();

    await a.sendSingle('01712345678', 'হ্যালো');
    expect(captured[1].payload.type).toBe('8');
  });
});

describe('configuration', () => {
  test('missing credentials report unconfigured rather than throwing at send time', () => {
    const a = adapter({ AUTOMAS_API_KEY: '', AUTOMAS_SENDER_ID: '' });
    expect(a.isConfigured()).toBe(false);
    expect(a.getProviderInfo()).toMatchObject({ name: 'automas', configured: false });
  });
});
