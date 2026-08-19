/**
 * Founder alerts — routing, noise control and device recognition.
 *
 * These three things are what make "notify me on every login" a setting an
 * operator can actually leave switched on, and each of them fails silently if
 * broken: a mis-routed alert goes to the wrong switch, a broken cooldown floods
 * the channel until it is muted, and a broken fingerprint marks every login as
 * suspicious until nobody reads the security class any more. None of those
 * produce an error anywhere — they just quietly make the feature worthless. So
 * they are pinned here.
 */

jest.mock('../services/telegram.service', () => ({
  isEnabled: () => true,
  broadcastToAdmins: jest.fn().mockResolvedValue(1),
  safeSend: jest.fn().mockResolvedValue(1),
}));

// An in-memory stand-in for Redis with the two semantics the notifier relies
// on: `setNX` returns true only for the first writer of a live key, and `get`
// returns null for anything unset. Faked rather than mocked per-call so the
// cooldown is exercised through its real code path.
const mockStore = new Map();
jest.mock('../services/cache.service', () => ({
  get: jest.fn(async (k) => (mockStore.has(k) ? mockStore.get(k) : null)),
  set: jest.fn(async (k, v) => { mockStore.set(k, v); return true; }),
  delete: jest.fn(async (k) => { mockStore.delete(k); return true; }),
  setNX: jest.fn(async (k, v) => {
    if (mockStore.has(k)) return false;
    mockStore.set(k, v);
    return true;
  }),
}));

/**
 * The signup alert enriches itself from two collections — the shop type's
 * readable name and the platform-wide shop count. Both are stubbed here rather
 * than left to Mongoose: unconnected, they buffer forever, and every assertion
 * below runs against a notifier that is documented to settle on the microtask
 * queue.
 */
jest.mock('../models/Shop.model', () => ({
  estimatedDocumentCount: jest.fn().mockResolvedValue(118),
}));
jest.mock('../models/ShopCategory.model', () => ({
  findOne: jest.fn(() => ({
    select: () => ({ maxTimeMS: () => ({ lean: async () => ({ name: 'কাপড়ের দোকান' }) }) }),
  })),
}));

const telegramService = require('../services/telegram.service');
const platformNotify = require('../services/platformNotify.service');
const { ALERT_KEYS } = require('../models/AdminTelegramLink.model');
const User = require('../models/User.model');
const mongoose = require('mongoose');

/**
 * The notifier's methods are fire-and-forget by design — they return
 * synchronously and do their work on the microtask queue, so a test that
 * asserts immediately after calling one asserts against nothing. This drains
 * the queue.
 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Pretend an operator is connected, and configure the login cooldown. */
function withAudience(cooldownMinutes = 60) {
  mockStore.clear();
  mockStore.set('pnotify:audience', true);
  mockStore.set('pnotify:logincooldown', cooldownMinutes * 60);
}

const shop = { _id: 'shop1', name: 'হিসাব ফ্যাশন' };
const user = { _id: 'user1', name: 'করিম', phone: '01711111111', isOwner: true };

beforeEach(() => {
  jest.clearAllMocks();
  withAudience();
});

describe('alert routing', () => {
  it('sends a routine login on the login switch, not the security one', async () => {
    platformNotify.userLogin({ user, shop, req: null });
    await settle();

    expect(telegramService.broadcastToAdmins).toHaveBeenCalledTimes(1);
    expect(telegramService.broadcastToAdmins.mock.calls[0][0]).toBe(ALERT_KEYS.USER_LOGIN);
  });

  it('routes a FIRST-EVER login to the security switch', async () => {
    platformNotify.userLogin({ user, shop, req: null, isFirstLogin: true });
    await settle();

    const [key, body] = telegramService.broadcastToAdmins.mock.calls[0];
    expect(key).toBe(ALERT_KEYS.SECURITY);
    expect(body).toContain('প্রথমবার');
  });

  it('routes an unrecognised device to the security switch', async () => {
    platformNotify.userLogin({ user, shop, req: null, isNewDevice: true });
    await settle();

    const [key, body] = telegramService.broadcastToAdmins.mock.calls[0];
    expect(key).toBe(ALERT_KEYS.SECURITY);
    expect(body).toContain('নতুন ডিভাইস');
  });

  it('reports a first login once, not twice — first-login wins over new-device', async () => {
    // Every first login is also, by definition, from an unknown device. Firing
    // both would put two messages in the channel for one event.
    platformNotify.userLogin({ user, shop, req: null, isFirstLogin: true, isNewDevice: true });
    await settle();

    expect(telegramService.broadcastToAdmins).toHaveBeenCalledTimes(1);
    expect(telegramService.broadcastToAdmins.mock.calls[0][1]).toContain('প্রথমবার');
  });

  it('puts an admin console login on the security switch', async () => {
    platformNotify.adminLogin({ admin: { name: 'Founder', phone: '01757995016', role: 'super_admin' } });
    await settle();

    expect(telegramService.broadcastToAdmins.mock.calls[0][0]).toBe(ALERT_KEYS.SECURITY);
  });

  it('puts a new shop on its own switch', async () => {
    platformNotify.newShop({ shop: { ...shop, slug: 'hisaab-fashion' }, user });
    await settle();

    const [key, body] = telegramService.broadcastToAdmins.mock.calls[0];
    expect(key).toBe(ALERT_KEYS.NEW_SHOP);
    expect(body).toContain('হিসাব ফ্যাশন');
    expect(body).toContain('01711111111');
  });
});

describe('signup detail', () => {
  /**
   * A signup alert exists so the operator can act — place a welcome call, watch
   * a trial expire — without opening the console. Every field below was silently
   * missing at some point: `type` and `address` were read under the names the
   * REGISTRATION PAYLOAD uses (`shopType`, `address.district`) rather than the
   * ones the Shop schema stores, so both dropped out of the message entirely
   * while the alert kept looking healthy.
   */
  const fullShop = {
    _id: 'shop1',
    name: 'হিসাব ফ্যাশন',
    slug: 'hisaab-fashion',
    type: 'cloth',
    address: 'ঝিনাইদহ সদর, ঝিনাইদহ',
    phone: '01799999999',
    subscription: {
      plan: 'trial',
      trialDays: 14,
      expiresAt: new Date('2026-09-01T17:59:59.999Z'),
    },
    billing: { monthlyPrice: 500 },
  };

  it('carries the shop type, address, plan, ids and platform total', async () => {
    platformNotify.newShop({ shop: fullShop, user });
    await settle();

    const body = telegramService.broadcastToAdmins.mock.calls[0][1];
    expect(body).toContain('কাপড়ের দোকান');       // resolved from the category key
    expect(body).toContain('ঝিনাইদহ সদর');
    expect(body).toContain('01799999999');         // shop phone, distinct from the owner's
    expect(body).toContain('01711111111');         // owner phone
    expect(body).toContain('14');                  // trial days
    expect(body).toContain('৳ 500');
    expect(body).toContain('hisaab-fashion');
    expect(body).toContain('shop1');
    expect(body).toContain('118');                 // platform-wide shop count
  });

  it("omits the shop phone when it is just the owner's number again", async () => {
    platformNotify.newShop({ shop: { ...fullShop, phone: user.phone }, user });
    await settle();

    const body = telegramService.broadcastToAdmins.mock.calls[0][1];
    expect(body).not.toContain('☎️');   // no separate shop-phone line
    expect(body).toContain('01711111111');
  });

  it('still sends when the shop carries nothing but a name', async () => {
    platformNotify.newShop({ shop: { name: 'নতুন দোকান' }, user });
    await settle();

    const body = telegramService.broadcastToAdmins.mock.calls[0][1];
    expect(body).toContain('নতুন দোকান');
    // Empty fields are dropped, not rendered as a column of dashes.
    expect(body).not.toContain('ধরন:');
    expect(body).not.toContain('মেয়াদ শেষ:');
  });

  it('falls back to the raw type key when the category lookup finds nothing', async () => {
    const ShopCategory = require('../models/ShopCategory.model');
    ShopCategory.findOne.mockReturnValueOnce({
      select: () => ({ maxTimeMS: () => ({ lean: async () => null }) }),
    });

    platformNotify.newShop({ shop: { name: 'দোকান', type: 'pharmacy' }, user });
    await settle();

    expect(telegramService.broadcastToAdmins.mock.calls[0][1]).toContain('pharmacy');
  });

  it('sends without the count when the shop count read fails', async () => {
    const Shop = require('../models/Shop.model');
    Shop.estimatedDocumentCount.mockRejectedValueOnce(new Error('no primary'));

    platformNotify.newShop({ shop: fullShop, user });
    await settle();

    const body = telegramService.broadcastToAdmins.mock.calls[0][1];
    expect(body).toContain('হিসাব ফ্যাশন');
    expect(body).not.toContain('মোট দোকান');
  });
});

describe('login cooldown', () => {
  it('collapses repeat logins by the same user inside the window', async () => {
    platformNotify.userLogin({ user, shop });
    await settle();
    platformNotify.userLogin({ user, shop });
    await settle();
    platformNotify.userLogin({ user, shop });
    await settle();

    expect(telegramService.broadcastToAdmins).toHaveBeenCalledTimes(1);
  });

  it('does not let one user\'s cooldown silence another', async () => {
    platformNotify.userLogin({ user, shop });
    await settle();
    platformNotify.userLogin({ user: { ...user, _id: 'user2', name: 'রহিম' }, shop });
    await settle();

    expect(telegramService.broadcastToAdmins).toHaveBeenCalledTimes(2);
  });

  it('never collapses a security-class login — that is the point of the split', async () => {
    platformNotify.userLogin({ user, shop, isNewDevice: true });
    await settle();
    platformNotify.userLogin({ user, shop, isNewDevice: true });
    await settle();

    expect(telegramService.broadcastToAdmins).toHaveBeenCalledTimes(2);
  });

  it('sends every login when the cooldown is set to 0', async () => {
    withAudience(0);

    platformNotify.userLogin({ user, shop });
    await settle();
    platformNotify.userLogin({ user, shop });
    await settle();

    expect(telegramService.broadcastToAdmins).toHaveBeenCalledTimes(2);
  });
});

describe('failed-password bursts', () => {
  it('stays quiet below the threshold — a typo is not an incident', async () => {
    for (let i = 0; i < 4; i++) {
      platformNotify.failedLogin({ phone: '01711111111' });
      await settle();
    }
    expect(telegramService.broadcastToAdmins).not.toHaveBeenCalled();
  });

  it('fires once the burst forms, then mutes itself', async () => {
    for (let i = 0; i < 12; i++) {
      platformNotify.failedLogin({ phone: '01711111111' });
      await settle();
    }

    // One message for twelve attempts. Without the mute this would be eight.
    expect(telegramService.broadcastToAdmins).toHaveBeenCalledTimes(1);
    expect(telegramService.broadcastToAdmins.mock.calls[0][0]).toBe(ALERT_KEYS.SECURITY);
  });

  it('counts each phone separately', async () => {
    for (let i = 0; i < 5; i++) {
      platformNotify.failedLogin({ phone: '01711111111' });
      await settle();
    }
    for (let i = 0; i < 5; i++) {
      platformNotify.failedLogin({ phone: '01722222222' });
      await settle();
    }

    expect(telegramService.broadcastToAdmins).toHaveBeenCalledTimes(2);
  });
});

describe('no audience', () => {
  it('sends nothing at all when no operator has linked Telegram', async () => {
    mockStore.clear();
    mockStore.set('pnotify:audience', false);

    platformNotify.userLogin({ user, shop });
    platformNotify.newShop({ shop, user });
    platformNotify.adminLogin({ admin: { name: 'X', phone: '01' } });
    await settle();

    expect(telegramService.broadcastToAdmins).not.toHaveBeenCalled();
  });
});

describe('message safety', () => {
  it('escapes a shop name that would otherwise break the HTML parse', async () => {
    // A shop called "M&S <Fashion>" is the documented way a Telegram send
    // starts failing with an unexplained 400.
    platformNotify.newShop({ shop: { name: 'M&S <Fashion>' }, user });
    await settle();

    const body = telegramService.broadcastToAdmins.mock.calls[0][1];
    expect(body).toContain('M&amp;S &lt;Fashion&gt;');
    expect(body).not.toContain('<Fashion>');
  });

  it('escapes an attacker-controlled user-agent in the footer', async () => {
    platformNotify.userLogin({
      user,
      shop,
      req: { ip: '1.2.3.4', headers: { 'user-agent': '<b>Android</b>' } },
    });
    await settle();

    const body = telegramService.broadcastToAdmins.mock.calls[0][1];
    // The agent is reduced to a coarse label, so the tags never survive at all.
    expect(body).toContain('1.2.3.4');
    expect(body).not.toContain('<b>Android</b>');
  });
});

/**
 * The footer's address line.
 *
 * Every one of these alerts exists so an operator can answer "was that me?",
 * and the address is the only part of the message that answers it. It read
 * `127.0.0.1` on every alert in production: `req.ip` falls back to the socket
 * address when the proxy sends no `x-forwarded-for`, and the header fallback
 * written to catch that sat behind a `||` that could never be reached.
 */
describe('origin address', () => {
  const send = (req) => {
    platformNotify.userLogin({ user, shop, req });
    return settle();
  };
  const lastBody = () => telegramService.broadcastToAdmins.mock.calls[0][1];

  it('falls through a loopback socket address to the resolved one', async () => {
    // What the request really looks like behind nginx: the socket is loopback
    // and the truth is in the header the middleware already read.
    await send({
      ip: '::ffff:127.0.0.1',
      context: { ip: '203.0.113.9' },
      headers: { 'x-real-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0 (Linux; Android 13)' },
    });

    expect(lastBody()).toContain('203.0.113.9');
    expect(lastBody()).not.toContain('127.0.0.1');
  });

  it('reads the proxy headers itself when the request skipped the middleware', async () => {
    // A job or a test double has no `req.context`. `x-real-ip` is the header
    // Express's own `trust proxy` never looks at.
    await send({ ip: '127.0.0.1', headers: { 'x-real-ip': '198.51.100.7' } });
    expect(lastBody()).toContain('198.51.100.7');
  });

  it('strips the IPv4-mapped prefix a dual-stack socket adds', async () => {
    await send({ ip: '::ffff:203.0.113.42', headers: {} });
    expect(lastBody()).toContain('203.0.113.42');
    expect(lastBody()).not.toContain('::ffff:');
  });

  it('keeps the address Express vouches for over a client-supplied one', async () => {
    // `trust proxy` makes `req.ip` the entry a client cannot push into — a
    // request forging `X-Forwarded-For: 1.2.3.4` has it shifted left and
    // ignored, while `getClientIP` would read exactly that forged first entry.
    // On "your password just changed, from here", an attacker-chosen address is
    // worse than no address.
    await send({
      ip: '203.0.113.9',
      context: { ip: '1.2.3.4' },
      headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
    });

    expect(lastBody()).toContain('203.0.113.9');
    expect(lastBody()).not.toContain('1.2.3.4');
  });

  it('skips a private proxy hop the way it skips loopback', async () => {
    // Two hops with only the inner one translated: the socket shows the LAN
    // address of the proxy, which answers "which machine", not "who".
    await send({ ip: '10.0.0.5', context: { ip: '198.51.100.22' }, headers: {} });
    expect(lastBody()).toContain('198.51.100.22');
    expect(lastBody()).not.toContain('10.0.0.5');
  });

  it('says the proxy is misconfigured rather than printing loopback', async () => {
    // Nothing forwarded a client address, so there is no address to show.
    // Printing 127.0.0.1 is what let this go unnoticed — it looks like data.
    await send({ ip: '127.0.0.1', headers: {} });

    const body = lastBody();
    expect(body).not.toContain('127.0.0.1');
    expect(body).toContain('প্রক্সি ঠিকানা পাঠাচ্ছে না');
  });
});

describe('device recognition', () => {
  /** A user document with save() stubbed — this is model logic, not persistence. */
  function stubUser() {
    const u = new User({
      phone: '01711111111',
      password: 'secret1',
      name: 'T',
      shop: new mongoose.Types.ObjectId(),
    });
    u.save = async () => u;
    return u;
  }

  it('flags the first login and does not also call it a new device', async () => {
    const u = stubUser();
    const result = await u.updateLastLogin({ ip: '103.5.140.22', userAgent: 'Android' });

    expect(result.isFirstLogin).toBe(true);
    expect(result.isNewDevice).toBe(false);
  });

  it('treats a changed host octet on the same network as the SAME device', async () => {
    // The whole reason the fingerprint hashes the /24 and not the full address:
    // Bangladeshi mobile carriers reassign the host octet several times a day.
    const u = stubUser();
    await u.updateLastLogin({ ip: '103.5.140.22', userAgent: 'Android' });
    const result = await u.updateLastLogin({ ip: '103.5.140.201', userAgent: 'Android' });

    expect(result.isNewDevice).toBe(false);
    expect(u.knownDevices).toHaveLength(1);
  });

  it('flags a genuinely different network', async () => {
    const u = stubUser();
    await u.updateLastLogin({ ip: '103.5.140.22', userAgent: 'Android' });
    const result = await u.updateLastLogin({ ip: '45.9.1.4', userAgent: 'Android' });

    expect(result.isNewDevice).toBe(true);
  });

  it('flags the same network from a different browser', async () => {
    const u = stubUser();
    await u.updateLastLogin({ ip: '103.5.140.22', userAgent: 'Android' });
    const result = await u.updateLastLogin({ ip: '103.5.140.22', userAgent: 'Windows Chrome' });

    expect(result.isNewDevice).toBe(true);
  });

  it('caps the device list rather than growing one entry per café wifi', async () => {
    const u = stubUser();
    for (let i = 0; i < 25; i++) {
      await u.updateLastLogin({ ip: `10.0.${i}.1`, userAgent: 'Android' });
    }
    expect(u.knownDevices.length).toBeLessThanOrEqual(10);
  });

  it('evicts the OLDEST device, so a long-unused one reads as unfamiliar again', async () => {
    const u = stubUser();
    for (let i = 0; i < 12; i++) {
      await u.updateLastLogin({ ip: `10.0.${i}.1`, userAgent: 'Android' });
    }
    // 10.0.0.1 was pushed out; coming back must be reported.
    const result = await u.updateLastLogin({ ip: '10.0.0.1', userAgent: 'Android' });
    expect(result.isNewDevice).toBe(true);
  });

  it('records nothing when there is no request context to describe', async () => {
    // An internal caller with no request must not write a null-fingerprinted
    // device — that would make the next REAL login look familiar.
    const u = stubUser();
    await u.updateLastLogin();

    expect(u.knownDevices).toHaveLength(0);
    expect(u.lastLogin).toBeInstanceOf(Date);
  });
});
