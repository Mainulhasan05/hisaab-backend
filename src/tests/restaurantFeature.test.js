/**
 * `features.restaurant` — uncounted stock (`Product.trackStock: false`) and the
 * serving units (প্লেট / বাটি / কাপ / গ্লাস).
 *
 * Two kinds of test live here, and CLAUDE.md §7.1 asks that they be told apart:
 *
 *   REGRESSION — fails against the code before this feature (the capability
 *                does not exist there). Marked [R].
 *   INVARIANT  — a shop without the flag is byte-identical. Passes before and
 *                after, by design. Marked [I].
 *
 * `createSale` / `cancelSale` / the return path cannot be run here without a
 * database (every model is mocked across this suite), so their skip logic is
 * pinned structurally at the bottom, the same way productSales.test.js and
 * dueSettlementAtCheckout.test.js pin that function.
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const {
  UNITS, LEGACY_UNITS, ALL_UNITS, SERVING_UNITS,
  unitsForShop, unitCatalogue, isServingUnit, unitDecimals,
} = require('../config/units');
const { quantityUnit, parseQuantity } = require('../utils/quantity.util');
const {
  isStockTracked, TRACKED_FILTER, normalizeTrackStock, assertTracked,
} = require('../utils/stockTracking.util');
const { computeComboAvailability, UNLIMITED_COMBO_AVAILABILITY } = require('../utils/combo.util');
const { FEATURES, FEATURE_KEYS } = require('../utils/features.util');
const productValidation = require('../validations/product.validation');
const Product = require('../models/Product.model');
const Sale = require('../models/Sale.model');
const Shop = require('../models/Shop.model');

const id = () => new mongoose.Types.ObjectId();
const reqWith = (features = {}) => ({
  shop: { _id: id(), multiBranchEnabled: false, features },
  branchId: null,
});
const OFF = reqWith({});
const ON = reqWith({ restaurant: true });

// ── The flag ────────────────────────────────────────────────────────────────

describe('registry', () => {
  it('[R] restaurant is a registered capability with no prerequisite', () => {
    expect(FEATURE_KEYS).toContain('restaurant');
    expect(FEATURES.restaurant.requires).toEqual([]);
  });

  it('[I] defaults OFF on the shop document', () => {
    const shop = new Shop({ name: 'x' });
    expect(shop.features.restaurant).toBe(false);
  });
});

// ── Serving units ───────────────────────────────────────────────────────────

describe('serving units', () => {
  it('[I] LEGACY_UNITS is still exactly the 13', () => {
    expect(LEGACY_UNITS).toHaveLength(13);
    for (const u of SERVING_UNITS) expect(LEGACY_UNITS).not.toContain(u);
  });

  it('[I] a shop with neither flag sees exactly the 13, bare-boolean call included', () => {
    expect(unitsForShop(false)).toEqual([...LEGACY_UNITS]);
    expect(unitsForShop({ packaging: false, restaurant: false })).toEqual([...LEGACY_UNITS]);
  });

  it('[I] packaging WITHOUT restaurant sees exactly what it saw before serving units existed', () => {
    const before = ALL_UNITS.filter((u) => UNITS[u].group !== 'serving');
    expect(unitsForShop(true)).toEqual(before);
    expect(unitsForShop({ packaging: true })).toEqual(before);
    const offered = unitCatalogue(true).groups.map((g) => g.key);
    expect(offered).not.toContain('serving');
  });

  it('[R] restaurant adds প্লেট / বাটি / কাপ / গ্লাস on top of the 13, not the 52', () => {
    const units = unitsForShop({ packaging: false, restaurant: true });
    expect(units).toEqual([...LEGACY_UNITS, 'plate', 'bowl', 'cup', 'glass']);
    expect(units).not.toContain('maund');
  });

  it('[R] both flags = everything', () => {
    expect(unitsForShop({ packaging: true, restaurant: true }).sort()).toEqual([...ALL_UNITS].sort());
  });

  it('[R] প্লেট and বাটি take a half; কাপ and গ্লাস do not', () => {
    expect(unitDecimals('plate')).toBe(1);
    expect(unitDecimals('bowl')).toBe(1);
    expect(unitDecimals('cup')).toBe(0);
    expect(unitDecimals('glass')).toBe(0);
    expect(isServingUnit('plate')).toBe(true);
    expect(isServingUnit('kg')).toBe(false);
  });

  it('[R] দেড় প্লেট is accepted with restaurant alone', () => {
    const rice = { unit: 'plate' };
    expect(quantityUnit(ON, rice)).toBe('plate');
    expect(parseQuantity('1.5', quantityUnit(ON, rice))).toBe(1.5);
  });

  it('[I] without the flag a প্লেট product falls back to whole numbers, never unsellable', () => {
    const rice = { unit: 'plate' };
    expect(quantityUnit(OFF, rice)).toBe('piece');
    expect(() => parseQuantity('1.5', quantityUnit(OFF, rice))).toThrow();
    expect(parseQuantity('2', quantityUnit(OFF, rice))).toBe(2);
  });

  it('[I] restaurant does not unlock fractions on a non-serving unit', () => {
    expect(quantityUnit(ON, { unit: 'kg' })).toBe('piece');
  });
});

// ── The two gates ───────────────────────────────────────────────────────────

describe('isStockTracked — DATA only', () => {
  it('[I] absent means counted — every product that existed before', () => {
    expect(isStockTracked({})).toBe(true);
    expect(isStockTracked({ trackStock: undefined })).toBe(true);
    expect(isStockTracked(null)).toBe(true);
  });

  it('[R] false means uncounted, regardless of any flag', () => {
    expect(isStockTracked({ trackStock: false })).toBe(false);
  });

  it('[R] the filter matches absent AND true, excludes false', () => {
    expect(TRACKED_FILTER).toEqual({ trackStock: { $ne: false } });
  });
});

describe('normalizeTrackStock — WRITE gate', () => {
  it('[I] absent stays absent', () => {
    expect(normalizeTrackStock(undefined, OFF)).toBeUndefined();
  });

  it('[R] false is refused without the capability', () => {
    expect(() => normalizeTrackStock(false, OFF)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('[R] false is accepted with it', () => {
    expect(normalizeTrackStock(false, ON)).toBe(false);
  });

  it('[R] true is always allowed — a shop that lost the flag can go back to counting', () => {
    expect(normalizeTrackStock(true, OFF)).toBe(true);
  });
});

describe('assertTracked — stock-in paths refuse an uncounted product', () => {
  it('[R] refuses, naming the product', () => {
    expect(() => assertTracked({ name: 'ভাত', trackStock: false }, 'ক্রয়'))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
  });
  it('[I] lets a counted product through', () => {
    expect(() => assertTracked({ name: 'চাল' }, 'ক্রয়')).not.toThrow();
  });
});

// ── Product create / update ─────────────────────────────────────────────────

describe('product payloads', () => {
  const productService = require('../services/product.service');

  it('[I] Joi adds no trackStock key to an ordinary create or update', () => {
    const { value } = productValidation.createProduct.validate({
      name: 'Rice', category: String(id()), buyingPrice: 40, sellingPrice: 60, stock: 10,
    });
    expect(value).not.toHaveProperty('trackStock');
    const upd = productValidation.updateProduct.validate({ sellingPrice: 70 });
    expect(Object.keys(upd.value)).toEqual(['sellingPrice']);
  });

  it('[R] Joi admits trackStock (stripUnknown would otherwise drop it silently)', () => {
    const { error, value } = productValidation.updateProduct.validate({ trackStock: false });
    expect(error).toBeUndefined();
    expect(value.trackStock).toBe(false);
  });

  it('[I] a data object without the key is left untouched', () => {
    const data = { name: 'x' };
    productService._applyTrackStock(data, OFF);
    expect(data).toEqual({ name: 'x' });
  });

  it('[R] flag off + false → 403; flag on + false → stored', () => {
    expect(() => productService._applyTrackStock({ trackStock: false }, OFF))
      .toThrow(expect.objectContaining({ statusCode: 403 }));
    const data = { trackStock: false };
    productService._applyTrackStock(data, ON);
    expect(data.trackStock).toBe(false);
  });

  it('[R] a combo never carries it', () => {
    const data = { trackStock: false };
    productService._applyTrackStock(data, ON, { type: 'combo' });
    expect(data).not.toHaveProperty('trackStock');
  });

  it('[R] refused alongside batch or serial tracking — never silently switched off', () => {
    expect(() => productService._applyTrackStock({ trackStock: false, trackBatches: true }, ON))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => productService._applyTrackStock({ trackStock: false }, ON, { trackSerials: true }))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('[I] a new Product document carries no trackStock and is low-stock as before', () => {
    const p = new Product({ name: 'Soap', stock: 2, minStock: 5 });
    expect(p.trackStock).toBeUndefined();
    expect(p.isLowStock).toBe(true);
  });

  it('[R] an uncounted product is never low-stock', () => {
    const p = new Product({ name: 'ভাত', stock: 0, minStock: 5, trackStock: false });
    expect(p.isLowStock).toBe(false);
  });
});

// ── Combos made of uncounted food ───────────────────────────────────────────

describe('combo availability', () => {
  const rice = { _id: id(), stock: 0, trackStock: false, buyingPrice: 0 };
  const fish = { _id: id(), stock: 7, buyingPrice: 40 };
  const map = (...docs) => new Map(docs.map((d) => [String(d._id), d]));

  it('[R] an uncounted component never limits the combo', () => {
    const combo = { comboItems: [{ product: rice._id, quantity: 1 }, { product: fish._id, quantity: 1 }] };
    expect(computeComboAvailability(combo, map(rice, fish)).available).toBe(7);
  });

  it('[R] all-uncounted → unlimited, flagged', () => {
    const combo = { comboItems: [{ product: rice._id, quantity: 2 }] };
    const out = computeComboAvailability(combo, map(rice));
    expect(out.unlimited).toBe(true);
    expect(out.available).toBe(UNLIMITED_COMBO_AVAILABILITY);
  });

  it('[I] a counted-only combo is computed exactly as before, with no unlimited key', () => {
    const combo = { comboItems: [{ product: fish._id, quantity: 2 }] };
    const out = computeComboAvailability(combo, map(fish));
    expect(out).toEqual({ available: 3, cost: 80, costMin: 80, broken: null });
  });
});

// ── Storefront and online orders ────────────────────────────────────────────

describe('storefront and online orders', () => {
  const storefront = require('../services/publicStorefront.service');
  const orders = require('../services/order.service');

  it('[R] an uncounted dish is in stock at 0', () => {
    expect(storefront._stock({ stock: 0, trackStock: false })).toEqual({ inStock: true });
  });
  it('[I] a counted product at 0 is still out', () => {
    expect(storefront._stock({ stock: 0 })).toEqual({ inStock: false });
  });
  it('[R] the listing filter admits uncounted products', () => {
    const clause = storefront._stockClause({ outOfStockBehaviour: 'hide' });
    expect(clause.$or).toContainEqual({ trackStock: false });
  });
  it('[R] ordering an uncounted dish online is not refused for stock', () => {
    const line = orders._simpleLine({ _id: id(), name: 'ভাত', stock: 0, trackStock: false, sellingPrice: 20 }, 3);
    expect(line.name).toBe('ভাত');
  });
  it('[I] ordering a counted product at 0 is still refused', () => {
    expect(() => orders._simpleLine({ _id: id(), name: 'Soap', stock: 0, sellingPrice: 20 }, 1))
      .toThrow(expect.objectContaining({ statusCode: 409 }));
  });
});

// ── The sale document ───────────────────────────────────────────────────────

describe('Sale.items[].stockUntracked', () => {
  it('[I] absent on an ordinary line', () => {
    const sale = new Sale({
      shop: id(), invoiceNo: 'INV-1', createdBy: id(), subtotal: 20, total: 20, paid: 20,
      items: [{ product: id(), productName: 'Soap', quantity: 1, unitPrice: 20, total: 20 }],
    });
    expect(sale.validateSync()).toBeUndefined();
    expect(sale.items[0].stockUntracked).toBeUndefined();
  });
  it('[R] persisted when set — cancel and return read this snapshot', () => {
    const sale = new Sale({
      shop: id(), invoiceNo: 'INV-2', createdBy: id(), subtotal: 30, total: 30, paid: 30,
      items: [{ product: id(), productName: 'ভাত', quantity: 1.5, unitPrice: 20, total: 30, stockUntracked: true }],
    });
    expect(sale.items[0].stockUntracked).toBe(true);
  });
});

// ── createSale / cancelSale / returns, pinned structurally ──────────────────

describe('stock paths skip uncounted lines (structural)', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'services', f), 'utf8');
  const sale = read('sale.service.js');
  const ret = read('salesReturn.service.js');

  const body = (source, signature) => {
    const start = source.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    // `) {` — the body, not a `= {}` default in the parameter list.
    let i = source.indexOf(') {', start) + 2;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) break;
    }
    return source.slice(start, i + 1);
  };

  it('[R] no ledger row is reached by position any more', () => {
    // With a row skipped, `[length - 1]` is ANOTHER line's row — silently
    // repriced. This is the trap the feature had to remove first.
    expect(sale).not.toMatch(/stockTransactions\[stockTransactions\.length - 1\]/);
  });

  it('[R] createSale guards both stock checks and snapshots the line', () => {
    const create = body(sale, 'async createSale(');
    expect(create).toMatch(/stockTracked && variant\.stock < item\.quantity/);
    expect(create).toMatch(/stockTracked && product\.stock < item\.quantity/);
    expect(create).toMatch(/isStockTracked\(comp\) && availableStock < required/);
    expect(create).toMatch(/stockTracked \? \{\} : \{ stockUntracked: true \}/);
  });

  it('[R] cancelSale restores from the snapshot, not the product setting', () => {
    const cancel = body(sale, 'async cancelSale(');
    expect(cancel).toMatch(/if \(item\.stockUntracked\) continue;/);
    expect(cancel).toMatch(/if \(c\.stockUntracked\) continue;/);
  });

  it('[R] returns carry the snapshot and skip the restore', () => {
    expect(ret).toMatch(/saleItem\.stockUntracked \? \{ stockUntracked: true \} : \{\}/);
    expect(ret).toMatch(/if \(item\.stockUntracked\) continue;/);
    expect(ret).toMatch(/if \(c\.stockUntracked\) continue;/);
  });

  it('[R] editing an uncounted product never routes its stock box into updateStock', () => {
    // updateStock refuses an uncounted product; reaching it from updateProduct
    // would 400 an ordinary edit after the save had already happened.
    const update = body(read('product.service.js'), 'async updateProduct(');
    expect(update).toMatch(/!product\.hasVariants && isStockTracked\(product\)/);
  });

  it('[R] a batch cannot be added to an uncounted product', () => {
    const add = body(read('product.service.js'), 'async addProductBatch(');
    expect(add).toMatch(/assertTracked\(product, 'মেয়াদের ব্যাচ'\)/);
  });

  it('[R] combo rows are tagged only when the component is uncounted', () => {
    // Absent on every counted row — an ordinary shop's combo payload is unchanged.
    expect(read('product.service.js')).toMatch(/if \(!isStockTracked\(comp\)\) ci\.trackStock = false;/);
  });

  it('[R] every stock-in path refuses an uncounted product', () => {
    expect(read('purchase.service.js')).toMatch(/assertTracked\(product, 'ক্রয়'\)/);
    expect(read('purchaseReturn.service.js')).toMatch(/assertTracked\(product, 'কেনা ফেরত'\)/);
    expect(read('stockTransfer.service.js')).toMatch(/assertTracked\(product, 'শাখা স্থানান্তর'\)/);
    const product = read('product.service.js');
    expect(product).toMatch(/assertTracked\(product, 'স্টক সমন্বয়'\)/);
    expect(product).toMatch(/assertTracked\(product, 'ক্ষতি'\)/);
  });
});
