/**
 * The daily Telegram digest, at the two points where a bug is expensive:
 * scheduling (an owner gets no digest, or two contradictory ones) and
 * rendering (a shop name breaks the message, or a figure reads wrong).
 *
 * The aggregation itself is not mocked here — it is proven against real data
 * by matching getDailySummary, which the dashboard already uses.
 */

const { isDue, buildMessage } = require('../jobs/dailyDigest.job');
const {
  escapeHtml,
  formatMoney,
  formatDate,
  formatTime,
} = require('../utils/telegramFormat.util');
const {
  getBangladeshDayRange,
  getBangladeshTodayStr,
  minutesOfDay,
} = require('../utils/bdTime.util');

const at = (h, m = 0) => h * 60 + m;

describe('digest scheduling', () => {
  it('fires at the configured minute', () => {
    expect(isDue('22:00', at(22, 0))).toBe(true);
  });

  it('does not fire before the configured time', () => {
    expect(isDue('22:00', at(21, 59))).toBe(false);
    expect(isDue('22:00', at(9, 0))).toBe(false);
  });

  it('still fires inside the catch-up window after a restart', () => {
    // Process was down at 22:00 and came back at 23:30 — the owner should
    // still get their day rather than nothing at all.
    expect(isDue('22:00', at(23, 30))).toBe(true);
  });

  it('gives up once the window has passed', () => {
    // 01:30 the next day is 3h30m past — a sales report at that hour is noise.
    expect(isDue('22:00', at(1, 30))).toBe(false);
  });

  it('never treats a pre-midnight time as due from the small hours', () => {
    // The window arithmetic must not wrap: 02:00 is "before" 22:00, not after.
    expect(isDue('22:00', at(2, 0))).toBe(false);
  });

  it('honours an early digest time', () => {
    expect(isDue('06:30', at(6, 31))).toBe(true);
    expect(isDue('06:30', at(6, 29))).toBe(false);
  });

  it('falls back to the default hour rather than never sending', () => {
    // A link whose digestTime went missing must not go permanently silent.
    expect(isDue(undefined, at(22, 5))).toBe(true);
    expect(isDue('', at(22, 5))).toBe(true);
  });

  it('rejects a malformed time instead of throwing', () => {
    expect(isDue('25:00', at(23, 0))).toBe(false);
    expect(isDue('nonsense', at(23, 0))).toBe(false);
    expect(minutesOfDay('24:00')).toBeNull();
  });
});

describe('Bangladesh day boundaries', () => {
  it('maps a BD calendar day to the right UTC window', () => {
    const { startOfDay, endOfDay } = getBangladeshDayRange('2026-08-08');
    // BD midnight is 18:00 UTC the previous day (UTC+6).
    expect(startOfDay.toISOString()).toBe('2026-08-07T18:00:00.000Z');
    expect(endOfDay.toISOString()).toBe('2026-08-08T17:59:59.999Z');
  });

  it('produces a today string the day range round-trips', () => {
    const today = getBangladeshTodayStr();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const { startOfDay, endOfDay } = getBangladeshDayRange(today);
    const now = Date.now();
    expect(startOfDay.getTime()).toBeLessThanOrEqual(now);
    expect(endOfDay.getTime()).toBeGreaterThanOrEqual(now);
  });
});

describe('message formatting', () => {
  it('escapes the characters that would break Telegram HTML parsing', () => {
    // An unescaped & or < makes Telegram reject the whole message with a 400,
    // so the shop simply stops receiving digests with no other symptom.
    expect(escapeHtml('M&S <Fashion>')).toBe('M&amp;S &lt;Fashion&gt;');
  });

  it('formats money in Bangladeshi lakh grouping', () => {
    expect(formatMoney(124500)).toBe('৳ 1,24,500');
    expect(formatMoney(12345678)).toBe('৳ 1,23,45,678');
  });

  it('shows both paisa digits or none, never one', () => {
    expect(formatMoney(124500.5)).toBe('৳ 1,24,500.50');
    expect(formatMoney(124500)).toBe('৳ 1,24,500');
  });

  it('renders a loss without mangling the currency symbol', () => {
    expect(formatMoney(-1820)).toBe('-৳ 1,820');
  });

  it('uses Bengali month names with Latin numerals', () => {
    expect(formatDate('2026-08-08')).toBe('8 আগস্ট 2026');
  });

  it('labels the hour with the right Bengali period', () => {
    expect(formatTime('22:00')).toBe('রাত 10:00');
    expect(formatTime('09:30')).toBe('সকাল 9:30');
    expect(formatTime('13:00')).toBe('দুপুর 1:00');
  });
});

describe('digest body', () => {
  const totals = {
    date: '2026-08-08',
    total: { count: 42, revenue: 124500, profit: 18200 },
    byBranch: [
      { name: 'মূল শাখা', count: 28, revenue: 86000, profit: 12400 },
      { name: 'উত্তরা', count: 14, revenue: 38500, profit: 5800 },
    ],
  };

  it('carries the three headline figures', () => {
    const msg = buildMessage({
      shopName: 'রহিম স্টোর',
      totals,
      asOfTime: '22:00',
      multiBranch: false,
    });
    expect(msg).toContain('<b>42</b>');
    expect(msg).toContain('৳ 1,24,500');
    expect(msg).toContain('৳ 18,200');
  });

  it('omits the branch block for a single-branch shop', () => {
    const msg = buildMessage({
      shopName: 'রহিম স্টোর',
      totals,
      asOfTime: '22:00',
      multiBranch: false,
    });
    expect(msg).not.toContain('শাখা অনুযায়ী');
  });

  it('lists every branch for a multi-branch shop', () => {
    const msg = buildMessage({
      shopName: 'রহিম স্টোর',
      totals,
      asOfTime: '22:00',
      multiBranch: true,
    });
    expect(msg).toContain('শাখা অনুযায়ী');
    expect(msg).toContain('মূল শাখা');
    expect(msg).toContain('উত্তরা');
  });

  it('escapes a shop name inside the rendered message', () => {
    const msg = buildMessage({
      shopName: 'M&S <Fashion>',
      totals,
      asOfTime: '22:00',
      multiBranch: false,
    });
    expect(msg).toContain('M&amp;S &lt;Fashion&gt;');
    expect(msg).not.toContain('M&S <Fashion>');
  });

  it('escapes branch names too', () => {
    const msg = buildMessage({
      shopName: 'Shop',
      totals: {
        ...totals,
        byBranch: [
          { name: 'A & B', count: 1, revenue: 1, profit: 1 },
          { name: 'উত্তরা', count: 1, revenue: 1, profit: 1 },
        ],
      },
      asOfTime: '22:00',
      multiBranch: true,
    });
    expect(msg).toContain('A &amp; B');
  });

  it('skips the breakdown when a multi-branch shop has only one branch', () => {
    // The single line would repeat the total verbatim.
    const msg = buildMessage({
      shopName: 'Shop',
      totals: { ...totals, byBranch: [{ name: 'মূল শাখা', count: 42, revenue: 124500, profit: 18200 }] },
      asOfTime: '22:00',
      multiBranch: true,
    });
    expect(msg).not.toContain('শাখা অনুযায়ী');
  });

  it('reports a zero day rather than staying silent', () => {
    const msg = buildMessage({
      shopName: 'রহিম স্টোর',
      totals: { date: '2026-08-08', total: { count: 0, revenue: 0, profit: 0 }, byBranch: [] },
      asOfTime: '22:00',
      multiBranch: false,
    });
    expect(msg).toContain('আজ কোনো বিক্রয় হয়নি');
  });

  it('states the time the figures were taken, not the configured one', () => {
    // On a catch-up send these differ, and an "as of 10 PM" line above 11:30 PM
    // figures would be a lie the owner has no way to detect.
    const msg = buildMessage({
      shopName: 'Shop',
      totals,
      asOfTime: '23:30',
      multiBranch: false,
    });
    expect(msg).toContain('রাত 11:30 পর্যন্ত');
  });
});
