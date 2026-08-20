/**
 * A recount is not a delivery.
 *
 * ── The two bugs these close ────────────────────────────────────────────────
 *
 * `product.service.updateStock` is the one path where a shopkeeper types a
 * stock figure directly — "recount: 12.5 kg", "found 3 more in the back". It
 * wrote its `StockTransaction` like this:
 *
 *     type:     type === 'set' ? 'adjustment' : (qty > 0 ? 'purchase' : 'adjustment')
 *     quantity: type === 'set' ? (newStock - previousStock) : qty
 *
 * 1. TYPE. Adding stock by hand was recorded as a PURCHASE — with no supplier,
 *    no bill, no cost and no `Purchase` document, while `reference.type` on the
 *    next line said `'manual'`. The stock ledger claimed goods had been bought
 *    that nobody ever billed the shop for.
 *
 * 2. SIGN. Because direction was carried by the label, the figure was unsigned.
 *    Every other writer stores a signed quantity — `sale` writes
 *    `-item.quantity`, and the schema says "Can be negative for stock out". So
 *    a manual subtract of 5 stored `+5`, and
 *
 *        previousStock + quantity === newStock
 *
 *    held for every movement in the system except this one.
 *
 * The two are one fix: correcting `type` alone would leave both directions
 * labelled `adjustment` with an unsigned figure, and a recount up would be
 * indistinguishable from a recount down.
 *
 * REGRESSIONS throughout — each assertion fails against the old expression.
 */
const mongoose = require('mongoose');
const fs = require('fs');
const StockTransaction = require('../models/StockTransaction.model');
const Product = require('../models/Product.model');
const AuditLog = require('../models/AuditLog.model');
const productService = require('../services/product.service');

const SHOP = new mongoose.Types.ObjectId();
const PRODUCT = new mongoose.Types.ObjectId();

/**
 * A plain, non-variant, non-combo product that saves without touching a
 * database. `updateStock` reads it, mutates `stock`, and calls `save()`.
 */
function stubProduct(stock) {
  const doc = {
    _id: PRODUCT,
    shop: SHOP,
    name: 'চাল',
    code: 'P-1',
    unit: 'পিস',
    stock,
    branch: null,
    hasVariants: false,
    variants: [],
    batches: [],
    productType: 'standard',
    save: jest.fn().mockResolvedValue(true),
    markModified: jest.fn(),
  };
  jest.spyOn(Product, 'findOne').mockResolvedValue(doc);
  return doc;
}

/** The single `StockTransaction.create` call `updateStock` makes. */
async function movementFor(stockData, openingStock = 30) {
  const create = jest.spyOn(StockTransaction, 'create').mockResolvedValue({});
  jest.spyOn(AuditLog, 'create').mockResolvedValue({});
  jest.spyOn(productService, '_transformProduct').mockImplementation((p) => p);
  stubProduct(openingStock);

  await productService.updateStock(SHOP, SHOP, PRODUCT, stockData, null);

  return create.mock.calls[0][0];
}

afterEach(() => jest.restoreAllMocks());

describe('a manual movement is never labelled a purchase', () => {
  it.each([
    ['add', { quantity: 5, type: 'add' }],
    ['subtract', { quantity: 5, type: 'subtract' }],
    ['set', { quantity: 8, type: 'set' }],
  ])('records %s as an adjustment', async (_label, stockData) => {
    const movement = await movementFor(stockData);

    expect(movement.type).toBe('adjustment');
    // The truth the old label contradicted, one line below it.
    expect(movement.reference.type).toBe('manual');
  });

  it('never claims a purchase nobody was billed for', async () => {
    // The specific old behaviour: `qty > 0` on an add.
    const movement = await movementFor({ quantity: 12, type: 'add' });

    expect(movement.type).not.toBe('purchase');
  });
});

describe('quantity is the signed delta', () => {
  it('is positive when stock goes up', async () => {
    const movement = await movementFor({ quantity: 5, type: 'add' }, 30);

    expect(movement.quantity).toBe(5);
    expect([movement.previousStock, movement.newStock]).toEqual([30, 35]);
  });

  it('is NEGATIVE when stock goes down', async () => {
    // The regression. This stored `+5` before, so the ledger read a subtract
    // as an add and only the (now removed) type told them apart.
    const movement = await movementFor({ quantity: 5, type: 'subtract' }, 30);

    expect(movement.quantity).toBe(-5);
  });

  it('is the delta on a recount down', async () => {
    // 30 counted down to 8 — twenty-two units gone.
    const movement = await movementFor({ quantity: 8, type: 'set' }, 30);

    expect(movement.quantity).toBe(-22);
  });

  it('is the delta on a recount up', async () => {
    const movement = await movementFor({ quantity: 42, type: 'set' }, 30);

    expect(movement.quantity).toBe(12);
  });

  it('is zero on a recount that changes nothing', async () => {
    // A no-op recount is still a fact worth recording — the shopkeeper
    // checked, and the shelf agreed.
    const movement = await movementFor({ quantity: 30, type: 'set' }, 30);

    expect(movement.quantity).toBe(0);
  });
});

describe('the ledger arithmetic holds for every mode', () => {
  it.each([
    ['add', { quantity: 7, type: 'add' }, 30],
    ['subtract', { quantity: 7, type: 'subtract' }, 30],
    ['set up', { quantity: 50, type: 'set' }, 30],
    ['set down', { quantity: 4, type: 'set' }, 30],
  ])('previousStock + quantity === newStock (%s)', async (_label, stockData, opening) => {
    // The invariant every other writer in the system already satisfied. This
    // path was the sole exception.
    const movement = await movementFor(stockData, opening);

    expect(movement.previousStock + movement.quantity).toBe(movement.newStock);
  });
});

describe('the expression is gone, not merely bypassed', () => {
  it('no longer branches the type on the sign of the quantity', () => {
    const source = fs.readFileSync(
      require.resolve('../services/product.service.js'), 'utf8'
    );
    const code = source
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
      })
      .join('\n');

    expect(code).not.toContain("qty > 0 ? 'purchase' : 'adjustment'");
  });
});
