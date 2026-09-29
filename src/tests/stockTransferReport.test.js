/**
 * The stock-transfer detail report, the per-line unit snapshot, and the create
 * whitelist.
 *
 * Models are stubbed, so these pin the FILTER the service builds and the
 * arithmetic it does — not what MongoDB would return for it. The scope tests
 * are the ones that matter most: the report is the one read in this module that
 * takes a branch from the query string, and it must never let a pinned user
 * widen their view with it.
 */

const mongoose = require('mongoose');
const Product = require('../models/Product.model');
const StockTransfer = require('../models/StockTransfer.model');
const Branch = require('../models/Branch.model');
const service = require('../services/stockTransfer.service');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH_A = new mongoose.Types.ObjectId();
const BRANCH_B = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();

/** A chainable stand-in for a Mongoose query that resolves to `rows`. */
const chain = (rows) => {
  const q = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select', 'session']) q[m] = jest.fn(() => q);
  q.lean = jest.fn(() => Promise.resolve(rows));
  return q;
};

const line = (over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  product: new mongoose.Types.ObjectId(),
  productName: 'চাল',
  productCode: 'P-1',
  unit: 'kg',
  quantity: 10,
  received: 0,
  ...over,
});

const transfer = (status, items, over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  transferNo: 'TRF-000001',
  shop: SHOP,
  status,
  items,
  createdAt: new Date('2026-09-01T06:00:00Z'),
  fromBranch: { _id: BRANCH_A, name: 'A' },
  toBranch: { _id: BRANCH_B, name: 'B' },
  ...over,
});

afterEach(() => jest.restoreAllMocks());

// ── The arithmetic ──────────────────────────────────────────────────────────

describe('summariseTransferLines', () => {
  it('reads each line by the status of its transfer', () => {
    const { lines } = service.summariseTransferLines([
      transfer('pending', [line({ quantity: 5 })]),
      transfer('in_transit', [line({ quantity: 6 })]),
      transfer('received', [line({ quantity: 7, received: 7 })]),
      transfer('rejected', [line({ quantity: 8 })]),
    ]);

    expect(lines.map((l) => [l.status, l.sent, l.received, l.inTransit, l.pending, l.rejected])).toEqual([
      ['pending', 0, 0, 0, 5, 0],
      ['in_transit', 6, 0, 6, 0, 0],
      ['received', 7, 7, 0, 0, 0],
      ['rejected', 0, 0, 0, 0, 8],
    ]);
  });

  it('surfaces a short receipt as ঘাটতি, at the unit\'s precision', () => {
    const { lines, totals } = service.summariseTransferLines([
      transfer('received', [line({ quantity: 12.5, received: 10.3 })]),
    ]);
    // 12.5 - 10.3 is 2.1999999999999993 in a double.
    expect(lines[0].short).toBe(2.2);
    expect(totals.shortLines).toBe(1);
  });

  it('never reports more received than sent, whatever the row says', () => {
    const { lines } = service.summariseTransferLines([
      transfer('received', [line({ quantity: 5, received: 9 })]),
    ]);
    expect(lines[0].received).toBe(5);
    expect(lines[0].short).toBe(0);
  });

  it('rolls the same product up across transfers by code, not by branch document id', () => {
    // Two branches' copies of one item are different documents — the source
    // _id differs per transfer direction, the code does not.
    const { products } = service.summariseTransferLines([
      transfer('received', [line({ quantity: 0.1, received: 0.1 })]),
      ...Array.from({ length: 9 }, () => transfer('received', [line({ quantity: 0.1, received: 0.1 })])),
    ]);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ transfers: 10, sent: 1, received: 1, short: 0 });
  });

  it('keeps variants of one product apart', () => {
    const { products } = service.summariseTransferLines([
      transfer('in_transit', [
        line({ productName: 'শার্ট', productCode: 'S', unit: 'piece', quantity: 2, variantSku: 'S-M' }),
        line({ productName: 'শার্ট', productCode: 'S', unit: 'piece', quantity: 3, variantSku: 'S-L' }),
      ]),
    ]);
    expect(products.map((p) => [p.variantSku, p.sent])).toEqual([['S-L', 3], ['S-M', 2]]);
  });

  it('counts transfers by status and numbers lines within each transfer', () => {
    const { totals, lines } = service.summariseTransferLines([
      transfer('pending', [line(), line({ productCode: 'P-2' })]),
      transfer('received', [line({ received: 10 })]),
    ]);
    expect(totals.byStatus).toEqual({ pending: 1, in_transit: 0, received: 1, rejected: 0 });
    expect(totals).toMatchObject({ transfers: 2, lines: 3, products: 2 });
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2, 1]);
  });
});

// ── Scope ───────────────────────────────────────────────────────────────────

describe('getTransferReport — filter', () => {
  let findSpy;
  beforeEach(() => {
    findSpy = jest.spyOn(StockTransfer, 'find').mockImplementation(() => chain([]));
    jest.spyOn(Product, 'find').mockImplementation(() => chain([]));
  });
  const filterOf = () => findSpy.mock.calls[0][0];

  it('always carries the shop (I-5)', async () => {
    await service.getTransferReport(SHOP, {}, { branchId: null });
    expect(filterOf().shop).toBe(SHOP);
  });

  it('refuses to run without a shop rather than query the platform', async () => {
    await expect(service.getTransferReport(undefined, {}, {})).rejects.toMatchObject({ statusCode: 400 });
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('a pinned user sees either end of THEIR branch, and ?branch cannot move them', async () => {
    await service.getTransferReport(SHOP, { branch: String(BRANCH_B) }, { branchId: BRANCH_A });
    expect(filterOf().$or).toEqual([{ fromBranch: BRANCH_A }, { toBranch: BRANCH_A }]);
  });

  it('the owner in All Branches may narrow to one branch and one direction', async () => {
    await service.getTransferReport(SHOP, { branch: String(BRANCH_B), direction: 'in' }, { branchId: null });
    expect(filterOf().toBranch).toBe(String(BRANCH_B));
    expect(filterOf().$or).toBeUndefined();
  });

  it('with no branch at all, the whole shop — a single-branch shop runs the plain query', async () => {
    await service.getTransferReport(SHOP, {}, { branchId: null });
    expect(filterOf()).toEqual({ shop: SHOP });
  });

  it('reads the date range as Bangladesh days', async () => {
    await service.getTransferReport(SHOP, { startDate: '2026-09-01', endDate: '2026-09-30' }, {});
    const { $gte, $lte } = filterOf().createdAt;
    expect($gte.toISOString()).toBe('2026-08-31T18:00:00.000Z');
    expect($lte.toISOString()).toBe('2026-09-30T17:59:59.999Z');
  });

  it.each([
    [{ status: 'lost' }],
    [{ direction: 'sideways' }],
    [{ branch: 'not-an-id' }],
    [{ startDate: '2026-13-45x' }],
  ])('refuses a bad filter %j with a 400, not a CastError', async (query) => {
    await expect(service.getTransferReport(SHOP, query, { branchId: null })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('flags a report that hit the cap instead of silently cutting it', async () => {
    const many = Array.from({ length: 2001 }, () => transfer('pending', []));
    findSpy.mockImplementation(() => chain(many));
    const out = await service.getTransferReport(SHOP, {}, {});
    expect(out.truncated).toBe(true);
    expect(out.totals.transfers).toBe(2000);
  });
});

// ── The unit snapshot ───────────────────────────────────────────────────────

describe('line units', () => {
  it('fills a line written before `unit` existed from its product, in one query', async () => {
    const product = new mongoose.Types.ObjectId();
    const old = transfer('received', [
      { ...line({ product }), unit: undefined },
      { ...line({ product }), unit: undefined },
    ]);
    jest.spyOn(StockTransfer, 'find').mockImplementation(() => chain([old]));
    jest.spyOn(StockTransfer, 'countDocuments').mockResolvedValue(1);
    const productFind = jest.spyOn(Product, 'find').mockImplementation(() => chain([{ _id: product, unit: 'kg' }]));

    const { data } = await service.getTransfers(SHOP, {}, {});
    expect(data[0].items.map((i) => i.unit)).toEqual(['kg', 'kg']);
    expect(productFind).toHaveBeenCalledTimes(1);
    expect(productFind.mock.calls[0][0].shop).toBe(SHOP);
  });

  it('never overwrites a stored unit with the product\'s current one', async () => {
    const t = transfer('received', [line({ unit: 'kg' })]);
    jest.spyOn(StockTransfer, 'find').mockImplementation(() => chain([t]));
    jest.spyOn(StockTransfer, 'countDocuments').mockResolvedValue(1);
    const productFind = jest.spyOn(Product, 'find');

    const { data } = await service.getTransfers(SHOP, {}, {});
    expect(data[0].items[0].unit).toBe('kg');
    expect(productFind).not.toHaveBeenCalled();
  });
});

describe('createTransfer — what a request may set', () => {
  const productId = new mongoose.Types.ObjectId();
  let created;

  beforeEach(() => {
    jest.spyOn(Branch, 'validateBranchOwnership').mockResolvedValue({ _id: BRANCH_A });
    // `find(...).session(...)` — loadProductsFor awaits straight off .session.
    jest.spyOn(Product, 'find').mockImplementation(() => {
      const doc = [{ _id: productId, name: 'চাল', code: 'P-1', unit: 'kg', stock: 50, variants: [] }];
      return { session: () => Promise.resolve(doc) };
    });
    jest.spyOn(StockTransfer, 'create').mockImplementation(async (doc) => { created = doc; return doc; });
  });

  it('snapshots the unit from the product and drops fields only the server writes', async () => {
    await service.createTransfer({
      shop: SHOP,
      fromBranch: String(BRANCH_A),
      toBranch: String(BRANCH_B),
      items: [{
        product: productId,
        productName: 'চাল',
        quantity: 12.5,
        unit: 'piece',                                      // client's claim — ignored
        received: 99,                                       // server-only
        batches: [{ batchNumber: 'X', quantity: 12.5 }],    // server-only
      }],
    }, USER, null);

    expect(created.items[0].unit).toBe('kg');
    expect(created.items[0]).not.toHaveProperty('received');
    expect(created.items[0]).not.toHaveProperty('batches');
    expect(created.items[0].productCode).toBe('P-1');
  });
});
