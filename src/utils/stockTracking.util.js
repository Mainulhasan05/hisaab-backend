/**
 * Uncounted stock — `Product.trackStock === false`.
 *
 * A ভাতের হোটেল does not count plates of rice. It cooks a pot, sells until the
 * pot is empty, and cooks another. A product marked this way sells with no
 * stock check, writes no stock and no StockTransaction row, and is refused by
 * every path that would ADD stock to it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO GATES, AND THEY MUST NOT BE MERGED (same shape as quantityUnit /
 * storageUnit, and priceTierFor / sellingPriceFor)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   normalizeTrackStock(raw, req)   WRITE — may this request SET the field?
 *                                   Depends on `features.restaurant`.
 *   isStockTracked(product)         READ  — does this product's stock count?
 *                                   Depends on the DATA only.
 *
 * Merging them onto the flag looks tidier and is the bug: an admin switching
 * `restaurant` off at 1pm would turn every uncounted dish into a product with
 * stock 0, and the hotel could not sell lunch. The flag decides whether the
 * checkbox is offered; it never decides whether food can be sold.
 */

const { AppError } = require('../middleware/error.middleware');
const { hasFeature } = require('./features.util');

/**
 * Is this product's stock a number the shop keeps? Null-safe; absent means yes,
 * which is every product that existed before the field did.
 */
function isStockTracked(product) {
  return product?.trackStock !== false;
}

/**
 * Filter fragment matching the COUNTED products — for stock reports, low-stock
 * counts and inventory value. `$ne: false` rather than `true` because the field
 * is absent on nearly every document, and absent must match.
 */
const TRACKED_FILTER = Object.freeze({ trackStock: { $ne: false } });

/**
 * Validate a posted `trackStock` on create / update.
 *
 *   absent            → undefined (caller must not touch the field)
 *   true              → true      (always allowed: counting is the default)
 *   false, flag on    → false
 *   false, flag off   → 403
 *
 * `true` is allowed without the flag on purpose: it is how a shop that lost
 * the capability can still go back to counting a product.
 */
function normalizeTrackStock(raw, req) {
  if (raw === undefined) return undefined;
  if (raw === false && !hasFeature(req, 'restaurant')) {
    throw new AppError(
      'Uncounted stock requires the restaurant capability',
      'স্টক না গোনার সুবিধা আপনার দোকানে চালু নেই',
      403
    );
  }
  return Boolean(raw);
}

/**
 * Refuse a stock-in / stock-move operation on an uncounted product. Mirrors
 * `combo.util.assertNotCombo`: a purchase of 50 plates of rice would mint a
 * stock figure the product explicitly does not keep.
 *
 * @param {Object} product
 * @param {string} contextBn  what the caller was trying to do, in Bengali
 */
function assertTracked(product, contextBn = 'এই কাজটি') {
  if (!isStockTracked(product)) {
    throw new AppError(
      `"${product.name}" does not track stock.`,
      `"${product.name}" এর স্টক গোনা হয় না — ${contextBn} এতে করা যাবে না। কাঁচামাল খরচে লিখুন।`,
      400
    );
  }
}

module.exports = {
  isStockTracked,
  TRACKED_FILTER,
  normalizeTrackStock,
  assertTracked,
};
