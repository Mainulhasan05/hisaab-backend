/**
 * Billing guard rails.
 *
 * These are the rules that stop an operator (or a script at 2am) from doing
 * quiet damage, and they live in the service rather than the panel because the
 * panel is not the only caller:
 *
 *   · a free extension needs a REASON — free days and paid days are
 *     indistinguishable in an expiry date, and the reason is the only place the
 *     difference survives
 *   · extending NEVER touches access — the old code's `isActive = true` meant
 *     renewing a shop you had deliberately switched off let it back in silently
 *   · blocking needs a reason; unblocking needs nothing at all
 *   · unblocking clears the LEGACY switches too, so a shop suspended by the old
 *     code path has a way back in
 *   · a trial extension does not convert the shop to a paid plan
 */

const billingService = require('../services/billing.service');
const Shop = require('../models/Shop.model');
const PlatformPayment = require('../models/PlatformPayment.model');
const SubscriptionEvent = require('../models/SubscriptionEvent.model');
const AuditLog = require('../models/AuditLog.model');
const { addBangladeshMonths } = require('../services/billing.service');
const {
  endOfBangladeshDay,
  toBangladeshDateStr,
  addBangladeshDays,
} = require('../utils/bdTime.util');

jest.mock('../utils/authCache.util', () => ({
  invalidateShopAuthCache: jest.fn().mockResolvedValue(undefined),
  invalidateUserAuthCache: jest.fn().mockResolvedValue(undefined),
  invalidateBranchCache: jest.fn().mockResolvedValue(undefined),
}));
const { invalidateShopAuthCache } = require('../utils/authCache.util');

const ADMIN = { kind: 'admin', id: 'admin1', name: 'Operator' };

/** A Shop document stand-in with just the surface the service touches. */
function fakeShop(overrides = {}) {
  const shop = {
    _id: 'shop1',
    name: 'Test Shop',
    isActive: true,
    subscription: { plan: 'paid', status: 'active', expiresAt: endOfBangladeshDay('2026-09-30'), graceDays: 0 },
    billing: { monthlyPrice: 800, smsUnitPrice: 0.35, currency: 'BDT' },
    access: { blockedAt: null },
    ...overrides,
    save: jest.fn().mockResolvedValue(undefined),
    set(path, value) {
      const parts = path.split('.');
      let node = this;
      while (parts.length > 1) node = node[parts.shift()];
      node[parts[0]] = value;
    },
  };
  return shop;
}

let shop;

beforeEach(() => {
  shop = fakeShop();
  jest.spyOn(Shop, 'findById').mockResolvedValue(shop);
  jest.spyOn(SubscriptionEvent, 'create').mockResolvedValue({ _id: 'evt1' });
  jest.spyOn(AuditLog, 'create').mockResolvedValue({});
  jest.spyOn(PlatformPayment, 'create').mockResolvedValue({ _id: 'pay1' });
  // The service returns the freshly-read billing view after every mutation;
  // the mutations themselves are what these tests are about.
  jest.spyOn(billingService, 'getShopBilling').mockResolvedValue({ ok: true });
});

afterEach(() => jest.restoreAllMocks());

const lastEvent = () => SubscriptionEvent.create.mock.calls.at(-1)[0];

describe('free extensions', () => {
  it('are refused without a reason', async () => {
    await expect(
      billingService.extendSubscription(ADMIN, 'shop1', { mode: 'days', value: 7, payment: null })
    ).rejects.toThrow(/reason is required/i);
    expect(shop.save).not.toHaveBeenCalled();
  });

  it('are recorded as unpaid, with the reason, when one is given', async () => {
    await billingService.extendSubscription(ADMIN, 'shop1', {
      mode: 'days', value: 7, payment: null, reason: 'outage credit',
    });

    expect(toBangladeshDateStr(shop.subscription.expiresAt)).toBe('2026-10-07');
    const event = lastEvent();
    expect(event.paid).toBe(false);
    expect(event.reason).toBe('outage credit');
    expect(event.days).toBe(7);
    // No PlatformPayment row: nothing was collected, and a ৳0 row would make
    // the free days look like revenue in the ledger.
    expect(PlatformPayment.create).not.toHaveBeenCalled();
  });

  it('do not convert a trial into a paid plan', async () => {
    shop.subscription.plan = 'trial';
    await billingService.extendSubscription(ADMIN, 'shop1', {
      mode: 'days', value: 5, payment: null, reason: 'still evaluating',
    });
    expect(shop.subscription.plan).toBe('trial');
    expect(lastEvent().type).toBe('trial_extended');
  });

  it('demand a reason before moving an expiry backwards', async () => {
    await expect(
      billingService.extendSubscription(ADMIN, 'shop1', {
        mode: 'until', value: '2026-08-01', payment: { amount: 0 },
      })
    ).rejects.toThrow(/backwards requires a reason/i);
  });
});

describe('extending never touches access', () => {
  it('leaves a blocked shop blocked', async () => {
    shop.access.blockedAt = new Date('2026-08-01');
    shop.access.blockReason = 'payment dispute';

    await billingService.extendSubscription(ADMIN, 'shop1', {
      mode: 'months', value: 1, payment: null, reason: 'paid up, unblocking separately',
    });

    expect(shop.access.blockedAt).toEqual(new Date('2026-08-01'));
    expect(shop.isActive).toBe(true); // untouched, not force-set
  });

  it('does not resurrect a shop switched off by the legacy isActive flag', async () => {
    shop.isActive = false;
    await billingService.extendSubscription(ADMIN, 'shop1', {
      mode: 'days', value: 30, payment: null, reason: 'renewal while suspended',
    });
    expect(shop.isActive).toBe(false);
  });
});

describe('paid extensions', () => {
  it('write a ledger row describing the period it bought', async () => {
    await billingService.applySubscriptionPayment({
      shopId: 'shop1', amount: 800, mode: 'months', value: 1,
      method: 'bkash', transactionId: 'TRX99', actor: ADMIN,
    });

    const row = PlatformPayment.create.mock.calls.at(-1)[0];
    expect(row.type).toBe('subscription');
    expect(row.amount).toBe(800);
    expect(row.transactionId).toBe('TRX99');
    expect(row.months).toBe(1);
    // 30 Sep + 1 month = 30 Oct: the day-of-month is preserved, so a monthly
    // subscription keeps its billing date instead of drifting later each cycle.
    expect(toBangladeshDateStr(row.periodEnd)).toBe('2026-10-30');
    expect(row.status).toBe('paid');
    expect(lastEvent().paid).toBe(true);
  });

  it('convert a trial to paid, and stamp when the trial ended', async () => {
    shop.subscription.plan = 'trial';
    await billingService.applySubscriptionPayment({
      shopId: 'shop1', amount: 800, mode: 'months', value: 1, actor: ADMIN,
    });
    expect(shop.subscription.plan).toBe('paid');
    expect(shop.subscription.trialEndedAt).toBeInstanceOf(Date);
  });

  it('book a ৳0 payment as waived rather than as revenue', async () => {
    await billingService.applySubscriptionPayment({
      shopId: 'shop1', amount: 0, mode: 'months', value: 1, actor: ADMIN,
    });
    expect(PlatformPayment.create.mock.calls.at(-1)[0].status).toBe('waived');
  });

  it('ignore a repeated gateway callback instead of extending twice', async () => {
    jest.spyOn(PlatformPayment, 'findOne').mockResolvedValue({ _id: 'pay1', shop: 'shop1' });
    await billingService.applySubscriptionPayment({
      shopId: 'shop1', amount: 800, source: 'gateway',
      gateway: { provider: 'bkash', paymentId: 'PID-1' }, actor: ADMIN,
    });
    expect(shop.save).not.toHaveBeenCalled();
    expect(PlatformPayment.create).not.toHaveBeenCalled();
  });
});

describe('money received before it was keyed in', () => {
  // The everyday case: bKash arrives on the 3rd, the operator enters it on the
  // 12th. The ledger must date it to the 3rd, and the shop must not be charged
  // nine days for the operator's backlog.
  const RECEIVED = '2026-08-01T04:00:00.000Z';

  beforeEach(() => {
    // Lapsed on 15 July, so there is no paid time to protect.
    shop.subscription.expiresAt = endOfBangladeshDay('2026-07-15');
  });

  it('always dates the ledger row to when the money arrived', async () => {
    await billingService.applySubscriptionPayment({
      shopId: 'shop1', amount: 800, mode: 'months', value: 1,
      receivedAt: RECEIVED, actor: ADMIN,
    });
    expect(toBangladeshDateStr(PlatformPayment.create.mock.calls.at(-1)[0].receivedAt)).toBe('2026-08-01');
    expect(toBangladeshDateStr(shop.subscription.lastPaymentAt)).toBe('2026-08-01');
  });

  it('runs the period from the payment date when asked to backdate', async () => {
    await billingService.applySubscriptionPayment({
      shopId: 'shop1', amount: 800, mode: 'months', value: 1,
      receivedAt: RECEIVED, backdate: true, actor: ADMIN,
    });
    // 1 Aug + 1 month, not (entry date) + 1 month.
    expect(toBangladeshDateStr(shop.subscription.expiresAt)).toBe('2026-09-01');
  });

  it('runs the period from today when not asked to', async () => {
    await billingService.applySubscriptionPayment({
      shopId: 'shop1', amount: 800, mode: 'months', value: 1,
      receivedAt: RECEIVED, actor: ADMIN,
    });
    const expected = toBangladeshDateStr(addBangladeshMonths(new Date(), 1));
    expect(toBangladeshDateStr(shop.subscription.expiresAt)).toBe(expected);
  });

  it('never lets a backdate cut an active subscription short', async () => {
    // Paid through 30 Sep already; a backdated top-up must extend from there,
    // not from the (earlier) payment date.
    shop.subscription.expiresAt = endOfBangladeshDay('2026-09-30');
    await billingService.applySubscriptionPayment({
      shopId: 'shop1', amount: 800, mode: 'months', value: 1,
      receivedAt: RECEIVED, backdate: true, actor: ADMIN,
    });
    expect(toBangladeshDateStr(shop.subscription.expiresAt)).toBe('2026-10-30');
  });

  it('ignores a receivedAt in the future rather than granting unpaid days', async () => {
    const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    await billingService.applySubscriptionPayment({
      shopId: 'shop1', amount: 800, mode: 'days', value: 10,
      receivedAt: future, backdate: true, actor: ADMIN,
    });
    const expected = toBangladeshDateStr(addBangladeshDays(new Date(), 10));
    expect(toBangladeshDateStr(shop.subscription.expiresAt)).toBe(expected);
  });
});

describe('trial and paid never coexist', () => {
  it('refuses to trial a shop that still has paid time left', async () => {
    shop.subscription.plan = 'paid';
    shop.subscription.expiresAt = endOfBangladeshDay('2027-12-31');
    await expect(billingService.startTrial(ADMIN, 'shop1', { days: 14 })).rejects.toThrow(
      /paid subscription until 2027-12-31/i
    );
    expect(shop.save).not.toHaveBeenCalled();
  });

  it('allows it when forced, and records what was thrown away', async () => {
    shop.subscription.plan = 'paid';
    shop.subscription.expiresAt = endOfBangladeshDay('2027-12-31');
    await billingService.startTrial(ADMIN, 'shop1', { days: 14, force: true, reason: 'downgrade agreed' });

    expect(shop.subscription.plan).toBe('trial');
    const event = lastEvent();
    // The discarded date survives on the event; without it the paid period is
    // simply gone and nobody can restore it.
    expect(toBangladeshDateStr(event.before.expiresAt)).toBe('2027-12-31');
    expect(event.note).toMatch(/2027-12-31/);
  });

  it('needs no confirmation when the paid time has already lapsed', async () => {
    shop.subscription.plan = 'paid';
    shop.subscription.expiresAt = endOfBangladeshDay('2026-01-01');
    await expect(billingService.startTrial(ADMIN, 'shop1', { days: 14 })).resolves.toBeDefined();
    expect(shop.subscription.plan).toBe('trial');
  });

  it('leaves exactly one plan set — taking a payment ends the trial', async () => {
    shop.subscription.plan = 'trial';
    await billingService.applySubscriptionPayment({
      shopId: 'shop1', amount: 800, mode: 'months', value: 1, actor: ADMIN,
    });
    expect(shop.subscription.plan).toBe('paid');
    expect(shop.subscription.trialEndedAt).toBeInstanceOf(Date);
  });
});

describe('access', () => {
  it('refuses to block without a reason', async () => {
    await expect(billingService.setAccess(ADMIN, 'shop1', { action: 'block' })).rejects.toThrow(
      /reason is required/i
    );
  });

  it('blocks with an actor and a reason attached, and invalidates the cache at once', async () => {
    await billingService.setAccess(ADMIN, 'shop1', { action: 'block', reason: 'chargeback' });
    expect(shop.access.blockedAt).toBeInstanceOf(Date);
    expect(shop.access.blockedBy).toBe('admin1');
    expect(shop.access.blockReason).toBe('chargeback');
    // Effective on the shop's very next request, not after the 5-minute TTL.
    expect(invalidateShopAuthCache).toHaveBeenCalledWith('shop1');
    expect(lastEvent().type).toBe('blocked');
  });

  it('unblocks with no reason required — the way out is never gated', async () => {
    shop.access.blockedAt = new Date();
    await expect(
      billingService.setAccess(ADMIN, 'shop1', { action: 'unblock' })
    ).resolves.toBeDefined();
    expect(shop.access.blockedAt).toBeNull();
  });

  it('clears the legacy switches too, so an old suspension is recoverable', async () => {
    shop.isActive = false;
    shop.subscription.status = 'suspended';
    await billingService.setAccess(ADMIN, 'shop1', { action: 'unblock' });
    expect(shop.isActive).toBe(true);
    expect(shop.subscription.status).toBe('active');
    expect(shop.access.blockedAt).toBeNull();
  });

  it('rejects anything that is not block or unblock', async () => {
    await expect(billingService.setAccess(ADMIN, 'shop1', { action: 'delete' })).rejects.toThrow(
      /block or unblock/i
    );
  });
});

describe('trials', () => {
  it('accept any day count and never mark the shop paid', async () => {
    // Lapsed, so no paid time is at stake — the guard for that case is in
    // "trial and paid never coexist" below.
    shop.subscription.expiresAt = endOfBangladeshDay('2026-01-01');
    await billingService.startTrial(ADMIN, 'shop1', { days: 45, reason: 'pilot' });
    expect(shop.subscription.plan).toBe('trial');
    expect(shop.subscription.trialDays).toBe(45);
    expect(shop.subscription.status).toBe('active');
    expect(lastEvent().type).toBe('trial_started');
  });

  it('reject a zero or negative length', async () => {
    await expect(billingService.startTrial(ADMIN, 'shop1', { days: 0 })).rejects.toThrow(
      /between 1 and/i
    );
  });
});

describe('negotiated pricing', () => {
  it('stores the agreed figures and records why', async () => {
    await billingService.updateBillingProfile(ADMIN, 'shop1', {
      monthlyPrice: 650, smsUnitPrice: 0.3, graceDays: 3, reason: 'bargained down, long term',
    });
    expect(shop.billing.monthlyPrice).toBe(650);
    expect(shop.billing.smsUnitPrice).toBe(0.3);
    expect(shop.subscription.graceDays).toBe(3);
    expect(lastEvent().reason).toMatch(/bargained/);
  });

  it('rejects a negative price rather than storing it', async () => {
    await expect(
      billingService.updateBillingProfile(ADMIN, 'shop1', { monthlyPrice: -100 })
    ).rejects.toThrow(/non-negative/i);
  });
});
