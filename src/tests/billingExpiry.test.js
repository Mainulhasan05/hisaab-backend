/**
 * Expiry arithmetic — where an extension lands.
 *
 * This is the part of billing a shop notices to the day, so the two rules it
 * turns on are pinned here:
 *
 *   pay early → extend from the EXPIRY (the shop keeps the days it paid for)
 *   pay late  → extend from TODAY     (no backdated credit for days not used)
 *
 * Plus the two refusals that stop an operator from doing real damage with one
 * keystroke: extending a never-expiring shop (which would CREATE an expiry),
 * and a fat-fingered "3000 months".
 */

const billingService = require('../services/billing.service');
const { addBangladeshMonths } = require('../services/billing.service');
const { endOfBangladeshDay, toBangladeshDateStr } = require('../utils/bdTime.util');

const NOW = new Date('2026-08-28T10:00:00.000Z'); // 16:00 Dhaka
const on = (dateStr) => endOfBangladeshDay(dateStr);
const dayOf = (d) => toBangladeshDateStr(d);

describe('the anchor rule', () => {
  it('extends from the expiry when the shop pays early', () => {
    const { expiresAt } = billingService.computeExpiry({
      currentExpiresAt: on('2026-09-10'),
      mode: 'days',
      value: 30,
      now: NOW,
    });
    // 10 Sep + 30 days, NOT 28 Aug + 30 days: the 13 unused days survive.
    expect(dayOf(expiresAt)).toBe('2026-10-10');
  });

  it('extends from today when the shop is already expired', () => {
    const { expiresAt } = billingService.computeExpiry({
      currentExpiresAt: on('2026-07-01'),
      mode: 'days',
      value: 30,
      now: NOW,
    });
    // No backdated credit for the eight weeks they did not use.
    expect(dayOf(expiresAt)).toBe('2026-09-27');
  });

  it('lands on the END of the target Bangladesh day', () => {
    const { expiresAt } = billingService.computeExpiry({
      currentExpiresAt: on('2026-09-10'),
      mode: 'until',
      value: '2026-12-31',
      now: NOW,
    });
    // 23:59:59.999 Dhaka = 17:59:59.999 UTC. Storing UTC midnight instead took
    // shops read-only at 6am on the last day they had paid for.
    expect(expiresAt.toISOString()).toBe('2026-12-31T17:59:59.999Z');
  });
});

describe('months are calendar months', () => {
  it('clamps a month-end date instead of spilling into the next month', () => {
    // 31 Jan + 1 month = 28 Feb, not 3 March. A month of subscription must not
    // quietly become a month and two days.
    expect(dayOf(addBangladeshMonths(on('2027-01-31'), 1))).toBe('2027-02-28');
    expect(dayOf(addBangladeshMonths(on('2028-01-31'), 1))).toBe('2028-02-29');
  });

  it('rolls the year over', () => {
    expect(dayOf(addBangladeshMonths(on('2026-11-15'), 3))).toBe('2027-02-15');
  });

  it('reports the days granted so a free extension can be audited', () => {
    const { days } = billingService.computeExpiry({
      currentExpiresAt: on('2026-08-31'),
      mode: 'months',
      value: 1,
      now: NOW,
    });
    expect(days).toBe(30); // 31 Aug → 30 Sep
  });
});

describe('refusals', () => {
  it('will not extend a shop that has no expiry date', () => {
    // Adding days to "never expires" would CREATE an expiry — a downgrade
    // wearing a renewal's clothes.
    expect(() =>
      billingService.computeExpiry({ currentExpiresAt: null, mode: 'days', value: 30, now: NOW })
    ).toThrow(/no expiry date/i);
  });

  it('still allows an explicit end date to be set on such a shop', () => {
    const { expiresAt } = billingService.computeExpiry({
      currentExpiresAt: null,
      mode: 'until',
      value: '2027-01-31',
      now: NOW,
    });
    expect(dayOf(expiresAt)).toBe('2027-01-31');
  });

  it('rejects absurd amounts rather than granting 250 free years', () => {
    expect(() =>
      billingService.computeExpiry({ currentExpiresAt: on('2026-09-01'), mode: 'months', value: 3000, now: NOW })
    ).toThrow(/more than 120 months/i);
    expect(() =>
      billingService.computeExpiry({ currentExpiresAt: on('2026-09-01'), mode: 'days', value: 99999, now: NOW })
    ).toThrow(/more than 3650 days/i);
  });

  it('rejects a zero or negative amount', () => {
    expect(() =>
      billingService.computeExpiry({ currentExpiresAt: on('2026-09-01'), mode: 'days', value: 0, now: NOW })
    ).toThrow(/positive number/i);
  });

  it('rejects an unknown mode instead of guessing', () => {
    expect(() =>
      billingService.computeExpiry({ currentExpiresAt: on('2026-09-01'), mode: 'forever', value: 1, now: NOW })
    ).toThrow(/Unknown extension mode/i);
  });

  it('reports a backwards correction as negative days', () => {
    // Legal as a correction; the service demands a reason for it.
    const { days } = billingService.computeExpiry({
      currentExpiresAt: on('2026-12-31'),
      mode: 'until',
      value: '2026-09-30',
      now: NOW,
    });
    expect(days).toBeLessThan(0);
  });
});
