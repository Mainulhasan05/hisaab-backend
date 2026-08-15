/**
 * Return numbering — the three defects that motivated `ReturnCounter`.
 *
 * `SalesReturn.generateReturnNo` was the read-modify-write that `InvoiceCounter`
 * had already removed from the sales path. Returns never got the same treatment,
 * and carried three separate bugs because of it:
 *
 *   1. **It raced, with no retry to absorb it.** Two returns processed together
 *      both read the same last row and built the same number. Sales had a retry
 *      loop; returns run inside `runInTransaction` with nothing to catch the
 *      duplicate, so a legitimate refund failed with E11000.
 *
 *   2. **The date came from the SERVER clock.** On a UTC host that is 06:00
 *      Dhaka, so a return made before 6am was stamped with the previous day
 *      while the sale it reversed carried the correct Bangladesh day from
 *      `InvoiceCounter` — two documents about one transaction, dated a day apart.
 *
 *   3. **It broke past 9,999 in a day.** `String(10000).padStart(4,'0')` is five
 *      characters, so the next `slice(-4)` read "0000", parsed to 0, and the
 *      sequence restarted at 1 — straight into the unique index.
 *
 * (2) and (3) are the ones with teeth: both produce a wrong number silently,
 * where (1) at least fails loudly.
 *
 * The in-memory counter below mirrors `invoiceCounter.test.js` — it models the
 * two operations `nextSeq` relies on with the atomicity MongoDB gives them.
 */

const mongoose = require('mongoose');
const ReturnCounter = require('../models/ReturnCounter.model');
const SalesReturn = require('../models/SalesReturn.model');
const { getBangladeshTodayStr } = require('../utils/bdTime.util');

const SHOP = new mongoose.Types.ObjectId();
const OTHER_SHOP = new mongoose.Types.ObjectId();

let counters; // Map<key, {seq}>

const keyOf = ({ shop, date }) => `${shop}|${date}`;

beforeEach(() => {
  counters = new Map();

  jest.spyOn(ReturnCounter, 'findOneAndUpdate').mockImplementation(async (filter, update) => {
    const k = keyOf(filter);
    const row = counters.get(k);
    if (!row) return null;              // no counter yet — seeding path
    row.seq += update.$inc.seq;         // atomic in the real thing
    return { seq: row.seq };
  });

  jest.spyOn(ReturnCounter, 'updateOne').mockImplementation(async (filter, update) => {
    const k = keyOf(filter);
    // $setOnInsert only takes effect when the document is actually inserted.
    if (!counters.has(k)) counters.set(k, { seq: update.$setOnInsert.seq });
    return { acknowledged: true };
  });
});

afterEach(() => jest.restoreAllMocks());

const stubExistingReturns = (n) => jest.spyOn(SalesReturn, 'countDocuments').mockResolvedValue(n);

describe('a fresh day', () => {
  it('starts at 0001', async () => {
    stubExistingReturns(0);
    const no = await SalesReturn.generateReturnNo(SHOP);
    expect(no).toMatch(/^RET\d{8}0001$/);
  });

  it('increments on each call', async () => {
    stubExistingReturns(0);
    const nos = [];
    for (let i = 0; i < 3; i++) nos.push(await SalesReturn.generateReturnNo(SHOP));
    expect(nos.map((s) => s.slice(-4))).toEqual(['0001', '0002', '0003']);
  });

  it('keeps each shop on its own sequence', async () => {
    stubExistingReturns(0);
    const a = await SalesReturn.generateReturnNo(SHOP);
    const b = await SalesReturn.generateReturnNo(OTHER_SHOP);
    expect(a.slice(-4)).toBe('0001');
    expect(b.slice(-4)).toBe('0001');
  });
});

describe('the date prefix is a Bangladesh calendar day', () => {
  it('stamps the BD date, not the server-local one', async () => {
    stubExistingReturns(0);
    const no = await SalesReturn.generateReturnNo(SHOP);
    expect(no).toBe(`RET${getBangladeshTodayStr().replace(/-/g, '')}0001`);
  });

  /**
   * The regression that matters. At 02:00 Dhaka on 16 August the server clock
   * (UTC) reads 20:00 on the 15th; the old code took `getFullYear/getMonth/
   * getDate` off that and stamped the return RET20260815 while the sale it
   * reversed carried 20260816.
   */
  it('does not roll over six hours late — the 00:00–05:59 Dhaka window', async () => {
    stubExistingReturns(0);
    // 2026-08-15T20:30:00Z is 2026-08-16 02:30 in Dhaka.
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-15T20:30:00.000Z'));

    const no = await SalesReturn.generateReturnNo(SHOP);

    expect(no.slice(3, 11)).toBe('20260816');
    // What the server clock would have said, and did:
    expect(new Date(Date.now()).toISOString().slice(0, 10).replace(/-/g, '')).toBe('20260815');
  });

  it('agrees with the invoice number a sale on the same instant would carry', async () => {
    stubExistingReturns(0);
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-12-31T19:00:00.000Z'));

    // 01:00 Dhaka on 1 January — a year boundary as well as a day one.
    const no = await SalesReturn.generateReturnNo(SHOP);
    expect(no.slice(3, 11)).toBe('20270101');
  });
});

describe('concurrency — the race that had no retry to absorb it', () => {
  it('never issues the same number twice under parallel returns', async () => {
    stubExistingReturns(0);
    const nos = await Promise.all(
      Array.from({ length: 25 }, () => SalesReturn.generateReturnNo(SHOP))
    );
    expect(new Set(nos).size).toBe(25);
  });

  it('seeds once when several returns hit an empty counter together', async () => {
    stubExistingReturns(4); // four returns already recorded today
    const nos = await Promise.all(
      Array.from({ length: 5 }, () => SalesReturn.generateReturnNo(SHOP))
    );
    // All distinct, and all above the four that already exist — the losing
    // seeder's value must be discarded, not written over the winner's.
    expect(new Set(nos).size).toBe(5);
    for (const no of nos) expect(Number(no.slice(-4))).toBeGreaterThan(4);
  });
});

describe('resuming an in-progress day', () => {
  it('continues from the returns already recorded rather than restarting', async () => {
    stubExistingReturns(7);
    const no = await SalesReturn.generateReturnNo(SHOP);
    expect(no.slice(-4)).toBe('0008');
  });

  it('consults the existing count only once per day', async () => {
    const spy = stubExistingReturns(3);
    await SalesReturn.generateReturnNo(SHOP);
    await SalesReturn.generateReturnNo(SHOP);
    await SalesReturn.generateReturnNo(SHOP);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/**
 * The old implementation parsed the sequence back out of the previous number
 * with `slice(-4)`. At 10,000 that reads "0000", so the counter restarted at 1
 * and collided with a number already issued that day. The counter never parses
 * anything back out, so the width is a minimum rather than a cap.
 */
describe('past 9,999 in a single day', () => {
  it('grows to five digits and stays unique', async () => {
    stubExistingReturns(9999);
    const a = await SalesReturn.generateReturnNo(SHOP);
    const b = await SalesReturn.generateReturnNo(SHOP);

    expect(a).toMatch(/^RET\d{8}10000$/);
    expect(b).toMatch(/^RET\d{8}10001$/);
    expect(a).not.toBe(b);
  });

  it('the old slice(-4) parse really did wrap — this is what was fixed', () => {
    const legacyNext = (prev) => parseInt(prev.slice(-4), 10) + 1;
    expect(legacyNext('RET202608150001')).toBe(2);
    // At five digits the parse reads the wrong characters and restarts.
    expect(legacyNext(`RET20260815${String(10000).padStart(4, '0')}`)).toBe(1);
  });
});

describe('the counter model itself', () => {
  it('is keyed uniquely on (shop, date)', () => {
    const idx = ReturnCounter.schema.indexes();
    const unique = idx.find(([, opts]) => opts.unique);
    expect(unique[0]).toEqual({ shop: 1, date: 1 });
  });

  it('carries no branch in its key — return numbers are shop-wide', () => {
    // Unlike InvoiceCounter. The prefix `RET<YYYYMMDD>` has no branch code, so a
    // per-branch sequence would make the numbering gappy for no visible reason.
    expect(ReturnCounter.schema.path('branch')).toBeUndefined();
  });

  it('expires old counters so they do not accumulate forever', () => {
    const idx = ReturnCounter.schema.indexes();
    const ttl = idx.find(([, opts]) => opts.expireAfterSeconds);
    expect(ttl[0]).toEqual({ createdAt: 1 });
    expect(ttl[1].expireAfterSeconds).toBe(30 * 24 * 60 * 60);
  });

  it('is registered in models/index.js so sync-indexes ships its unique index', () => {
    // Without registration the index never reaches production (autoIndex is off
    // there), leaving the race this model exists to remove still open.
    const models = require('../models');
    expect(models.ReturnCounter).toBeDefined();
    expect(models.InvoiceCounter).toBeDefined();
  });
});
