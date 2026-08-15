/**
 * Landing page expiry — `landingPageState.util`.
 *
 * Two things are pinned here and both are money:
 *
 *   I-14 — expiry stops NEW orders and nothing else. The resolver deliberately
 *          has no "can the shop see its orders" output, because the answer is
 *          always yes; a test that the resolver cannot express it is the closest
 *          thing to a guarantee available at this layer.
 *   The boundary — `expiresAt` is the END of a Bangladesh day. An order at 23:59
 *          BST on the last day is inside the window; one at 00:01 is not. Get
 *          this wrong by a few hours and a trader loses their busiest evening.
 */

const {
  STATES,
  WARNING_DAYS,
  resolveLandingPage,
  describeLandingState,
  buildLandingNotice,
} = require('../utils/landingPageState.util');
const { endOfBangladeshDay } = require('../utils/bdTime.util');

/** A live page expiring at the end of 2026-08-31 Bangladesh time. */
const page = (over = {}) => ({
  status: 'live',
  startsAt: null,
  expiresAt: endOfBangladeshDay('2026-08-31'),
  graceDays: 0,
  pausedByAdmin: null,
  ...over,
});

const at = (iso) => new Date(iso);

describe('the states that ignore the calendar', () => {
  test('a draft never serves, whatever its dates say', () => {
    const r = resolveLandingPage(page({ status: 'draft' }), at('2026-08-01T00:00:00Z'));
    expect(r.state).toBe(STATES.DRAFT);
    expect(r.canAcceptOrders).toBe(false);
    expect(r.isServable).toBe(false);
  });

  test('a shop-paused page stops taking orders but stays editable', () => {
    const r = resolveLandingPage(page({ status: 'paused' }), at('2026-08-01T00:00:00Z'));
    expect(r.state).toBe(STATES.PAUSED);
    expect(r.canAcceptOrders).toBe(false);
    expect(r.canEdit).toBe(true);
  });

  test('REGRESSION: an admin block beats perfectly valid dates', () => {
    // Checked before the calendar on purpose. A page taken down for abuse must
    // not come back because its expiry happens to be next month.
    const r = resolveLandingPage(
      page({ pausedByAdmin: 'admin-1', pauseReason: 'ভুয়া পণ্য' }),
      at('2026-08-01T00:00:00Z')
    );
    expect(r.state).toBe(STATES.BLOCKED);
    expect(r.canAcceptOrders).toBe(false);
    expect(r.reason).toBe('ভুয়া পণ্য');
  });

  test('an admin block also beats a paused status', () => {
    const r = resolveLandingPage(page({ status: 'paused', pausedByAdmin: 'a' }), at('2026-08-01T00:00:00Z'));
    expect(r.state).toBe(STATES.BLOCKED);
  });

  test('a scheduled page does not serve before its start', () => {
    const p = page({ startsAt: at('2026-08-10T00:00:00Z') });
    expect(resolveLandingPage(p, at('2026-08-09T00:00:00Z')).state).toBe(STATES.SCHEDULED);
    expect(resolveLandingPage(p, at('2026-08-11T00:00:00Z')).state).toBe(STATES.ACTIVE);
  });

  test('no page at all resolves to draft rather than throwing', () => {
    const r = resolveLandingPage(null);
    expect(r.state).toBe(STATES.DRAFT);
    expect(r.canAcceptOrders).toBe(false);
  });
});

describe('the expiry boundary — Bangladesh days', () => {
  test('REGRESSION: an order at 23:59 BST on the last day is accepted', () => {
    // 2026-08-31 23:59 Dhaka is 17:59 UTC.
    const r = resolveLandingPage(page(), at('2026-08-31T17:59:00Z'));
    expect(r.canAcceptOrders).toBe(true);
  });

  test('REGRESSION: an order at 00:01 BST the next day is refused', () => {
    // 2026-09-01 00:01 Dhaka is 2026-08-31 18:01 UTC.
    const r = resolveLandingPage(page(), at('2026-08-31T18:01:00Z'));
    expect(r.state).toBe(STATES.EXPIRED);
    expect(r.canAcceptOrders).toBe(false);
  });

  test('the expiry date is reported as a Bangladesh calendar day', () => {
    expect(resolveLandingPage(page(), at('2026-08-01T00:00:00Z')).expiresOn).toBe('2026-08-31');
  });
});

describe('warning and grace', () => {
  test('the warning window is seven days, not the subscription\'s three', () => {
    // A trader has ad spend committed and needs time to decide; 72 hours is not
    // that. This is a deliberate divergence from subscriptionState.util.
    expect(WARNING_DAYS).toBe(7);
  });

  test('inside the window the page still sells, loudly', () => {
    const r = resolveLandingPage(page(), at('2026-08-27T06:00:00Z'));
    expect(r.state).toBe(STATES.EXPIRING);
    expect(r.canAcceptOrders).toBe(true);
    expect(r.severity).toBe('warning');
  });

  test('the last day and the day before are critical, not a heads-up', () => {
    const dayBefore = resolveLandingPage(page(), at('2026-08-30T06:00:00Z'));
    expect(dayBefore.severity).toBe('critical');

    const lastDay = resolveLandingPage(page(), at('2026-08-31T06:00:00Z'));
    expect(lastDay.state).toBe(STATES.EXPIRING);
    expect(lastDay.severity).toBe('critical');
    expect(lastDay.canAcceptOrders).toBe(true);
  });

  test('comfortably inside the window is quiet', () => {
    const r = resolveLandingPage(page(), at('2026-08-01T06:00:00Z'));
    expect(r.state).toBe(STATES.ACTIVE);
    expect(r.severity).toBe('none');
  });

  test('granted grace keeps the page selling past its expiry', () => {
    const r = resolveLandingPage(page({ graceDays: 3 }), at('2026-09-01T06:00:00Z'));
    expect(r.state).toBe(STATES.GRACE);
    expect(r.canAcceptOrders).toBe(true);
    expect(r.graceEndsAt).toBeInstanceOf(Date);
  });

  test('past the grace it is expired like any other', () => {
    const r = resolveLandingPage(page({ graceDays: 3 }), at('2026-09-06T06:00:00Z'));
    expect(r.state).toBe(STATES.EXPIRED);
    expect(r.canAcceptOrders).toBe(false);
  });

  test('grace defaults to zero, so most pages expire exactly on the date', () => {
    const r = resolveLandingPage(page(), at('2026-09-01T06:00:00Z'));
    expect(r.state).toBe(STATES.EXPIRED);
  });
});

describe('I-14 — expiry darkens the page, never the orders', () => {
  test('an expired page still SERVES, as the closed notice', () => {
    // Not a 404. The advertisement may still be running, and a dead link is
    // worse than an honest "this offer has ended" with a phone number.
    const r = resolveLandingPage(page(), at('2026-09-05T06:00:00Z'));
    expect(r.state).toBe(STATES.EXPIRED);
    expect(r.isServable).toBe(true);
    expect(r.canAcceptOrders).toBe(false);
  });

  test('the resolver has no say over order access at all', () => {
    // The guarantee is structural: there is no output here that could ever be
    // read as "hide this shop's orders". If a key like `canSeeOrders` ever
    // appears, I-14 has been reopened.
    const r = resolveLandingPage(page(), at('2026-09-05T06:00:00Z'));
    const keys = Object.keys(r);
    expect(keys).not.toContain('canSeeOrders');
    expect(keys).not.toContain('canManageOrders');
    expect(keys.filter((k) => /order/i.test(k))).toEqual(['canAcceptOrders']);
  });

  test('an expired page is not editable, so next season\'s content survives', () => {
    expect(resolveLandingPage(page(), at('2026-09-05T06:00:00Z')).canEdit).toBe(false);
  });

  test('a page with no expiry date never expires', () => {
    // Reached only by a hand-written document or a migration. Treating it as
    // "never expires" rather than "expired" is what stops a bad migration
    // taking live pages down — the same choice Shop.subscription makes.
    const r = resolveLandingPage(page({ expiresAt: null }), at('2030-01-01T00:00:00Z'));
    expect(r.state).toBe(STATES.ACTIVE);
    expect(r.canAcceptOrders).toBe(true);
  });
});

describe('the copy the shop reads', () => {
  test('day counts are in Bengali numerals', () => {
    const r = resolveLandingPage(page(), at('2026-08-27T06:00:00Z'));
    const copy = describeLandingState(r);
    expect(copy.title).toMatch(/[০-৯]/);
    expect(copy.title).not.toMatch(/[0-9]/);
  });

  test('an expired page says the orders are still workable', () => {
    const copy = describeLandingState(resolveLandingPage(page(), at('2026-09-05T06:00:00Z')));
    expect(copy.detail).toContain('আগের অর্ডার');
  });

  test('a healthy page produces no banner at all', () => {
    expect(buildLandingNotice(page(), at('2026-08-01T06:00:00Z'))).toBeNull();
  });

  test('an expiring page produces one the frontend can render on truthiness', () => {
    const notice = buildLandingNotice(page(), at('2026-08-27T06:00:00Z'));
    expect(notice).toMatchObject({ state: STATES.EXPIRING, severity: 'warning' });
    expect(notice.title).toBeTruthy();
    expect(notice.detail).toBeTruthy();
  });

  test('a blocked page explains itself with the admin\'s reason', () => {
    const notice = buildLandingNotice(page({ pausedByAdmin: 'a', pauseReason: 'যাচাই চলছে' }), at('2026-08-01T00:00:00Z'));
    expect(notice.detail).toContain('যাচাই চলছে');
  });
});
