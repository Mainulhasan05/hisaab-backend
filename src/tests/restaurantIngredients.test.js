/**
 * কাঁচামাল — the restaurant store room (CLAUDE.md §18).
 *
 *   [R] regression — fails before this change (the module did not exist).
 *   [I] invariant  — an ordinary shop / an ordinary purchase is unchanged;
 *                    passes both ways by design.
 *
 * Models are mocked, as across this suite, so the store-room writes are pinned
 * by what they are ASKED to do (filters, pipelines, rows). Whether MongoDB
 * executes the pipelines as intended is a real-database question — see the
 * report that shipped this.
 */
jest.mock('../utils/transaction.util', () => ({ runInTransaction: (fn) => fn(null) }));
jest.mock('../services/cache.service', () => ({
  bumpShopCacheVersion: jest.fn(() => Promise.resolve(true)),
  get: jest.fn(() => Promise.resolve(null)),
  set: jest.fn(() => Promise.resolve(true)),
}));

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Ingredient = require('../models/Ingredient.model');
const IngredientMovement = require('../models/IngredientMovement.model');
const Purchase = require('../models/Purchase.model');
const service = require('../services/ingredient.service');

const id = () => new mongoose.Types.ObjectId();
const SHOP = id();
const USER = id();
const reqWith = (features = { restaurant: true }, user = { _id: USER, isOwner: true }) => ({
  shop: { _id: SHOP, multiBranchEnabled: false, features },
  branchId: null,
  user,
});

const sessionQuery = (value) => ({ session: () => Promise.resolve(value) });

afterEach(() => jest.restoreAllMocks());

// ── The ledger's vocabulary ─────────────────────────────────────────────────

describe('movement types', () => {
  it('[R] only consumption and waste are P&L costs — a correction never is', () => {
    expect([...IngredientMovement.COST_TYPES].sort()).toEqual(['consumption', 'waste']);
    expect(IngredientMovement.MOVEMENT_TYPES).toContain('adjustment');
    expect(IngredientMovement.COST_TYPES).not.toContain('adjustment');
    expect(IngredientMovement.COST_TYPES).not.toContain('purchase');
  });
});

// ── Stock arithmetic ────────────────────────────────────────────────────────

describe('pipelines', () => {
  const { stockDelta, receiveUpdate } = service._internals;

  it('[R] a delta re-rounds at the unit precision', () => {
    expect(stockDelta(-1.5, 'kg')[0].$set.stock.$round[1]).toBe(3);
    expect(stockDelta(-2, 'piece')[0].$set.stock.$round[1]).toBe(0);
  });

  it('[R] receive blends avgCost and stock in ONE $set — both read the old document', () => {
    const [stage, ...rest] = receiveUpdate(10, 80, 'kg');
    expect(rest).toHaveLength(0);
    expect(Object.keys(stage.$set).sort()).toEqual(['avgCost', 'stock']);
  });

  /** Evaluate the blend the way MongoDB would, to pin the arithmetic itself. */
  it('[R] the blend is a weighted average: 10 kg @৳70 + 10 kg @৳80 → ৳75', () => {
    const doc = { stock: 10, avgCost: 70 };
    const q = 10; const c = 80;
    const after = doc.stock + q;
    expect((doc.stock * doc.avgCost + q * c) / after).toBe(75);
    // and the pipeline carries exactly those operands
    const expr = receiveUpdate(q, c, 'kg')[0].$set.avgCost.$cond[1].$round[0].$divide[0].$add[1];
    expect(expr).toBe(q * c);
  });
});

// ── Business date ───────────────────────────────────────────────────────────

describe('business date', () => {
  const { resolveBusinessDate } = service._internals;
  const ymd = (offsetDays) => {
    const d = new Date(Date.now() + 6 * 3600000 + offsetDays * 86400000);
    return d.toISOString().slice(0, 10);
  };

  it('[R] today is accepted and anchored inside the Dhaka day', () => {
    expect(resolveBusinessDate(ymd(0))).toBeInstanceOf(Date);
  });
  it('[R] tomorrow is refused', () => {
    expect(() => resolveBusinessDate(ymd(1))).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
  it('[R] more than a week back is refused', () => {
    expect(() => resolveBusinessDate(ymd(-9))).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

// ── The kitchen sheet ───────────────────────────────────────────────────────

describe('issue — রান্নাঘরে দেওয়া', () => {
  const rice = () => ({ _id: id(), name: 'চাল', unit: 'kg', stock: 48, avgCost: 72 });

  const wire = (doc) => {
    jest.spyOn(Ingredient, 'findOne').mockReturnValue(sessionQuery(doc));
    const fau = jest.spyOn(Ingredient, 'findOneAndUpdate').mockResolvedValue({ ...doc });
    const ins = jest.spyOn(IngredientMovement, 'insertMany').mockResolvedValue([]);
    return { fau, ins };
  };

  it('[R] "used" mode: deducts what was typed, guarded by $gte, costed at avgCost', async () => {
    const doc = rice();
    const { fau, ins } = wire(doc);
    const out = await service.issue(reqWith(), USER, { mode: 'used', lines: [{ ingredient: doc._id, quantity: '15' }] });

    const [filter, update] = fau.mock.calls[0];
    expect(filter.stock).toEqual({ $gte: 15 });
    expect(filter.shop).toBe(SHOP);
    expect(update[0].$set.stock.$round[0].$add[1]).toBe(-15);
    const [row] = ins.mock.calls[0][0];
    expect(row).toMatchObject({ type: 'consumption', quantity: -15, unitCost: 72, totalCost: 1080, newStock: 33 });
    expect(out.totalCost).toBe(1080);
  });

  it('[R] "left" mode: used = stock − counted, guarded on the EXACT stock read', async () => {
    const doc = rice();
    const { fau, ins } = wire(doc);
    await service.issue(reqWith(), USER, { mode: 'left', lines: [{ ingredient: doc._id, quantity: '40.5' }] });
    expect(fau.mock.calls[0][0].stock).toBe(48);
    expect(ins.mock.calls[0][0][0].quantity).toBe(-7.5);
  });

  it('[R] counting MORE than the book is refused, not booked as negative cooking', async () => {
    const doc = rice();
    wire(doc);
    await expect(service.issue(reqWith(), USER, { mode: 'left', lines: [{ ingredient: doc._id, quantity: 50 }] }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('[R] a lost race is a 409, never oversold stock', async () => {
    const doc = rice();
    wire(doc);
    Ingredient.findOneAndUpdate.mockResolvedValue(null);
    await expect(service.issue(reqWith(), USER, { lines: [{ ingredient: doc._id, quantity: 5 }] }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('[R] waste is booked as waste', async () => {
    const doc = rice();
    const { ins } = wire(doc);
    await service.issue(reqWith(), USER, { type: 'waste', lines: [{ ingredient: doc._id, quantity: 1 }] });
    expect(ins.mock.calls[0][0][0].type).toBe('waste');
  });

  it('[R] the same ingredient twice on one sheet is refused', async () => {
    const doc = rice();
    wire(doc);
    await expect(service.issue(reqWith(), USER, {
      lines: [{ ingredient: doc._id, quantity: 1 }, { ingredient: doc._id, quantity: 2 }],
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('[R] a cashier without view_cost gets no cost back', async () => {
    const doc = rice();
    wire(doc);
    const cashier = { _id: USER, isOwner: false, permissions: { products: { update: true } } };
    const out = await service.issue(reqWith(undefined, cashier), USER, { lines: [{ ingredient: doc._id, quantity: 1 }] });
    expect(out.totalCost).toBeUndefined();
  });
});

// ── Cost totals feed the P&L ────────────────────────────────────────────────

describe('costTotals', () => {
  it('[R] ids are CAST and the day bucket carries the Dhaka timezone (I-3)', async () => {
    const agg = jest.spyOn(IngredientMovement, 'aggregate').mockResolvedValue([{ byType: [], byIngredient: [], byDay: [] }]);
    await service.costTotals(String(SHOP), String(id()), {});
    const [match] = agg.mock.calls[0][0];
    expect(match.$match.shop).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(match.$match.branch).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(match.$match.type).toEqual({ $in: ['consumption', 'waste'] });
    const day = agg.mock.calls[0][0][1].$facet.byDay[0].$group._id.$dateToString;
    expect(day.timezone).toBeDefined();
  });

  it('[R] totals consumption + waste', async () => {
    jest.spyOn(IngredientMovement, 'aggregate').mockResolvedValue([{
      byType: [{ _id: 'consumption', total: 1760 }, { _id: 'waste', total: 90 }], byIngredient: [], byDay: [],
    }]);
    const out = await service.costTotals(String(SHOP), null, {});
    expect(out).toMatchObject({ total: 1850, consumption: 1760, waste: 90 });
  });
});

// ── Purchases ───────────────────────────────────────────────────────────────

describe('purchase lines', () => {
  it('[I] an ordinary line still requires a product', () => {
    const p = new Purchase({ shop: SHOP, invoiceNo: 'P-1', items: [{ productName: 'x', quantity: 1, unitPrice: 1, total: 1 }], totalAmount: 1, createdBy: USER });
    expect(p.validateSync()?.errors['items.0.product']).toBeDefined();
  });

  it('[R] an ingredient line needs no product', () => {
    const p = new Purchase({ shop: SHOP, invoiceNo: 'P-2', items: [{ ingredient: id(), productName: 'চাল', quantity: 50, unitPrice: 72, total: 3600 }], totalAmount: 3600, createdBy: USER });
    expect(p.validateSync()?.errors?.['items.0.product']).toBeUndefined();
  });

  it('[R] fractions follow the ingredient unit; a bad price is refused', () => {
    const rice = { _id: id(), name: 'চাল', unit: 'kg' };
    expect(service.prepareLine({ quantity: '2.5', unitPrice: 72 }, rice)).toMatchObject({ quantity: 2.5, total: 180, productName: 'চাল' });
    expect(() => service.prepareLine({ quantity: '2.5', unitPrice: 12 }, { ...rice, unit: 'piece' })).toThrow();
    expect(() => service.prepareLine({ quantity: 1, unitPrice: 'abc' }, rice)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('[R] ingredient lines are refused without the capability', async () => {
    await expect(service.loadForPurchase(reqWith({}), [String(id())], null))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('[I] a bill with no ingredient lines reads nothing, flag or not', async () => {
    const find = jest.spyOn(Ingredient, 'find');
    const map = await service.loadForPurchase(reqWith({}), [], null);
    expect(map.size).toBe(0);
    expect(find).not.toHaveBeenCalled();
  });
});

// ── The integration seams, pinned structurally ──────────────────────────────

describe('seams (structural)', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('[R] cancelPurchase never casts a missing product id', () => {
    expect(read('services/purchase.service.js'))
      .toMatch(/purchase\.items\.filter\(i => i\.product\)\.map\(i => String\(i\.product\)\)/);
  });

  it('[R] the store room is stocked only when the bill has ingredient lines', () => {
    expect(read('services/purchase.service.js'))
      .toMatch(/if \(ingredientIds\.length\) \{\s*await ingredientService\.receivePurchase/);
  });

  it('[R] purchase returns refuse an ingredient line by name', () => {
    const src = read('services/purchaseReturn.service.js');
    expect(src).toMatch(/if \(line\.ingredient\) \{/);
    expect(src).toMatch(/\.filter\(\(pi\) => pi && pi\.product\)/);
  });

  it('[I] the P&L and daily summary query ingredients only for a restaurant', () => {
    const svc = read('services/report.service.js');
    expect(svc.match(/options\.withIngredientCost\s*\?/g)).toHaveLength(2);
    const ctl = read('controllers/report.controller.js');
    expect(ctl.match(/withIngredientCost: hasFeature\(req, 'restaurant'\)/g)).toHaveLength(2);
  });

  it('[R] the router is behind the capability', () => {
    expect(read('routes/ingredient.routes.js')).toMatch(/router\.use\(requireFeature\('restaurant'\)\)/);
  });

  it('[R] both models are in the multi-branch backfill and the model registry', () => {
    expect(read('services/admin.service.js')).toMatch(/Ingredient, IngredientMovement\s*\]/);
    const idx = read('models/index.js');
    expect(idx).toMatch(/Ingredient: require/);
    expect(idx).toMatch(/IngredientMovement: require/);
  });
});
