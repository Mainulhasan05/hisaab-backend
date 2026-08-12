/**
 * The online/offline list filter — all three states.
 *
 * `isAvailableOnline` is a tri-state on the wire: absent means "no preference",
 * and `true` and `false` are both real questions. The server has always handled
 * all three; the CLIENT sent only one. `productsSlice.fetchProducts` read
 *
 *     if (filters.isAvailableOnline) params.append('isAvailableOnline', 'true')
 *
 * which had two faults stacked: `false` is falsy so it was never transmitted,
 * making "offline only" unreachable from the UI at all — and the value was
 * hardcoded, so even a corrected truthiness test would have asked the wrong
 * question. This file pins the server half so a future "simplification" back to
 * a boolean has something to fail against.
 *
 * Models are stubbed at module level (the harness from
 * productListProjection.test.js): this asserts the QUERY that is built, which
 * needs no database.
 */

const mongoose = require('mongoose');

function makeQueryStub(result) {
  const q = {
    select: () => q,
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
  Product.find.mockReset();
  Product.find.mockImplementation(() => makeQueryStub([]));
});

/** The mongo filter `getProducts` built for these query-string options. */
const queryFor = async (options) => {
  // Reset per call, not just per test: a case that asks twice would otherwise
  // read the FIRST call's query both times and pass on the wrong evidence.
  Product.find.mockClear();
  await productService.getProducts(SHOP, options, req());
  return Product.find.mock.calls[0][0];
};

describe('online availability filter', () => {
  it('narrows to online products', async () => {
    expect((await queryFor({ isAvailableOnline: 'true' })).isAvailableOnline).toBe(true);
  });

  it('narrows to offline products — the state the UI could never ask for', async () => {
    expect((await queryFor({ isAvailableOnline: 'false' })).isAvailableOnline).toBe(false);
  });

  it('accepts real booleans as well as query-string strings', async () => {
    // The POS path and internal callers pass booleans; the HTTP query string
    // can only ever produce strings. Both reach the same branch.
    expect((await queryFor({ isAvailableOnline: true })).isAvailableOnline).toBe(true);
    expect((await queryFor({ isAvailableOnline: false })).isAvailableOnline).toBe(false);
  });

  it.each([
    ['omitted', {}],
    ['null', { isAvailableOnline: null }],
    ['empty string', { isAvailableOnline: '' }],
  ])('leaves the query unconstrained when the preference is %s', async (_label, options) => {
    // "No preference" must not collapse into "offline", which is what a plain
    // `Boolean(value)` cast would do to every one of these.
    expect(await queryFor(options)).not.toHaveProperty('isAvailableOnline');
  });
});
