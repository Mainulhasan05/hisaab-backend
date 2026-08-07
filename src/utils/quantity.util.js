/**
 * Quantity Utility — the only sanctioned way to round, validate, format or
 * write a quantity.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS SOLVES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Before the packaging feature every quantity was an integer, so `$inc` was
 * exact and nobody had to think. Fractional units (কেজি, লিটার, গজ) break that:
 *
 *     0.1 + 0.2  ===  0.30000000000000004
 *
 * Left alone, that error ACCUMULATES in the stored double. Three ways it bites,
 * all of them silent:
 *
 *   1. The screen prints "৯৯.৯৯৯৯৯৯৯৯৯৯৯৯৯৮ কেজি".
 *   2. Stock is really 0.9999999999 when it should be 1. The atomic
 *      `stock: { $gte: 1 }` guard then REFUSES a legitimate 1kg sale, and the
 *      cashier is told "পর্যাপ্ত স্টক নেই" while the screen says ১ কেজি.
 *   3. Stock that should be exactly 0 sits at 1.4e-14 forever, so the product
 *      never leaves the "in stock" list and never triggers a reorder.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FIX: QUANTIZE ON EVERY WRITE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `buildStockUpdate()` re-rounds the stored value to the unit's precision as
 * part of the same atomic update that changes it. Error is therefore clamped on
 * every single operation instead of accumulating across a million of them.
 *
 * Two subtleties worth knowing before you "simplify" this:
 *
 *   • The `$round` is mathematically a NO-OP. A 3-decimal value minus a
 *     3-decimal value is exactly a 3-decimal value; all `$round` does is snap
 *     the binary representation back to the nearest double to that decimal. So
 *     the fact that MongoDB's `$round` breaks ties to-even while JS's
 *     `Math.round` breaks them up NEVER MATTERS HERE — a tie can never arise.
 *     Do not add code to reconcile them.
 *
 *   • For `decimals === 0` units this file returns the ORIGINAL `$inc` update,
 *     untouched. Integer arithmetic on doubles is already exact. That means
 *     every shop without the packaging flag — and every countable product in a
 *     shop with it — runs the exact same query it ran before this file existed.
 *     That is invariant I-6, enforced in code rather than by comment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RANGE GUARANTEE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A double's spacing at magnitude M is M x 2^-52, so 3-decimal rounding stays
 * unambiguous while M < 0.0005 x 2^52 ~= 2.25 x 10^12. `parseQuantity` refuses
 * anything above SAFE_QUANTITY_MAX (2 x 10^12), so the guarantee is enforced,
 * not assumed. No Decimal128, no BigInt, no schema change — `stock` stays a
 * plain Number and every existing index, aggregation and JSON response keeps
 * its shape.
 */
const mongoose = require('mongoose');
const { AppError } = require('../middleware/error.middleware');
const { toBengaliNumber } = require('./bengali.util');
const { hasFeature } = require('./features.util');
const {
  unitDecimals,
  unitLabel,
  isDivisible,
  SAFE_QUANTITY_MAX,
  DEFAULT_UNIT,
} = require('../config/units');

/**
 * Round a value to a unit's precision.
 *
 * Uses the epsilon-nudged form rather than a bare `Math.round(v * f) / f`:
 * `1.005 * 100` is `100.49999999999999`, which would round DOWN to 1.00.
 *
 * The nudge is proportional to the value, so it corrects representation error
 * at any magnitude — but the MULTIPLIER matters and is not free to pick:
 *
 *   too small (0)     `1.005` and `8.165` round the wrong way
 *   too large (64+)   at 1e11 the nudge exceeds half a unit in the last place
 *                     and pushes correct values UP by one
 *
 * 8 sits in the middle of the window that passes both ends (2..16 all work).
 * `src/tests/packagingUnits.test.js` pins both failure modes. If you change
 * this constant, run that suite — an over-eager nudge silently adds a gram to
 * every large stock figure, which is exactly the class of bug this file exists
 * to prevent.
 *
 * @param {number} value
 * @param {string} unit
 * @returns {number}
 */
function quantize(value, unit = DEFAULT_UNIT) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;

  const dp = unitDecimals(unit);
  if (dp === 0) return Math.round(num);

  const factor = Math.pow(10, dp);
  const scaled = num * factor;
  // See the header: 8 is calibrated, not arbitrary.
  const nudge = Math.abs(scaled) * Number.EPSILON * 8;
  return Math.round(scaled + (scaled >= 0 ? nudge : -nudge)) / factor;
}

/**
 * Round money to paisa. Quantities may be fractional, so `unitPrice x quantity`
 * no longer lands on a whole taka: 70 x 0.333 = 23.310000000000002.
 *
 * @param {number} value
 * @returns {number}
 */
function quantizeMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const scaled = num * 100;
  const nudge = Math.abs(scaled) * Number.EPSILON * 8;
  return Math.round(scaled + (scaled >= 0 ? nudge : -nudge)) / 100;
}

/**
 * True when a value is zero to within the unit's precision.
 *
 * Use this instead of `=== 0` or `> 0` on any fractional stock check. A residue
 * of 1e-14 is not stock; it is float noise, and treating it as stock keeps a
 * sold-out product out of the low-stock report indefinitely.
 *
 * @param {number} value
 * @param {string} unit
 * @returns {boolean}
 */
function isEffectivelyZero(value, unit = DEFAULT_UNIT) {
  const dp = unitDecimals(unit);
  return Math.abs(Number(value) || 0) < 0.5 / Math.pow(10, dp);
}

/**
 * Validate and quantize a quantity arriving from a client.
 *
 * This is the API boundary. Everything downstream may assume the value is
 * finite, positive, within range, and already snapped to the unit's precision —
 * which is what makes the atomic `$gte` stock guard comparable against exact
 * values rather than approximations.
 *
 * @param {*} raw
 * @param {string} unit
 * @param {Object} [opts]
 * @param {string} [opts.label]      product name, for the error message
 * @param {boolean} [opts.allowZero] permit 0 (stock adjustments set to zero)
 * @returns {number}
 * @throws {AppError} 400
 */
function parseQuantity(raw, unit = DEFAULT_UNIT, opts = {}) {
  const { label = '', allowZero = false } = opts;
  const named = label ? `${label}: ` : '';
  const num = Number(raw);

  if (!Number.isFinite(num)) {
    throw new AppError(
      `Invalid quantity: ${raw}`,
      `${named}পরিমাণ সঠিক নয়`,
      400
    );
  }

  if (num < 0) {
    throw new AppError(
      'Quantity cannot be negative',
      `${named}পরিমাণ ঋণাত্মক হতে পারবে না`,
      400
    );
  }

  if (num > SAFE_QUANTITY_MAX) {
    throw new AppError(
      `Quantity exceeds the maximum of ${SAFE_QUANTITY_MAX}`,
      `${named}পরিমাণ অনেক বেশি`,
      400
    );
  }

  // Countable units refuse fractions outright rather than silently rounding
  // 0.5 piece to 1 — a rounded quantity is a wrong invoice, not a small one.
  if (!isDivisible(unit) && !Number.isInteger(num)) {
    throw new AppError(
      `${unit} cannot be sold in fractions`,
      `${named}${unitLabel(unit)} ভগ্নাংশে হিসাব করা যাবে না, পূর্ণ সংখ্যা দিন`,
      400
    );
  }

  const value = quantize(num, unit);

  if (!allowZero && isEffectivelyZero(value, unit)) {
    throw new AppError(
      'Quantity must be greater than zero',
      `${named}পরিমাণ ০ এর বেশি হতে হবে`,
      400
    );
  }

  return value;
}

/**
 * Render a quantity for humans: Bengali digits, Indian grouping, and NO
 * trailing zeros — "৯৯.৫", never "৯৯.৫০০", and "১০০", never "১০০.০০০".
 *
 * Every quantity shown to a user goes through here or its frontend twin in
 * `lib/quantity.js`. Calling `.toLocaleString()` on a raw quantity is what puts
 * "৩৩.৩৩৩৩৩৩৩৩৩৩৩" on a receipt.
 *
 * @param {number} value
 * @param {string} unit
 * @returns {string}
 */
function formatQuantity(value, unit = DEFAULT_UNIT) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '০';

  const dp = unitDecimals(unit);
  const abs = Math.abs(quantize(num, unit));

  const fixed = abs.toFixed(dp);
  const [intPart, fracPartRaw = ''] = fixed.split('.');
  const fracPart = fracPartRaw.replace(/0+$/, '');

  const grouped = Number(intPart).toLocaleString('en-IN');
  const composed = fracPart ? `${grouped}.${fracPart}` : grouped;

  return `${num < 0 ? '-' : ''}${toBengaliNumber(composed)}`;
}

/** As formatQuantity, with the Bengali unit label appended — "৯৯.৫ কেজি". */
function formatQuantityWithUnit(value, unit = DEFAULT_UNIT) {
  return `${formatQuantity(value, unit)} ${unitLabel(unit)}`;
}

/* ───────────────────────────────────────────────────────────────────────────
 * TWO UNITS, TWO QUESTIONS. DO NOT MERGE THEM.
 *
 * A future reader will notice `quantityUnit` and `storageUnit` usually return
 * the same string and be tempted to collapse them. They answer different
 * questions and diverge in exactly the cases that matter:
 *
 *   quantityUnit(req, product)  "may this REQUEST send a fraction, and how do
 *                                we show it back?"     → depends on the FLAG
 *
 *   storageUnit(product)        "at what precision must the STORED number be
 *                                re-rounded?"          → depends on the DATA
 *
 * Merging them onto the flag breaks a shop whose packaging flag is turned OFF
 * while it still holds fractional stock from when it was on: writes would stop
 * re-rounding and the drift this whole file exists to prevent comes back —
 * silently, months later, on data nobody is looking at.
 *
 * Merging them onto the data instead would let a shop without the flag submit
 * `0.5` for a kg product, which is the feature it has not paid for.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * INPUT + DISPLAY gate. The unit a client is allowed to express quantities in
 * on this request.
 *
 * Without `features.packaging` this returns DEFAULT_UNIT ('piece',
 * `decimals: 0`) whatever the product's unit says, so `parseQuantity` refuses
 * every fraction and `formatQuantity` renders plain integers — exactly the
 * behaviour that shipped before this feature existed (I-6).
 *
 * Reading `product.unit` directly to decide what a client may send reopens the
 * hole. Reading it as a display LABEL (the invoice line) is fine and always was.
 *
 * @param {Object|null} req   Express request; null/undefined reads as flag OFF
 * @param {Object} product    needs `.unit`
 * @returns {string} a units.js key
 */
function quantityUnit(req, product) {
  if (!hasFeature(req, 'packaging')) return DEFAULT_UNIT;
  return product?.unit || DEFAULT_UNIT;
}

/**
 * STORAGE gate. The precision the stored stock number must be re-rounded at.
 *
 * Deliberately takes no `req` and never consults the flag — see the block
 * comment above. Correctness of stored arithmetic cannot depend on a switch an
 * admin may flip either way.
 *
 * Non-divisible units collapse to DEFAULT_UNIT so their writes keep the plain
 * `$inc` path: integer arithmetic on doubles is already exact, there is nothing
 * for a rounding pipeline to fix, and that is the path ~every product in ~every
 * shop takes.
 *
 * @param {Object} product   needs `.unit`
 * @returns {string} a units.js key
 */
function storageUnit(product) {
  const unit = product?.unit || DEFAULT_UNIT;
  return isDivisible(unit) ? unit : DEFAULT_UNIT;
}

/**
 * Build the atomic stock update for a delta.
 *
 * Returns a Mongo update document to be used with the caller's OWN filter — the
 * `stock: { $gte: qty }` guard must stay on the filter, because that is what
 * makes two concurrent cashiers safe. Do not move it in here.
 *
 * Integer units get the original `$inc`, byte for byte. Fractional units get a
 * pipeline update that re-rounds in the same atomic operation.
 *
 * @param {number} delta   signed change; negative for a sale
 * @param {string} unit
 * @param {string} [field] dotted path to the stock field
 * @returns {Object|Array} `{ $inc: {...} }` or an aggregation-pipeline update
 */
function buildStockUpdate(delta, unit = DEFAULT_UNIT, field = 'stock') {
  const dp = unitDecimals(unit);

  if (dp === 0) {
    return { $inc: { [field]: delta } };
  }

  return [{
    $set: {
      [field]: {
        $round: [{ $add: [{ $ifNull: [`$${field}`, 0] }, delta] }, dp],
      },
    },
  }];
}

/**
 * Build the atomic stock update for one variant inside `variants[]`.
 *
 * Integer units keep the positional-operator `$inc` the codebase already uses.
 * Fractional units cannot: **a pipeline update has no positional `$`**, so the
 * array is rebuilt with `$map` and only the matching element is changed. Still
 * one atomic single-document update, still guarded by the caller's
 * `$elemMatch` filter.
 *
 * `variantId` MUST be cast — inside a pipeline `$eq` compares BSON types, so a
 * string id matches no element and the update silently changes nothing (I-3,
 * same trap as `$match`).
 *
 * @param {ObjectId|string} variantId
 * @param {number} delta
 * @param {string} unit
 * @returns {Object|Array}
 */
function buildVariantStockUpdate(variantId, delta, unit = DEFAULT_UNIT) {
  const dp = unitDecimals(unit);

  if (dp === 0) {
    return { $inc: { 'variants.$.stock': delta } };
  }

  const vid = new mongoose.Types.ObjectId(variantId);

  return [{
    $set: {
      variants: {
        $map: {
          input: '$variants',
          as: 'v',
          in: {
            $cond: [
              { $eq: ['$$v._id', vid] },
              {
                $mergeObjects: [
                  '$$v',
                  { stock: { $round: [{ $add: [{ $ifNull: ['$$v.stock', 0] }, delta] }, dp] } },
                ],
              },
              '$$v',
            ],
          },
        },
      },
    },
  }];
}

module.exports = {
  quantize,
  quantizeMoney,
  isEffectivelyZero,
  parseQuantity,
  quantityUnit,
  storageUnit,
  formatQuantity,
  formatQuantityWithUnit,
  buildStockUpdate,
  buildVariantStockUpdate,
};
