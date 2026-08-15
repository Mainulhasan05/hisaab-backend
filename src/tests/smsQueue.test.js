/**
 * Durable campaign queueing, pinned.
 *
 * ── What moving to BullMQ was for ───────────────────────────────────────────
 *
 * Campaigns above `SYNC_LIMIT` used to run in-process via `setImmediate`. Under
 * PM2 that is not a rare-crash risk — `pm2 reload` is a routine deploy, it stops
 * workers gracefully, and an in-flight campaign died with them: the log stuck at
 * `pending` forever, the shop's quota already spent, and nobody told.
 *
 * The three behaviours that make the queue an improvement rather than a
 * relocation of the same problem are pinned here:
 *
 *   1. REFUSE, don't fall back. With Redis down a campaign is rejected, the
 *      reservation is returned and the log says why. A silent revert to
 *      `setImmediate` would reintroduce the original failure as an untested
 *      path — and it would only ever run when Redis was already broken.
 *   2. RESUME, don't restart. BullMQ retries. A retry that began again at batch
 *      zero would re-send to everyone already reached; the shop pays twice and
 *      the customer reads it twice.
 *   3. NEVER re-send a finished campaign. A worker killed after the final write
 *      but before its job was acked gets that job redelivered.
 */

const SMSLog = require('../models/SMSLog.model');
const SMSQuota = require('../models/SMSQuota.model');
const smsService = require('../services/sms.service');
const queueConfig = require('../config/queue.config');
const { SMS_STATUS, SMS_TYPES } = require('../config/constants');

describe('queue availability gate', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('is disabled when Redis is switched off', () => {
    process.env.USE_REDIS = 'false';
    process.env.REDIS_HOST = 'localhost';
    expect(queueConfig.isQueueEnabled()).toBe(false);
  });

  it('is disabled when no connection is configured', () => {
    process.env.USE_REDIS = 'true';
    delete process.env.REDIS_SOCKET;
    delete process.env.REDIS_HOST;
    expect(queueConfig.isQueueEnabled()).toBe(false);
  });

  it('can be switched off deliberately without switching off the cache', () => {
    // The escape hatch: run the API with Redis caching on but queued sends off.
    process.env.USE_REDIS = 'true';
    process.env.REDIS_HOST = 'localhost';
    process.env.USE_SMS_QUEUE = 'false';
    expect(queueConfig.isQueueEnabled()).toBe(false);
  });

  it('builds a unix-socket connection when one is configured', () => {
    process.env.REDIS_SOCKET = '/home/stackroo/.redis/redis.sock';
    delete process.env.REDIS_HOST;
    const opts = queueConfig.connectionOptions();
    expect(opts.path).toBe('/home/stackroo/.redis/redis.sock');
    // BullMQ workers require this to be null, or a Redis blip kills the worker
    // instead of making it wait.
    expect(opts.maxRetriesPerRequest).toBeNull();
  });
});

describe('enqueueCampaign with no queue', () => {
  let refunded;
  let logUpdate;

  beforeEach(() => {
    refunded = null;
    logUpdate = null;
    jest.spyOn(queueConfig, 'isQueueEnabled').mockReturnValue(false);
    jest.spyOn(SMSQuota, 'refund').mockImplementation(async (shopId, n) => {
      refunded = { shopId, n };
      return {};
    });
    jest.spyOn(SMSLog, 'updateOne').mockImplementation(async (filter, update) => {
      logUpdate = update.$set;
      return {};
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('refuses rather than silently running in-process', async () => {
    await expect(
      smsService.enqueueCampaign(
        { logId: 'log1', batches: [[]], totalCost: 100 },
        { logId: 'log1', shopId: 'shop1', reservedSegments: 100 }
      )
    ).rejects.toThrow(/queue is unavailable/i);
  });

  it('gives the shop its reservation back', async () => {
    // A campaign that cannot start must not leave the shop paying for it.
    await smsService
      .enqueueCampaign(
        { logId: 'log1', batches: [[]], totalCost: 100 },
        { logId: 'log1', shopId: 'shop1', reservedSegments: 100 }
      )
      .catch(() => {});

    expect(refunded).toEqual({ shopId: 'shop1', n: 100 });
  });

  it('marks the log failed instead of leaving it pending forever', async () => {
    await smsService
      .enqueueCampaign(
        { logId: 'log1', batches: [[]], totalCost: 100 },
        { logId: 'log1', shopId: 'shop1', reservedSegments: 100 }
      )
      .catch(() => {});

    expect(logUpdate.status).toBe(SMS_STATUS.FAILED);
    expect(logUpdate.cost).toBe(0);
    expect(logUpdate.errorMessage).toMatch(/queue unavailable/i);
    expect(logUpdate['progress.completedAt']).toBeInstanceOf(Date);
  });

  it('refunds nothing on a platform broadcast, which reserved nothing', async () => {
    await smsService
      .enqueueCampaign(
        { logId: 'log2', batches: [[]], totalCost: 10 },
        { logId: 'log2', shopId: null, reservedSegments: 0 }
      )
      .catch(() => {});

    expect(refunded).toBeNull();
    expect(logUpdate.status).toBe(SMS_STATUS.FAILED);
  });
});

describe('processCampaignJob', () => {
  afterEach(() => jest.restoreAllMocks());

  const stubLog = (log) => {
    jest.spyOn(SMSLog, 'findById').mockReturnValue({ lean: async () => log });
  };

  it('refuses to re-send a campaign that already completed', async () => {
    // The redelivered-after-ack case. Re-sending a finished campaign is the
    // worst outcome a retry can have.
    stubLog({
      _id: 'log1',
      recipients: [{ phone: '8801712345678' }],
      progress: { completedAt: new Date(), batchesDone: 1 },
    });
    const run = jest.spyOn(smsService, 'runCampaign').mockResolvedValue({});

    const result = await smsService.processCampaignJob({ logId: 'log1' });

    expect(result).toEqual({ skipped: 'already_complete' });
    expect(run).not.toHaveBeenCalled();
  });

  it('does nothing when the log has vanished', async () => {
    stubLog(null);
    const result = await smsService.processCampaignJob({ logId: 'gone' });
    expect(result).toEqual({ skipped: 'no_log' });
  });

  it('resumes at the first batch that never ran', async () => {
    // 250 recipients at the default batch size of 100 is three batches; a
    // worker that died after two must start at the third, not the first.
    const recipients = Array.from({ length: 250 }, (_, i) => ({
      phone: `88017123456${String(i).padStart(2, '0')}`,
    }));
    stubLog({
      _id: 'log1',
      shop: 'shop1',
      type: SMS_TYPES.BULK,
      message: 'Hello',
      cost: 250,
      sentCount: 200,
      failedCount: 0,
      recipients,
      progress: { batchesDone: 2, total: 250 },
    });

    let captured = null;
    jest.spyOn(smsService, 'runCampaign').mockImplementation(async (opts) => {
      captured = opts;
      return {};
    });

    await smsService.processCampaignJob({ logId: 'log1' });

    expect(captured.startBatch).toBe(2);
    expect(captured.batches).toHaveLength(3);
    // The counts already achieved carry forward, or the final tally reports
    // only what the last attempt managed.
    expect(captured.sentCount).toBe(200);
  });

  it('rebuilds a dynamic campaign as personalised', async () => {
    stubLog({
      _id: 'log1',
      shop: 'shop1',
      type: SMS_TYPES.DYNAMIC,
      message: 'Dear A, ...',
      cost: 2,
      recipients: [
        { phone: '8801712345678', message: 'Dear A, ...' },
        { phone: '8801812345678', message: 'Dear B, ...' },
      ],
      progress: { batchesDone: 0 },
    });

    let captured = null;
    jest.spyOn(smsService, 'runCampaign').mockImplementation(async (o) => {
      captured = o;
      return {};
    });

    await smsService.processCampaignJob({ logId: 'log1' });

    expect(captured.personalized).toBe(true);
    // A personalised run has no shared body; each recipient carries its own.
    expect(captured.sharedBody).toBe('');
    expect(captured.batches[0][0].message).toBe('Dear A, ...');
  });
});

describe('resume offset arithmetic', () => {
  afterEach(() => jest.restoreAllMocks());

  it('writes recipient statuses to the right positions after a short batch', async () => {
    // The trap: assuming `startBatch × BATCH_SIZE` for the offset. With an
    // uneven final batch that lands the per-recipient `$set` on the wrong array
    // positions, marking the wrong people sent.
    const batches = [
      [{ phone: 'a' }, { phone: 'b' }, { phone: 'c' }], // 3
      [{ phone: 'd' }],                                  // 1 — short
      [{ phone: 'e' }, { phone: 'f' }],                  // 2
    ];

    const writes = [];
    jest.spyOn(SMSLog, 'updateOne').mockImplementation(async (f, u) => {
      writes.push(u.$set);
      return {};
    });
    jest.spyOn(smsService, 'sendBatch').mockResolvedValue({ ok: true, response: {} });

    await smsService.runCampaign({
      logId: 'log1',
      shopId: null,
      batches,
      sharedBody: 'x',
      personalized: false,
      totalCost: 6,
      startBatch: 2,        // resume at the LAST batch
      sentCount: 4,
      failedCount: 0,
    });

    // Batch 2 holds recipients 4 and 5 (0-indexed), because 3 + 1 came before.
    // Indexed rather than `toHaveProperty`, which reads a dotted string as a
    // path into nested objects — these are literal Mongo positional keys.
    expect(writes[0]['recipients.4.status']).toBe(SMS_STATUS.SENT);
    expect(writes[0]['recipients.5.status']).toBe(SMS_STATUS.SENT);
    expect(writes[0]['recipients.6.status']).toBeUndefined();
    // And nothing was written for the batches that already ran.
    expect(writes[0]['recipients.0.status']).toBeUndefined();
    expect(writes[0]['recipients.3.status']).toBeUndefined();
  });

  it('does not re-send the batches a previous attempt already sent', async () => {
    const batches = [[{ phone: 'a' }], [{ phone: 'b' }], [{ phone: 'c' }]];
    const sent = [];
    jest.spyOn(SMSLog, 'updateOne').mockResolvedValue({});
    jest.spyOn(smsService, 'sendBatch').mockImplementation(async (batch) => {
      sent.push(batch[0].phone);
      return { ok: true, response: {} };
    });

    await smsService.runCampaign({
      logId: 'log1',
      shopId: null,
      batches,
      sharedBody: 'x',
      personalized: false,
      totalCost: 3,
      startBatch: 2,
      sentCount: 2,
    });

    expect(sent).toEqual(['c']);
  });
});
