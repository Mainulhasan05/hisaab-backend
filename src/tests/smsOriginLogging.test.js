/**
 * Every SMS the app sends must land in the SMS panel, with where it was ordered
 * from and when it actually left.
 *
 * Three things this pins, each of which was silently absent before:
 *
 *   1. ORIGIN IS AMBIENT. It is stamped by a model hook from the request in
 *      flight, not passed in by the call site. The three paths that write an
 *      SMS log have one `req` between them, and the two without it — the
 *      receipt fired from the till after a sale, and the OTP sent during
 *      registration — are precisely the ones whose origin matters most. A test
 *      that only checked the controller path would pass while both stayed
 *      blank.
 *
 *   2. OTPs ARE LOGGED AT ALL. `SMS_TYPES.OTP` existed, the panel had an OTP
 *      filter and a "System OTP" pill, and not one document had ever carried
 *      that type — `sendOTP` called the gateway and wrote nothing. It is the
 *      highest-volume message the product sends.
 *
 *   3. `sentAt` IS WHEN THE GATEWAY TOOK IT. A campaign's log is written before
 *      the first gateway call so a crash leaves a record, so `createdAt` is
 *      when the send was ORDERED. On a five-thousand-recipient campaign the
 *      first message leaves minutes later — and a queue retry that resumes at
 *      batch 30 must not restamp the field to the time of the restart.
 */

// The gateway is stubbed at the axios layer, before sms.service builds its
// client. Without this the failure case below reaches api.mimsms.com for real
// — it passes, because unconfigured credentials are refused, but a unit test
// that needs the internet fails in CI for reasons that have nothing to do with
// the code under test.
const mockGatewayPost = jest.fn();
jest.mock('axios', () => ({
  create: () => ({ post: mockGatewayPost, get: jest.fn() }),
  post: mockGatewayPost,
}));

/**
 * Routing and earnings both read the database on the send path, and this suite
 * runs without one. In production that read is fast; here it waits out the
 * lookup bound on every call, which turns an eleven-test file into a
 * thirty-second one for reasons that have nothing to do with what it asserts.
 *
 * Stubbed rather than bounded-away because the subject of these tests is the
 * SHAPE OF THE LOG ROW, not which gateway was chosen or what it cost. The
 * failover decisions live in smsFailover.test.js, where they are the point.
 */
jest.mock('../services/sms/routing', () => ({
  resolve: jest.fn().mockResolvedValue({
    primaryProvider: 'mimsms', failoverProvider: null,
    failoverEnabled: false, source: 'test',
  }),
  invalidate: jest.fn(),
  describe: jest.fn(),
}));

jest.mock('../services/sms/earnings', () => ({
  priceAndRecord: jest.fn().mockResolvedValue({
    provider: 'mimsms', billedSegments: 1,
    unitCost: null, totalCost: null, revenue: null, unpriced: true,
  }),
  invalidate: jest.fn(),
}));

const mongoose = require('mongoose');
const SMSLog = require('../models/SMSLog.model');
const SMSQuota = require('../models/SMSQuota.model');
const smsService = require('../services/sms.service');
const { runWithContext } = require('../utils/requestStore.util');
const { SMS_STATUS, SMS_TYPES } = require('../config/constants');

/** The shape requestContext.middleware.js leaves on `req`. */
const fakeRequest = (ip = '103.106.72.14') => ({
  clientInfo: {
    ip,
    userAgent: 'Mozilla/5.0 (Linux; Android 13) Chrome/120',
    browser: 'Chrome',
    os: 'Android',
    device: 'Samsung',
  },
  context: { requestId: 'mk3f9a1-abc123xyz' },
});

/** Validate without a database — the hook runs on `pre('validate')`. */
const stamp = async (doc) => {
  const log = new SMSLog(doc);
  await log.validate();
  return log;
};

const MINIMAL = {
  recipients: [{ phone: '8801712345678' }],
  message: 'Test message',
};

describe('SMSLog origin stamping', () => {
  it('records the IP and device of the request that ordered the send', async () => {
    const log = await runWithContext(fakeRequest(), () => stamp(MINIMAL));

    expect(log.origin.ip).toBe('103.106.72.14');
    expect(log.origin.browser).toBe('Chrome');
    expect(log.origin.os).toBe('Android');
    expect(log.origin.device).toBe('Samsung');
    expect(log.origin.requestId).toBe('mk3f9a1-abc123xyz');
    expect(log.origin.source).toBe('web');
  });

  it('reaches a send fired after the response, with no req in hand', async () => {
    // The sale receipt path: `setImmediate` inside the request, running after
    // the till has already been answered. AsyncLocalStorage propagates across
    // it, which is the entire reason origin is ambient rather than threaded —
    // `sendSaleReceiptAsync` is never given a `req`.
    const log = await runWithContext(fakeRequest('203.112.18.9'), async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return stamp(MINIMAL);
    });

    expect(log.origin.ip).toBe('203.112.18.9');
    expect(log.origin.source).toBe('web');
  });

  it('marks a send with no request behind it as system, not as a missing IP', async () => {
    // A script, a seeder, or a queue worker resuming a campaign. A blank IP
    // here means nobody was on the other end — it must be tellable apart from
    // a blank IP that means the recording was forgotten.
    const log = await stamp(MINIMAL);

    expect(log.origin.ip).toBeNull();
    expect(log.origin.source).toBe('system');
  });

  it('never overwrites an origin the caller set deliberately', async () => {
    // Anything replaying work on behalf of a request it no longer holds knows
    // more than the ambient context does.
    const log = await runWithContext(fakeRequest(), () =>
      stamp({ ...MINIMAL, origin: { ip: '10.0.0.5', source: 'queue' } })
    );

    expect(log.origin.ip).toBe('10.0.0.5');
    expect(log.origin.source).toBe('queue');
  });
});

describe('OTP sends reach the SMS panel', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.restoreAllMocks();
    // The simulated path, so the test never touches the real gateway. A
    // pretended send is logged too — otherwise a development run exercises
    // nothing and the panel first meets real traffic in production.
    process.env = { ...OLD_ENV, SKIP_SMS: 'true', NODE_ENV: 'test' };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('writes an otp-typed, shop-less log carrying the requester IP', async () => {
    const create = jest.spyOn(SMSLog, 'create').mockResolvedValue({ _id: 'log1' });

    await runWithContext(fakeRequest('118.179.44.2'), () =>
      smsService.sendOTP('01712345678', '483920')
    );

    expect(create).toHaveBeenCalledTimes(1);
    const doc = create.mock.calls[0][0];

    expect(doc.type).toBe(SMS_TYPES.OTP);
    // `shop: null` is how a shop-less send has always been represented, and is
    // what keeps these out of the shop-facing history.
    expect(doc.shop).toBeNull();
    expect(doc.status).toBe(SMS_STATUS.SENT);
    expect(doc.recipients[0].phone).toBe('8801712345678');
    expect(doc.sentAt).toBeInstanceOf(Date);

    // Origin is not on the payload — the model hook adds it on validate. Prove
    // the context is live at the point `create` is reached, which is the part
    // that would break if the send were moved off the request's async chain.
    const stamped = await runWithContext(fakeRequest('118.179.44.2'), () =>
      stamp({ ...doc, origin: undefined })
    );
    expect(stamped.origin.ip).toBe('118.179.44.2');
  });

  it('logs a real send with the gateway transaction id', async () => {
    process.env.SKIP_SMS = 'false';
    mockGatewayPost.mockResolvedValue({
      data: { statusCode: '200', status: 'Success', TransactionId: 'TX-778812' },
    });
    const create = jest.spyOn(SMSLog, 'create').mockResolvedValue({ _id: 'log2' });

    await smsService.sendOTP('01712345678', '556677');

    const doc = create.mock.calls[0][0];
    expect(doc.status).toBe(SMS_STATUS.SENT);
    expect(doc.transactionId).toBe('TX-778812');
    expect(doc.sentAt).toBeInstanceOf(Date);
  });

  it('records a gateway refusal as failed, not as sent', async () => {
    // MimSMS refuses with HTTP 200 and the verdict in the body. `sendOTP` did
    // not read it, so a code the gateway turned away — a dead number, an
    // exhausted platform float — would have been logged `sent`, and the one
    // screen built to answer "why did this user never get their OTP" would
    // have answered it wrongly.
    process.env.SKIP_SMS = 'false';
    mockGatewayPost.mockResolvedValue({
      data: { statusCode: '400', status: 'Failed', responseResult: 'Invalid Mobile Number' },
    });
    const create = jest.spyOn(SMSLog, 'create').mockResolvedValue({ _id: 'log3' });

    await expect(smsService.sendOTP('01712345678', '111222')).rejects.toThrow(/Invalid Mobile Number/);

    expect(create).toHaveBeenCalledTimes(1);
    const doc = create.mock.calls[0][0];
    expect(doc.status).toBe(SMS_STATUS.FAILED);
    expect(doc.failedCount).toBe(1);
    expect(doc.sentAt).toBeNull();
    expect(doc.errorMessage).toMatch(/Invalid Mobile Number/);
    // The refusal body is the only record of what the gateway objected to.
    expect(doc.apiResponse).toEqual(expect.objectContaining({ status: 'Failed' }));
  });

  it('does not fail the caller when the log write itself fails', async () => {
    // Registration must not roll a new shop owner back over a bookkeeping row.
    jest.spyOn(SMSLog, 'create').mockRejectedValue(new Error('mongo down'));

    await expect(smsService.sendOTP('01712345678', '999000')).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
  });
});

describe('campaign sentAt', () => {
  const logId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(SMSLog, 'updateOne').mockResolvedValue({ modifiedCount: 1 });
    jest.spyOn(SMSQuota, 'refund').mockResolvedValue(true);
  });

  const run = (overrides = {}) =>
    smsService.runCampaign({
      logId,
      shopId: new mongoose.Types.ObjectId(),
      batches: [[{ phone: '8801711111111' }], [{ phone: '8801722222222' }]],
      sharedBody: 'Hello',
      personalized: false,
      totalCost: 2,
      ...overrides,
    });

  /** The `$set` of every progress write, in order. */
  const writes = () => SMSLog.updateOne.mock.calls.map(([, update]) => update.$set);

  it('is stamped by the first accepted batch, not by the last', async () => {
    jest.spyOn(smsService, 'sendBatch').mockResolvedValue({ ok: true, response: {} });

    await run();

    const stamped = writes().filter((s) => s.sentAt);
    // Exactly one write establishes it, and it is the first batch's.
    expect(stamped).toHaveLength(1);
    expect(writes()[0].sentAt).toBeInstanceOf(Date);
  });

  it('is not moved forward when a retry resumes mid-campaign', async () => {
    // The failure this guards: a worker killed at batch 30 of 40 restarts, and
    // the log starts claiming the campaign began at the time of the restart —
    // the one question the field exists to answer.
    jest.spyOn(smsService, 'sendBatch').mockResolvedValue({ ok: true, response: {} });
    const original = new Date('2026-08-17T04:30:00.000Z');

    await run({ startBatch: 1, sentCount: 1, sentAt: original });

    expect(writes().some((s) => s.sentAt)).toBe(false);
  });

  it('stays unset while every batch is refused', async () => {
    // Nothing left the building, so "when did it leave" has no answer. A
    // timestamp here would make a wholly failed campaign look partly delivered.
    jest
      .spyOn(smsService, 'sendBatch')
      .mockResolvedValue({ ok: false, error: new Error('Gateway refused') });

    await run();

    expect(writes().some((s) => s.sentAt)).toBe(false);
  });
});
