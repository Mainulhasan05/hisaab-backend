/**
 * The per-shop billing day.
 *
 * Two drifts motivate the whole feature, and every individual step of both was
 * arithmetically correct before it, which is exactly why nothing caught them:
 *
 *   clamping      31 Jan +1mo = 28 Feb is right, but 28 Feb then became the
 *                 anchor, so March landed on the 28th and the 31st never came
 *                 back — roughly three days lost per year, silently.
 *   late payment  a lapsed expiry means the anchor is today, so a shop billed
 *                 on the 5th that pays on the 20th is billed on the 20th from
 *                 then on, and the operator's call list stops being a calendar.
 *
 * The rule asserted hardest here is the one that makes the feature safe to
 * ship: alignment may change WHERE a renewal lands and may never take back
 * time already paid for.
 *
 * A separate file from `billingGuards.test.js` because these tests need to
 * drive the clock, and `jest.useFakeTimers()` in a shared file is how unrelated
 * suites start failing before noon.
 */

const billingService = require('../services/billing.service');
const Shop = require('../models/Shop.model');
const PlatformPayment = require('../models/PlatformPayment.model');
const SubscriptionEvent = require('../models/SubscriptionEvent.model');
const AuditLog = require('../models/AuditLog.model');
const {
  addBangladeshMonths,
  alignToBillingDay,
  normalizeBillingDay,
} = require('../services/billing.service');
const { endOfBangladeshDay, toBangladeshDateStr } = require('../utils/bdTime.util');

jest.mock('../utils/authCache.util', () => ({
  invalidateShopAuthCache: jest.fn().mockResolvedValue(undefined),
  invalidateUserAuthCache: jest.fn().mockResolvedValue(undefined),
  invalidateBranchCache: jest.fn().mockResolvedValue(undefined),
}));

const ADMIN = { kind: 'admin', id: 'admin1', name: 'Operator' };

const on = (iso) => endOfBangladeshDay(iso);
const dayOf = (d) => toBangladeshDateStr(d);

/** A Shop document stand-in with just the surface the service touches. */
function fakeShop(overrides = {}) {
  return {
    _id: 'shop1',
    name: 'Test Shop',
    isActive: true,
    subscription: { plan: 'paid', status: 'active', expiresAt: on('2026-09-30'), graceDays: 0 },
    billing: { monthlyPrice: 800, smsUnitPrice: 0.35, currency: 'BDT', billingDay: null },
    access: { blockedAt: null },
    ...overrides,
    save: jest.fn().mockResolvedValue(undefined),
  };
}

let shop;

/**
 * The clock is frozen for the whole suite.
 *
 * Every expiry below is a literal date, and the anchor rule reads "today" when
 * an expiry has lapsed — so against the real clock these tests would start
 * anchoring on the current month and change their answers as the year moves.
 * A fixed early-2026 "now" keeps every expiry in these tests in the future
 * unless a test deliberately moves the clock past it.
 */
const FROZEN_NOW = new Date('2026-01-10T06:00:00.000Z');

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(FROZEN_NOW);
  shop = fakeShop();
  jest.spyOn(Shop, 'findById').mockResolvedValue(shop);
  jest.spyOn(SubscriptionEvent, 'create').mockResolvedValue({ _id: 'evt1' });
  jest.spyOn(AuditLog, 'create').mockResolvedValue({});
  jest.spyOn(PlatformPayment, 'create').mockResolvedValue({ _id: 'pay1' });
  jest.spyOn(billingService, 'getShopBilling').mockResolvedValue({ ok: true });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const lastEvent = () => SubscriptionEvent.create.mock.calls.at(-1)[0];

const renew = (extra = {}) =>
  billingService.extendSubscription(ADMIN, 'shop1', {
    mode: 'months', value: 1, payment: null, reason: 'renewal', ...extra,
  });

const pay = (extra = {}) =>
  billingService.applySubscriptionPayment({
    shopId: 'shop1', actor: ADMIN, amount: 800, mode: 'months', value: 1, ...extra,
  });

// ── the arithmetic ──────────────────────────────────────────────────────────

describe('alignToBillingDay', () => {
  it('brings the 31st back after a February clamp instead of losing it', () => {
    // The difference from addBangladeshMonths is which day survives: that one
    // carries the ANCHOR's day forward, this one carries the STORED day and
    // re-clamps it fresh each month.
    const feb = alignToBillingDay(on('2026-01-31'), 1, 31);
    expect(dayOf(feb)).toBe('2026-02-28');

    expect(dayOf(alignToBillingDay(feb, 1, 31))).toBe('2026-03-31');
    // What the un-aligned arithmetic does with the same input, for contrast.
    expect(dayOf(addBangladeshMonths(feb, 1))).toBe('2026-03-28');
  });

  it('clamps into a 30-day month', () => {
    expect(dayOf(alignToBillingDay(on('2026-03-31'), 1, 31))).toBe('2026-04-30');
  });

  it('crosses a year boundary', () => {
    expect(dayOf(alignToBillingDay(on('2026-11-05'), 2, 5))).toBe('2027-01-05');
  });

  it('handles a leap February', () => {
    expect(dayOf(alignToBillingDay(on('2028-01-31'), 1, 31))).toBe('2028-02-29');
  });

  it('returns null for a day it cannot use, rather than guessing', () => {
    expect(alignToBillingDay(on('2026-01-31'), 1, 0)).toBeNull();
    expect(alignToBillingDay(on('2026-01-31'), 1, 32)).toBeNull();
    expect(alignToBillingDay(null, 1, 5)).toBeNull();
  });
});

describe('normalizeBillingDay', () => {
  it('accepts a day of the month and rejects everything else', () => {
    expect(normalizeBillingDay(5)).toBe(5);
    expect(normalizeBillingDay('5')).toBe(5);
    expect(normalizeBillingDay(31)).toBe(31);
    expect(normalizeBillingDay(0)).toBeNull();
    expect(normalizeBillingDay(32)).toBeNull();
    expect(normalizeBillingDay(null)).toBeNull();
    expect(normalizeBillingDay(undefined)).toBeNull();
    expect(normalizeBillingDay('')).toBeNull();
    expect(normalizeBillingDay('abc')).toBeNull();
  });
});

// ── the behaviour shops actually see ────────────────────────────────────────

describe('a shop with no billing day', () => {
  it('reproduces the pre-feature behaviour exactly, drift included', async () => {
    shop.subscription.expiresAt = on('2026-01-31');

    for (const expected of ['2026-02-28', '2026-03-28', '2026-04-28']) {
      // eslint-disable-next-line no-await-in-loop
      await renew();
      expect(dayOf(shop.subscription.expiresAt)).toBe(expected);
    }
    // Asserted so a later change cannot quietly alter the behaviour of shops
    // that never opted in. A free extension never stamps a day.
    expect(shop.billing.billingDay).toBeNull();
  });

  it('is unaffected by a stored alignment preference', async () => {
    shop.billing.cycleAlignment = 'billing_day';
    shop.subscription.expiresAt = on('2026-01-31');
    await renew();
    expect(dayOf(shop.subscription.expiresAt)).toBe('2026-02-28');
  });
});

describe('a shop with a billing day', () => {
  it('holds the day across a clamp instead of drifting', async () => {
    shop.subscription.expiresAt = on('2026-01-31');
    shop.billing.billingDay = 31;

    for (const expected of ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']) {
      // eslint-disable-next-line no-await-in-loop
      await renew();
      expect(dayOf(shop.subscription.expiresAt)).toBe(expected);
    }
    // The stored anchor is never rewritten — that is the whole mechanism.
    expect(shop.billing.billingDay).toBe(31);
  });

  it('gives a clean month when it is already aligned', async () => {
    shop.subscription.expiresAt = on('2026-02-05');
    shop.billing.billingDay = 5;
    await renew();
    expect(dayOf(shop.subscription.expiresAt)).toBe('2026-03-05');
  });

  it('takes a 6-month package to the same day six months out', async () => {
    shop.subscription.expiresAt = on('2026-03-05');
    shop.billing.billingDay = 5;
    await pay({ value: 6, amount: 4000 });
    expect(dayOf(shop.subscription.expiresAt)).toBe('2026-09-05');
  });

  it('takes a 12-month package to the same day a year out', async () => {
    shop.subscription.expiresAt = on('2026-03-05');
    shop.billing.billingDay = 5;
    await pay({ value: 12, amount: 8000 });
    expect(dayOf(shop.subscription.expiresAt)).toBe('2027-03-05');
  });
});

describe('a late payment', () => {
  // Expiry 5 Feb, money keyed on the 20th. Without a billing day the shop
  // moves to the 20th and stays there for good.
  const lapsedOnThe20th = () => {
    shop.subscription.expiresAt = on('2026-02-05');
    jest.useFakeTimers().setSystemTime(new Date('2026-02-20T06:00:00.000Z'));
  };

  it('comes back to the billing day', async () => {
    lapsedOnThe20th();
    shop.billing.billingDay = 5;
    await pay();
    expect(dayOf(shop.subscription.expiresAt)).toBe('2026-03-05');
  });

  it('walks the date across the month when the shop opted out of alignment', async () => {
    lapsedOnThe20th();
    shop.billing.billingDay = 5;
    shop.billing.cycleAlignment = 'from_anchor';
    await pay();
    expect(dayOf(shop.subscription.expiresAt)).toBe('2026-03-20');
  });

  it('can be overridden for one extension without changing the shop', async () => {
    lapsedOnThe20th();
    shop.billing.billingDay = 5;

    await renew({ alignment: 'from_anchor' });

    expect(dayOf(shop.subscription.expiresAt)).toBe('2026-03-20');
    // A one-off must never become the shop's standing preference.
    expect(shop.billing.cycleAlignment).toBeUndefined();
  });
});

describe('alignment never takes back paid time', () => {
  /**
   * The invariant holds structurally, not by a runtime check: the anchor is
   * `max(currentExpiresAt, from)`, months are whole and at least one, and day 1
   * of any month is later than every day of the month before it. So an aligned
   * date always lands in a strictly later month than the anchor.
   *
   * This sweeps the awkward shapes — every billing day against expiries at the
   * start, middle and end of months with 28, 30 and 31 days — so that a future
   * change to the anchor rule fails here rather than silently shortening
   * somebody's subscription.
   */
  it('advances past the current expiry for every day-of-month and every anchor', () => {
    const expiries = [
      '2026-01-01', '2026-01-15', '2026-01-31',
      '2026-02-01', '2026-02-28',
      '2026-04-01', '2026-04-30',
      '2026-11-30', '2026-12-31',
      '2028-02-29',
    ];

    for (const iso of expiries) {
      for (let day = 1; day <= 31; day += 1) {
        for (const months of [1, 3, 6, 12]) {
          const current = on(iso);
          const result = billingService.computeExpiry({
            currentExpiresAt: current,
            mode: 'months',
            value: months,
            now: new Date('2026-01-01T00:00:00.000Z'),
            billingDay: day,
          });
          expect(result.expiresAt.getTime()).toBeGreaterThan(current.getTime());
        }
      }
    }
  });

  it('still advances when the shop has already lapsed', () => {
    const current = on('2026-01-05');
    const result = billingService.computeExpiry({
      currentExpiresAt: current,
      mode: 'months',
      value: 1,
      now: new Date('2026-03-20T06:00:00.000Z'),
      billingDay: 5,
    });
    expect(result.expiresAt.getTime()).toBeGreaterThan(current.getTime());
    expect(dayOf(result.expiresAt)).toBe('2026-04-05');
  });
});

describe('the transition period', () => {
  /**
   * Aligning a shop that is NOT yet on its billing day can hand it fewer days
   * than a plain calendar month. This is real, it is one-time, and the point of
   * the tests below is that it is reported rather than hidden.
   */
  it('lands on the billing day and reports the period as shortened', async () => {
    shop.subscription.expiresAt = on('2026-03-20');
    shop.billing.billingDay = 5;

    const preview = await billingService.previewExtension('shop1', { mode: 'months', value: 1 });
    expect(preview.expiresOn).toBe('2026-04-05');
    expect(preview.naiveExpiresOn).toBe('2026-04-20');
    expect(preview.shortened).toBe(true);
  });

  it('is over after one renewal — the next one is a clean month', async () => {
    shop.subscription.expiresAt = on('2026-03-20');
    shop.billing.billingDay = 5;

    await renew();
    expect(dayOf(shop.subscription.expiresAt)).toBe('2026-04-05');

    await renew();
    expect(dayOf(shop.subscription.expiresAt)).toBe('2026-05-05');
  });
});

// ── how the day gets set ────────────────────────────────────────────────────

describe('stamping the billing day', () => {
  it('stamps on the first paid month-mode extension', async () => {
    shop.subscription.expiresAt = on('2026-09-30');
    await pay();
    // September ends on the 30th, so that is the day this shop renews on.
    expect(shop.billing.billingDay).toBe(30);
    expect(shop.billing.billingDaySetAt).toBeInstanceOf(Date);
  });

  it('never overwrites a day that is already set', async () => {
    shop.subscription.expiresAt = on('2026-09-30');
    shop.billing.billingDay = 5;
    await pay();
    expect(shop.billing.billingDay).toBe(5);
  });

  it('does not stamp on a free extension', async () => {
    await renew();
    expect(shop.billing.billingDay).toBeNull();
  });

  it('does not stamp on days mode', async () => {
    await pay({ mode: 'days', value: 30 });
    expect(shop.billing.billingDay).toBeNull();
  });

  it('does not stamp on until mode', async () => {
    await pay({ mode: 'until', value: '2026-12-15' });
    expect(shop.billing.billingDay).toBeNull();
  });

  it('does not stamp a trial', async () => {
    shop.subscription.plan = 'trial';
    await billingService.startTrial(ADMIN, 'shop1', { days: 14, force: true });
    expect(shop.billing.billingDay).toBeNull();
  });
});

describe('explicit dates always win over the anchor', () => {
  it('until mode ignores the billing day entirely', async () => {
    shop.subscription.expiresAt = on('2026-09-30');
    shop.billing.billingDay = 5;
    await renew({ mode: 'until', value: '2026-12-15', reason: 'agreed end date' });
    expect(dayOf(shop.subscription.expiresAt)).toBe('2026-12-15');
  });

  it('days mode ignores the billing day entirely', async () => {
    shop.subscription.expiresAt = on('2026-09-30');
    shop.billing.billingDay = 5;
    await renew({ mode: 'days', value: 10, reason: 'ten days' });
    expect(dayOf(shop.subscription.expiresAt)).toBe('2026-10-10');
  });
});

describe('the admin billing profile form', () => {
  it('stores a billing day and files it as its own event', async () => {
    await billingService.updateBillingProfile(ADMIN, 'shop1', {
      billingDay: 5, reason: 'owner asked to be billed on the 5th',
    });
    expect(shop.billing.billingDay).toBe(5);
    expect(shop.billing.billingDaySetAt).toBeInstanceOf(Date);
    expect(lastEvent().type).toBe('billing_day_changed');
  });

  it('files under price_changed when the money moved too', async () => {
    // The price is what an operator scans the timeline for; burying a price
    // change under a date change is how "why is this shop on ৳800?" stops
    // being answerable.
    await billingService.updateBillingProfile(ADMIN, 'shop1', {
      billingDay: 5, monthlyPrice: 700, reason: 'new deal',
    });
    expect(lastEvent().type).toBe('price_changed');
  });

  it('clears the day on an explicit null, putting the shop back on plain months', async () => {
    shop.billing.billingDay = 12;
    await billingService.updateBillingProfile(ADMIN, 'shop1', { billingDay: null });
    expect(shop.billing.billingDay).toBeNull();
    expect(shop.billing.billingDaySetAt).toBeNull();
  });

  it('leaves the day alone when the key is absent', async () => {
    shop.billing.billingDay = 12;
    await billingService.updateBillingProfile(ADMIN, 'shop1', { monthlyPrice: 900 });
    expect(shop.billing.billingDay).toBe(12);
  });

  it('rejects a day outside the month rather than storing it', async () => {
    await expect(
      billingService.updateBillingProfile(ADMIN, 'shop1', { billingDay: 45 })
    ).rejects.toThrow(/1 and 31/i);
    expect(shop.save).not.toHaveBeenCalled();
  });

  it('rejects an unknown alignment mode', async () => {
    await expect(
      billingService.updateBillingProfile(ADMIN, 'shop1', { cycleAlignment: 'whenever' })
    ).rejects.toThrow(/billing_day or from_anchor/i);
  });

  it('stores the alignment preference', async () => {
    await billingService.updateBillingProfile(ADMIN, 'shop1', { cycleAlignment: 'from_anchor' });
    expect(shop.billing.cycleAlignment).toBe('from_anchor');
  });
});

describe('preview', () => {
  it('writes nothing', async () => {
    await billingService.previewExtension('shop1', { mode: 'months', value: 1 });
    expect(shop.save).not.toHaveBeenCalled();
    expect(SubscriptionEvent.create).not.toHaveBeenCalled();
  });

  it('agrees with what the write actually does', async () => {
    shop.subscription.expiresAt = on('2026-01-31');
    shop.billing.billingDay = 31;

    const preview = await billingService.previewExtension('shop1', { mode: 'months', value: 1 });
    await renew();

    expect(dayOf(shop.subscription.expiresAt)).toBe(preview.expiresOn);
  });

  it('honours a backdated payment the same way the write does', async () => {
    // Money that arrived on the 5th but was keyed in on the 20th: the period
    // must run from when it was received, not from the operator's backlog.
    shop.subscription.expiresAt = on('2026-01-31');
    shop.billing.billingDay = null;
    jest.useFakeTimers().setSystemTime(new Date('2026-02-20T06:00:00.000Z'));

    const preview = await billingService.previewExtension('shop1', {
      mode: 'months', value: 1, backdate: true, receivedAt: '2026-02-05T06:00:00.000Z',
    });
    await pay({ backdate: true, receivedAt: '2026-02-05T06:00:00.000Z' });

    expect(dayOf(shop.subscription.expiresAt)).toBe(preview.expiresOn);
  });

  it('ignores a receivedAt in the future rather than handing out free days', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-02-20T06:00:00.000Z'));
    const preview = await billingService.previewExtension('shop1', {
      mode: 'months', value: 1, backdate: true, receivedAt: '2026-06-01T06:00:00.000Z',
    });
    expect(preview.backdatedTo).toBeNull();
  });
});
