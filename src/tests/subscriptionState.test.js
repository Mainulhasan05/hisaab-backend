/**
 * The subscription resolver — the contract every other file leans on.
 *
 * These are the rules that decide whether a shop can trade, so each one is
 * pinned here rather than trusted to the call sites:
 *
 *   · no expiry date means NEVER expires, not expired  (invariant §8.4)
 *   · expiry degrades to read-only, it never locks out (invariant §8.5)
 *   · a block beats everything, and only a stored block produces one
 *   · days are Bangladesh CALENDAR days, not 24h blocks
 *
 * The calendar-day one is the subtle one: with timestamp arithmetic, 11pm
 * tonight → 1am tomorrow reads as "0 days" and an owner is told their shop
 * expires today when it expires tomorrow.
 */

const {
  resolveSubscription,
  buildSubscriptionNotice,
  isBlocked,
  STATES,
} = require('../utils/subscriptionState.util');
const { endOfBangladeshDay } = require('../utils/bdTime.util');

// 2026-08-28, 16:00 in Dhaka (10:00 UTC). Mid-afternoon on a working day, so
// nothing here depends on being near a date boundary by accident.
const NOW = new Date('2026-08-28T10:00:00.000Z');

const shopWith = (subscription = {}, extra = {}) => ({
  _id: 'shop1',
  name: 'Test Shop',
  isActive: true,
  subscription: { plan: 'paid', status: 'active', ...subscription },
  ...extra,
});

const expiringOn = (dateStr) => endOfBangladeshDay(dateStr);

describe('no expiry date means never expires', () => {
  it('resolves to active and allows writes', () => {
    const r = resolveSubscription(shopWith({ expiresAt: null }), NOW);
    expect(r.state).toBe(STATES.ACTIVE);
    expect(r.canWrite).toBe(true);
    expect(r.daysRemaining).toBeNull();
    expect(r.severity).toBe('none');
  });

  it('still says trial when the plan is trial', () => {
    const r = resolveSubscription(shopWith({ plan: 'trial', expiresAt: undefined }), NOW);
    expect(r.state).toBe(STATES.TRIAL);
    expect(r.canWrite).toBe(true);
  });

  it('never denies a request when there is no shop at all', () => {
    const r = resolveSubscription(null, NOW);
    expect(r.canRead).toBe(true);
    expect(r.canWrite).toBe(true);
  });
});

describe('expiry degrades to read-only, never to a lockout', () => {
  it('allows reads and denies writes once the date has passed', () => {
    const r = resolveSubscription(shopWith({ expiresAt: expiringOn('2026-08-27') }), NOW);
    expect(r.state).toBe(STATES.EXPIRED);
    expect(r.canRead).toBe(true);
    expect(r.canWrite).toBe(false);
    expect(r.isBlocked).toBe(false);
  });

  it('is still valid on the LAST day, right up to midnight Dhaka', () => {
    // The bug this pins: an expiry stored as UTC midnight took the shop
    // read-only at 6am Dhaka ON its final paid day.
    const lateOnLastDay = new Date('2026-08-31T17:00:00.000Z'); // 23:00 Dhaka
    const r = resolveSubscription(shopWith({ expiresAt: expiringOn('2026-08-31') }), lateOnLastDay);
    expect(r.canWrite).toBe(true);
    expect(r.daysRemaining).toBe(0);
  });

  it('keeps writing during a granted grace period, then stops', () => {
    const shop = shopWith({ expiresAt: expiringOn('2026-08-26'), graceDays: 3 });
    const inGrace = resolveSubscription(shop, NOW);
    expect(inGrace.state).toBe(STATES.GRACE);
    expect(inGrace.canWrite).toBe(true);

    const afterGrace = resolveSubscription(shop, new Date('2026-08-30T10:00:00.000Z'));
    expect(afterGrace.state).toBe(STATES.EXPIRED);
    expect(afterGrace.canWrite).toBe(false);
  });

  it('defaults to no grace at all, so expiry behaves exactly as before', () => {
    const r = resolveSubscription(shopWith({ expiresAt: expiringOn('2026-08-27') }), NOW);
    expect(r.graceDays).toBe(0);
    expect(r.state).toBe(STATES.EXPIRED);
  });
});

describe('blocking', () => {
  it('beats every other state, including a paid-up subscription', () => {
    const shop = shopWith(
      { expiresAt: expiringOn('2027-01-01') },
      { access: { blockedAt: new Date('2026-08-01'), blockReason: 'payment dispute' } }
    );
    const r = resolveSubscription(shop, NOW);
    expect(r.state).toBe(STATES.BLOCKED);
    expect(r.canRead).toBe(false);
    expect(r.canWrite).toBe(false);
    expect(r.reason).toBe('payment dispute');
  });

  it('reads the two legacy switches as blocks, so old suspensions still apply', () => {
    expect(isBlocked(shopWith({}, { isActive: false }))).toBe(true);
    expect(isBlocked(shopWith({ status: 'suspended' }))).toBe(true);
  });

  it('is never produced by expiry alone — only a stored block blocks', () => {
    const r = resolveSubscription(shopWith({ expiresAt: expiringOn('2020-01-01') }), NOW);
    expect(r.isBlocked).toBe(false);
    expect(r.canRead).toBe(true);
  });
});

describe('the 3-day warning', () => {
  it.each([
    ['2026-08-31', 3, 'warning'],
    ['2026-08-30', 2, 'warning'],
    ['2026-08-29', 1, 'critical'],
    ['2026-08-28', 0, 'critical'],
  ])('expiring on %s = %i days left, severity %s', (date, days, severity) => {
    const r = resolveSubscription(shopWith({ expiresAt: expiringOn(date) }), NOW);
    expect(r.state).toBe(STATES.EXPIRING);
    expect(r.daysRemaining).toBe(days);
    expect(r.severity).toBe(severity);
    expect(r.canWrite).toBe(true);
  });

  it('stays quiet at 4 days out', () => {
    const r = resolveSubscription(shopWith({ expiresAt: expiringOn('2026-09-01') }), NOW);
    expect(r.state).toBe(STATES.ACTIVE);
    expect(r.severity).toBe('none');
  });

  it('counts calendar days, not 24h blocks', () => {
    // 23:30 Dhaka; the expiry is the end of TOMORROW. Timestamp arithmetic
    // would call this 1.02 days and floor it to 1 by luck; a shop expiring
    // 30 minutes after midnight would be reported as expiring "today".
    const lateNight = new Date('2026-08-28T17:30:00.000Z');
    const r = resolveSubscription(shopWith({ expiresAt: expiringOn('2026-08-29') }), lateNight);
    expect(r.daysRemaining).toBe(1);
  });
});

describe('the notice handed to the client', () => {
  it('is null when there is nothing to say', () => {
    expect(buildSubscriptionNotice(shopWith({ expiresAt: expiringOn('2026-12-01') }), NOW)).toBeNull();
  });

  it('carries Bangla copy and the support number', () => {
    const notice = buildSubscriptionNotice(shopWith({ expiresAt: expiringOn('2026-08-30') }), NOW);
    expect(notice.severity).toBe('warning');
    expect(notice.supportPhone).toBe('01757995016');
    expect(notice.title).toContain('২');       // "২ দিন পর শেষ হবে"
    expect(notice.body).toContain('01757995016');
  });

  it('lets an amber warning be dismissed but never a red one', () => {
    const amber = buildSubscriptionNotice(shopWith({ expiresAt: expiringOn('2026-08-30') }), NOW);
    const red = buildSubscriptionNotice(shopWith({ expiresAt: expiringOn('2026-08-20') }), NOW);
    expect(amber.dismissible).toBe(true);
    expect(red.dismissible).toBe(false);
    expect(red.canWrite).toBe(false);
  });
});
