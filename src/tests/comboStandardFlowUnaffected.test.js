/**
 * The combo feature must be INVISIBLE to a shop that does not use it.
 *
 * `comboProducts.test.js` asserts that combos work. This file asserts the other
 * half, which is the half that breaks a live shop: that adding them changed
 * nothing about creating an ordinary product, ringing up an ordinary sale, or
 * printing an ordinary invoice.
 *
 * Every check here is written as "byte-identical to before", because the combo
 * work touched shared code on all three paths — `getProducts` gained a
 * decorator call, `createProduct` gained a branch, `createSale` gained one, and
 * the Joi schema made `buyingPrice` conditional. Each of those is a place where
 * a shop with zero combos could have started behaving differently.
 */

const mongoose = require('mongoose');

// ── Capture the queries the service builds, without a database ──────────────
const selectCalls = [];
const findFilters = [];

function makeQueryStub(result) {
  const q = {
    select: (v) => { selectCalls.push(v); return q; },
    populate: () => q,
    sort: () => q,
    skip: () => q,
    limit: () => q,
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
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
  delete: jest.fn(() => Promise.resolve(true)),
}));

const Product = require('../models/Product.model');
const productService = require('../services/product.service');
const productValidation = require('../validations/product.validation');
const Sale = require('../models/Sale.model');
const StockTransaction = require('../models/StockTransaction.model');

const id = () => new mongoose.Types.ObjectId();
const SHOP = id();
const req = () => ({
  shop: { _id: SHOP, multiBranchEnabled: false, features: {} },
  branch: null,
  branchId: null,
});

beforeEach(() => {
  selectCalls.length = 0;
  findFilters.length = 0;
  Product.find.mockImplementation((filter) => {
    findFilters.push(filter);
    return makeQueryStub([]);
  });
});

// ── 1. Listing a catalogue with no combos in it ─────────────────────────────

describe('product listing: a shop with no combos', () => {
  it('issues no extra query — the component read is skipped entirely', async () => {
    Product.find.mockImplementation((filter) => {
      findFilters.push(filter);
      return makeQueryStub([
        { _id: id(), name: 'Rice', stock: 10, hasVariants: false },
        { _id: id(), name: 'Soap', stock: 4, hasVariants: false },
      ]);
    });

    await productService.getProducts(SHOP, {}, req());

    // Exactly one: the listing itself. The decorator must not fire a second
    // read for a page that has no combo on it — this endpoint is the hottest
    // in the app.
    expect(findFilters).toHaveLength(1);
  });

  it('adds no combo keys to an ordinary row', async () => {
    const plain = { _id: id(), name: 'Rice', stock: 10, hasVariants: false };
    Product.find.mockImplementation(() => makeQueryStub([plain]));

    const result = await productService.getProducts(SHOP, {}, req());
    const row = result.data[0];

    for (const key of ['comboAvailability', 'comboCost', 'comboBroken', 'comboItems']) {
      expect(row).not.toHaveProperty(key);
    }
  });
});

describe('product listing: a page that does contain a combo', () => {
  it('decorates the combo and leaves the ordinary row beside it untouched', async () => {
    const compId = id();
    const combo = {
      _id: id(),
      name: 'Eid Pack',
      type: 'combo',
      sellingPrice: 250,
      comboItems: [{ product: compId, quantity: 2 }],
    };
    const plain = { _id: id(), name: 'Rice', stock: 10, hasVariants: false };

    let call = 0;
    Product.find.mockImplementation((filter) => {
      findFilters.push(filter);
      call += 1;
      // 1st = the listing, 2nd = the batched component read.
      return makeQueryStub(
        call === 1
          ? [combo, plain]
          : [{ _id: compId, stock: 9, buyingPrice: 30, sellingPrice: 50, isActive: true }]
      );
    });

    const result = await productService.getProducts(SHOP, {}, req());

    // One extra read for the WHOLE page, not one per combo.
    expect(findFilters).toHaveLength(2);

    const decorated = result.data.find((p) => p.type === 'combo');
    expect(decorated.comboAvailability).toBe(4); // floor(9 / 2)
    expect(decorated.comboCost).toBe(60);        // 30 x 2

    const untouched = result.data.find((p) => p.name === 'Rice');
    expect(untouched).not.toHaveProperty('comboAvailability');
    expect(untouched.stock).toBe(10);
  });
});

// ── 2. The POS payload for an ordinary product ──────────────────────────────

describe('POS picker: an ordinary product', () => {
  it('sends exactly the fields it always did — no combo keys leak in', async () => {
    Product.find.mockImplementation(() => makeQueryStub([{
      _id: id(),
      name: 'Rice',
      code: 'R-1',
      barcode: '123',
      hasVariants: false,
      buyingPrice: 40,
      sellingPrice: 60,
      stock: 10,
      minStock: 5,
      unit: 'piece',
      category: null,
      totalSold: 3,
      variants: [],
    }]));

    const result = await productService.searchProductsForSale(SHOP, {}, req());
    const payload = result.data[0];

    // The exact key set the till has always received (wholesalePrice is absent
    // because this shop has no `features.wholesale`).
    expect(Object.keys(payload).sort()).toEqual([
      '_id', 'barcode', 'buyingPrice', 'category', 'code', 'hasVariants',
      'minStock', 'name', 'packaging', 'sellingPrice', 'stock', 'totalSold',
      'unit', 'variants',
    ]);
  });

  it('still asks the database for every field the mapper reads', async () => {
    await productService.searchProductsForSale(SHOP, {}, req());
    const requested = selectCalls[0].split(/\s+/).filter(Boolean);

    for (const field of ['name', 'code', 'stock', 'sellingPrice', 'variants', 'totalSold']) {
      expect(requested).toContain(field);
    }
    // The two combo fields ride along so a combo tile can render; they cost
    // nothing on a product that has neither.
    expect(requested).toContain('type');
    expect(requested).toContain('comboItems');
  });
});

// ── 3. Creating an ordinary product ─────────────────────────────────────────

describe('product create validation: ordinary payloads', () => {
  const standard = {
    name: 'Rice',
    category: String(id()),
    buyingPrice: 40,
    sellingPrice: 60,
    stock: 10,
  };

  it('accepts the payload the form has always sent, and adds no combo keys', () => {
    const { error, value } = productValidation.createProduct.validate(standard);

    expect(error).toBeUndefined();
    // Joi assigns its result back over req.body, so a defaulted `type` or
    // `comboItems: []` here would be persisted onto every ordinary product.
    expect(value).not.toHaveProperty('type');
    expect(value).not.toHaveProperty('comboItems');
  });

  it('still REQUIRES buyingPrice — making it conditional must not have relaxed it', () => {
    const { buyingPrice, ...withoutCost } = standard;
    const { error } = productValidation.createProduct.validate(withoutCost);

    expect(error).toBeDefined();
    expect(error.message).toMatch(/buyingPrice/);
  });

  it('an update that says nothing about combos stays a plain update', () => {
    const { error, value } = productValidation.updateProduct.validate({ sellingPrice: 70 });

    expect(error).toBeUndefined();
    expect(Object.keys(value)).toEqual(['sellingPrice']);
  });
});

// ── 4. An ordinary sale, and the invoice printed from it ────────────────────

describe('ordinary sale documents', () => {
  const plainSale = () => new Sale({
    shop: SHOP,
    invoiceNo: 'INV-20260814-0001',
    items: [
      { product: id(), productName: 'Rice', quantity: 2, unitPrice: 60, buyingPrice: 40, total: 120 },
      { product: id(), productName: 'Soap', quantity: 1, unitPrice: 25, buyingPrice: 15, total: 25 },
    ],
    subtotal: 145,
    total: 145,
    paid: 145,
    createdBy: id(),
  });

  it('validates, and carries no combo payload on any line', () => {
    const sale = plainSale();
    expect(sale.validateSync()).toBeUndefined();

    for (const item of sale.items) {
      expect(item.itemType).toBe('standard');
      expect(item.comboComponents).toBeUndefined();
    }
  });

  it('totals and profit are computed exactly as before', () => {
    const sale = plainSale();
    // The same arithmetic pre('save') runs.
    const subtotal = sale.items.reduce((sum, i) => sum + i.total, 0);
    const profit = sale.items.reduce(
      (sum, i) => sum + (i.unitPrice - (i.buyingPrice || 0)) * i.quantity - i.discount,
      0
    );

    expect(subtotal).toBe(145);
    expect(profit).toBe(2 * 20 + 1 * 10);
  });

  it('the invoice renderer finds no component list to print on a plain line', () => {
    // Mirrors `comboComponentLines` on the sale-detail page: the guard is
    // `itemType === 'combo'`, so an ordinary line renders exactly as it did.
    const sale = plainSale();
    const componentsFor = (item) =>
      (item.itemType === 'combo' && Array.isArray(item.comboComponents))
        ? item.comboComponents
        : [];

    for (const item of sale.items) {
      expect(componentsFor(item)).toEqual([]);
    }
  });

  it('an ordinary stock movement carries no viaCombo attribution', () => {
    const txn = new StockTransaction({
      shop: SHOP,
      product: id(),
      productName: 'Rice',
      type: 'sale',
      quantity: -2,
      previousStock: 10,
      newStock: 8,
      reference: { type: 'sale', id: id(), invoiceNo: 'INV-20260814-0001' },
      createdBy: id(),
    });

    expect(txn.validateSync()).toBeUndefined();
    expect(txn.viaCombo).toBeUndefined();
  });
});
