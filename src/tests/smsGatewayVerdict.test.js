/**
 * The MimSMS response contract, pinned.
 *
 * ── The bug this exists to prevent ──────────────────────────────────────────
 *
 * MimSMS answers a REFUSAL with HTTP 200 and the verdict in the body:
 *
 *     { "statusCode": "207", "status": "Failed",
 *       "responseResult": "Invalid TransactionType" }
 *
 * `sendBatch` read only the HTTP status, so every refusal was recorded as a
 * successful send. Combined with a second bug — the wrong `TransactionType` on
 * both campaign endpoints — this meant every bulk campaign and every due
 * reminder the product ever attempted was rejected by the gateway, marked
 * `sent` in the log, billed to the shop's prepaid quota, and never refunded.
 * The admin panel showed "Sent" next to a raw gateway response that said
 * "Failed", which is how it was finally caught.
 *
 * ── The TransactionType matrix ──────────────────────────────────────────────
 *
 * Determined empirically by probing each endpoint with an undeliverable number,
 * so only the validator answered:
 *
 *     /SMS        T ✓   P ✓   D ✓
 *     /OneToMany  T ✓   P ✗   D ✗
 *     /DSMS       T ✗   P ✗   D ✓
 *
 * The code sent 'P' on bulk and 'T' on dynamic — the two combinations that
 * cannot work. These assertions are a tripwire: if the gateway's accepted
 * values change, this is where it should be noticed, not in a silent campaign.
 */

const smsService = require('../services/sms.service');
const { readGatewayVerdict, TRANSACTION_TYPE } = smsService;

describe('readGatewayVerdict', () => {
  it('refuses the exact body that shipped a broken broadcast', () => {
    // Copied verbatim from the log that exposed this.
    const verdict = readGatewayVerdict({
      statusCode: '207',
      status: 'Failed',
      trxnId: 'TG5Z7E9BUCPM5YR',
      responseResult: 'Invalid TransactionType',
    });

    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toContain('Invalid TransactionType');
  });

  it('accepts the body a real successful send returns', () => {
    // Also verbatim — the 19 receipts that did work.
    const verdict = readGatewayVerdict({
      statusCode: '200',
      status: 'Success',
      responseResult: 'SMS Send Successfuly',
    });

    expect(verdict.accepted).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  it('refuses a rejected number', () => {
    const verdict = readGatewayVerdict({
      statusCode: '207',
      status: 'Failed',
      responseResult: 'Invalid Mobile Number',
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toContain('Invalid Mobile Number');
  });

  it('refuses on a non-200 statusCode even when no status string is present', () => {
    expect(readGatewayVerdict({ statusCode: '401' }).accepted).toBe(false);
  });

  it('lets the SKIP_SMS simulation through', () => {
    // Development sends carry no verdict; refusing them would make every
    // campaign fail locally and teach everyone to distrust the check.
    expect(readGatewayVerdict({ simulated: true, count: 100 }).accepted).toBe(true);
  });

  it('treats an unrecognised shape as accepted rather than failing every send', () => {
    // Deliberate asymmetry. A gateway that adds a field must not turn working
    // traffic into false failures; only an EXPLICIT refusal is a refusal.
    expect(readGatewayVerdict({ somethingNew: true }).accepted).toBe(true);
    expect(readGatewayVerdict(null).accepted).toBe(true);
    expect(readGatewayVerdict('OK').accepted).toBe(true);
  });
});

describe('TransactionType per endpoint', () => {
  it('sends T on the single endpoint', () => {
    expect(TRANSACTION_TYPE.single).toBe('T');
  });

  it('sends T on bulk — NOT P, which /OneToMany refuses', () => {
    expect(TRANSACTION_TYPE.bulk).toBe('T');
  });

  it('sends D on dynamic — NOT T, which /DSMS refuses', () => {
    expect(TRANSACTION_TYPE.dynamic).toBe('D');
  });
});

describe('sendBatch honours the body, not the HTTP status', () => {
  /**
   * The service builds its own axios instance at require time
   * (`axios.create({ timeout })`), so the only way to intercept the call
   * deterministically is to stub `create` BEFORE the module is loaded — hence
   * the isolated registry. Without this the test either reaches the real
   * gateway or proves nothing, and a test that might be doing neither is worse
   * than no test.
   */
  const loadWithGatewayReply = (reply) => {
    let captured = null;
    let service;

    jest.isolateModules(() => {
      jest.doMock('axios', () => ({
        create: () => ({
          post: async (url, payload) => {
            captured = { url, payload };
            return { data: reply };
          },
          get: async () => ({ data: {} }),
        }),
      }));
      service = require('../services/sms.service');
    });

    return { service, sent: () => captured };
  };

  afterEach(() => {
    jest.dontMock('axios');
    jest.resetModules();
  });

  it('reports a 200-with-Failed body as a FAILED batch', async () => {
    // The regression that matters. Before the fix this returned ok:true and
    // every recipient in the batch was written to the log as sent.
    const { service } = loadWithGatewayReply({
      statusCode: '207',
      status: 'Failed',
      responseResult: 'Invalid TransactionType',
    });

    const result = await service.sendBatch([{ phone: '8801712345678' }], {
      sharedBody: 'Hello',
      personalized: false,
      transactionType: 'T',
    });

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain('Invalid TransactionType');
    expect(result.response).toEqual(
      expect.objectContaining({ status: 'Failed' })
    );
  });

  it('reports a 200-with-Success body as a sent batch', async () => {
    const { service } = loadWithGatewayReply({
      statusCode: '200',
      status: 'Success',
      responseResult: 'SMS Send Successfuly',
    });

    const result = await service.sendBatch([{ phone: '8801712345678' }], {
      sharedBody: 'Hello',
      personalized: false,
      transactionType: 'T',
    });

    expect(result.ok).toBe(true);
  });

  it('puts D on the wire for a dynamic batch, whatever the caller asked for', async () => {
    // The caller's `transactionType` records INTENT. /DSMS accepts exactly one
    // value, so the wire value is decided by the endpoint.
    const { service, sent } = loadWithGatewayReply({ status: 'Success', statusCode: '200' });

    await service.sendBatch([{ phone: '8801712345678', message: 'Hi' }], {
      sharedBody: '',
      personalized: true,
      transactionType: 'T',
    });

    expect(sent().url).toContain('/DSMS');
    expect(sent().payload.TransactionType).toBe('D');
  });

  it('puts T on the wire for a bulk batch, even for a promotional campaign', async () => {
    // /OneToMany refuses 'P' outright for this account. A promotional campaign
    // still has to go somewhere, and this is the only value that is accepted.
    const { service, sent } = loadWithGatewayReply({ status: 'Success', statusCode: '200' });

    await service.sendBatch([{ phone: '8801712345678' }], {
      sharedBody: 'Sale on now',
      personalized: false,
      transactionType: 'P',
    });

    expect(sent().url).toContain('/OneToMany');
    expect(sent().payload.TransactionType).toBe('T');
  });

  it('does not retry a refusal', async () => {
    // An "Invalid TransactionType" returns the identical answer a second later.
    // Retrying it only delays every batch behind it.
    let calls = 0;
    let service;
    jest.isolateModules(() => {
      jest.doMock('axios', () => ({
        create: () => ({
          post: async () => {
            calls++;
            return { data: { status: 'Failed', statusCode: '207', responseResult: 'Nope' } };
          },
          get: async () => ({ data: {} }),
        }),
      }));
      service = require('../services/sms.service');
    });

    await service.sendBatch([{ phone: '8801712345678' }], {
      sharedBody: 'x',
      personalized: false,
      transactionType: 'T',
    });

    expect(calls).toBe(1);
  });
});
