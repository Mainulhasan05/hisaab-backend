/**
 * The Automas wire contract, pinned.
 *
 * These assertions are not style preferences. Each one guards a failure that
 * returns HTTP 200 with a success-shaped body while delivering nothing, which is
 * the only kind of bug this gateway actually produces:
 *
 *   1. The body must be FORM-ENCODED. A JSON post is accepted, ignored, and
 *      answered with `msisdn: "NA"` and status 105. This is how the integration
 *      was broken for its entire life before 2026-09-10.
 *   2. Success is `status: 0`. A truthiness check on that field is backwards —
 *      it reads every success as a failure and every failure as a success.
 *   3. Recipients the gateway did not confirm must not be marked sent.
 *
 * The bodies asserted here are the ones the live gateway returned on
 * 2026-09-10, not invented shapes.
 */

jest.mock('../utils/logger.util', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const captured = [];
const mockPost = jest.fn(async (url, body, config) => {
  captured.push({ url, body, config, params: Object.fromEntries(new URLSearchParams(body)) });
  const reply = Array.isArray(mockPost.replies) ? mockPost.replies.shift() : mockPost.reply;
  if (reply instanceof Error) throw reply;
  return { data: reply };
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
    AUTOMAS_BALANCE_URL: '',
    AUTOMAS_HTTP_ENCODE: '',
    SKIP_SMS: 'false',
    ...env,
  };
  return new AutomasAdapter();
}

beforeEach(() => {
  captured.length = 0;
  mockPost.mockClear();
  mockPost.reply = { response: [] };
  mockPost.replies = null;
});

afterAll(() => { process.env = OLD_ENV; });

const ok = (msisdn, id = 1) => ({ status: 0, id, msisdn });

describe('the request is form-encoded, never JSON', () => {
  /**
   * The bug this whole rewrite exists for. A JSON body returns
   * `{"response":[{"status":105,"id":95413,"msisdn":"NA"}]}` — HTTP 200, an
   * allocated id, and nothing delivered. Passing an object to axios.post is the
   * mistake; it must be a urlencoded string with the matching content type.
   */
  test('single send posts a urlencoded string with the form content type', async () => {
    mockPost.reply = { response: [ok('8801712345678', 296334)] };
    await adapter().sendSingle('01712345678', 'Hello');

    expect(typeof captured[0].body).toBe('string');
    expect(captured[0].config.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(captured[0].params).toMatchObject({
      apikey: 'KEY123',
      sender: '8809617632463',
      msisdn: '8801712345678',
      smstext: 'Hello',
    });
  });

  test('bulk and dynamic use the same endpoint and the same auth parameters', async () => {
    mockPost.reply = { response: [ok('8801712345678')] };
    const a = adapter();

    await a.sendBulk(['01712345678'], 'Hello');
    await a.sendDynamic([{ phone: '01712345678', message: 'Hi' }]);

    expect(captured[0].url).toBe(captured[1].url);
    for (const call of captured) {
      expect(typeof call.body).toBe('string');
      expect(call.params).toMatchObject({ apikey: 'KEY123', sender: '8809617632463' });
      // The docs' bulk shape. It authenticates as nobody on this account.
      expect(call.params.api_key).toBeUndefined();
      expect(call.params.senderid).toBeUndefined();
      expect(call.params.contacts).toBeUndefined();
    }
  });

  /** Many recipients ride in one call as a comma-separated msisdn list. */
  test('bulk joins recipients into one msisdn parameter', async () => {
    mockPost.reply = { response: [ok('8801712345678', 1), ok('8801812345678', 2)] };
    await adapter().sendBulk(['01712345678', '01812345678'], 'Hi');

    expect(captured).toHaveLength(1);
    expect(captured[0].params.msisdn).toBe('8801712345678,8801812345678');
  });
});

describe('status 0 is success', () => {
  test('status 0 resolves', async () => {
    mockPost.reply = { response: [ok('8801712345678', 296334)] };
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

  /** The live signature of an ignored body: no recipient echoed back. */
  test('the "NA" msisdn refusal is surfaced, not swallowed', async () => {
    mockPost.reply = { response: [{ status: 105, id: 95413, msisdn: 'NA' }] };

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

    const err = await a.sendSingle('01712345678', 'Hello').catch((e) => e);
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
    mockPost.reply = { response: [ok('8801712345678')] }; // second number absent

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
        ok('8801712345678', 7),
      ],
    };

    const result = await adapter().sendBulk(['01712345678', '01812345678'], 'Hi');

    expect(result.results[0]).toMatchObject({ phone: '8801712345678', success: true, messageId: 7 });
    expect(result.results[1]).toMatchObject({ phone: '8801812345678', success: false });
  });

  /**
   * A number can legitimately appear twice in a campaign list. Mapping each
   * occurrence to the same response entry would report one gateway id twice and
   * hide a failure behind a success.
   */
  test('a repeated number consumes one response entry each', async () => {
    mockPost.reply = {
      response: [ok('8801712345678', 11), { status: 1000, msisdn: '8801712345678' }],
    };

    const result = await adapter().sendBulk(['01712345678', '01712345678'], 'Hi');

    expect(result.results[0]).toMatchObject({ success: true, messageId: 11 });
    expect(result.results[1]).toMatchObject({ success: false, statusCode: 1000 });
  });

  test('an empty response throws so the batch can fail over as a whole', async () => {
    mockPost.reply = { response: [] };
    await expect(adapter().sendBulk(['01712345678'], 'Hi'))
      .rejects.toThrow(/no results/);
  });
});

describe('personalised sends without a dynamic endpoint', () => {
  /** Recipients sharing a body collapse into one call — the common campaign. */
  test('one call per distinct body, results still in input order', async () => {
    mockPost.replies = [
      { response: [ok('8801712345678', 11), ok('8801912345678', 13)] }, // body "A"
      { response: [ok('8801812345678', 12)] }, // body "B"
    ];

    const result = await adapter().sendDynamic([
      { phone: '01712345678', message: 'A' },
      { phone: '01812345678', message: 'B' },
      { phone: '01912345678', message: 'A' },
    ]);

    expect(captured).toHaveLength(2);
    expect(captured[0].params.msisdn).toBe('8801712345678,8801912345678');
    expect(captured[1].params.msisdn).toBe('8801812345678');

    expect(result.results[0]).toMatchObject({ phone: '8801712345678', messageId: 11 });
    expect(result.results[1]).toMatchObject({ phone: '8801812345678', messageId: 12 });
    expect(result.results[2]).toMatchObject({ phone: '8801912345678', messageId: 13 });
  });

  /**
   * A group whose call failed must not take the groups that succeeded with it.
   * Re-sending the whole campaign would double-charge everyone who did receive
   * their message.
   */
  test('one failed group leaves the others confirmed', async () => {
    const boom = new Error('socket hang up');
    boom.code = 'ECONNRESET';
    mockPost.replies = [{ response: [ok('8801712345678', 11)] }, boom];

    const result = await adapter().sendDynamic([
      { phone: '01712345678', message: 'A' },
      { phone: '01812345678', message: 'B' },
    ]);

    expect(result.results[0]).toMatchObject({ success: true, messageId: 11 });
    expect(result.results[1]).toMatchObject({ success: false });
  });

  test('every group failing throws so the dispatcher can fail over', async () => {
    const boom = new Error('socket hang up');
    boom.code = 'ECONNRESET';
    mockPost.replies = [boom, boom];

    await expect(adapter().sendDynamic([
      { phone: '01712345678', message: 'A' },
      { phone: '01812345678', message: 'B' },
    ])).rejects.toThrow(/socket hang up/);
  });
});

describe('chunking', () => {
  test('a list beyond the cap is split, and a failed chunk costs only itself', async () => {
    mockPost.replies = [
      { response: [ok('8801712345678', 1)] },
      new Error('boom'),
    ];

    const result = await adapter({ AUTOMAS_MAX_RECIPIENTS: '1' })
      .sendBulk(['01712345678', '01812345678'], 'Hi');

    expect(captured).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ success: true, messageId: 1 });
    expect(result.results[1]).toMatchObject({ success: false });
  });
});

describe('body encoding', () => {
  /**
   * The docs call the field "HTTP encoded". This account does not decode it: a
   * message reading "A&B 50% #1 +2" was sent raw on 2026-09-10 and arrived on
   * the handset exactly as written. Encoding it here would deliver "%26".
   */
  test('collision characters go out untouched by default', async () => {
    mockPost.reply = { response: [ok('8801712345678')] };
    await adapter().sendSingle('01712345678', '100% off A&B +1 #sale');

    expect(captured[0].params.smstext).toBe('100% off A&B +1 #sale');
  });

  test('percent-encoding can be switched back on without a deploy', async () => {
    mockPost.reply = { response: [ok('8801712345678')] };
    await adapter({ AUTOMAS_HTTP_ENCODE: 'true' }).sendSingle('01712345678', 'A&B');

    // "%" first: encoding it after the others would re-encode the % signs they
    // just introduced, and the recipient would read %2526 instead of &.
    expect(captured[0].params.smstext).toBe('A%26B');
  });

  test('a Unicode message is flagged; an ASCII one is not', async () => {
    mockPost.reply = { response: [ok('8801712345678')] };
    const a = adapter();

    await a.sendSingle('01712345678', 'Hello');
    expect(captured[0].params.type).toBeUndefined();

    await a.sendSingle('01712345678', 'হ্যালো');
    expect(captured[1].params.type).toBe('8');
  });
});

describe('balance', () => {
  /**
   * There is no balance endpoint on this account, and the previous code posted
   * the balance request to the SEND url — so every load of the admin providers
   * screen fired a send-shaped request at the gateway.
   */
  test('with no balance url configured, nothing is called at all', async () => {
    const result = await adapter().checkBalance();

    expect(mockPost).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, balance: null, supported: false });
  });

  test('a real balance is read from the bare-string response', async () => {
    mockPost.reply = { response: '1234.56' };
    const result = await adapter({ AUTOMAS_BALANCE_URL: 'https://x/balance' }).checkBalance();

    expect(captured[0].params).toEqual({ api_key: 'KEY123' });
    expect(result.balance).toBeCloseTo(1234.56, 2);
  });

  /**
   * /getbalance answers "104" to any request, including an empty one. That is
   * the code for "Invalid User" — reporting it as 104 taka of credit would let
   * a campaign start against a balance that does not exist.
   */
  test('a bare status code is reported as an error, not as taka', async () => {
    mockPost.reply = { response: '104' };
    const result = await adapter({ AUTOMAS_BALANCE_URL: 'https://x/balance' }).checkBalance();

    expect(result.success).toBe(false);
    expect(result.balance).toBeNull();
    expect(result.error).toMatch(/Invalid User/);
  });
});

describe('configuration', () => {
  test('missing credentials report unconfigured rather than throwing at send time', () => {
    const a = adapter({ AUTOMAS_API_KEY: '', AUTOMAS_SENDER_ID: '' });
    expect(a.isConfigured()).toBe(false);
    expect(a.getProviderInfo()).toMatchObject({ name: 'automas', configured: false });
  });

  test('SKIP_SMS short-circuits every send path', async () => {
    const a = adapter({ SKIP_SMS: 'true' });

    expect((await a.sendSingle('01712345678', 'Hi')).success).toBe(true);
    expect((await a.sendBulk(['01712345678'], 'Hi')).results).toHaveLength(1);
    expect((await a.sendDynamic([{ phone: '01712345678', message: 'Hi' }])).results).toHaveLength(1);
    expect(mockPost).not.toHaveBeenCalled();
  });
});
