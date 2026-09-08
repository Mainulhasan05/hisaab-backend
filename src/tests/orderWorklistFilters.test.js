/**
 * The worklist's filters — the query the screen actually asks.
 *
 * ── WHY THESE ARE WORTH A SUITE OF THEIR OWN ────────────────────────────────
 *
 * Every failure this guards against is SILENT. A filter that is built wrong
 * does not throw; it returns the wrong orders, or the right orders under a
 * badge that says a different number, and the shopkeeper's only clue is that
 * the tab and the list disagree. AGENT_WORKFLOW §7.3 names exactly that
 * disagreement as the thing to check for, and §8's table is a list of scoping
 * bugs that raised no error at all.
 *
 * Models are stubbed, so what is asserted is the SHAPE of the filter handed to
 * Mongo — which is the layer where these bugs live.
 */

const mongoose = require('mongoose');

jest.mock('../models/Order.model', () => {
  const ORDER_STATUSES = ['pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'];
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    countDocuments: jest.fn(() => Promise.resolve(0)),
    aggregate: jest.fn(() => Promise.resolve([])),
    ORDER_STATUSES,
    PRE_CONFIRM_STATUSES: ['pending', 'cancelled'],
  };
});
jest.mock('../models/OrderCounter.model', () => ({ nextSeq: jest.fn() }));
jest.mock('../models/Product.model', () => ({ find: jest.fn() }));
jest.mock('../models/Storefront.model', () => ({ updateOne: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/publicStorefront.service', () => ({
  _effective: jest.fn(() => ({ price: 100, compareAt: null })),
  _onlinePriceOf: jest.fn(() => null),
}));
jest.mock('../utils/logger.util', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const Order = require('../models/Order.model');
const orderService = require('../services/order.service');

const SHOP_ID = new mongoose.Types.ObjectId();
const BRANCH_ID = new mongoose.Types.ObjectId();

const req = (over = {}) => ({
  shop: { _id: SHOP_ID, multiBranchEnabled: false },
  branchId: null,
  user: { _id: new mongoose.Types.ObjectId() },
  ...over,
});

/** `Order.find(...).sort(...).skip(...).limit(...).lean()` */
const chain = (rows = []) => ({
  sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve(rows) }) }) }),
});

beforeEach(() => {
  jest.clearAllMocks();
  Order.find.mockReturnValue(chain());
  Order.countDocuments.mockResolvedValue(0);
  Order.aggregate.mockResolvedValue([]);
});

/**
 * The filter handed to `Order.find` by ONE call.
 *
 * Reads the LAST mock call, not the first. Reading `calls[0]` works right up
 * until a test calls this twice, at which point it silently asserts against the
 * previous invocation — which is how the open-ended-range test appeared to
 * prove that `to` alone produced a `$gte`.
 */
const filterFor = async (criteria) => {
  await orderService.listOrders(req(), criteria);
  const { calls } = Order.find.mock;
  return calls[calls.length - 1][0];
};

describe('the search term and the stuck rule can both apply at once', () => {
  /**
   * REGRESSION, and the reason `$and` exists in `_worklistFilter`.
   *
   * Both clauses are disjunctions. Assigned as `filter.$or` twice, the second
   * overwrites the first — so searching a phone number while "আটকে আছে" was on
   * would silently drop the search and hand back a stranger's order. No error,
   * a perfectly well-formed query, and the wrong customer on screen.
   */
  it('keeps BOTH disjunctions instead of one overwriting the other', async () => {
    const filter = await filterFor({ q: '01712345678', late: true });

    expect(filter.$and).toHaveLength(2);
    const [search, stuck] = filter.$and;

    expect(search.$or).toEqual(
      expect.arrayContaining([{ 'customer.phone': '01712345678' }])
    );
    // One branch per non-terminal state, and no branch for the terminal ones:
    // a delivered order cannot be late.
    const states = stuck.$or.map((c) => c.status);
    expect(states).toEqual(['pending', 'confirmed', 'packed', 'shipped']);
    expect(states).not.toContain('delivered');
    expect(states).not.toContain('cancelled');
  });

  it('searches an order number case-insensitively, by upper-casing the term', async () => {
    const filter = await filterFor({ q: 'ord-0042' });
    expect(filter.$and[0].$or).toEqual(
      expect.arrayContaining([{ orderNo: 'ORD-0042' }])
    );
  });
});

describe('dates are Bangladesh calendar days', () => {
  /**
   * Bangladesh is UTC+6. A day that began at Dhaka midnight began at 18:00 UTC
   * the day before, and a service that bounded it with the server's own
   * midnight would file the first six hours of every day under the previous
   * one — the exact error `bdTime.util` was written to stop, and one that shows
   * up as "আজকের অর্ডার" being empty at 3am.
   */
  it("bounds a single day at Dhaka midnight, not the server's", async () => {
    const filter = await filterFor({ from: '2026-09-08', to: '2026-09-08' });

    expect(filter.createdAt.$gte.toISOString()).toBe('2026-09-07T18:00:00.000Z');
    expect(filter.createdAt.$lte.toISOString()).toBe('2026-09-08T17:59:59.999Z');
  });

  it('accepts an open-ended range in either direction', async () => {
    const fromOnly = await filterFor({ from: '2026-09-01' });
    expect(fromOnly.createdAt.$gte).toBeInstanceOf(Date);
    expect(fromOnly.createdAt.$lte).toBeUndefined();

    const toOnly = await filterFor({ to: '2026-09-30' });
    expect(toOnly.createdAt.$gte).toBeUndefined();
    expect(toOnly.createdAt.$lte).toBeInstanceOf(Date);
  });

  it('IGNORES an unparseable date rather than widening the range to 1970', async () => {
    const filter = await filterFor({ from: 'yesterday-ish' });
    expect(filter.createdAt).toBeUndefined();
  });
});

describe('the delivery-arrangement filter', () => {
  /**
   * Pickup is not a zone. An order the customer collects carries
   * `zoneKey: null`, so matching pickup as if it were a zone key would either
   * match every pickup order or none, depending only on how it was written.
   */
  it('matches pickup on the flag, never on a zone key', async () => {
    const filter = await filterFor({ zone: 'pickup' });
    expect(filter['delivery.isPickup']).toBe(true);
    expect(filter['delivery.zoneKey']).toBeUndefined();
  });

  it('excludes pickups when a real zone is chosen', async () => {
    const filter = await filterFor({ zone: 'inside-dhaka' });
    expect(filter['delivery.zoneKey']).toBe('inside-dhaka');
    expect(filter['delivery.isPickup']).toEqual({ $ne: true });
  });
});

describe('the tab badges and the rows agree', () => {
  /**
   * The failure AGENT_WORKFLOW §7.3 names: two query paths answering one
   * question differently, so the card says twelve above a list of three.
   *
   * A badge must obey every filter EXCEPT the status tabs themselves — count
   * the status too and every tab but the open one reads zero.
   */
  it('counts under the same date, source and zone filters as the list', async () => {
    const criteria = {
      status: 'pending',
      from: '2026-09-01',
      to: '2026-09-08',
      source: 'manual',
      zone: 'inside-dhaka',
    };

    await orderService.listOrders(req(), criteria);
    await orderService.countsByStatus(req(), criteria);

    const listFilter = Order.find.mock.calls[0][0];
    const countMatch = Order.aggregate.mock.calls[0][0][0].$match;

    for (const key of ['source', 'delivery.zoneKey', 'delivery.isPickup']) {
      expect(countMatch[key]).toEqual(listFilter[key]);
    }
    expect(countMatch.createdAt.$gte.getTime()).toBe(listFilter.createdAt.$gte.getTime());
    expect(countMatch.createdAt.$lte.getTime()).toBe(listFilter.createdAt.$lte.getTime());

    // …and the one difference, which is the whole point.
    expect(listFilter.status).toBe('pending');
    expect(countMatch.status).toBeUndefined();
  });

  it('gives the totals line the same filter as the rows, status included', async () => {
    const criteria = { status: 'delivered', from: '2026-09-01' };

    await orderService.listOrders(req(), criteria);
    await orderService.worklistTotals(req(), criteria);

    const listFilter = Order.find.mock.calls[0][0];
    const totalsMatch = Order.aggregate.mock.calls[0][0][0].$match;

    expect(totalsMatch.status).toBe(listFilter.status);
    expect(totalsMatch.createdAt.$gte.getTime()).toBe(listFilter.createdAt.$gte.getTime());
  });
});

describe('scoping (I-1, I-3, I-5)', () => {
  it('carries the shop on every read', async () => {
    const filter = await filterFor({});
    expect(String(filter.shop)).toBe(String(SHOP_ID));
  });

  /**
   * I-1: a single-branch shop must be pixel-identical, and that starts with the
   * query. `branchId` is null, so `branch` must not appear in the filter AT
   * ALL — `{branch: null}` is a predicate, and it would match only orders whose
   * branch is explicitly null.
   */
  it('adds no branch predicate for a single-branch shop', async () => {
    const filter = await filterFor({});
    expect('branch' in filter).toBe(false);
  });

  /**
   * I-3: `$match` does not cast. A branch id that reaches an aggregation as a
   * string matches nothing and returns zeros — no error, no log, just a tab
   * badge reading ০ over a list of orders.
   */
  it('casts the branch id to an ObjectId for the aggregations', async () => {
    const r = req({ branchId: String(BRANCH_ID), shop: { _id: SHOP_ID, multiBranchEnabled: true } });

    await orderService.countsByStatus(r, {});
    const match = Order.aggregate.mock.calls[0][0][0].$match;

    expect(match.branch).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(match.branch)).toBe(String(BRANCH_ID));
  });
});

describe('sorting', () => {
  const sortFor = async (criteria) => {
    let captured = null;
    Order.find.mockReturnValue({
      sort: (s) => {
        captured = s;
        return { skip: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) };
      },
    });
    await orderService.listOrders(req(), criteria);
    return captured;
  };

  /**
   * A product decision, and one that has been made both ways.
   *
   * §7.2 originally put the নতুন tab in oldest-first: the order that has waited
   * longest is the one to deal with next. It was reversed because it buried the
   * order the shopkeeper had just been pinged about — they open this screen
   * because something arrived, and it was at the bottom behind everything they
   * had already chosen not to handle.
   *
   * Staleness is not lost, it moved to where it works better: `STUCK_AFTER_HOURS`
   * labels a rotting order, counts it on the overview and links straight to it.
   * A label beats a position.
   *
   * This test is written to fail loudly if pending goes back to `createdAt: 1`
   * without that argument being had again.
   */
  it('defaults every tab to newest-first, pending included', async () => {
    expect(await sortFor({ status: 'pending' })).toEqual({ createdAt: -1 });
    expect(await sortFor({ status: 'delivered' })).toEqual({ createdAt: -1 });
    expect(await sortFor({})).toEqual({ createdAt: -1 });
  });

  it('lets an explicit choice override the default', async () => {
    // `oldest` is what a shopkeeper who WANTS the old queue discipline picks,
    // so the capability is still one tap away rather than gone.
    expect(await sortFor({ status: 'pending', sort: 'oldest' })).toEqual({ createdAt: 1 });
    expect(await sortFor({ status: 'pending', sort: 'newest' })).toEqual({ createdAt: -1 });
    expect(await sortFor({ status: 'pending', sort: 'amount' }))
      .toEqual({ total: -1, createdAt: -1 });
  });
});
