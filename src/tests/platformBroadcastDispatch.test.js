/**
 * The admin → shopkeeper broadcast, end to end through the gateway layer.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * `platformBroadcast.test.js` covers audience resolution, the manual-recipient
 * cap and quota isolation — but its dispatch test deliberately stops at
 * "no valid recipients", which returns before any gateway or log write. So the
 * part that actually SENDS was never exercised: the chain from
 * `sendPlatformCampaign` through `runCampaign` and `sendBatch` into the
 * dispatcher and out to a gateway.
 *
 * That chain was rewritten when the second gateway was added. This pins it.
 *
 * The platform path differs from a shop campaign in three ways that are easy to
 * break and silent when broken:
 *
 *   · `shop` is null — there is no quota to reserve and none to refund.
 *   · It is therefore pure COST with no revenue, and must still be booked, or
 *     the highest-volume messaging the platform does is missing from the margin.
 *   · It signs off with the platform's name, not a shop's.
 */

const captured = [];

/**
 * The default gateway behaviour: answer with whatever `reply` currently holds.
 *
 * Reinstated in `beforeEach` via `mockImplementation`, NOT `mockClear` — clear
 * only forgets the CALLS, so an implementation installed by one test (the
 * failover cases below install their own) silently governs every test after it.
 * That leak made a test asserting a gateway refusal quietly assert a success.
 */
const defaultGateway = async (url, payload) => {
  captured.push({ url, payload });
  if (mockGatewayPost.fail) throw mockGatewayPost.fail;
  return { data: mockGatewayPost.reply };
};

const mockGatewayPost = jest.fn(defaultGateway);

jest.mock('axios', () => ({
  create: () => ({ post: mockGatewayPost, get: jest.fn() }),
  post: mockGatewayPost,
}));

jest.mock('../utils/logger.util', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const SMSLog = require('../models/SMSLog.model');
const SMSQuota = require('../models/SMSQuota.model');
const SmsEarning = require('../models/SmsEarning.model');
const PlatformSetting = require('../models/PlatformSetting.model');
const routing = require('../services/sms/routing');
const registry = require('../services/sms/registry');
const earnings = require('../services/sms/earnings');
const smsService = require('../services/sms.service');
const { SMS_STATUS } = require('../config/constants');

const OLD_ENV = process.env;

/** Two shopkeepers, as the audience resolver would hand them over. */
const RECIPIENTS = [
  { phone: '01712345678', name: 'Rahim Store' },
  { phone: '01812345678', name: 'Karim Traders' },
];

let logDoc;
let updates;
let booked;

beforeEach(() => {
  captured.length = 0;
  mockGatewayPost.mockReset();
  mockGatewayPost.mockImplementation(defaultGateway);
  mockGatewayPost.fail = null;
  mockGatewayPost.reply = { statusCode: '200', status: 'Success', TransactionId: 'TX-1' };

  process.env = {
    ...OLD_ENV,
    SKIP_SMS: 'false',
    MIMSMS_USERNAME: 'u', MIMSMS_API_KEY: 'k', MIMSMS_SENDER_ID: 'HISAAB',
    AUTOMAS_API_KEY: 'ak', AUTOMAS_SENDER_ID: 'HISAAB',
  };
  registry.resetAdapters();
  routing.invalidate();
  earnings.invalidate();

  logDoc = { _id: 'campaign-1' };
  updates = [];
  booked = [];

  jest.spyOn(SMSLog, 'create').mockImplementation(async (doc) => ({ ...doc, _id: logDoc._id }));
  jest.spyOn(SMSLog, 'updateOne').mockImplementation(async (filter, update) => {
    updates.push(update.$set || {});
    return { acknowledged: true };
  });
  jest.spyOn(SmsEarning, 'record').mockImplementation(async (entry) => {
    booked.push(entry);
    return entry;
  });
  // Rates: MimSMS priced, so cost is real; no shop, so revenue must be zero.
  jest.spyOn(PlatformSetting, 'current').mockResolvedValue({
    smsPrimaryProvider: 'mimsms',
    smsFailoverProvider: 'automas',
    smsFailoverEnabled: true,
    smsProviderCost: { mimsms: 0.3, automas: 0.5 },
    platformSmsCost: null,
    defaultSmsUnitPrice: 0.4,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = OLD_ENV;
  registry.resetAdapters();
  routing.invalidate();
  earnings.invalidate();
});

/** The status written for each recipient, flattened across progress updates. */
function recipientStatuses() {
  const seen = {};
  for (const set of updates) {
    for (const [key, value] of Object.entries(set)) {
      const match = /^recipients\.(\d+)\.status$/.exec(key);
      if (match) seen[match[1]] = value;
    }
  }
  return seen;
}

/** The final campaign-level $set — the one that carries the terminal status. */
function finalUpdate() {
  return [...updates].reverse().find((u) => u.status && u['progress.completedAt']) || {};
}

describe('the broadcast actually reaches a gateway', () => {
  test('a plain broadcast dispatches and marks every shopkeeper sent', async () => {
    const result = await smsService.sendPlatformCampaign({
      recipients: RECIPIENTS,
      message: 'Your subscription expires in 3 days.',
      senderName: 'Hisaab',
      audience: 'expiring',
      forceSync: true,
    });

    // It reached the gateway at all — the thing the existing suite never proved.
    expect(mockGatewayPost).toHaveBeenCalledTimes(1);
    expect(captured[0].url).toContain('/OneToMany');
    expect(captured[0].payload.MobileNumber).toBe('8801712345678,8801812345678');

    expect(result.success).toBe(true);
    expect(result.sentCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(recipientStatuses()).toEqual({ 0: SMS_STATUS.SENT, 1: SMS_STATUS.SENT });
  });

  test('the platform sign-off is what goes on the wire, not a shop name', async () => {
    await smsService.sendPlatformCampaign({
      recipients: RECIPIENTS,
      message: 'Scheduled maintenance tonight.',
      senderName: 'Hisaab',
      forceSync: true,
    });

    expect(captured[0].payload.Message).toContain('Hisaab');
    expect(captured[0].payload.SenderName).toBe('HISAAB');
  });

  test('a personalized broadcast goes out on the dynamic endpoint', async () => {
    await smsService.sendPlatformCampaign({
      recipients: [
        { phone: '01712345678', message: 'Rahim, you owe 500' },
        { phone: '01812345678', message: 'Karim, you owe 900' },
      ],
      personalized: true,
      senderName: 'Hisaab',
      forceSync: true,
    });

    expect(captured[0].url).toContain('/DSMS');
    expect(captured[0].payload.MessageData).toHaveLength(2);
    // /DSMS accepts 'D' and refuses everything else on this account.
    expect(captured[0].payload.TransactionType).toBe('D');
  });
});

describe('the platform path never touches a shop quota', () => {
  /**
   * The most expensive mistake available here: charging a shop for the
   * platform's own messaging, out of credits they paid for.
   */
  test('neither reserve nor refund is called, even when the gateway refuses', async () => {
    const reserve = jest.spyOn(SMSQuota, 'reserve');
    const refund = jest.spyOn(SMSQuota, 'refund');

    mockGatewayPost.reply = {
      statusCode: '400', status: 'Failed', responseResult: 'Invalid Mobile Number',
    };

    const result = await smsService.sendPlatformCampaign({
      recipients: RECIPIENTS,
      message: 'Hello',
      senderName: 'Hisaab',
      forceSync: true,
    });

    expect(result.failedCount).toBe(2);
    expect(reserve).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });
});

describe('failover works on the broadcast path too', () => {
  /**
   * A broadcast is how the platform tells shopkeepers their subscription is
   * expiring. If it silently dies because one gateway is down, the operator
   * finds out from the shops that never renewed.
   */
  test('a primary timeout is caught by the backup, and both are recorded', async () => {
    let call = 0;
    mockGatewayPost.mockImplementation(async (url, payload) => {
      captured.push({ url, payload });
      call += 1;
      if (call === 1) {
        const err = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      }
      // Automas answers per recipient, with 0 meaning success.
      return {
        data: {
          response: [
            { status: 0, id: 11, msisdn: '8801712345678' },
            { status: 0, id: 12, msisdn: '8801812345678' },
          ],
        },
      };
    });

    const result = await smsService.sendPlatformCampaign({
      recipients: RECIPIENTS,
      message: 'Your subscription expires in 3 days.',
      senderName: 'Hisaab',
      forceSync: true,
    });

    expect(result.sentCount).toBe(2);
    expect(mockGatewayPost).toHaveBeenCalledTimes(2); // primary, then backup

    const gateway = finalUpdate().gateway;
    expect(gateway.provider).toBe('automas');
    expect(gateway.failedOver).toBe(true);
    expect(gateway.failedProvider).toBe('mimsms');
  });

  /**
   * An invalid number is a fact about the recipient. The backup refuses it
   * identically, so failing over spends a second gateway credit to be told the
   * same thing — on every bad number in the shopkeeper list.
   */
  test('a permanent refusal is not retried on the backup', async () => {
    mockGatewayPost.reply = {
      statusCode: '400', status: 'Failed', responseResult: 'Invalid Mobile Number',
    };

    await smsService.sendPlatformCampaign({
      recipients: RECIPIENTS,
      message: 'Hello',
      senderName: 'Hisaab',
      forceSync: true,
    });

    expect(mockGatewayPost).toHaveBeenCalledTimes(1);
  });
});

describe('a broadcast is booked as cost with no revenue', () => {
  /**
   * Platform broadcasts are sent on the platform's own gateway account. They
   * cost money and earn none — counting them as revenue would invent income,
   * and omitting them entirely would hide the platform's largest SMS expense.
   */
  test('earnings are recorded against no shop, at the gateway rate, earning nothing', async () => {
    await smsService.sendPlatformCampaign({
      recipients: RECIPIENTS,
      message: 'Scheduled maintenance tonight.',
      senderName: 'Hisaab',
      forceSync: true,
    });

    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({
      shop: null,
      provider: 'mimsms',
      revenue: 0,
      failed: false,
    });
    // Two recipients, one segment each, at ৳0.30.
    expect(booked[0].segments).toBe(2);
    expect(booked[0].gatewayCost).toBeCloseTo(0.6, 5);
  });

  test('a failed broadcast still books its cost, because the gateway may still charge', async () => {
    mockGatewayPost.reply = {
      statusCode: '400', status: 'Failed', responseResult: 'Invalid Mobile Number',
    };

    await smsService.sendPlatformCampaign({
      recipients: RECIPIENTS,
      message: 'Hello',
      senderName: 'Hisaab',
      forceSync: true,
    });

    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({ shop: null, failed: true, revenue: 0 });
    expect(booked[0].gatewayCost).toBeCloseTo(0.6, 5);
  });
});

describe('the campaign log tells the truth afterwards', () => {
  test('the terminal status and provider attribution are written', async () => {
    await smsService.sendPlatformCampaign({
      recipients: RECIPIENTS,
      message: 'Hello there.',
      senderName: 'Hisaab',
      forceSync: true,
    });

    const final = finalUpdate();
    expect(final.status).toBe(SMS_STATUS.SENT);
    expect(final.gateway.provider).toBe('mimsms');
    expect(final.gateway.failedOver).toBe(false);
    expect(final['progress.completedAt']).toBeInstanceOf(Date);
  });

  /**
   * The single most important correctness rule for a batch: a recipient the
   * gateway did not confirm must not be marked sent. Marking them overstates
   * delivery and leaves nobody able to say which shopkeepers actually missed the
   * message — which, for an expiry warning, is the whole point of sending it.
   */
  test('a recipient the gateway never confirmed is not reported as sent', async () => {
    // MimSMS drops the connection, so the batch fails over to Automas — which
    // confirms only the first shopkeeper and does not mention the second.
    mockGatewayPost.mockImplementation(async (url, payload) => {
      captured.push({ url, payload });
      if (captured.length === 1) {
        const err = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      }
      return { data: { response: [{ status: 0, id: 11, msisdn: '8801712345678' }] } };
    });

    const result = await smsService.sendPlatformCampaign({
      recipients: RECIPIENTS,
      message: 'Hello there.',
      senderName: 'Hisaab',
      forceSync: true,
    });

    expect(result.sentCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(recipientStatuses()).toEqual({ 0: SMS_STATUS.SENT, 1: SMS_STATUS.FAILED });
    expect(finalUpdate().status).toBe(SMS_STATUS.PARTIAL);
  });
});
