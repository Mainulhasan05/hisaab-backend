/**
 * Finding products by their brand.
 *
 * Brands have been assignable since the feature shipped, but nothing could
 * FILTER on one: `getProducts` accepted `category`, `status`, `lowStock` and
 * `isAvailableOnline`, and a shop that had carefully tagged four hundred
 * products could not ask to see one brand's.
 *
 * Two halves are asserted here, because they fail differently:
 *
 *   · the explicit `brand=<id>` filter, which must reach the query;
 *   · a search TERM matching a brand name, which cannot be a `$regex` branch
 *     the way `name` and `code` are — `brand` is a ref, so the names have to be
 *     resolved to ids in a separate read first.
 *
 * Both are behind `features.brands`, and the capability tests are the point
 * rather than decoration: a shop without it stores `brand: null` on every
 * product, so a filter that leaked through would return an empty list and a
 * name search would buy a Brand query to find nothing.
 *
 * Models are stubbed — this asserts the QUERY that is built, and needs no
 * database. Same approach as productListProjection.test.js.
 */

const mongoose = require('mongoose');

// ── Capture the query `find()` was handed ───────────────────────────────────
const findCalls = [];

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

jest.mock('../models/Brand.model', () => ({
  find: jest.fn(),
}));

jest.mock('../services/cache.service', () => ({
  get: jest.fn(() => Promise.resolve(null)),
  set: jest.fn(() => Promise.resolve(true)),
}));

const Product = require('../models/Product.model');
const Brand = require('../models/Brand.model');
const productService = require('../services/product.service');

const SHOP = new mongoose.Types.ObjectId();
const BRAND_A = new mongoose.Types.ObjectId();
const BRAND_B = new mongoose.Types.ObjectId();

/** `brands` on unless a test says otherwise — the flag-off cases are explicit. */
const req = (features = { brands: true }) => ({
  shop: { _id: SHOP, multiBranchEnabled: false, features },
  branch: null,
  branchId: null,
});

/** The `$or` branches the search term built, or null if there was no search. */
const searchBranches = () => {
  const q = findCalls[0];
  return q.$or || (q.$and && q.$and[0] && q.$and[0].$or) || null;
};

const brandLookup = () => Brand.find.mock.calls[0]?.[0];

beforeEach(() => {
  findCalls.length = 0;
  Product.find.mockReset();
  Brand.find.mockReset();
  Product.find.mockImplementation((query) => {
    findCalls.push(query);
    return makeQueryStub([]);
  });
  Product.countDocuments.mockResolvedValue(0);
  Product.aggregate.mockResolvedValue([]);
  // Default: the shop has brands, none of them match anything.
  Brand.find.mockImplementation(() => ({
    select: () => ({ lean: () => Promise.resolve([]) }),
  }));
});

describe('brand filter', () => {
  it('narrows the catalogue to one brand', async () => {
    await productService.getProducts(SHOP, { brand: String(BRAND_A) }, req());

    expect(findCalls[0].brand).toBe(String(BRAND_A));
  });

  it('is absent when no brand is asked for, so the list stays whole', async () => {
    await productService.getProducts(SHOP, {}, req());

    expect(findCalls[0]).not.toHaveProperty('brand');
  });

  it('treats an empty string as "every brand", not as "the brand named nothing"', async () => {
    // What a cleared <select> sends. A truthiness test is the whole guard here,
    // and `query.brand = ''` would match no product and empty the page.
    await productService.getProducts(SHOP, { brand: '' }, req());

    expect(findCalls[0]).not.toHaveProperty('brand');
  });

  it('composes with the other filters rather than replacing them', async () => {
    // "The low-stock items of this one brand" is a real question, and the two
    // must survive together — `lowStock` builds an `$or`, which is exactly the
    // kind of clause a naive filter overwrites.
    await productService.getProducts(
      SHOP,
      { brand: String(BRAND_A), category: 'cat1', status: 'active', lowStock: 'true' },
      req()
    );

    const q = findCalls[0];
    expect(q.brand).toBe(String(BRAND_A));
    expect(q.category).toBe('cat1');
    expect(q.isActive).toBe(true);
    expect(q.$or).toBeDefined();
  });

  it('is ignored by a shop without the capability', async () => {
    // Fails closed, matching `_resolveBrand` on the write side. Such a shop has
    // `brand: null` on every product, so an honoured filter would answer an
    // empty list — which reads as "no products" rather than "not your feature".
    await productService.getProducts(SHOP, { brand: String(BRAND_A) }, req({}));

    expect(findCalls[0]).not.toHaveProperty('brand');
  });
});

describe('searching by brand name', () => {
  it('adds the matching brands as an $or branch alongside name and code', async () => {
    Brand.find.mockImplementation(() => ({
      select: () => ({ lean: () => Promise.resolve([{ _id: BRAND_A }, { _id: BRAND_B }]) }),
    }));

    await productService.getProducts(SHOP, { search: 'Square' }, req());

    const branches = searchBranches();
    const brandBranch = branches.find((b) => b.brand);
    expect(brandBranch).toEqual({ brand: { $in: [BRAND_A, BRAND_B] } });

    // ADDITIVE. A product literally named "Square" must still be found by name,
    // so the original branches have to survive the new one.
    expect(branches.some((b) => b.name)).toBe(true);
    expect(branches.some((b) => b.code)).toBe(true);
    expect(branches.some((b) => b.barcode)).toBe(true);
  });

  it('only consults active brands of this shop', async () => {
    await productService.getProducts(SHOP, { search: 'Square' }, req());

    const lookup = brandLookup();
    expect(lookup.shop).toBe(SHOP);
    expect(lookup.isActive).toBe(true);
  });

  it('regex-escapes the term before it reaches the brand lookup', async () => {
    // The product branches have always escaped; a second collection reading the
    // same raw term is a second place for a `.*(.*)*` to become a CPU burn.
    await productService.getProducts(SHOP, { search: 'a.*(b' }, req());

    expect(brandLookup().name.$regex).toBe('a\\.\\*\\(b');
  });

  it('adds no branch when no brand name matches', async () => {
    // Already the default stub: zero matches. The name/code/barcode branches
    // must still answer, or typing anything at all in a brands shop would
    // return nothing.
    await productService.getProducts(SHOP, { search: 'Square' }, req());

    const branches = searchBranches();
    expect(branches.some((b) => b.brand)).toBe(false);
    expect(branches.some((b) => b.name)).toBe(true);
  });

  it('does not touch the Brand collection when there is no search term', async () => {
    await productService.getProducts(SHOP, {}, req());

    expect(Brand.find).not.toHaveBeenCalled();
  });

  it('does not touch the Brand collection for a shop without the capability', async () => {
    await productService.getProducts(SHOP, { search: 'Square' }, req({}));

    expect(Brand.find).not.toHaveBeenCalled();
  });

  it('stays off the POS picker, which fires per keystroke and shows no brand', async () => {
    Brand.find.mockImplementation(() => ({
      select: () => ({ lean: () => Promise.resolve([{ _id: BRAND_A }]) }),
    }));

    await productService.searchProductsForSale(SHOP, { search: 'Square' }, req());

    expect(Brand.find).not.toHaveBeenCalled();
    expect(searchBranches().some((b) => b.brand)).toBe(false);
  });

  it('cannot be switched back on from the query string', async () => {
    // `searchProductsForSale` passes the BOOLEAN false after spreading the
    // client's query. A query string can only produce the string 'false', which
    // is not `!== false` — so neither value a client can send reaches the flag.
    Brand.find.mockImplementation(() => ({
      select: () => ({ lean: () => Promise.resolve([{ _id: BRAND_A }]) }),
    }));

    await productService.searchProductsForSale(
      SHOP,
      { search: 'Square', brandNameSearch: 'true' },
      req()
    );

    expect(Brand.find).not.toHaveBeenCalled();
  });

  it("a client's 'false' string does not disable it on the ordinary list", async () => {
    Brand.find.mockImplementation(() => ({
      select: () => ({ lean: () => Promise.resolve([{ _id: BRAND_A }]) }),
    }));

    await productService.getProducts(SHOP, { search: 'Square', brandNameSearch: 'false' }, req());

    expect(Brand.find).toHaveBeenCalled();
  });
});
