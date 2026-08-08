/**
 * Invoice numbering — the correctness properties that motivated the change.
 *
 * Measurement demoted this from a performance fix (the old `countDocuments`
 * came in at 9ms — PERFORMANCE_BASELINE.md), so what is being protected here is
 * behaviour, not speed:
 *
 *   1. two concurrent cashiers never receive the same number;
 *   2. each branch has its OWN sequence, matching its prefix;
 *   3. a shop that switches over mid-trading-day resumes its numbering instead
 *      of restarting at 0001.
 *
 * (3) is the one with teeth — getting it wrong reissues numbers that are
 * already on printed receipts.
 */

const mongoose = require('mongoose');
const InvoiceCounter = require('../models/InvoiceCounter.model');
const Sale = require('../models/Sale.model');
const saleService = require('../services/sale.service');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH_A = new mongoose.Types.ObjectId();
const BRANCH_B = new mongoose.Types.ObjectId();

// ── In-memory stand-in for the counter collection ───────────────────────────
//
// Models the two operations `nextSeq` relies on, with the atomicity guarantees
// MongoDB gives them: findOneAndUpdate($inc) is indivisible, and $setOnInsert
// applies only when the upsert actually inserts.

let counters; // Map<key, {seq}>

const keyOf = ({ shop, branch, date }) => `${shop}|${branch || 'null'}|${date}`;

beforeEach(() => {
  counters = new Map();

  jest.spyOn(InvoiceCounter, 'findOneAndUpdate').mockImplementation(async (filter, update) => {
    const k = keyOf(filter);
    const row = counters.get(k);
    if (!row) return null;                 // no counter yet — seeding path
    row.seq += update.$inc.seq;            // atomic in the real thing
    return { seq: row.seq };
  });

  jest.spyOn(InvoiceCounter, 'updateOne').mockImplementation(async (filter, update) => {
    const k = keyOf(filter);
    // $setOnInsert only takes effect when the document is actually inserted.
    if (!counters.has(k)) counters.set(k, { seq: update.$setOnInsert.seq });
    return { acknowledged: true };
  });
});

afterEach(() => jest.restoreAllMocks());

const stubExistingSales = (n) => jest.spyOn(Sale, 'countDocuments').mockResolvedValue(n);

describe('a fresh day', () => {
  it('starts at 0001', async () => {
    stubExistingSales(0);
    const no = await saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A);
    expect(no).toMatch(/^INV-DHA-\d{8}-0001$/);
  });

  it('increments on each call', async () => {
    stubExistingSales(0);
    const a = await saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A);
    const b = await saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A);
    const c = await saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A);
    expect([a, b, c].map((s) => s.slice(-4))).toEqual(['0001', '0002', '0003']);
  });

  it('omits the branch segment for a single-branch shop', async () => {
    stubExistingSales(0);
    const no = await saleService.generateInvoiceNumber(SHOP, null, null);
    expect(no).toMatch(/^INV-\d{8}-0001$/);
  });
});

describe('concurrency — the race the retry loop used to absorb', () => {
  it('never issues the same number twice under parallel checkout', async () => {
    stubExistingSales(0);

    const numbers = await Promise.all(
      Array.from({ length: 25 }, () => saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A))
    );

    expect(new Set(numbers).size).toBe(25);
  });

  it('seeds exactly once when several cashiers hit an empty counter together', async () => {
    stubExistingSales(40);

    const numbers = await Promise.all(
      Array.from({ length: 5 }, () => saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A))
    );

    // All five resume from 40 — none restarts, none collides.
    expect(new Set(numbers).size).toBe(5);
    const seqs = numbers.map((n) => Number(n.slice(-4))).sort((a, b) => a - b);
    expect(seqs).toEqual([41, 42, 43, 44, 45]);
  });
});

describe('per-branch sequences', () => {
  it('gives each branch its own run of numbers', async () => {
    stubExistingSales(0);

    const a1 = await saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A);
    const b1 = await saleService.generateInvoiceNumber(SHOP, 'CTG', BRANCH_B);
    const a2 = await saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A);
    const b2 = await saleService.generateInvoiceNumber(SHOP, 'CTG', BRANCH_B);

    // Previously a sale at DHA bumped what CTG produced next, because the
    // count was shop-wide while the prefix was not.
    expect(a1.slice(-4)).toBe('0001');
    expect(a2.slice(-4)).toBe('0002');
    expect(b1.slice(-4)).toBe('0001');
    expect(b2.slice(-4)).toBe('0002');
    expect(a1).toContain('-DHA-');
    expect(b1).toContain('-CTG-');
  });

  it('keeps one branch\'s counter untouched while the other sells', async () => {
    stubExistingSales(0);
    await saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A);
    await saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A);
    await saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A);

    const first = await saleService.generateInvoiceNumber(SHOP, 'CTG', BRANCH_B);
    expect(first.slice(-4)).toBe('0001');
  });
});

describe('mid-day cutover — the migration risk', () => {
  it('resumes from existing sales rather than restarting', async () => {
    // 40 invoices already printed today under the old scheme.
    stubExistingSales(40);
    const next = await saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A);
    expect(next.slice(-4)).toBe('0041');
  });

  it('counts only the branch\'s own sales when seeding', async () => {
    const spy = stubExistingSales(12);
    await saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ shop: SHOP, branch: BRANCH_A })
    );
  });

  it('does not scope by branch for a single-branch shop', async () => {
    const spy = stubExistingSales(3);
    await saleService.generateInvoiceNumber(SHOP, null, null);

    const filter = spy.mock.calls[0][0];
    expect('branch' in filter).toBe(false);
  });

  it('consults existing sales only once per branch per day', async () => {
    const spy = stubExistingSales(5);

    await saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A);
    await saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A);
    await saleService.generateInvoiceNumber(SHOP, 'DHA', BRANCH_A);

    // Steady state is one atomic increment — the seed lookup must not repeat.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('InvoiceCounter schema', () => {
  it('is unique per (shop, branch, date)', () => {
    const unique = InvoiceCounter.schema.indexes()
      .map(([key, opts]) => ({ key, opts: opts || {} }))
      .filter((i) => i.opts.unique);

    expect(unique).toHaveLength(1);
    expect(Object.keys(unique[0].key)).toEqual(['shop', 'branch', 'date']);
  });

  it('expires stale counters so the collection cannot grow without bound', () => {
    const ttl = InvoiceCounter.schema.indexes()
      .map(([, opts]) => opts || {})
      .find((o) => o.expireAfterSeconds !== undefined);

    expect(ttl).toBeDefined();
    expect(ttl.expireAfterSeconds).toBeGreaterThan(0);
  });
});
