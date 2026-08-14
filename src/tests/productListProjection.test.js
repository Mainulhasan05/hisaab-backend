/**
 * Projections on the product list and the POS picker.
 *
 * `getProducts` used to return whole product documents — description, batches,
 * serials and both image arrays included — for a paginated list that renders
 * none of them. `searchProductsForSale` then reduced each row to fourteen
 * fields in JavaScript, having already paid to fetch and deserialise the rest,
 * on an endpoint the till fires per keystroke.
 *
 * Both now project in the database. That is only safe while the projections
 * still cover every field their consumers read, and a missing field is a blank
 * column that nobody notices until a shopkeeper reports it. So the field lists
 * are asserted here rather than trusted.
 *
 * The service is loaded with its Mongoose models stubbed — this asserts the
 * QUERY that is built, which needs no database.
 */

const mongoose = require('mongoose');

// ── Capture what .select() is asked for, without a database ─────────────────
const selectCalls = [];

function makeQueryStub(result) {
  const q = {
    select: (v) => { selectCalls.push(v); return q; },
    populate: () => q,
    sort: () => q,
    skip: () => q,
    limit: () => q,
    lean: () => Promise.resolve(result),
  };
  return q;
}

jest.mock('../models/Product.model', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(() => Promise.resolve(0)),
  aggregate: jest.fn(() => Promise.resolve([])),
  schema: { indexes: () => [] },
}));

jest.mock('../services/cache.service', () => ({
  get: jest.fn(() => Promise.resolve(null)),
  set: jest.fn(() => Promise.resolve(true)),
}));

const Product = require('../models/Product.model');
const productService = require('../services/product.service');

const SHOP = new mongoose.Types.ObjectId();
const req = () => ({
  shop: { _id: SHOP, multiBranchEnabled: false, features: {} },
  branch: null,
  branchId: null,
});

beforeEach(() => {
  selectCalls.length = 0;
  Product.find.mockImplementation(() => makeQueryStub([]));
});

describe('product list projection', () => {
  it('excludes the heavy fields no list view renders', async () => {
    await productService.getProducts(SHOP, {}, req());

    expect(selectCalls).toHaveLength(1);
    const projection = selectCalls[0];

    // Exclusion form: everything else on the model still comes back, so a field
    // added to the schema later is visible to the list without anyone
    // remembering to add it here.
    for (const field of ['description', 'batches', 'serials', 'images', 'catalogImages']) {
      expect(projection).toContain(`-${field}`);
    }
  });

  it('does not let the client choose the projection', async () => {
    // getProducts is called as getProducts(shopId, req.query, req), so its
    // options object IS the query string. A plain `fields` key would let anyone
    // pass ?fields=-shop and strip the tenant field off every row.
    await productService.getProducts(SHOP, { fields: '-shop', projection: '_id' }, req());

    expect(selectCalls[0]).not.toBe('-shop');
    expect(selectCalls[0]).not.toBe('_id');
    expect(selectCalls[0]).toContain('-description');
  });
});

describe('POS picker projection', () => {
  /**
   * Every field `searchProductsForSale` reads off a product row. Kept in step
   * with the mapper in product.service.js — if that mapper starts reading a new
   * field, this list and the projection must both learn about it, and this test
   * is what says so.
   */
  const POS_READS = [
    'name', 'code', 'barcode', 'hasVariants', 'buyingPrice', 'sellingPrice',
    'wholesalePrice', 'stock', 'minStock', 'unit', 'packaging', 'category',
    'totalSold', 'variants',
  ];

  it('requests exactly the fields the POS payload builder reads', async () => {
    await productService.searchProductsForSale(SHOP, {}, req());

    expect(selectCalls).toHaveLength(1);
    const requested = selectCalls[0].split(/\s+/).filter(Boolean);

    for (const field of POS_READS) {
      expect(requested).toContain(field);
    }
  });

  it('is an allowlist — the heavy fields are simply absent', async () => {
    await productService.searchProductsForSale(SHOP, {}, req());
    const requested = selectCalls[0].split(/\s+/).filter(Boolean);

    for (const field of ['description', 'batches', 'serials', 'images', 'catalogImages']) {
      expect(requested).not.toContain(field);
    }
  });

  it('returns _id, which Mongo includes unless explicitly excluded', async () => {
    const id = new mongoose.Types.ObjectId();
    Product.find.mockImplementation(() =>
      makeQueryStub([{ _id: id, name: 'Test', variants: [] }])
    );

    const result = await productService.searchProductsForSale(SHOP, {}, req());

    expect(selectCalls[0]).not.toContain('-_id');
    expect(String(result.data[0]._id)).toBe(String(id));
  });
});
