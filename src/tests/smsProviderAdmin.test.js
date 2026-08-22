/**
 * The gateway-routing admin surface, pinned.
 *
 * The rules here are the ones that lose data or lie to the operator when they
 * break — a PATCH that wipes settings it was not asked to touch, a failover that
 * points at itself, a "test this gateway" button that answers using a different
 * gateway.
 */

jest.mock('../utils/logger.util', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const PlatformSetting = require('../models/PlatformSetting.model');
const AuditLog = require('../models/AuditLog.model');
const registry = require('../services/sms/registry');
const routing = require('../services/sms/routing');
const dispatcher = require('../services/sms/dispatcher');
const earnings = require('../services/sms/earnings');
const service = require('../services/smsProvider.service');

/** A settings document that behaves like a mongoose doc for our purposes. */
function fakeSettings(initial = {}) {
  return {
    _id: 'settings-1',
    smsPrimaryProvider: null,
    smsFailoverProvider: null,
    smsFailoverEnabled: false,
    smsProviderCost: { mimsms: null, automas: null },
    updatedBy: null,
    ...initial,
    save: jest.fn().mockResolvedValue(true),
  };
}

let settings;

beforeEach(() => {
  settings = fakeSettings();
  jest.spyOn(PlatformSetting, 'current').mockImplementation(async () => settings);
  jest.spyOn(AuditLog, 'create').mockResolvedValue({});
  jest.spyOn(routing, 'invalidate').mockImplementation(() => {});
  jest.spyOn(earnings, 'invalidate').mockImplementation(() => {});
  // `describe()` re-reads through the real resolver; stub it so these tests
  // assert what was WRITTEN rather than what a cache happened to hold.
  jest.spyOn(routing, 'describe').mockImplementation(async () => ({
    primaryProvider: settings.smsPrimaryProvider || 'mimsms',
    failoverProvider: settings.smsFailoverProvider,
    failoverEnabled: settings.smsFailoverEnabled,
  }));
});

afterEach(() => jest.restoreAllMocks());

describe('routing updates merge rather than replace', () => {
  /**
   * The data-loss bug this exists to prevent: an admin changing only the primary
   * gateway silently switched the whole platform's failover off, because the
   * handler treated every absent field as an instruction to clear it.
   */
  test('a PATCH naming only the primary leaves failover settings intact', async () => {
    settings.smsPrimaryProvider = 'mimsms';
    settings.smsFailoverProvider = 'automas';
    settings.smsFailoverEnabled = true;

    await service.updateRouting({ primaryProvider: 'mimsms' }, { id: 'admin1' });

    expect(settings.smsPrimaryProvider).toBe('mimsms');
    // Untouched, because they were not mentioned.
    expect(settings.smsFailoverProvider).toBe('automas');
    expect(settings.smsFailoverEnabled).toBe(true);
  });

  /**
   * Promoting the backup to primary is an ordinary thing to want, and the
   * operator did not mention failover at all. Refusing on its behalf would block
   * the action; the sensible reading is a swap.
   */
  test('promoting the failover to primary swaps them rather than failing', async () => {
    settings.smsPrimaryProvider = 'mimsms';
    settings.smsFailoverProvider = 'automas';
    settings.smsFailoverEnabled = true;

    await service.updateRouting({ primaryProvider: 'automas' }, { id: 'admin1' });

    expect(settings.smsPrimaryProvider).toBe('automas');
    expect(settings.smsFailoverProvider).toBe('mimsms');
    expect(settings.smsFailoverEnabled).toBe(true);
  });

  test('an explicit null clears a setting', async () => {
    settings.smsPrimaryProvider = 'automas';
    await service.updateRouting({ primaryProvider: null }, { id: 'admin1' });
    expect(settings.smsPrimaryProvider).toBeNull();
  });

  test('the send path cache is dropped after a change', async () => {
    await service.updateRouting({ primaryProvider: 'automas' }, { id: 'admin1' });
    expect(routing.invalidate).toHaveBeenCalled();
  });

  test('a change is written to the audit log with before and after', async () => {
    settings.smsPrimaryProvider = 'mimsms';
    await service.updateRouting({ primaryProvider: 'automas' }, { id: 'admin1' });

    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      action: 'sms_routing_updated',
      changes: expect.objectContaining({
        before: expect.objectContaining({ primaryProvider: 'mimsms' }),
        after: expect.objectContaining({ primaryProvider: 'automas' }),
      }),
    }));
  });
});

describe('routing validation', () => {
  test('an unknown provider is rejected, and the error lists the real ones', async () => {
    await expect(service.updateRouting({ primaryProvider: 'twilio' }, {}))
      .rejects.toThrow(/Unknown SMS provider 'twilio'/);
    expect(settings.save).not.toHaveBeenCalled();
  });

  /**
   * Failing over to the gateway that just failed is not failover — for an auth
   * failure it is a guaranteed second refusal.
   */
  test('naming both as the same gateway in one request is refused', async () => {
    await expect(
      service.updateRouting(
        { primaryProvider: 'mimsms', failoverProvider: 'mimsms', failoverEnabled: true },
        {}
      )
    ).rejects.toThrow(/must differ from the primary/);
    expect(settings.save).not.toHaveBeenCalled();
  });

  /**
   * A switch labelled "failover" that has nothing behind it is worse than one
   * that is off: it reads as protection at exactly the moment it provides none.
   */
  test('enabling failover without naming a backup auto-selects the other configured gateway', async () => {
    jest.spyOn(registry, 'getAnyOtherConfigured').mockReturnValue({ name: 'automas' });

    await service.updateRouting({ primaryProvider: 'mimsms', failoverEnabled: true }, {});

    expect(settings.smsFailoverProvider).toBe('automas');
    expect(settings.smsFailoverEnabled).toBe(true);
  });

  test('enabling failover with no other configured gateway stores no phantom backup', async () => {
    jest.spyOn(registry, 'getAnyOtherConfigured').mockReturnValue(null);

    await service.updateRouting({ primaryProvider: 'mimsms', failoverEnabled: true }, {});

    expect(settings.smsFailoverProvider).toBeNull();
  });
});

describe('gateway costs', () => {
  test('an omitted provider keeps its rate; an explicit null clears it', async () => {
    settings.smsProviderCost = { mimsms: 0.35, automas: 0.30 };

    const after = await service.updateCosts({ automas: null }, { id: 'admin1' });

    expect(after.mimsms).toBe(0.35); // untouched
    expect(after.automas).toBeNull(); // explicitly cleared
  });

  test('a negative rate is rejected', async () => {
    await expect(service.updateCosts({ mimsms: -1 }, {})).rejects.toThrow(/Invalid cost/);
  });

  test('changing a rate drops the cached rates the send path reads', async () => {
    await service.updateCosts({ mimsms: 0.4 }, { id: 'admin1' });
    expect(earnings.invalidate).toHaveBeenCalled();
  });
});

describe('testing a provider', () => {
  /**
   * The whole point of the button. A test that quietly succeeds on the OTHER
   * gateway reports a broken gateway as healthy.
   */
  test('sends with the provider pinned and failover disabled', async () => {
    jest.spyOn(registry, 'getAdapter').mockReturnValue({
      name: 'automas', isConfigured: () => true, categorizeError: () => 'auth',
    });
    const send = jest.spyOn(dispatcher, 'sendSingle').mockResolvedValue({
      provider: 'automas', messageId: 'X1', statusCode: 0, senderIdUsed: 'HISAAB', data: {},
    });

    const result = await service.testProvider('automas', { phone: '01712345678' }, {});

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(
      '8801712345678',
      expect.any(String),
      expect.objectContaining({ providerName: 'automas', disableFailover: true })
    );
  });

  test('a failure returns the actionable category rather than throwing', async () => {
    jest.spyOn(registry, 'getAdapter').mockReturnValue({
      name: 'automas', isConfigured: () => true, categorizeError: () => 'auth',
    });
    jest.spyOn(dispatcher, 'sendSingle').mockRejectedValue(new Error('Incorrect API Key'));

    const result = await service.testProvider('automas', { phone: '01712345678' }, {});

    expect(result.success).toBe(false);
    expect(result.category).toBe('auth');
    expect(result.error).toBe('Incorrect API Key');
  });

  test('an unconfigured gateway is refused before any message is attempted', async () => {
    jest.spyOn(registry, 'getAdapter').mockReturnValue({
      name: 'automas', isConfigured: () => false, categorizeError: () => 'auth',
    });
    const send = jest.spyOn(dispatcher, 'sendSingle');

    await expect(service.testProvider('automas', { phone: '01712345678' }, {}))
      .rejects.toThrow(/no credentials/);
    expect(send).not.toHaveBeenCalled();
  });

  test('an invalid number is refused before any message is attempted', async () => {
    const send = jest.spyOn(dispatcher, 'sendSingle');
    await expect(service.testProvider('automas', { phone: '123' }, {}))
      .rejects.toThrow(/valid phone number/);
    expect(send).not.toHaveBeenCalled();
  });
});
