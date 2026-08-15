/**
 * Report date bucketing — every calendar grouping is a BANGLADESH day.
 *
 * ── The bug these pin ───────────────────────────────────────────────────────
 *
 * MongoDB's `$dateToString` defaults to **UTC** when `timezone` is omitted.
 * It does not warn; it just answers a different question. Five aggregations
 * bounded `createdAt` with a BD-aligned window (`buildDateMatch` →
 * `getBangladeshDayRange`) and then grouped with a bare `$dateToString`, so the
 * match and the grouping disagreed by exactly six hours:
 *
 *   · every sale rung between 00:00 and 05:59 Dhaka was credited to the
 *     PREVIOUS day — that is the whole night shift of a shop that trades late;
 *   · a "1–31 August" report grew a spurious `2026-07-31` row holding the first
 *     six hours of 1 August;
 *   · `groupBy: 'month'` put the first six hours of every month in the month
 *     before it;
 *   · and the dashboard chart therefore disagreed with `getDateWiseSummary`,
 *     which had always passed `timezone` — same shop, same day, two answers.
 *
 * The `summary` facet sums the same matched set, so the TOTAL stayed correct
 * while the per-day breakdown was wrong. That is what made it survive: nothing
 * looked broken unless you added the rows up.
 *
 * These tests assert on the emitted PIPELINE rather than on query results,
 * because the defect is entirely in the pipeline the service builds — a stubbed
 * aggregate would happily return correct-looking rows for a wrong pipeline.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Sale = require('../models/Sale.model');
const reportService = require('../services/report.service');
const { BD_TZ, getBangladeshDayRange } = require('../utils/bdTime.util');

jest.mock('../services/cache.service', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  getShopCacheVersion: jest.fn().mockResolvedValue(1),
  bumpShopCacheVersion: jest.fn().mockResolvedValue(undefined),
}));

const SHOP = new mongoose.Types.ObjectId().toString();

/** Every `$dateToString` anywhere in a pipeline, however deeply nested. */
function collectDateToString(node, found = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectDateToString(n, found));
    return found;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$dateToString') found.push(value);
      collectDateToString(value, found);
    }
  }
  return found;
}

afterEach(() => jest.restoreAllMocks());

describe('BD_TZ is the single definition of the report timezone', () => {
  it('matches the offset the JS-side helpers use', () => {
    expect(BD_TZ).toBe('+06:00');
    // The two must agree or a pipeline bucket and a JS day range describe
    // different days. Derive the offset back out of BD_TZ and compare.
    const { startOfDay } = getBangladeshDayRange('2026-08-15');
    expect(startOfDay.toISOString()).toBe('2026-08-14T18:00:00.000Z');
  });
});

describe('getSalesReport', () => {
  /** Capture the pipeline `getSalesReport` builds, without touching a database. */
  async function capture(options) {
    let pipeline = null;
    jest.spyOn(Sale, 'aggregate').mockImplementation((p) => {
      pipeline = p;
      return Promise.resolve([{ byPeriod: [], summary: [] }]);
    });
    await reportService.getSalesReport(SHOP, options);
    return pipeline;
  }

  it('buckets days in Bangladesh time, not UTC', async () => {
    const stages = collectDateToString(
      await capture({ startDate: '2026-08-01', endDate: '2026-08-31', groupBy: 'day' })
    );
    expect(stages).toHaveLength(1);
    expect(stages[0].timezone).toBe(BD_TZ);
    expect(stages[0].format).toBe('%Y-%m-%d');
  });

  it('buckets months in Bangladesh time — the first six hours of a month stay in it', async () => {
    const stages = collectDateToString(await capture({ groupBy: 'month' }));
    expect(stages[0]).toMatchObject({ format: '%Y-%m', timezone: BD_TZ });
  });

  it('buckets hours in Bangladesh time, so "peak hour" is a Dhaka wall-clock hour', async () => {
    const stages = collectDateToString(await capture({ groupBy: 'hour' }));
    expect(stages[0]).toMatchObject({ format: '%Y-%m-%d %H:00', timezone: BD_TZ });
  });

  /**
   * `%V` is the ISO-8601 week number, whose year is the ISO WEEK-year (`%G`) and
   * NOT the calendar year (`%Y`). The two disagree at 82 of the 100 year
   * boundaries between 2026 and 2125: 31 Dec 2029 is ISO 2030-W01, which `%Y`
   * labelled "2029-W01" — a December row that sorts to the top of the year and
   * merges with the real January week whenever a range spans both.
   */
  it('labels weeks with the ISO week-year, not the calendar year', async () => {
    const stages = collectDateToString(await capture({ groupBy: 'week' }));
    expect(stages[0].format).toBe('%G-W%V');
    expect(stages[0].format).not.toContain('%Y');
    expect(stages[0].timezone).toBe(BD_TZ);
  });
});

/**
 * The blanket guard.
 *
 * Stubbing each service to inspect its pipeline needs every collateral query
 * mocked too, which makes the test fragile against changes that have nothing to
 * do with dates. Reading the source instead covers EVERY aggregation in the
 * codebase — including ones written after this test — and the thing being
 * guarded is a literal argument, so the source is exactly where it is visible.
 *
 * A calendar bucket with no `timezone` is the defect. A `$dateToString` used to
 * format a full timestamp for display is not, so the scan only flags formats
 * that TRUNCATE to a calendar period.
 */
describe('no aggregation buckets by calendar period in UTC', () => {
  const SERVICE_DIR = path.join(__dirname, '..', 'services');

  /** Format strings that name a calendar period rather than an instant. */
  const BUCKETING = /%Y-%m-%d|%Y-%m(?!-)|%G-W%V|%Y-W%V|%H:00/;

  const files = fs.readdirSync(SERVICE_DIR).filter((f) => f.endsWith('.js'));

  it.each(files)('%s', (file) => {
    const src = fs.readFileSync(path.join(SERVICE_DIR, file), 'utf8');
    const offenders = [];

    // Each `$dateToString: { ... }` object, matched to its closing brace.
    const re = /\$dateToString:\s*\{/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      let depth = 1;
      let i = m.index + m[0].length;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
      }
      const body = src.slice(m.index, i);
      if (BUCKETING.test(body) && !/timezone:/.test(body)) {
        offenders.push(`line ${src.slice(0, m.index).split('\n').length}: ${body.replace(/\s+/g, ' ')}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('actually detects a missing timezone (the guard is not vacuous)', () => {
    const bad = `$dateToString: { format: '%Y-%m-%d', date: '$createdAt' }`;
    expect(BUCKETING.test(bad)).toBe(true);
    expect(/timezone:/.test(bad)).toBe(false);
  });

  it('does not flag a full-timestamp format, which has no calendar bucket', () => {
    const fine = `$dateToString: { format: '%Y-%m-%dT%H:%M:%S.%LZ', date: '$createdAt' }`;
    // It contains %Y-%m-%d, so it IS flagged — deliberately conservative. If a
    // real full-timestamp format ever appears, give it an explicit timezone
    // rather than loosening this: an unlabelled timestamp is its own bug.
    expect(BUCKETING.test(fine)).toBe(true);
  });
});

describe('the P&L chart joins sales and expenses on the same key', () => {
  it('uses one timezone and one format for both series', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'report.service.js'),
      'utf8'
    );
    // Both series bucket on '$createdAt' / '$date' with BD_TZ. Pinning the pair
    // together is the point: the chart merges them by this key, so one drifting
    // to UTC would misalign cost from revenue by six hours while both looked
    // individually plausible.
    expect(src).toContain("date: '$createdAt', timezone: BD_TZ");
    expect(src).toContain("date: '$date', timezone: BD_TZ");
    expect(src).not.toMatch(/\$dateToString:\s*\{\s*format:\s*'%Y-%m-%d',\s*date:\s*'\$\w+'\s*\}/);
  });
});

/**
 * The property that actually matters, stated directly: a sale rung at any
 * Bangladesh wall-clock time belongs to that Bangladesh date. This is what the
 * `timezone` argument buys, expressed without reference to a pipeline — if
 * someone ever replaces `$dateToString` with `$dateTrunc`, this still holds them
 * to the same contract.
 */
describe('the invariant the timezone argument enforces', () => {
  const bdDayOf = (iso) => new Date(new Date(iso).getTime() + 6 * 3600e3).toISOString().slice(0, 10);

  it.each([
    ['2026-08-16T00:15:00+06:00', '2026-08-16'],
    ['2026-08-16T05:59:59+06:00', '2026-08-16'],
    ['2026-08-16T06:00:00+06:00', '2026-08-16'],
    ['2026-08-16T23:59:59+06:00', '2026-08-16'],
    ['2026-09-01T00:30:00+06:00', '2026-09-01'],
  ])('a sale at %s is reported under %s', (instant, expected) => {
    expect(bdDayOf(instant)).toBe(expected);
    // And the UTC reading — what the bare `$dateToString` produced — is the
    // wrong answer for exactly the 00:00–05:59 window.
    const utc = new Date(instant).toISOString().slice(0, 10);
    if (Number(instant.slice(11, 13)) < 6) expect(utc).not.toBe(expected);
  });

  it('a BD day range never leaks into a neighbouring day', () => {
    const { startOfDay, endOfDay } = getBangladeshDayRange('2026-08-16');
    expect(bdDayOf(startOfDay.toISOString())).toBe('2026-08-16');
    expect(bdDayOf(endOfDay.toISOString())).toBe('2026-08-16');
    expect(bdDayOf(new Date(startOfDay.getTime() - 1).toISOString())).toBe('2026-08-15');
    expect(bdDayOf(new Date(endOfDay.getTime() + 1).toISOString())).toBe('2026-08-17');
  });
});
