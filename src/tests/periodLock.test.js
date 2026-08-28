/**
 * খাতা বন্ধ — the period lock.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * Backdating is permission-gated and honest — a sale backdated to Thursday IS a
 * Thursday sale, everywhere — but it was UNBOUNDED. Anyone holding
 * `sales.backdate` or `customers.backdate` could post into any prior month or
 * year, and `saleDate.util`'s own header names the consequence: "you read it on
 * Friday; after a Saturday backdate it is ৳45,000." The owner has no way to
 * notice, because the report simply reads differently next time.
 *
 * ── What these tests pin ────────────────────────────────────────────────────
 *
 *   A. INERT UNTIL DRAWN — `null` is the default and every dated write passes.
 *      That is every shop on the platform until an owner chooses otherwise.
 *   B. THE BOUNDARY — closing "31 July" closes ALL of 31 July. Off by six
 *      hours here and half a closed day silently stays open.
 *   C. TODAY IS NEVER BLOCKED — the lock stops the past being rewritten and
 *      must never stop the till taking money.
 *   D. NO OVERRIDE — not even for the owner. A lock its holder can step over on
 *      the spot is a reminder, not a lock; the way past is to move the line.
 *   E. WIRED IN — the sale and collection date gates both consult it, in the
 *      right order relative to their own rules.
 */

const { closedThrough, assertPeriodOpen } = require('../utils/periodLock.util');
const { resolveSaleDate } = require('../utils/saleDate.util');
const { resolvePaidAt } = require('../utils/paymentDate.util');
const { getBangladeshDayRange, getBangladeshTodayStr } = require('../utils/bdTime.util');

/** A shop with the books closed through the given YYYY-MM-DD (or not at all). */
const shop = (through = null) => ({
  createdAt: new Date('2020-01-01'),
  settings: through ? { booksClosedThrough: getBangladeshDayRange(through).endOfDay } : {},
});

/** Someone who may backdate — the gates' own rules are not what is under test. */
const backdater = () => ({
  user: {
    isOwner: false,
    permissions: { sales: { backdate: true }, customers: { backdate: true } },
  },
});

const owner = () => ({ user: { isOwner: true, permissions: {} } });

/** Noon Bangladesh time on a date — where `resolveSaleDate` puts a bare date. */
const noonBD = (dateStr) =>
  new Date(getBangladeshDayRange(dateStr).startOfDay.getTime() + 12 * 3600 * 1000);

// ── A. Inert until drawn ────────────────────────────────────────────────────

describe('A · a shop that has drawn no line notices nothing', () => {
  it.each([
    ['unset', undefined],
    ['null', null],
    ['empty string', ''],
    ['an unparseable value', 'not-a-date'],
  ])('treats %s as nothing closed', (_label, through) => {
    // The unparseable case is deliberate. A malformed lock that refused every
    // write would take a shop's till offline with nothing they could
    // self-diagnose — a worse failure than the one being prevented.
    const s = { settings: { booksClosedThrough: through } };
    expect(closedThrough(s)).toBeNull();
    expect(() =>
      assertPeriodOpen({ when: new Date('2019-01-01'), shop: s })
    ).not.toThrow();
  });

  it('passes an undated write', () => {
    // An undated write is today's by definition. Rule 1 exists so no caller has
    // to special-case "the user did not name a date".
    expect(() => assertPeriodOpen({ when: null, shop: shop('2026-07-31') })).not.toThrow();
  });
});

// ── B. The boundary ─────────────────────────────────────────────────────────

describe('B · closing a day closes all of it', () => {
  it('refuses noon on the closed day itself', () => {
    // THE OFF-BY-SIX-HOURS TRAP. A bare `YYYY-MM-DD` is stored at NOON
    // Bangladesh time by `resolveSaleDate`. Comparing against the stored
    // instant rather than the end of the BD day would let every afternoon of
    // the closed day through, and half of July 31 would quietly stay open.
    expect(() =>
      assertPeriodOpen({ when: noonBD('2026-07-31'), shop: shop('2026-07-31') })
    ).toThrow(/closed through 2026-07-31/);
  });

  it('refuses the last millisecond of the closed day', () => {
    const end = getBangladeshDayRange('2026-07-31').endOfDay;
    expect(() => assertPeriodOpen({ when: end, shop: shop('2026-07-31') })).toThrow();
  });

  it('allows the first moment of the next day', () => {
    const start = getBangladeshDayRange('2026-08-01').startOfDay;
    expect(() => assertPeriodOpen({ when: start, shop: shop('2026-07-31') })).not.toThrow();
  });

  it('refuses anything earlier still', () => {
    expect(() =>
      assertPeriodOpen({ when: noonBD('2026-03-15'), shop: shop('2026-07-31') })
    ).toThrow();
  });

  it('names the date in the refusal, in both languages', () => {
    // "The books are closed" is unactionable. The owner needs to know WHICH
    // date, because the fix is to move that line in settings.
    let err;
    try {
      assertPeriodOpen({ when: noonBD('2026-07-01'), shop: shop('2026-07-31'), labelBn: 'বিক্রয়' });
    } catch (e) { err = e; }

    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('2026-07-31');
    expect(err.messageBn).toContain('2026-07-31');
    expect(err.messageBn).toContain('বিক্রয়');
  });
});

// ── C/D. Today, and the absence of an override ──────────────────────────────

describe('C · the till never stops', () => {
  it('allows today even with a lock in place', () => {
    expect(() =>
      assertPeriodOpen({ when: new Date(), shop: shop('2026-07-31') })
    ).not.toThrow();
  });

  it('lets a collection dated today through before the lock is ever consulted', () => {
    // `resolvePaidAt` returns at rule 2 for a bare date equal to today, so the
    // lock is not even reached. Asserted through the real gate rather than the
    // util, because the ORDER of those rules is the thing that guarantees a
    // closed book can never refuse today's takings.
    const today = getBangladeshTodayStr();
    expect(() =>
      resolvePaidAt({ raw: today, req: { ...backdater(), shop: shop(today) }, shop: shop(today) })
    ).not.toThrow();
  });
});

describe('D · there is no way over the line, only a way to move it', () => {
  it('refuses the owner exactly as it refuses a cashier', () => {
    // A lock its holder can step over on the spot is a reminder. The sanctioned
    // route is a settings change — owner-only, audited, and visible afterwards.
    expect(() =>
      resolveSaleDate({ raw: '2026-07-15', req: owner(), shop: shop('2026-07-31') })
    ).toThrow(/closed through/);
  });
});

// ── E. Wired into both date gates ───────────────────────────────────────────

describe('E · the dated-write gates consult it', () => {
  it('blocks a backdated sale inside a closed period', () => {
    let err;
    try {
      resolveSaleDate({ raw: '2026-07-15', req: backdater(), shop: shop('2026-07-31') });
    } catch (e) { err = e; }

    expect(err.statusCode).toBe(400);
    expect(err.messageBn).toContain('বিক্রয়');
  });

  it('allows a backdated sale after the line', () => {
    const when = resolveSaleDate({ raw: '2026-08-05', req: backdater(), shop: shop('2026-07-31') });
    expect(when).toBeInstanceOf(Date);
  });

  it('blocks a backdated collection inside a closed period', () => {
    let err;
    try {
      resolvePaidAt({
        raw: '2026-07-15',
        req: { ...backdater(), shop: shop('2026-07-31') },
        shop: shop('2026-07-31'),
      });
    } catch (e) { err = e; }

    expect(err.statusCode).toBe(400);
    expect(err.messageBn).toContain('আদায়');
  });

  it('checks permission BEFORE the lock', () => {
    // Someone with no backdate permission must be told they cannot backdate —
    // not that the books are closed. Leaking the lock's existence to a cashier
    // who could never have written there anyway sends them to the owner with
    // the wrong question.
    const cashier = { user: { isOwner: false, permissions: { sales: { backdate: false } } } };
    let err;
    try {
      resolveSaleDate({ raw: '2026-07-15', req: cashier, shop: shop('2026-07-31') });
    } catch (e) { err = e; }

    expect(err.statusCode).toBe(403);
  });
});
