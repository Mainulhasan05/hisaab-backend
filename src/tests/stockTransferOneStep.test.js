/**
 * Stock transfer — the destination check at create time, cloning what the
 * destination does not stock, and the one-step paths (dispatchNow/receiveNow).
 *
 * Models are faked over one in-memory store, as in stockTransferBatching: the
 * service mutates the docs it reads, so final stock is asserted on the store.
 * `runInTransaction` hands out ONE fake session object, so a test can tell the
 * joined steps apart from steps that opened a second atomic unit.
 */

const SESSION = { fake: 'session' };

jest.mock('../utils/transaction.util', () => ({
  runInTransaction: jest.fn((cb, opts = {}) => cb(opts.session || SESSION)),
}));

jest.mock('../services/media.service', () => ({
  reconcileRefs: jest.fn(() => Promise.resolve({ attached: [], detached: [] })),
  mediaIdsOfProduct: (p) => [
    ...(p?.catalogImages || []).map((i) => i?.mediaId),
    ...(p?.variants || []).map((v) => v?.imageMediaId),
  ].filter(Boolean),
}));

const mongoose = require('mongoose');
const Product = require('../models/Product.model');
const StockTransaction = require('../models/StockTransaction.model');
const StockTransfer = require('../models/StockTransfer.model');
const Branch = require('../models/Branch.model');
const { runInTransaction } = require('../utils/transaction.util');
const mediaService = require('../services/media.service');
const service = require('../services/stockTransfer.service');

const oid = () => new mongoose.Types.ObjectId();
const SHOP = oid();
const USER = oid();
const BRANCH_A = oid(); // source
const BRANCH_B = oid(); // destination

let products;   // Map<id, doc>
let transfers;  // Map<id, doc>
let txns;

const withIdAccessor = (arr) => {
  arr.id = (vid) => arr.find((v) => String(v._id) === String(vid)) || null;
  return arr;
};

function product({ code, branch, stock = 0, variants = null, extra = {} }) {
  const doc = {
    _id: oid(), shop: SHOP, branch, code, name: `পণ্য ${code}`,
    unit: 'piece', stock, isDeleted: false, clonedFrom: null,
    buyingPrice: 10, sellingPrice: 15,
    hasVariants: Boolean(variants),
    variants: withIdAccessor(variants || []),
    isAvailableOnline: true, isFeaturedOnline: true, totalSold: 7,
    ...extra,
  };
  products.set(String(doc._id), doc);
  return doc;
}

const variant = (sku, size, stock) => ({
  _id: oid(), sku, attributes: { size }, buyingPrice: 10, sellingPrice: 15, stock,
});

const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
  if (k === '$or') return v.some((f) => matches(doc, f));
  // The only $expr the service issues: stock below minStock.
  if (k === '$expr') return (doc.stock || 0) < (doc.minStock || 0);
  if (k === 'variants.0') return (doc.variants || []).length > 0;
  if (v && typeof v === 'object' && v.$in) return v.$in.some((x) => String(x) === String(doc[k]));
  if (v && typeof v === 'object' && v.$ne !== undefined) return doc[k] !== v.$ne;
  return String(doc[k]) === String(v);
});

const query = (result) => {
  const q = {
    session: () => Promise.resolve(result),
    select: () => q,
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  };
  return q;
};

const req = ({ owner = true, perms = {}, branch = BRANCH_A } = {}) => ({
  shop: { _id: SHOP, multiBranchEnabled: true },
  branchId: branch,
  user: { _id: USER, isOwner: owner, permissions: perms },
});

const STAFF_ALL = {
  stock_transfers: { create: true, update: true },
  products: { create: true },
};

beforeEach(() => {
  products = new Map();
  transfers = new Map();
  txns = [];
  runInTransaction.mockClear();
  mediaService.reconcileRefs.mockClear();

  jest.spyOn(Product, 'find').mockImplementation((f) =>
    query([...products.values()].filter((d) => matches(d, f))));

  jest.spyOn(Product, 'insertMany').mockImplementation((docs) => {
    const out = docs.map((d) => {
      const doc = { ...d, _id: oid(), variants: withIdAccessor([...(d.variants || [])]) };
      products.set(String(doc._id), doc);
      return doc;
    });
    return Promise.resolve(out);
  });

  // Stock values are already on the in-memory docs (the service mutates what
  // it read). Only the variant append has to be applied here.
  jest.spyOn(Product, 'bulkWrite').mockImplementation((ops) => {
    for (const { updateOne } of ops) {
      const push = updateOne.update?.$push?.variants?.$each;
      if (push) products.get(String(updateOne.filter._id)).variants.push(...push);
    }
    return Promise.resolve({});
  });

  jest.spyOn(StockTransaction, 'insertMany').mockImplementation((rows) => {
    txns.push(...rows);
    return Promise.resolve(rows);
  });

  jest.spyOn(StockTransfer, 'create').mockImplementation((arg) => {
    const d = Array.isArray(arg) ? arg[0] : arg;
    const doc = {
      ...d, _id: oid(), transferNo: 'TRF-000001',
      items: d.items.map((i) => ({ ...i, _id: oid() })),
      save: jest.fn(function save() { return Promise.resolve(this); }),
    };
    transfers.set(String(doc._id), doc);
    return Promise.resolve(Array.isArray(arg) ? [doc] : doc);
  });
  jest.spyOn(StockTransfer, 'findOne').mockImplementation((f) => query(transfers.get(String(f._id)) || null));

  jest.spyOn(Branch, 'validateBranchOwnership').mockImplementation((id) => Promise.resolve({ _id: id }));
});

afterEach(() => jest.restoreAllMocks());

const body = (items, flags = {}) => ({
  shop: SHOP, fromBranch: BRANCH_A, toBranch: BRANCH_B, items, ...flags,
});
const line = (p, quantity, v = null) => ({
  product: p._id, productName: p.name, quantity, variantId: v?._id || null,
});
const inBranch = (branch) => [...products.values()].filter((p) => String(p.branch) === String(branch));

// ── The destination is checked at CREATE, not at receive ────────────────────

describe('create — a product the destination does not stock', () => {
  it('is refused by name before anything is written', async () => {
    const src = product({ code: 'RICE', branch: BRANCH_A, stock: 50 });

    await expect(service.createTransfer(body([line(src, 5)]), USER, req()))
      .rejects.toMatchObject({ statusCode: 409, code: 'TRANSFER_MISSING_AT_DESTINATION' });

    expect(StockTransfer.create).not.toHaveBeenCalled();
    expect(Product.insertMany).not.toHaveBeenCalled();
    expect(src.stock).toBe(50);
  });

  it('createMissing clones it into the destination at zero stock, online off', async () => {
    const src = product({ code: 'RICE', branch: BRANCH_A, stock: 50 });

    const t = await service.createTransfer(body([line(src, 5)], { createMissing: true }), USER, req());

    const [copy] = inBranch(BRANCH_B);
    expect(copy).toMatchObject({
      code: 'RICE', shop: SHOP, stock: 0, totalSold: 0,
      isAvailableOnline: false, isFeaturedOnline: false,
    });
    expect(String(copy.clonedFrom)).toBe(String(src._id));
    expect(String(copy._id)).not.toBe(String(src._id));
    expect(t.status).toBe('pending');
    expect(src.stock).toBe(50); // creating a request moves nothing
  });

  it('createMissing needs products.create', async () => {
    const src = product({ code: 'RICE', branch: BRANCH_A, stock: 50 });
    const staff = req({ owner: false, perms: { stock_transfers: { create: true, update: true } } });

    await expect(service.createTransfer(body([line(src, 5)], { createMissing: true }), USER, staff))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(Product.insertMany).not.toHaveBeenCalled();
  });

  it('counts the copy\'s photo references after commit', async () => {
    const mediaId = oid();
    const src = product({
      code: 'RICE', branch: BRANCH_A, stock: 50,
      extra: { catalogImages: [{ url: 'x', mediaId }] },
    });

    await service.createTransfer(body([line(src, 5)], { createMissing: true }), USER, req());

    expect(mediaService.reconcileRefs).toHaveBeenCalledWith(SHOP, [], [mediaId]);
  });
});

describe('create — variants', () => {
  it('appends a size the destination product lacks, at zero stock', async () => {
    const xl = variant('SH-XL', 'XL', 10);
    const src = product({ code: 'SH', branch: BRANCH_A, variants: [xl, variant('SH-S', 'S', 4)] });
    const dest = product({ code: 'SH', branch: BRANCH_B, variants: [variant('SH-S', 'S', 1)] });

    await service.createTransfer(body([line(src, 3, xl)], { createMissing: true }), USER, req());

    const added = dest.variants.find((v) => v.sku === 'SH-XL');
    expect(added).toMatchObject({ stock: 0, attributes: { size: 'XL' } });
    expect(Product.insertMany).not.toHaveBeenCalled();
  });

  it('refuses a variant line into a destination product that has no variants', async () => {
    const xl = variant('SH-XL', 'XL', 10);
    const src = product({ code: 'SH', branch: BRANCH_A, variants: [xl] });
    const dest = product({ code: 'SH', branch: BRANCH_B, stock: 9 });

    await expect(service.createTransfer(body([line(src, 3, xl)], { createMissing: true }), USER, req()))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(dest.variants).toHaveLength(0);
    expect(dest.stock).toBe(9);
  });

  it('refuses a plain line into a destination product that has variants', async () => {
    const src = product({ code: 'SH', branch: BRANCH_A, stock: 10 });
    product({ code: 'SH', branch: BRANCH_B, variants: [variant('SH-S', 'S', 1)] });

    await expect(service.createTransfer(body([line(src, 3)]), USER, req()))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

// ── One step ────────────────────────────────────────────────────────────────

describe('create — dispatchNow / receiveNow', () => {
  it('a plain request still writes one document and opens no transaction', async () => {
    const src = product({ code: 'RICE', branch: BRANCH_A, stock: 50 });
    product({ code: 'RICE', branch: BRANCH_B, stock: 0 });

    const t = await service.createTransfer(body([line(src, 5)]), USER, req());

    expect(t.status).toBe('pending');
    expect(runInTransaction).not.toHaveBeenCalled();
    expect(src.stock).toBe(50);
  });

  it('dispatchNow deducts the source inside the same transaction', async () => {
    const src = product({ code: 'RICE', branch: BRANCH_A, stock: 50 });
    product({ code: 'RICE', branch: BRANCH_B, stock: 0 });

    const t = await service.createTransfer(body([line(src, 5)], { dispatchNow: true }), USER, req());

    expect(t.status).toBe('in_transit');
    expect(src.stock).toBe(45);
    expect(txns.map((x) => x.type)).toEqual(['transfer_out']);
    // The approve step JOINED the create's session rather than opening its own.
    expect(runInTransaction.mock.calls[1][1]).toEqual({ session: SESSION });
  });

  it('dispatchNow needs stock_transfers.update', async () => {
    const src = product({ code: 'RICE', branch: BRANCH_A, stock: 50 });
    product({ code: 'RICE', branch: BRANCH_B, stock: 0 });
    const staff = req({ owner: false, perms: { stock_transfers: { create: true } } });

    await expect(service.createTransfer(body([line(src, 5)], { dispatchNow: true }), USER, staff))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(src.stock).toBe(50);
  });

  it('owner: create + clone + send + receive in one go, from the source branch', async () => {
    const src = product({ code: 'RICE', branch: BRANCH_A, stock: 50 });

    const t = await service.createTransfer(
      body([line(src, 5)], { createMissing: true, receiveNow: true }), USER, req()
    );

    const [copy] = inBranch(BRANCH_B);
    expect(t.status).toBe('received');
    expect(src.stock).toBe(45);
    expect(copy.stock).toBe(5);
    expect(txns.map((x) => x.type)).toEqual(['transfer_out', 'transfer_in']);
    expect(String(txns[1].product)).toBe(String(copy._id));
    expect(String(txns[1].branch)).toBe(String(BRANCH_B));
  });

  it('receiveNow is owner-only, even for staff holding every permission', async () => {
    const src = product({ code: 'RICE', branch: BRANCH_A, stock: 50 });
    product({ code: 'RICE', branch: BRANCH_B, stock: 0 });

    await expect(service.createTransfer(
      body([line(src, 5)], { receiveNow: true }), USER, req({ owner: false, perms: STAFF_ALL })
    )).rejects.toMatchObject({ statusCode: 403 });
    expect(src.stock).toBe(50);
  });

  it('a received variant lands on the destination\'s own variant', async () => {
    const xl = variant('SH-XL', 'XL', 10);
    const src = product({ code: 'SH', branch: BRANCH_A, variants: [xl] });
    const destXl = variant('SH-XL', 'XL', 2);
    product({ code: 'SH', branch: BRANCH_B, variants: [destXl] });

    await service.createTransfer(body([line(src, 3, xl)], { receiveNow: true }), USER, req());

    expect(xl.stock).toBe(7);
    expect(destXl.stock).toBe(5);
  });

  it('the receive route itself still refuses a user standing at the source', async () => {
    const src = product({ code: 'RICE', branch: BRANCH_A, stock: 50 });
    product({ code: 'RICE', branch: BRANCH_B, stock: 0 });
    const t = await service.createTransfer(body([line(src, 5)], { dispatchNow: true }), USER, req());

    await expect(service.receiveTransfer(t._id, SHOP, USER, null, req()))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});

// ── Preview ─────────────────────────────────────────────────────────────────

describe('previewTransfer', () => {
  it('lists what the destination lacks and what this user may do, writing nothing', async () => {
    const rice = product({ code: 'RICE', branch: BRANCH_A, stock: 50 });
    const dal = product({ code: 'DAL', branch: BRANCH_A, stock: 50 });
    product({ code: 'DAL', branch: BRANCH_B });

    const staff = req({ owner: false, perms: { stock_transfers: { create: true } } });
    const out = await service.previewTransfer(body([line(rice, 1), line(dal, 1)]), staff);

    expect(out.missing).toEqual([
      expect.objectContaining({ product: rice._id, productName: rice.name, kind: 'product' }),
    ]);
    expect(out.blocked).toEqual([]);
    expect(out).toMatchObject({ canCreateMissing: false, canDispatch: false, canReceiveNow: false });
    expect(Product.insertMany).not.toHaveBeenCalled();
    expect(StockTransfer.create).not.toHaveBeenCalled();
  });

  it('returns the source stock per line, and blocks a line that left the source', async () => {
    const rice = product({ code: 'RICE', branch: BRANCH_A, stock: 42 });
    product({ code: 'RICE', branch: BRANCH_B });
    const gone = { product: oid(), productName: 'পুরোনো পণ্য', quantity: 1 };

    const out = await service.previewTransfer(body([line(rice, 1), gone]), req());

    expect(out.lines).toEqual([{ product: rice._id, variantId: null, stock: 42 }]);
    expect(out.blocked).toEqual([
      expect.objectContaining({ product: gone.product, message: expect.stringContaining('পুরোনো পণ্য') }),
    ]);
  });

  it('refuses a preview from a branch the user is not standing in', async () => {
    const rice = product({ code: 'RICE', branch: BRANCH_A, stock: 50 });
    await expect(service.previewTransfer(body([line(rice, 1)]), req({ branch: BRANCH_B })))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});

// ── Suggestions ─────────────────────────────────────────────────────────────

describe('getTransferSuggestions', () => {
  const suggest = (r = req()) => service.getTransferSuggestions(SHOP, { toBranch: BRANCH_B }, r);

  it('tops the destination up to twice its minimum', async () => {
    const src = product({ code: 'RICE', branch: BRANCH_A, stock: 30, extra: { minStock: 5 } });
    product({ code: 'RICE', branch: BRANCH_B, stock: 1, extra: { minStock: 5 } });

    const { suggestions } = await suggest();

    expect(suggestions).toEqual([expect.objectContaining({
      product: src._id, destStock: 1, threshold: 5, sourceStock: 30, suggested: 9,
    })]);
  });

  it('never takes the source below its own minimum', async () => {
    product({ code: 'RICE', branch: BRANCH_A, stock: 7, extra: { minStock: 5 } });
    product({ code: 'RICE', branch: BRANCH_B, stock: 1, extra: { minStock: 5 } });
    product({ code: 'DAL', branch: BRANCH_A, stock: 5, extra: { minStock: 5 } });
    product({ code: 'DAL', branch: BRANCH_B, stock: 0, extra: { minStock: 5 } });

    const { suggestions } = await suggest();

    expect(suggestions).toHaveLength(1); // DAL has nothing to spare
    expect(suggestions[0]).toMatchObject({ productCode: 'RICE', suggested: 2 });
  });

  it('skips shelves that are not low, and products the source does not stock', async () => {
    product({ code: 'RICE', branch: BRANCH_A, stock: 30, extra: { minStock: 5 } });
    product({ code: 'RICE', branch: BRANCH_B, stock: 5, extra: { minStock: 5 } }); // at minimum
    product({ code: 'OIL', branch: BRANCH_B, stock: 0, extra: { minStock: 5 } });  // B only

    expect((await suggest()).suggestions).toEqual([]);
  });

  it('suggests a low variant by the SOURCE variant id', async () => {
    const srcXl = variant('SH-XL', 'XL', 20);
    product({ code: 'SH', branch: BRANCH_A, variants: [srcXl] });
    product({ code: 'SH', branch: BRANCH_B, variants: [variant('SH-XL', 'XL', 1)] });

    const { suggestions } = await suggest();

    // No minStock → variant threshold 5: want 10 - 1 = 9, spare 20 - 5 = 15.
    expect(suggestions).toEqual([expect.objectContaining({ variantId: srcXl._id, suggested: 9 })]);
  });

  it('is owner only — it reads the other branch\'s stock', async () => {
    await expect(suggest(req({ owner: false, perms: STAFF_ALL })))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});
