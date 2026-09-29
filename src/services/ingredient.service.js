/**
 * কাঁচামাল — the restaurant store room (CLAUDE.md §18).
 *
 * Every change to `Ingredient.stock` goes through this file and writes an
 * `IngredientMovement`. Nothing else in the codebase touches either
 * collection, which is the point of keeping them apart from Product: the POS,
 * the product reports and the online shop cannot see চাল because they never
 * read this collection.
 *
 * ── How the money works ─────────────────────────────────────────────────────
 *
 *   buy    → an ordinary Purchase bill (supplier due, payment, cash drawer —
 *            all unchanged). Stock rises, `avgCost` re-blends. NOT a P&L cost:
 *            the P&L has never subtracted purchases.
 *   cook   → `issue()` — stock falls, `consumption` rows are costed at
 *            `avgCost`. THIS is what the P&L subtracts (`costTotals`).
 *   spoil  → `issue({ type: 'waste' })` — same, reported separately.
 *   fix    → `adjust()` — corrects a typo. Never a cost.
 *
 * So rice bought on Monday and cooked all week costs each day what was cooked
 * that day, and nothing is ever counted twice.
 *
 * ── Stock writes ────────────────────────────────────────────────────────────
 *
 * Always a pipeline `$round` at the unit's precision (quantity.util's rule —
 * error clamped per write, never accumulated), always guarded on the filter so
 * two cashiers issuing the last kilo cannot both succeed. This collection is
 * new, so there is no legacy `$inc` path to preserve.
 */
const mongoose = require('mongoose');
const Ingredient = require('../models/Ingredient.model');
const IngredientMovement = require('../models/IngredientMovement.model');
const { AppError } = require('../middleware/error.middleware');
const { branchFilter, requireBranch } = require('../utils/branchScope.util');
const { runInTransaction } = require('../utils/transaction.util');
const { parseQuantity, quantize, quantizeMoney } = require('../utils/quantity.util');
const { unitDecimals, unitsForShop } = require('../config/units');
const { hasFeature } = require('../utils/features.util');
const { hasPermission } = require('../middleware/permission.middleware');
const { getBangladeshDayRange, getBangladeshTodayStr, BD_TZ } = require('../utils/bdTime.util');
const cacheService = require('./cache.service');

const { COST_TYPES } = IngredientMovement;
const oid = (v) => new mongoose.Types.ObjectId(String(v));

/** How far back a kitchen sheet may be dated — a forgotten night, not a month. */
const MAX_BACKDATE_DAYS = 7;

/** `$round` pipeline adding `delta` to stock at the unit's precision. */
function stockDelta(delta, unit) {
  return [{
    $set: { stock: { $round: [{ $add: [{ $ifNull: ['$stock', 0] }, delta] }, unitDecimals(unit)] } },
  }];
}

/**
 * Receive `qty` at `unitCost`: stock rises and `avgCost` re-blends as a
 * weighted average, in ONE atomic update. Both expressions sit in the same
 * `$set`, so both read the document as it was BEFORE — the blend uses the old
 * stock, which is what the formula needs.
 */
function receiveUpdate(qty, unitCost, unit) {
  const stock = { $ifNull: ['$stock', 0] };
  const cost = { $ifNull: ['$avgCost', 0] };
  const after = { $add: [stock, qty] };
  return [{
    $set: {
      avgCost: {
        $cond: [
          { $gt: [after, 0] },
          { $round: [{ $divide: [{ $add: [{ $multiply: [stock, cost] }, qty * unitCost] }, after] }, 4] },
          unitCost,
        ],
      },
      stock: { $round: [after, unitDecimals(unit)] },
    },
  }];
}

/**
 * The business date a sheet is booked on. `YYYY-MM-DD` in Dhaka time, today by
 * default, never in the future and at most a week back. Anchored at Dhaka NOON
 * so no timezone reading can push it into the neighbouring day.
 */
function resolveBusinessDate(raw) {
  const today = getBangladeshTodayStr();
  const day = raw ? String(raw).slice(0, 10) : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new AppError('Invalid date', 'তারিখ ঠিকভাবে দিন', 400);
  }
  if (day > today) {
    throw new AppError('Date is in the future', 'আগামী দিনের তারিখে লেখা যাবে না', 400);
  }
  const { startOfDay } = getBangladeshDayRange(day);
  const todayStart = getBangladeshDayRange(today).startOfDay;
  if ((todayStart - startOfDay) / 86400000 > MAX_BACKDATE_DAYS) {
    throw new AppError(
      'Date too far back',
      `${MAX_BACKDATE_DAYS} দিনের বেশি আগের তারিখে লেখা যাবে না`,
      400
    );
  }
  return new Date(startOfDay.getTime() + 12 * 3600000);
}

/** Cost figures are behind `products.view_cost`, like Product.buyingPrice. */
function canSeeCost(req) {
  return !req || hasPermission(req, 'products', 'view_cost');
}

function sanitize(doc, req) {
  const out = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  if (!canSeeCost(req)) {
    delete out.avgCost;
    delete out.unitCost;
    delete out.totalCost;
  }
  return out;
}

class IngredientService {
  // ── Master ─────────────────────────────────────────────────────────────────

  async list(req, { includeInactive = false } = {}) {
    const filter = branchFilter(req, { shop: req.shop._id });
    if (!includeInactive) filter.isActive = true;
    const rows = await Ingredient.find(filter).sort({ name: 1 }).lean();
    return rows.map((r) => sanitize(r, req));
  }

  async _load(req, id, session = null) {
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      throw new AppError('Ingredient not found', 'কাঁচামালটি পাওয়া যায়নি', 404);
    }
    const doc = await Ingredient.findOne(
      branchFilter(req, { _id: id, shop: req.shop._id })
    ).session(session);
    if (!doc) throw new AppError('Ingredient not found', 'কাঁচামালটি পাওয়া যায়নি', 404);
    return doc;
  }

  _assertUnit(req, unit) {
    if (!unit) return;
    const allowed = unitsForShop({ packaging: hasFeature(req, 'packaging'), restaurant: true });
    if (!allowed.includes(unit)) {
      throw new AppError(`Unit "${unit}" not available`, 'এই এককটি চালু নেই', 400);
    }
  }

  async _assertNameFree(req, name, exceptId = null) {
    const clash = await Ingredient.findOne(branchFilter(req, {
      shop: req.shop._id,
      name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
      ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    })).select('_id').lean();
    if (clash) {
      throw new AppError('Name already used', `"${name}" নামে কাঁচামাল আগে থেকেই আছে`, 409);
    }
  }

  async create(req, userId, data) {
    const branch = requireBranch(req);
    const name = String(data.name || '').trim();
    if (!name) throw new AppError('Name required', 'কাঁচামালের নাম দিন', 400);
    const unit = data.unit || 'kg';
    this._assertUnit(req, unit);
    await this._assertNameFree(req, name);

    const stock = data.stock === undefined || data.stock === '' || data.stock === null
      ? 0
      : parseQuantity(data.stock, unit, { label: name, allowZero: true });
    const avgCost = Number(data.avgCost) || 0;
    if (avgCost < 0) throw new AppError('Invalid cost', 'দাম ০ এর কম হতে পারে না', 400);
    const minStock = data.minStock ? parseQuantity(data.minStock, unit, { allowZero: true }) : 0;

    return runInTransaction(async (session) => {
      const [doc] = await Ingredient.create([{
        shop: req.shop._id, branch, name, unit, stock, avgCost, minStock, createdBy: userId,
      }], { session });
      if (stock > 0) {
        await IngredientMovement.create([{
          shop: req.shop._id, branch, ingredient: doc._id, ingredientName: name, unit,
          type: 'opening', quantity: stock, previousStock: 0, newStock: stock,
          unitCost: avgCost, totalCost: quantizeMoney(stock * avgCost),
          date: new Date(), createdBy: userId,
        }], { session });
      }
      return sanitize(doc, req);
    });
  }

  /**
   * Name, unit, warning level, active. NEVER stock or cost — stock moves only
   * through a movement, and avgCost only through a purchase. Changing the unit
   * does not convert the stored stock (CLAUDE.md §13.3); the UI warns.
   */
  async update(req, id, data) {
    const doc = await this._load(req, id);
    if (data.name !== undefined) {
      const name = String(data.name).trim();
      if (!name) throw new AppError('Name required', 'কাঁচামালের নাম দিন', 400);
      await this._assertNameFree(req, name, doc._id);
      doc.name = name;
    }
    if (data.unit !== undefined && data.unit !== doc.unit) {
      this._assertUnit(req, data.unit);
      doc.unit = data.unit;
    }
    if (data.minStock !== undefined) {
      doc.minStock = parseQuantity(data.minStock || 0, doc.unit, { allowZero: true });
    }
    if (data.isActive !== undefined) doc.isActive = Boolean(data.isActive);
    await doc.save();
    return sanitize(doc, req);
  }

  // ── Store-room movements ───────────────────────────────────────────────────

  /**
   * রান্নাঘরে দেওয়া — one sheet, many lines, one transaction.
   *
   *   mode 'used'  line.quantity = what went to the kitchen
   *   mode 'left'  line.quantity = what was counted on the shelf; used is
   *                stock − counted, computed HERE from a read inside the
   *                transaction, never from a number the client worked out.
   *
   * 'left' guards on the EXACT stock it read: a delivery received while the
   * count was being typed would otherwise be booked as cooking.
   */
  async issue(req, userId, data) {
    const branch = requireBranch(req);
    const mode = data.mode === 'left' ? 'left' : 'used';
    const type = data.type === 'waste' ? 'waste' : 'consumption';
    const date = resolveBusinessDate(data.date);
    const lines = Array.isArray(data.lines) ? data.lines : [];
    if (!lines.length) throw new AppError('No lines', 'অন্তত একটি কাঁচামাল দিন', 400);
    const seen = new Set();
    for (const l of lines) {
      const key = String(l.ingredient);
      if (seen.has(key)) {
        throw new AppError('Duplicate ingredient', 'একই কাঁচামাল দুবার দেওয়া হয়েছে', 400);
      }
      seen.add(key);
    }

    const result = await runInTransaction(async (session) => {
      const sheet = new mongoose.Types.ObjectId();
      const rows = [];
      let totalCost = 0;

      for (const line of lines) {
        const doc = await this._load(req, line.ingredient, session);
        const counted = parseQuantity(line.quantity, doc.unit, { label: doc.name, allowZero: true });
        const before = quantize(doc.stock || 0, doc.unit);
        let used;
        if (mode === 'left') {
          if (counted > before) {
            throw new AppError(
              'Counted more than stock',
              `"${doc.name}" গুনে ${counted} পেয়েছেন, খাতায় ${before} — বেশি পেলে "স্টক ঠিক করুন" দিয়ে সংশোধন করুন`,
              400
            );
          }
          used = quantize(before - counted, doc.unit);
        } else {
          used = counted;
        }
        if (!(used > 0)) continue;

        const filter = mode === 'left'
          ? { _id: doc._id, shop: req.shop._id, stock: doc.stock }
          : { _id: doc._id, shop: req.shop._id, stock: { $gte: used } };
        const prev = await Ingredient.findOneAndUpdate(
          filter, stockDelta(-used, doc.unit), { new: false, session }
        );
        if (!prev) {
          throw new AppError(
            'Stock changed',
            mode === 'left'
              ? `"${doc.name}" এর স্টক এইমাত্র বদলেছে — পেজ রিফ্রেশ করে আবার গুনে দিন`
              : `"${doc.name}" স্টকে আছে ${before} — এর বেশি দেওয়া যাবে না`,
            409
          );
        }

        const unitCost = prev.avgCost || 0;
        const cost = quantizeMoney(used * unitCost);
        totalCost = quantizeMoney(totalCost + cost);
        rows.push({
          shop: req.shop._id, branch, ingredient: doc._id, ingredientName: doc.name, unit: doc.unit,
          type, quantity: -used,
          previousStock: prev.stock, newStock: quantize(prev.stock - used, doc.unit),
          unitCost, totalCost: cost, date, sheet,
          notes: data.notes ? String(data.notes).slice(0, 300) : undefined,
          createdBy: userId,
        });
      }

      if (!rows.length) {
        throw new AppError('Nothing used', 'কোনো কাঁচামাল কমেনি — পরিমাণ দিন', 400);
      }
      await IngredientMovement.insertMany(rows, { session });
      return {
        sheet,
        lines: rows.length,
        totalCost: canSeeCost(req) ? totalCost : undefined,
      };
    });
    // The P&L and daily summary are cached behind the shop's version key; a
    // sheet changes their কাঁচামাল খরচ, so it invalidates them like a sale does.
    // Never awaited into the response's fate: a cache hiccup must not fail a
    // write that has already committed.
    cacheService.bumpShopCacheVersion(req.shop._id).catch(() => {});
    return result;
  }

  /**
   * স্টক ঠিক করুন — set the figure the shelf actually holds after a typo or a
   * miscount. Booked as `adjustment`, which the P&L never reads: a correction
   * is not a day's cooking. Real loss goes through `issue({ type: 'waste' })`.
   */
  async adjust(req, userId, id, data) {
    const branch = requireBranch(req);
    return runInTransaction(async (session) => {
      const doc = await this._load(req, id, session);
      const target = parseQuantity(data.stock, doc.unit, { label: doc.name, allowZero: true });
      const before = doc.stock || 0;
      const delta = quantize(target - before, doc.unit);
      if (delta === 0) return sanitize(doc, req);

      const prev = await Ingredient.findOneAndUpdate(
        { _id: doc._id, shop: req.shop._id, stock: doc.stock },
        stockDelta(delta, doc.unit),
        { new: false, session }
      );
      if (!prev) {
        throw new AppError('Stock changed', `"${doc.name}" এর স্টক এইমাত্র বদলেছে — আবার চেষ্টা করুন`, 409);
      }
      await IngredientMovement.create([{
        shop: req.shop._id, branch, ingredient: doc._id, ingredientName: doc.name, unit: doc.unit,
        type: 'adjustment', quantity: delta, previousStock: before, newStock: target,
        unitCost: doc.avgCost || 0, totalCost: quantizeMoney(Math.abs(delta) * (doc.avgCost || 0)),
        date: new Date(),
        notes: data.notes ? String(data.notes).slice(0, 300) : undefined,
        createdBy: userId,
      }], { session });
      doc.stock = target;
      return sanitize(doc, req);
    });
  }

  async movements(req, { ingredient, type, from, to, page = 1, limit = 50 } = {}) {
    const filter = branchFilter(req, { shop: req.shop._id });
    if (ingredient) filter.ingredient = ingredient;
    if (type && IngredientMovement.MOVEMENT_TYPES.includes(type)) filter.type = type;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = getBangladeshDayRange(String(from).slice(0, 10)).startOfDay;
      if (to) filter.date.$lte = getBangladeshDayRange(String(to).slice(0, 10)).endOfDay;
    }
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const pg = Math.max(parseInt(page, 10) || 1, 1);
    const [rows, total] = await Promise.all([
      IngredientMovement.find(filter).sort({ createdAt: -1 }).skip((pg - 1) * lim).limit(lim).lean(),
      IngredientMovement.countDocuments(filter),
    ]);
    return {
      data: rows.map((r) => sanitize(r, req)),
      pagination: { page: pg, limit: lim, total, pages: Math.ceil(total / lim) },
    };
  }

  /**
   * What the kitchen cost over a period — the P&L's "কাঁচামাল খরচ", split by
   * type, by ingredient and by day. Ids CAST (I-3): `$match` does not.
   */
  /** The shape `costTotals` returns when there is nothing to count. */
  emptyCost() {
    return { total: 0, consumption: 0, waste: 0, byIngredient: [], byDay: [] };
  }

  async costTotals(shopId, branchId, { start, end } = {}) {
    const match = { shop: oid(shopId), type: { $in: [...COST_TYPES] } };
    if (branchId) match.branch = oid(branchId);
    if (start || end) {
      match.date = {};
      if (start) match.date.$gte = start;
      if (end) match.date.$lte = end;
    }
    const [result] = await IngredientMovement.aggregate([
      { $match: match },
      {
        $facet: {
          byType: [{ $group: { _id: '$type', total: { $sum: '$totalCost' } } }],
          byIngredient: [
            {
              $group: {
                _id: '$ingredient',
                name: { $last: '$ingredientName' },
                unit: { $last: '$unit' },
                quantity: { $sum: { $abs: '$quantity' } },
                total: { $sum: '$totalCost' },
              },
            },
            { $sort: { total: -1 } },
          ],
          byDay: [
            {
              $group: {
                // Dhaka calendar day — a bare $dateToString buckets in UTC
                // (reportDateBuckets.test.js).
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: BD_TZ } },
                total: { $sum: '$totalCost' },
              },
            },
            { $sort: { _id: 1 } },
          ],
        },
      },
    ]);
    const byType = Object.fromEntries((result?.byType || []).map((r) => [r._id, quantizeMoney(r.total)]));
    const consumption = byType.consumption || 0;
    const waste = byType.waste || 0;
    return {
      total: quantizeMoney(consumption + waste),
      consumption,
      waste,
      byIngredient: (result?.byIngredient || []).map((r) => ({
        ingredient: r._id, name: r.name, unit: r.unit,
        quantity: quantize(r.quantity, r.unit), total: quantizeMoney(r.total),
      })),
      byDay: (result?.byDay || []).map((r) => ({ date: r._id, total: quantizeMoney(r.total) })),
    };
  }

  async costReport(req, { from, to } = {}) {
    const today = getBangladeshTodayStr();
    const start = getBangladeshDayRange(String(from || today).slice(0, 10)).startOfDay;
    const end = getBangladeshDayRange(String(to || today).slice(0, 10)).endOfDay;
    if (!canSeeCost(req)) {
      throw new AppError('Forbidden', 'খরচ দেখার অনুমতি নেই', 403);
    }
    return this.costTotals(req.shop._id, req.branchId || null, { start, end });
  }

  // ── Purchase integration (called from purchase.service, inside its session) ──

  /** Resolve the ingredient lines of a purchase in one read. */
  async loadForPurchase(req, ids, session) {
    if (!ids.length) return new Map();
    if (!hasFeature(req, 'restaurant')) {
      throw new AppError(
        'Ingredients require the restaurant capability',
        'কাঁচামাল কেনার সুবিধা আপনার দোকানে চালু নেই',
        403
      );
    }
    const docs = await Ingredient.find(branchFilter(req, {
      _id: { $in: ids }, shop: req.shop._id, isActive: true,
    })).session(session || null);
    return new Map(docs.map((d) => [String(d._id), d]));
  }

  /**
   * A purchase line for an ingredient — the same shape the product lines use,
   * so every bill-level reader (totals, print, supplier ledger) sees an
   * ordinary line. `productName` carries the ingredient's name for exactly
   * that reason; `product` is absent, which is what the stock loop in
   * `createPurchase` already skips.
   */
  prepareLine(item, ingredient) {
    const quantity = parseQuantity(item.quantity, ingredient.unit, { label: ingredient.name });
    const unitPrice = Number(item.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new AppError(
        `Invalid unit price for ${ingredient.name}`,
        `"${ingredient.name}" এর ক্রয় মূল্য ঠিকভাবে লিখুন`,
        400
      );
    }
    return {
      ingredient: ingredient._id,
      productName: ingredient.name,
      quantity,
      unit: ingredient.unit,
      purchaseUnit: 'base',
      unitPrice,
      lineDiscount: 0,
      total: quantizeMoney(quantity * unitPrice),
    };
  }

  /**
   * Put a saved purchase's ingredient lines into stock, costed at the LANDED
   * rate (ভাড়া and the supplier's discount spread in) — the rate the bill
   * actually cost, same rule as Product.buyingPrice.
   */
  async receivePurchase(purchase, ingredientMap, userId, session) {
    const rows = [];
    for (const line of purchase.items) {
      if (!line.ingredient) continue;
      const doc = ingredientMap.get(String(line.ingredient));
      if (!doc) continue;
      const rate = Number.isFinite(line.landedUnitPrice) ? line.landedUnitPrice : line.unitPrice;
      const prev = await Ingredient.findOneAndUpdate(
        { _id: doc._id, shop: purchase.shop },
        receiveUpdate(line.quantity, rate, doc.unit),
        { new: false, session }
      );
      if (!prev) throw new AppError('Ingredient not found', 'কাঁচামালটি পাওয়া যায়নি', 404);
      rows.push({
        shop: purchase.shop, branch: purchase.branch || null, ingredient: doc._id,
        ingredientName: doc.name, unit: doc.unit, type: 'purchase',
        quantity: line.quantity, previousStock: prev.stock,
        newStock: quantize((prev.stock || 0) + line.quantity, doc.unit),
        unitCost: rate, totalCost: quantizeMoney(line.quantity * rate),
        date: purchase.date || new Date(),
        reference: { type: 'purchase', id: purchase._id, no: purchase.invoiceNo },
        createdBy: userId,
      });
    }
    if (rows.length) await IngredientMovement.insertMany(rows, { session });
    return rows.length;
  }

  /**
   * Take a cancelled bill's ingredients back out. Clamped at zero, like the
   * product reversal in `cancelPurchase`: rice already cooked cannot be un-cooked,
   * and refusing the cancel over it would leave a wrong bill standing. The
   * cost basis is left alone — un-blending an average after later purchases is
   * not recoverable, and the same call is made for products.
   */
  async reversePurchase(purchase, userId, session) {
    const lines = (purchase.items || []).filter((l) => l.ingredient);
    if (!lines.length) return 0;
    const rows = [];
    for (const line of lines) {
      const doc = await Ingredient.findOne({ _id: line.ingredient, shop: purchase.shop }).session(session || null);
      if (!doc) continue;
      const take = Math.min(line.quantity, doc.stock || 0);
      if (!(take > 0)) continue;
      const prev = await Ingredient.findOneAndUpdate(
        { _id: doc._id, shop: purchase.shop, stock: { $gte: take } },
        stockDelta(-take, doc.unit),
        { new: false, session }
      );
      if (!prev) continue;
      rows.push({
        shop: purchase.shop, branch: purchase.branch || null, ingredient: doc._id,
        ingredientName: doc.name, unit: doc.unit, type: 'purchase_cancel',
        quantity: -take, previousStock: prev.stock,
        newStock: quantize(prev.stock - take, doc.unit),
        unitCost: line.landedUnitPrice ?? line.unitPrice ?? 0,
        totalCost: quantizeMoney(take * (line.landedUnitPrice ?? line.unitPrice ?? 0)),
        date: new Date(),
        reference: { type: 'purchase', id: purchase._id, no: purchase.invoiceNo },
        createdBy: userId,
      });
    }
    if (rows.length) await IngredientMovement.insertMany(rows, { session });
    return rows.length;
  }
}

const service = new IngredientService();
service._internals = { stockDelta, receiveUpdate, resolveBusinessDate };
module.exports = service;
