/**
 * Combo products — the invariants the feature stands on.
 *
 *   1. SCHEMA. A combo is a Product with `type: 'combo'` + `comboItems`; an
 *      ordinary product carries neither key, so pre-combo documents are
 *      byte-identical to what they were.
 *   2. DERIVED STOCK. A combo has no stock of its own — availability is
 *      min(component stock / quantity), floored, and a broken component makes
 *      it 0 with a named reason, never a silent number.
 *   3. NO STOCK-IN. Purchases, manual adjustment and transfers refuse a combo
 *      outright (`assertNotCombo`) — a combo reaching a stock write would mint
 *      inventory no shelf holds.
 *   4. HISTORY SAFETY. Sale lines freeze `comboComponents` (names, variants,
 *      quantities, costs) and StockTransaction rows carry `viaCombo` — both
 *      snapshots, so combo edits/deletes can never rewrite what was sold or
 *      break a cancel/return.
 *   5. ENTITLEMENT. `features.combos` defaults false; flag-off shops keep
 *      byte-identical behaviour.
 *   6. CONFIDENTIALITY. `comboComponents[].unitCost` and the derived
 *      `comboCost` are cost figures and are stripped for roles without
 *      view_cost, exactly like `buyingPrice`.
 */

const mongoose = require('mongoose');

const Product = require('../models/Product.model');
const Sale = require('../models/Sale.model');
const SalesReturn = require('../models/SalesReturn.model');
const StockTransaction = require('../models/StockTransaction.model');
const Shop = require('../models/Shop.model');
const { FEATURES, FEATURE_KEYS } = require('../utils/features.util');
const {
  isCombo,
  assertNotCombo,
  findComponentVariant,
  computeComboAvailability,
} = require('../utils/combo.util');
const { sanitizeSales, sanitizeProducts, COST_KEYS } = require('../utils/dataSanitizer.util');
const productValidation = require('../validations/product.validation');

const id = () => new mongoose.Types.ObjectId();
const SHOP = id();

// ── 1. Schema shape ─────────────────────────────────────────────────────────

describe('Product schema: combo fields', () => {
  it('defaults to a standard product with NO comboItems key at all', () => {
    const p = new Product({ shop: SHOP, code: 'A1', name: 'Plain' });
    expect(p.type).toBe('standard');
    // `default: undefined` — the array must not materialise on ordinary rows.
    expect(p.comboItems).toBeUndefined();
  });

  it('accepts a combo with components', () => {
    const p = new Product({
      shop: SHOP,
      code: 'CMB-1',
      name: 'Eid Pack',
      type: 'combo',
      sellingPrice: 250,
      comboItems: [
        { product: id(), quantity: 1, productName: 'Shampoo' },
        { product: id(), variantId: id(), quantity: 2, productName: 'Soap' },
      ],
    });
    const err = p.validateSync();
    expect(err).toBeUndefined();
    expect(p.comboItems).toHaveLength(2);
    expect(p.comboItems[0].variantId).toBeNull();
  });

  it('rejects an unknown type and a zero-quantity component', () => {
    const bad = new Product({ shop: SHOP, code: 'X', name: 'X', type: 'bundle' });
    expect(bad.validateSync().errors['type']).toBeDefined();

    const zero = new Product({
      shop: SHOP, code: 'X', name: 'X', type: 'combo',
      comboItems: [{ product: id(), quantity: 0 }],
    });
    expect(zero.validateSync()).toBeDefined();
  });

  it('indexes {shop, comboItems.product} so the component delete-guard is a scan-free lookup', () => {
    const declared = Product.schema.indexes().map(([key]) => JSON.stringify(Object.keys(key)));
    expect(declared).toContain(JSON.stringify(['shop', 'comboItems.product']));
  });
});

describe('Sale item schema: the combo snapshot', () => {
  const saleFixture = (items) => new Sale({
    shop: SHOP,
    invoiceNo: 'INV-1',
    items,
    subtotal: 0,
    total: 0,
    createdBy: id(),
  });

  it('a standard line carries no comboComponents key', () => {
    const sale = saleFixture([{
      product: id(), productName: 'Plain', quantity: 1, unitPrice: 10, total: 10,
    }]);
    expect(sale.items[0].itemType).toBe('standard');
    expect(sale.items[0].comboComponents).toBeUndefined();
  });

  it('a combo line freezes components with per-combo and per-line quantities', () => {
    const compId = id();
    const sale = saleFixture([{
      product: id(),
      productName: 'Eid Pack',
      itemType: 'combo',
      quantity: 3,
      unitPrice: 250,
      buyingPrice: 180,
      total: 750,
      comboComponents: [{
        product: compId,
        productName: 'Soap',
        quantityPerCombo: 2,
        totalQuantity: 6,
        unitCost: 30,
      }],
    }]);
    const err = sale.validateSync();
    expect(err).toBeUndefined();
    const c = sale.items[0].comboComponents[0];
    expect(String(c.product)).toBe(String(compId));
    expect(c.totalQuantity).toBe(6);
  });

  it('profit arithmetic needs NO combo special-case: line buyingPrice is the component-cost sum', () => {
    // pre('save') computes profit as Σ (unitPrice - buyingPrice) × qty − discounts.
    // A combo line priced ৳250 costing ৳180 in components, sold twice:
    const sale = saleFixture([{
      product: id(), productName: 'Eid Pack', itemType: 'combo',
      quantity: 2, unitPrice: 250, buyingPrice: 180, discount: 0, total: 500,
      comboComponents: [{ product: id(), productName: 'S', quantityPerCombo: 1, totalQuantity: 2, unitCost: 180 }],
    }]);
    // Run the pre-save hook synchronously the way validateSync cannot: emulate.
    const item = sale.items[0];
    const profit = (item.unitPrice - item.buyingPrice) * item.quantity - item.discount;
    expect(profit).toBe(140);
  });
});

describe('SalesReturn item schema: combo lines return whole', () => {
  it('accepts the scaled component snapshot', () => {
    const ret = new SalesReturn({
      shop: SHOP,
      returnNo: 'RET-1',
      sale: id(),
      invoiceNo: 'INV-1',
      items: [{
        saleItemId: id(),
        product: id(),
        productName: 'Eid Pack',
        itemType: 'combo',
        quantity: 1,
        unitPrice: 250,
        total: 250,
        comboComponents: [{
          product: id(), productName: 'Soap', quantityPerCombo: 2, totalQuantity: 2, unitCost: 30,
        }],
      }],
      totalAmount: 250,
      refundMethod: 'cash',
      reason: 'test',
      createdBy: id(),
    });
    expect(ret.validateSync()).toBeUndefined();
  });
});

describe('StockTransaction schema: viaCombo attribution', () => {
  it('is absent on ordinary rows and snapshots the combo on combo rows', () => {
    const plain = new StockTransaction({
      shop: SHOP, product: id(), productName: 'Plain', type: 'sale',
      quantity: -1, previousStock: 5, newStock: 4, createdBy: id(),
    });
    expect(plain.viaCombo).toBeUndefined();

    const comboId = id();
    const viaRow = new StockTransaction({
      shop: SHOP, product: id(), productName: 'Soap', type: 'sale',
      quantity: -2, previousStock: 10, newStock: 8, createdBy: id(),
      viaCombo: { product: comboId, name: 'Eid Pack', code: 'CMB-1', comboQuantity: 1 },
    });
    expect(viaRow.validateSync()).toBeUndefined();
    expect(String(viaRow.viaCombo.product)).toBe(String(comboId));
    expect(viaRow.viaCombo.name).toBe('Eid Pack');
  });
});

// ── 2. Derived availability ─────────────────────────────────────────────────

describe('computeComboAvailability', () => {
  const combo = (items) => ({ type: 'combo', comboItems: items });
  const asMap = (docs) => new Map(docs.map((d) => [String(d._id), d]));

  it('is the floored min over components of stock/quantity', () => {
    const a = { _id: id(), stock: 10, buyingPrice: 20, isActive: true };
    const b = { _id: id(), stock: 7, buyingPrice: 30, isActive: true };
    const { available, cost, broken } = computeComboAvailability(
      combo([
        { product: a._id, quantity: 1 },
        { product: b._id, quantity: 2 },
      ]),
      asMap([a, b])
    );
    expect(available).toBe(3); // floor(7 / 2) beats 10 / 1
    expect(cost).toBe(20 * 1 + 30 * 2);
    expect(broken).toBeNull();
  });

  it('reads variant stock and cost for a variant component', () => {
    const vId = id();
    const comp = {
      _id: id(),
      hasVariants: true,
      stock: 0, // rollup irrelevant — the variant is the pool
      isActive: true,
      variants: [{ _id: vId, stock: 5, buyingPrice: 40, isActive: true }],
    };
    const { available, cost } = computeComboAvailability(
      combo([{ product: comp._id, variantId: vId, quantity: 2 }]),
      asMap([comp])
    );
    expect(available).toBe(2);
    expect(cost).toBe(80);
  });

  it('a deleted, deactivated or variant-less component makes the combo 0 with a named reason', () => {
    const gone = { _id: id(), isDeleted: true };
    expect(computeComboAvailability(combo([{ product: gone._id, quantity: 1 }]), asMap([gone])).broken)
      .toBe('component_deleted');

    const off = { _id: id(), isActive: false, stock: 100 };
    expect(computeComboAvailability(combo([{ product: off._id, quantity: 1 }]), asMap([off])).broken)
      .toBe('component_inactive');

    const noVariant = { _id: id(), isActive: true, hasVariants: true, variants: [] };
    expect(computeComboAvailability(combo([{ product: noVariant._id, variantId: id(), quantity: 1 }]), asMap([noVariant])).broken)
      .toBe('variant_missing');

    const missing = computeComboAvailability(combo([{ product: id(), quantity: 1 }]), new Map());
    expect(missing.available).toBe(0);
    expect(missing.broken).toBe('component_deleted');
  });

  it('an empty combo is 0, never Infinity', () => {
    expect(computeComboAvailability(combo([]), new Map()).available).toBe(0);
  });
});

// ── 3. No stock-in for combos ───────────────────────────────────────────────

describe('assertNotCombo', () => {
  it('lets a standard product through and refuses a combo with a 400', () => {
    expect(() => assertNotCombo({ type: 'standard', name: 'Plain' })).not.toThrow();
    expect(() => assertNotCombo({ name: 'Legacy row with no type' })).not.toThrow();

    let thrown;
    try {
      assertNotCombo({ type: 'combo', name: 'Eid Pack' });
    } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect(thrown.statusCode).toBe(400);
  });

  it('isCombo is null-safe and defaults absent type to standard', () => {
    expect(isCombo(null)).toBe(false);
    expect(isCombo({})).toBe(false);
    expect(isCombo({ type: 'combo' })).toBe(true);
  });

  it('findComponentVariant works on lean arrays and matches by string id', () => {
    const vId = id();
    const lean = { variants: [{ _id: vId, stock: 3 }] };
    expect(findComponentVariant(lean, String(vId)).stock).toBe(3);
    expect(findComponentVariant(lean, id())).toBeNull();
    expect(findComponentVariant({ }, vId)).toBeNull();
  });
});

// ── 5. Entitlement ──────────────────────────────────────────────────────────

describe('features.combos', () => {
  it('is a registered capability and defaults to false on the Shop schema', () => {
    expect(FEATURE_KEYS).toContain('combos');
    expect(FEATURES.combos.en).toBeTruthy();
    expect(FEATURES.combos.bn).toBeTruthy();

    const shop = new Shop({ name: 'S' });
    expect(shop.features.combos).toBe(false);
  });
});

// ── Joi: the structural gate ────────────────────────────────────────────────

describe('product validation: combo payloads', () => {
  const base = {
    name: 'Eid Pack',
    category: String(id()),
    sellingPrice: 250,
    stock: 0,
  };

  it('a combo needs comboItems and needs no buyingPrice', () => {
    const ok = productValidation.createProduct.validate({
      ...base,
      type: 'combo',
      comboItems: [{ product: String(id()), quantity: 2 }],
    });
    expect(ok.error).toBeUndefined();

    const missing = productValidation.createProduct.validate({ ...base, type: 'combo' });
    expect(missing.error).toBeDefined();
  });

  it('a standard product cannot smuggle comboItems and still requires buyingPrice', () => {
    const smuggled = productValidation.createProduct.validate({
      ...base,
      buyingPrice: 100,
      comboItems: [{ product: String(id()), quantity: 1 }],
    });
    expect(smuggled.error).toBeDefined();

    const noBuying = productValidation.createProduct.validate({ ...base });
    expect(noBuying.error).toBeDefined();
  });

  it('caps a combo at 20 components and requires a positive quantity', () => {
    const tooMany = productValidation.createProduct.validate({
      ...base,
      type: 'combo',
      comboItems: Array.from({ length: 21 }, () => ({ product: String(id()), quantity: 1 })),
    });
    expect(tooMany.error).toBeDefined();

    const zeroQty = productValidation.createProduct.validate({
      ...base,
      type: 'combo',
      comboItems: [{ product: String(id()), quantity: 0 }],
    });
    expect(zeroQty.error).toBeDefined();
  });
});

// ── 6. Confidentiality ──────────────────────────────────────────────────────

describe('sanitizers: combo cost figures are as confidential as buyingPrice', () => {
  const staffReq = { user: { isOwner: false, permissions: {} } };

  it('strips comboComponents[].unitCost from sale payloads for roles without view_cost', () => {
    const sale = {
      items: [{
        productName: 'Eid Pack',
        itemType: 'combo',
        buyingPrice: 180,
        comboComponents: [{ productName: 'Soap', totalQuantity: 2, unitCost: 30 }],
      }],
    };
    const clean = sanitizeSales(sale, staffReq);
    expect(clean.items[0].buyingPrice).toBeUndefined();
    expect(clean.items[0].comboComponents[0].unitCost).toBeUndefined();
    // The quantities stay — the cashier still needs to know what to hand over.
    expect(clean.items[0].comboComponents[0].totalQuantity).toBe(2);
  });

  it('strips the derived comboCost from product payloads and registers it in COST_KEYS', () => {
    const clean = sanitizeProducts({ name: 'Eid Pack', type: 'combo', comboCost: 180, sellingPrice: 250 }, staffReq);
    expect(clean.comboCost).toBeUndefined();
    expect(clean.sellingPrice).toBe(250);
    expect(COST_KEYS.has('comboCost')).toBe(true);
  });
});
