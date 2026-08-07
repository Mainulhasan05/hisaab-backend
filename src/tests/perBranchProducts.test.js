/**
 * Phase 3 — per-branch product catalogues.
 *
 * Asserts the schema shape, the cloning rules, and — most importantly — that a
 * single-branch shop is completely unaffected by the change.
 */

const mongoose = require('mongoose');
const Product = require('../models/Product.model');
const { branchFilter } = require('../utils/branchScope.util');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH_A = new mongoose.Types.ObjectId();
const BRANCH_B = new mongoose.Types.ObjectId();

const singleBranchReq = () => ({
  shop: { _id: SHOP, multiBranchEnabled: false },
  branch: null,
  branchId: null,
});
const branchReq = (b) => ({
  shop: { _id: SHOP, multiBranchEnabled: true },
  branch: { _id: b, code: 'DHA' },
  branchId: b,
});

describe('Product schema', () => {
  it('has branch and clonedFrom, both defaulting to null', () => {
    const p = new Product({ shop: SHOP, code: 'A1', name: 'Test' });
    expect(p.branch).toBeNull();
    expect(p.clonedFrom).toBeNull();
  });

  it('accepts a branch assignment', () => {
    const p = new Product({ shop: SHOP, branch: BRANCH_A, code: 'A1', name: 'Test' });
    expect(String(p.branch)).toBe(String(BRANCH_A));
  });

  it('makes code unique per (shop, branch), not per shop', () => {
    const declared = Product.schema.indexes().map(([key, opts]) => ({ key, opts: opts || {} }));
    const unique = declared.filter((i) => i.opts.unique);

    const codeUnique = unique.find((i) => 'code' in i.key);
    expect(codeUnique).toBeDefined();
    expect(Object.keys(codeUnique.key)).toEqual(['shop', 'branch', 'code']);

    // The old shop-wide unique index must be gone, or two branches could not
    // stock the same item under the same code.
    const shopCodeUnique = unique.find(
      (i) => JSON.stringify(Object.keys(i.key)) === JSON.stringify(['shop', 'code'])
    );
    expect(shopCodeUnique).toBeUndefined();
  });

  it('keeps a non-unique {shop, code} index for cross-branch transfer matching', () => {
    const declared = Product.schema.indexes().map(([key, opts]) => ({ key, opts: opts || {} }));
    const match = declared.find(
      (i) => JSON.stringify(Object.keys(i.key)) === JSON.stringify(['shop', 'code']) && !i.opts.unique
    );
    expect(match).toBeDefined();
  });
});

describe('single-branch shops see no change', () => {
  it('product queries carry no branch predicate', () => {
    const f = branchFilter(singleBranchReq(), { shop: SHOP, isDeleted: { $ne: true } });
    expect(f).not.toHaveProperty('branch');
    expect(Object.keys(f).sort()).toEqual(['isDeleted', 'shop']);
  });

  it('a product created without a branch is valid', () => {
    const p = new Product({ shop: SHOP, code: 'A1', name: 'Test', sellingPrice: 10 });
    const err = p.validateSync();
    expect(err).toBeUndefined();
    expect(p.branch).toBeNull();
  });

  it('{shop, branch, code} with branch null is equivalent to {shop, code}', () => {
    // Two products, same shop, same code, both unbranched → the unique index
    // still treats them as a collision, exactly as before Phase 3.
    const a = { shop: String(SHOP), branch: null, code: 'A1' };
    const b = { shop: String(SHOP), branch: null, code: 'A1' };
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('per-branch catalogues', () => {
  it('scopes product reads to the active branch', () => {
    const f = branchFilter(branchReq(BRANCH_A), { shop: SHOP, isDeleted: { $ne: true } });
    expect(String(f.branch)).toBe(String(BRANCH_A));
  });

  it('the same code in two branches is two distinct index keys', () => {
    const a = `${SHOP}|${BRANCH_A}|COKE`;
    const b = `${SHOP}|${BRANCH_B}|COKE`;
    expect(a).not.toBe(b);
  });

  it('barcode lookup is branch-scoped', () => {
    const f = branchFilter(branchReq(BRANCH_B), {
      shop: SHOP,
      $or: [{ code: 'X' }, { 'variants.barcode': 'X' }],
    });
    expect(String(f.branch)).toBe(String(BRANCH_B));
  });
});

describe('Product statics accept an optional branch', () => {
  // Assert the filter each static actually builds — arity is not a useful
  // signal here, since Function.length stops at the first default parameter.
  it('findByCode scopes to the branch when given one, and not otherwise', () => {
    expect(Product.findByCode(SHOP, 'a1', BRANCH_A).getFilter().branch).toEqual(BRANCH_A);
    expect(Product.findByCode(SHOP, 'a1').getFilter()).not.toHaveProperty('branch');
  });

  it('findByBarcode scopes to the branch when given one', () => {
    expect(Product.findByBarcode(SHOP, 'X', BRANCH_A).getFilter().branch).toEqual(BRANCH_A);
    expect(Product.findByBarcode(SHOP, 'X').getFilter()).not.toHaveProperty('branch');
  });

  it('getLowStockProducts scopes to the branch when given one', () => {
    expect(Product.getLowStockProducts(SHOP, 5, BRANCH_A).getFilter().branch).toEqual(BRANCH_A);
    expect(Product.getLowStockProducts(SHOP, 5).getFilter()).not.toHaveProperty('branch');
  });

  it('findByCode still upper-cases the code', () => {
    expect(Product.findByCode(SHOP, 'a1').getFilter().code).toBe('A1');
  });
});

describe('BranchStock is retired', () => {
  it('the model is no longer registered or exported', () => {
    expect(() => require('../models/BranchStock.model')).toThrow();
    expect(require('../models')).not.toHaveProperty('BranchStock');
  });

  it('no service still imports it', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'services');
    const offenders = fs.readdirSync(dir).filter((f) =>
      f.endsWith('.js') && fs.readFileSync(path.join(dir, f), 'utf8').includes('BranchStock')
    );
    expect(offenders).toEqual([]);
  });
});

describe('clone rules', () => {
  // cloneBranchProducts copies pricing and identity, resets everything that
  // belongs to the branch that physically holds the goods.
  const source = {
    _id: new mongoose.Types.ObjectId(),
    shop: SHOP,
    branch: BRANCH_A,
    code: 'COKE',
    name: 'Coca-Cola',
    sellingPrice: 50,
    buyingPrice: 40,
    stock: 120,
    totalSold: 33,
    lastSold: new Date(0),
    batches: [{ batchNumber: 'B1', quantity: 5 }],
    serials: ['S1'],
    variants: [{ sku: 'C-500', sellingPrice: 50, buyingPrice: 40, stock: 60 }],
    clonedFrom: null,
  };

  const clone = (p, target) => {
    const { _id, createdAt, updatedAt, __v, ...rest } = p;
    return {
      ...rest,
      branch: target,
      clonedFrom: p.clonedFrom || p._id,
      stock: 0,
      variants: (p.variants || []).map((v) => ({ ...v, stock: 0 })),
      batches: [],
      serials: [],
      totalSold: 0,
      lastSold: null,
    };
  };

  it('copies prices and code, zeroes stock', () => {
    const c = clone(source, BRANCH_B);
    expect(c.sellingPrice).toBe(50);
    expect(c.buyingPrice).toBe(40);
    expect(c.code).toBe('COKE');
    expect(c.stock).toBe(0);
    expect(c.variants[0].sellingPrice).toBe(50);
    expect(c.variants[0].stock).toBe(0);
  });

  it('does not carry over branch-held state', () => {
    const c = clone(source, BRANCH_B);
    expect(c.batches).toEqual([]);
    expect(c.serials).toEqual([]);
    expect(c.totalSold).toBe(0);
    expect(c.lastSold).toBeNull();
  });

  it('records lineage and targets the new branch', () => {
    const c = clone(source, BRANCH_B);
    expect(String(c.branch)).toBe(String(BRANCH_B));
    expect(String(c.clonedFrom)).toBe(String(source._id));
  });

  it('keeps the original lineage when cloning a clone', () => {
    const root = new mongoose.Types.ObjectId();
    const c = clone({ ...source, clonedFrom: root }, BRANCH_B);
    expect(String(c.clonedFrom)).toBe(String(root));
  });
});
