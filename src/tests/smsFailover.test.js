/**
 * The failover contract, pinned.
 *
 * These are the rules that decide whether a shop is charged once or twice for a
 * message, and whether a message the gateway refused is quietly recorded as
 * sent. Each block below names the specific way it goes wrong when the rule is
 * broken.
 *
 * Nothing here touches the network. The adapters are replaced with fakes that
 * throw the exact error shapes the real gateways produce, because the point is
 * to test the DECISION, not the HTTP.
 */

const { ERROR_CATEGORY } = require('../services/sms/adapters/base.adapter');

jest.mock('../utils/logger.util', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const registry = require('../services/sms/registry');
const routing = require('../services/sms/routing');
const dispatcher = require('../services/sms/dispatcher');

/** A stand-in gateway whose behaviour each test dictates. */
function fakeAdapter(name, { configured = true, behaviour = {} } = {}) {
  return {
    name,
    isConfigured: () => configured,
    categorizeError: (err) => err?.category || ERROR_CATEGORY.RETRYABLE,
    sendSingle: jest.fn(async () => {
      if (behaviour.single) return behaviour.single();
      return { success: true, messageId: `${name}-1`, statusCode: 200, senderIdUsed: `${name}-sender` };
    }),
    sendBulk: jest.fn(async () => {
      if (behaviour.bulk) return behaviour.bulk();
      return { success: true, method: 'one-to-many', results: [] };
    }),
    checkBalance: jest.fn(async () => ({ success: true, balance: 100, provider: name })),
    getProviderInfo: () => ({ name, configured, baseUrl: null }),
  };
}

function failWith(message, category, extra = {}) {
  return () => {
    const err = new Error(message);
    err.category = category;
    Object.assign(err, extra);
    throw err;
  };
}

/** Point the registry at our fakes and the routing at a fixed config. */
function install(adapters, config) {
  jest.spyOn(registry, 'getAdapter').mockImplementation((name) => {
    const found = adapters[name];
    if (!found) throw new Error(`Unknown SMS provider '${name}'. Available: ${Object.keys(adapters).join(', ')}`);
    return found;
  });
  jest.spyOn(registry, 'getAnyOtherConfigured').mockImplementation((exclude) => {
    const other = Object.values(adapters).find((a) => a.name !== exclude && a.isConfigured());
    return other || null;
  });
  jest.spyOn(routing, 'resolve').mockResolvedValue(config);
}

const ROUTING = {
  primaryProvider: 'mimsms',
  failoverProvider: 'automas',
  failoverEnabled: true,
  source: 'test',
};

afterEach(() => jest.restoreAllMocks());

describe('failover decisions', () => {
  test('a healthy primary sends, and the result names it', async () => {
    const mim = fakeAdapter('mimsms');
    const automas = fakeAdapter('automas');
    install({ mimsms: mim, automas }, ROUTING);

    const result = await dispatcher.sendSingle('01712345678', 'hello');

    expect(result.provider).toBe('mimsms');
    expect(result.failedOver).toBe(false);
    expect(automas.sendSingle).not.toHaveBeenCalled();
  });

  /**
   * The expensive mistake. An invalid number is a fact about the RECIPIENT — the
   * second gateway rejects it identically, so failing over spends a second
   * credit to be told the same thing, on every bad number in the book.
   */
  test('a permanent refusal does NOT fail over — exactly one gateway call', async () => {
    const mim = fakeAdapter('mimsms', {
      behaviour: { single: failWith('Invalid Mobile Number', ERROR_CATEGORY.PERMANENT) },
    });
    const automas = fakeAdapter('automas');
    install({ mimsms: mim, automas }, ROUTING);

    await expect(dispatcher.sendSingle('01700000000', 'hi')).rejects.toThrow('Invalid Mobile Number');

    expect(mim.sendSingle).toHaveBeenCalledTimes(1);
    expect(automas.sendSingle).not.toHaveBeenCalled();
  });

  test('a retryable failure fails over, and the result carries the attribution', async () => {
    const mim = fakeAdapter('mimsms', {
      behaviour: { single: failWith('socket hang up', ERROR_CATEGORY.RETRYABLE) },
    });
    const automas = fakeAdapter('automas');
    install({ mimsms: mim, automas }, ROUTING);

    const result = await dispatcher.sendSingle('01712345678', 'hi');

    expect(result.provider).toBe('automas');
    expect(result.failedOver).toBe(true);
    expect(result.failedProvider).toBe('mimsms');
    expect(result.failedReason).toBe('socket hang up');
    expect(result.failedCategory).toBe(ERROR_CATEGORY.RETRYABLE);
  });

  /**
   * Each gateway bills its own wallet, so an empty one is precisely the case
   * where the other gateway can still deliver.
   */
  test('an exhausted balance fails over to the gateway with its own wallet', async () => {
    const mim = fakeAdapter('mimsms', {
      behaviour: { single: failWith('Insufficient Balance', ERROR_CATEGORY.BALANCE) },
    });
    const automas = fakeAdapter('automas');
    install({ mimsms: mim, automas }, ROUTING);

    const result = await dispatcher.sendSingle('01712345678', 'hi');
    expect(result.provider).toBe('automas');
  });

  test('an auth failure fails over to the other credentials, never a same-gateway retry', async () => {
    const mim = fakeAdapter('mimsms', {
      behaviour: { single: failWith('Incorrect API Key', ERROR_CATEGORY.AUTH) },
    });
    const automas = fakeAdapter('automas');
    install({ mimsms: mim, automas }, ROUTING);

    const result = await dispatcher.sendSingle('01712345678', 'hi');

    expect(result.provider).toBe('automas');
    expect(mim.sendSingle).toHaveBeenCalledTimes(1);
  });

  /**
   * An OTP that double-sends hands the user two codes and invalidates the one
   * they are already typing.
   */
  test('disableFailover means one attempt, whatever the category', async () => {
    const mim = fakeAdapter('mimsms', {
      behaviour: { single: failWith('timeout', ERROR_CATEGORY.RETRYABLE) },
    });
    const automas = fakeAdapter('automas');
    install({ mimsms: mim, automas }, ROUTING);

    await expect(
      dispatcher.sendSingle('01712345678', 'code 1234', { disableFailover: true })
    ).rejects.toThrow('timeout');

    expect(automas.sendSingle).not.toHaveBeenCalled();
  });

  /**
   * The admin "test this provider" screen is meaningless if a failure silently
   * returns a different gateway's success.
   */
  test('pinning a provider disables failover', async () => {
    const mim = fakeAdapter('mimsms');
    const automas = fakeAdapter('automas', {
      behaviour: { single: failWith('Sender Not Valid', ERROR_CATEGORY.PERMANENT) },
    });
    install({ mimsms: mim, automas }, ROUTING);

    await expect(
      dispatcher.sendSingle('01712345678', 'test', { providerName: 'automas' })
    ).rejects.toThrow('Sender Not Valid');

    expect(mim.sendSingle).not.toHaveBeenCalled();
  });

  test('failover switched off means the primary failure stands', async () => {
    const mim = fakeAdapter('mimsms', {
      behaviour: { single: failWith('timeout', ERROR_CATEGORY.RETRYABLE) },
    });
    const automas = fakeAdapter('automas');
    install({ mimsms: mim, automas }, { ...ROUTING, failoverEnabled: false });

    await expect(dispatcher.sendSingle('01712345678', 'hi')).rejects.toThrow('timeout');
    expect(automas.sendSingle).not.toHaveBeenCalled();
  });

  /**
   * A backup with no credentials must look like NO backup, not like a backup
   * that fails on every message.
   */
  test('an unconfigured backup is not selected', async () => {
    const mim = fakeAdapter('mimsms', {
      behaviour: { single: failWith('timeout', ERROR_CATEGORY.RETRYABLE) },
    });
    const automas = fakeAdapter('automas', { configured: false });
    install({ mimsms: mim, automas }, ROUTING);

    await expect(dispatcher.sendSingle('01712345678', 'hi')).rejects.toThrow('timeout');
    expect(automas.sendSingle).not.toHaveBeenCalled();
  });

  test('when both gateways fail, one error names both', async () => {
    const mim = fakeAdapter('mimsms', {
      behaviour: { single: failWith('gateway down', ERROR_CATEGORY.RETRYABLE) },
    });
    const automas = fakeAdapter('automas', {
      behaviour: { single: failWith('route unavailable', ERROR_CATEGORY.RETRYABLE) },
    });
    install({ mimsms: mim, automas }, ROUTING);

    await expect(dispatcher.sendSingle('01712345678', 'hi')).rejects.toMatchObject({
      allProvidersFailed: true,
      primaryProvider: 'mimsms',
      failoverProvider: 'automas',
    });
  });

  /**
   * Retrying the gateway that just refused is not failover; for an auth failure
   * it is a guaranteed second refusal.
   */
  test('never fails over to the gateway that just failed', async () => {
    const mim = fakeAdapter('mimsms', {
      behaviour: { single: failWith('down', ERROR_CATEGORY.RETRYABLE) },
    });
    install({ mimsms: mim }, { ...ROUTING, failoverProvider: 'mimsms' });

    await expect(dispatcher.sendSingle('01712345678', 'hi')).rejects.toThrow('down');
    expect(mim.sendSingle).toHaveBeenCalledTimes(1);
  });

  /**
   * A misconfigured setting should not also cost you the outage: with two
   * working gateways, one going down must still be survivable.
   */
  test('falls back to any other configured provider when the named backup is unusable', async () => {
    const mim = fakeAdapter('mimsms', {
      behaviour: { single: failWith('down', ERROR_CATEGORY.RETRYABLE) },
    });
    const automas = fakeAdapter('automas');
    install({ mimsms: mim, automas }, { ...ROUTING, failoverProvider: null });

    const result = await dispatcher.sendSingle('01712345678', 'hi');
    expect(result.provider).toBe('automas');
  });
});

describe('registry', () => {
  test('an unknown provider throws, and the error lists the real ones', () => {
    expect(() => registry.getAdapter('twilio')).toThrow(/Unknown SMS provider 'twilio'/);
    expect(() => registry.getAdapter('twilio')).toThrow(/mimsms/);
  });

  test('retired names keep resolving through the alias map', () => {
    expect(registry.normalizeName('mim')).toBe('mimsms');
    expect(registry.normalizeName('MimSMS')).toBe('mimsms');
  });

  test('adapters are singletons — they hold no per-request state', () => {
    expect(registry.getAdapter('mimsms')).toBe(registry.getAdapter('mimsms'));
  });
});
