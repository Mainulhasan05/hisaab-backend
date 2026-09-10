/**
 * `hasPhoto` — the online catalogue's "ছবি নেই" filter.
 *
 * The screen used to count only the photo-less rows on the page in front of the
 * shopkeeper, so a shop with four hundred unphotographed products was told
 * about twenty-three of them and given no way to reach the rest. This filter is
 * the other half of that fix; the inline uploader is the first.
 *
 * ── WHAT THIS FILE IS REALLY GUARDING ───────────────────────────────────────
 *
 * Not the filter on its own — the filter's AGREEMENT with
 * `bulkSetOnlineStatus`, which decides what a bulk publish silently skips. The
 * shopkeeper's workflow depends on the two being one predicate: filter to the
 * photo-less rows, photograph every one of them, publish, and find nothing
 * skipped. Two clauses that merely look alike would drift, and the drift would
 * surface as "৭৪টি পণ্য অনলাইনে যোগ হয়েছে, ৬টি বাদ পড়েছে" on a screen that had
 * just shown zero remaining — which reads as the count lying rather than as a
 * predicate disagreeing.
 *
 * So the assertions below compare the two shapes rather than restating either.
 *
 * Models are stubbed at module level (the harness from
 * onlineSellingFilter.test.js): this asserts the QUERY that is built, which
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
  updateMany: jest.fn(() => Promise.resolve({ matchedCount: 0, modifiedCount: 0 })),
  aggregate: jest.fn(() => Promise.resolve([])),
  schema: { indexes: () => [] },
}));

jest.mock('../models/AuditLog.model', () => ({
  create: jest.fn(() => Promise.resolve({})),
}));

jest.mock('../services/cache.service', () => ({
  get: jest.fn(() => Promise.resolve(null)),
  set: jest.fn(() => Promise.resolve(true)),
  bumpShopCacheVersion: jest.fn(() => Promise.resolve(true)),
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
  Product.countDocuments.mockReset();
  Product.countDocuments.mockImplementation(() => Promise.resolve(0));
  Product.updateMany.mockReset();
  Product.updateMany.mockImplementation(() =>
    Promise.resolve({ matchedCount: 0, modifiedCount: 0 })
  );
});

/** The mongo filter `getProducts` built for these query-string options. */
const queryFor = async (options) => {
  Product.find.mockClear();
  await productService.getProducts(SHOP, options, req());
  return Product.find.mock.calls[0][0];
};

/** The `$nor` clause `bulkSetOnlineStatus` excludes when publishing. */
const bulkNorClause = async () => {
  Product.updateMany.mockClear();
  await productService.bulkSetOnlineStatus(
    SHOP,
    new mongoose.Types.ObjectId(),
    req(),
    { productIds: [String(new mongoose.Types.ObjectId())], isAvailableOnline: true }
  );
  return Product.updateMany.mock.calls[0][0].$nor[0];
};

describe('hasPhoto filter', () => {
  it('is absent when nothing asked for it — the default list is untouched', async () => {
    const q = await queryFor({});
    expect(q.$and).toBeUndefined();
  });

  it('hasPhoto=false selects products with neither pipeline populated', async () => {
    const q = await queryFor({ hasPhoto: 'false' });
    // Both arrays have to be empty or absent. A product with a legacy ImgBB
    // row and no `catalogImages` HAS a photo and must not be listed here.
    expect(q.$and).toEqual([
      {
        $and: [
          { $or: [{ catalogImages: { $size: 0 } }, { catalogImages: { $exists: false } }] },
          { $or: [{ images: { $size: 0 } }, { images: { $exists: false } }] },
        ],
      },
    ]);
  });

  it('hasPhoto=true is the exact negation, not a separate rule', async () => {
    const [no, yes] = [
      (await queryFor({ hasPhoto: 'false' })).$and[0],
      (await queryFor({ hasPhoto: 'true' })).$and[0],
    ];
    expect(yes).toEqual({ $nor: [no] });
  });

  it('accepts real booleans as well as query-string strings', async () => {
    expect((await queryFor({ hasPhoto: false })).$and)
      .toEqual((await queryFor({ hasPhoto: 'false' })).$and);
    expect((await queryFor({ hasPhoto: true })).$and)
      .toEqual((await queryFor({ hasPhoto: 'true' })).$and);
  });
});

describe('the filter and the bulk-publish skip are one predicate', () => {
  it('what "ছবি নেই" lists is exactly what a bulk publish refuses', async () => {
    const listed = (await queryFor({ hasPhoto: 'false' })).$and[0];
    expect(await bulkNorClause()).toEqual(listed);
  });
});

describe('composition with the filters that already own $or', () => {
  /**
   * `$or` is claimed by search and by low-stock, and a second `$or` key on the
   * same object silently discards the first. The photo clause therefore rides
   * on `$and`, which Mongo ANDs with `$or` at the top level.
   */
  it('leaves a search $or intact', async () => {
    const q = await queryFor({ search: 'চাল', hasPhoto: 'false' });
    expect(Array.isArray(q.$or)).toBe(true);
    expect(q.$or.length).toBeGreaterThan(0);
    expect(q.$and).toHaveLength(1);
  });

  it('appends to an existing $and rather than replacing it', async () => {
    // search + lowStock is the one combination that already builds `$and`.
    const both = await queryFor({ search: 'চাল', lowStock: 'true', hasPhoto: 'false' });
    const without = await queryFor({ search: 'চাল', lowStock: 'true' });

    expect(without.$and).toHaveLength(2);
    expect(both.$and).toHaveLength(3);
    // The two pre-existing clauses survive, in order, ahead of the new one.
    expect(both.$and.slice(0, 2)).toEqual(without.$and);
  });
});
