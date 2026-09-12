/**
 * List endpoints clamp their page size.
 *
 * `limit` used to go from the query string straight into `.limit()`, so a
 * single `GET /api/products?limit=100000` (or `/customers`, or `/sales`)
 * materialised a shop's whole book — plus populate chains — into one PM2
 * worker's heap. Nothing in the app asks for more than 1000 rows a page (the
 * SMS recipient picker asks for exactly that; report downloads walk 200 at a
 * time and follow `pagination.pages`), so the cap changes no screen. It only
 * changes what an abusive or mistyped request can do to a worker.
 *
 * The services are loaded with their models stubbed — this asserts the QUERY
 * that is built, which needs no database. Against the pre-clamp code every
 * "caps" case here fails (the stub records `limit(100000)`), and the "keeps"
 * cases pass both ways: they are the guard that the clamp never narrows a
 * legitimate page.
 */

const mongoose = require('mongoose');

// ── Query stubs that record what .limit()/.skip() were asked for ────────────
const calls = { limit: [], skip: [] };

function makeQueryStub(result) {
  const q = {
    select: () => q,
    populate: () => q,
    sort: () => q,
    skip: (v) => { calls.skip.push(v); return q; },
    limit: (v) => { calls.limit.push(v); return q; },
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

jest.mock('../models/Customer.model', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(() => Promise.resolve(0)),
  aggregate: jest.fn(() => Promise.resolve([])),
  schema: { indexes: () => [] },
}));

jest.mock('../models/Sale.model', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(() => Promise.resolve(0)),
  aggregate: jest.fn(() => Promise.resolve([])),
  schema: { indexes: () => [] },
}));

jest.mock('../services/cache.service', () => ({
  get: jest.fn(() => Promise.resolve(null)),
  set: jest.fn(() => Promise.resolve(true)),
  del: jest.fn(() => Promise.resolve(true)),
  getShopCacheVersion: jest.fn(() => Promise.resolve(1)),
  bumpShopCacheVersion: jest.fn(() => Promise.resolve(2)),
}));

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));

const Product = require('../models/Product.model');
const Customer = require('../models/Customer.model');
const Sale = require('../models/Sale.model');
const productService = require('../services/product.service');
const customerService = require('../services/customer.service');
const saleService = require('../services/sale.service');

const SHOP = new mongoose.Types.ObjectId();
const req = () => ({
  shop: { _id: SHOP, multiBranchEnabled: false, features: {} },
  branch: null,
  branchId: null,
  user: { isOwner: true },
});

beforeEach(() => {
  calls.limit.length = 0;
  calls.skip.length = 0;
  Product.find.mockImplementation(() => makeQueryStub([]));
  Customer.find.mockImplementation(() => makeQueryStub([]));
  Sale.find.mockImplementation(() => makeQueryStub([]));
});

afterEach(() => jest.restoreAllMocks());

const lastLimit = () => calls.limit[calls.limit.length - 1];

describe('products list', () => {
  test('caps an oversized limit at 1000', async () => {
    const out = await productService.getProducts(SHOP, { limit: '100000' }, req());
    expect(lastLimit()).toBe(1000);
    expect(out.pagination.limit).toBe(1000);
  });

  test('keeps the sizes the app actually asks for', async () => {
    await productService.getProducts(SHOP, { limit: '100' }, req());
    expect(lastLimit()).toBe(100);
    await productService.getProducts(SHOP, { limit: 200 }, req());
    expect(lastLimit()).toBe(200);
  });

  test('a junk or missing limit falls to the default, and page never goes below 1', async () => {
    const out = await productService.getProducts(SHOP, { limit: 'abc', page: '-3' }, req());
    expect(lastLimit()).toBe(20);
    expect(out.pagination.page).toBe(1);
    expect(calls.skip[calls.skip.length - 1]).toBe(0);
  });
});

describe('customers list (shared book)', () => {
  test('caps an oversized limit at 1000', async () => {
    const out = await customerService.getCustomers(SHOP, { limit: '100000' }, req());
    expect(lastLimit()).toBe(1000);
    expect(out.pagination.limit).toBe(1000);
  });

  test('the SMS recipient picker still gets its 1000', async () => {
    await customerService.getCustomers(SHOP, { limit: '1000' }, req());
    expect(lastLimit()).toBe(1000);
  });

  test('page 3 of 20 skips 40 and reports its page as a number', async () => {
    const out = await customerService.getCustomers(SHOP, { page: '3', limit: '20' }, req());
    expect(calls.skip[calls.skip.length - 1]).toBe(40);
    expect(out.pagination.page).toBe(3);
    expect(out.pagination.pages).toBe(0);
  });
});

describe('sales list', () => {
  test('caps an oversized limit at 1000', async () => {
    const out = await saleService.getSales(SHOP, { limit: '100000' });
    expect(lastLimit()).toBe(1000);
    expect(out.pagination.limit).toBe(1000);
  });

  test('a zero or negative limit becomes 1, never an unbounded query', async () => {
    await saleService.getSales(SHOP, { limit: '0' });
    expect(lastLimit()).toBe(20);
    await saleService.getSales(SHOP, { limit: '-5' });
    expect(lastLimit()).toBe(1);
  });
});
