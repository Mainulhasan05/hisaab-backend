/**
 * The digest tick's candidate query (PERFORMANCE_AUDIT.md M-5).
 *
 * The sweep used to fetch EVERY active link on the platform once a minute and
 * filter by send time in memory — `lastDigestSentFor: { $ne }` is not
 * selectively indexable, so the index narrowed only the first two terms.
 *
 * The pre-filter added to fix that is the kind of change that quietly stops
 * delivering to a subset of users, so these tests pin down who must still be
 * reachable:
 *
 *   - links whose digestTime is inside the catch-up window;
 *   - links with NO digestTime at all, which `isDue` serves at the 22:00
 *     default (older documents, from before the field existed);
 *   - and nobody outside the window.
 */

jest.mock('../services/telegram.service', () => ({
  isEnabled: () => true,
  safeSend: jest.fn().mockResolvedValue(true),
  initialize: jest.fn(),
  shutdown: jest.fn(),
}));

// The job destructures these at require time, so it holds direct references to
// the original functions — a `jest.spyOn` on the module object afterwards would
// never be seen. The clock has to be replaced at the module boundary.
let mockNow = '22:00';
jest.mock('../utils/bdTime.util', () => {
  const actual = jest.requireActual('../utils/bdTime.util');
  return { ...actual, getBangladeshTimeStr: () => mockNow };
});

const TelegramLink = require('../models/TelegramLink.model');
const Shop = require('../models/Shop.model');
const { runTick } = require('../jobs/dailyDigest.job');

/** Run one tick at a fixed Bangladesh wall-clock time and capture the query. */
async function queryAtTime(hhmm) {
  mockNow = hhmm;

  let captured = null;
  jest.spyOn(TelegramLink, 'find').mockImplementation((filter) => {
    captured = filter;
    return { lean: () => Promise.resolve([]) };
  });
  jest.spyOn(Shop, 'find').mockReturnValue({
    select: () => ({ lean: () => Promise.resolve([]) }),
  });

  await runTick();
  return captured;
}

afterEach(() => jest.restoreAllMocks());

describe('candidate pre-filter', () => {
  it('still constrains on the indexed activity fields', async () => {
    const q = await queryAtTime('22:00');
    expect(q.isActive).toBe(true);
    expect(q['preferences.dailySummary']).toBe(true);
  });

  it('asks only for send times inside the catch-up window', async () => {
    const q = await queryAtTime('22:00');
    const times = q.$or[0]['preferences.digestTime'].$in;

    expect(times).toContain('22:00');   // due right now
    expect(times).toContain('21:30');   // 30 min late, still inside
    expect(times).toContain('19:00');   // 180 min late — the boundary
    expect(times).not.toContain('18:59'); // past the window
    expect(times).not.toContain('22:01'); // not due yet
  });

  it('reaches links that have no digestTime when the default hour is due', async () => {
    // `isDue` falls back to 22:00 for documents predating the field. A bare
    // $in on digestTime would drop them silently and forever.
    const q = await queryAtTime('22:00');
    const nullClause = q.$or.find(
      (c) => Array.isArray(c['preferences.digestTime']?.$in)
        && c['preferences.digestTime'].$in.includes(null)
    );
    expect(nullClause).toBeDefined();
  });

  it('does not reach for the null case outside the default hour', async () => {
    const q = await queryAtTime('09:00');
    expect(q.$or).toHaveLength(1);
    expect(q.$or[0]['preferences.digestTime'].$in).not.toContain(null);
  });

  it('never asks for pre-midnight times from the small hours', async () => {
    // Mirrors the isDue rule the existing suite pins: a 23:30 digest is missed
    // rather than delivered at 00:15. Wrapping here would fetch candidates
    // isDue then throws away.
    const q = await queryAtTime('00:15');
    const times = q.$or[0]['preferences.digestTime'].$in;

    expect(times).toContain('00:15');
    expect(times).toContain('00:00');
    expect(times.some((t) => t.startsWith('23:'))).toBe(false);
    expect(times).toHaveLength(16); // 00:00 through 00:15
  });

  it('keeps the send-once guard in the query', async () => {
    const q = await queryAtTime('22:00');
    expect(q.lastDigestSentFor).toEqual({ $ne: expect.any(String) });
  });
});

describe('the index backing it', () => {
  it('covers digestTime alongside the activity fields', () => {
    const keys = TelegramLink.schema.indexes().map(([key]) => Object.keys(key));
    const sweep = keys.find(
      (k) => k.includes('isActive') && k.includes('preferences.dailySummary')
    );
    expect(sweep).toContain('preferences.digestTime');
  });
});
