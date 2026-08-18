/**
 * The retail price a delivery sets.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `costing.util` re-blends `Product.buyingPrice` the moment goods are received,
 * because the shelf's cost basis genuinely changed. Nothing did the same for
 * `sellingPrice`, and nothing should have — a price is a decision, not an
 * average — but the decision had nowhere to be made. Recording the purchase and
 * repricing the goods were two separate errands on two separate screens, and in
 * practice the second one did not happen: shops sold new stock at last season's
 * price against a cost that had already moved, and every margin figure agreed
 * that this was fine.
 *
 * So the purchase form now carries the price, and this file is the three
 * decisions that follow from it:
 *
 *     parseSellingPrice(raw, productName) -> number | null   what was asked for
 *     buildSellingPriceUpdate(...)        -> op | null       how to write it
 *     buildSellingPriceRestore(...)       -> op | null       how to undo it
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SET AND NOT A BLEND
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Cost is an average of what the shop paid over time, so a new delivery moves it
 * only partly. A price is what the shopkeeper has decided to charge from now on,
 * so the last one entered is simply the right one. Averaging prices would
 * produce a number nobody chose and no customer was ever charged.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO PROPERTIES WORTH KNOWING BEFORE CHANGING THIS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   • ZERO MEANS ABSENT, not free. A cleared number input posts 0, and writing
 *     ৳0 as a price hands the goods away. `packSellingPrice` and
 *     `wholesalePrice` already read 0 this way for the same reason; anything
 *     that changes it here has to change it there too.
 *
 *   • THE REVERSAL IS OWNERSHIP-CHECKED. A cancellation restores the old price
 *     only while the current price is still the one this delivery wrote. A price
 *     is something a person chose, so silently undoing a choice made after this
 *     delivery — on the product form, or on a later purchase — is worse than
 *     leaving a price that is merely stale.
 */

/** Paisa tolerance, matching `cancelPurchase`'s cost comparison. */
const PRICE_EPSILON = 0.005;

/**
 * What the request asked the shelf price to become.
 *
 * @param {*} raw            whatever the purchase line carried
 * @param {string} [label]   product name, for the Bengali error
 * @returns {number|null}    null = "leave the price alone"
 * @throws {AppError} 400 on a non-empty value that is not a usable price
 */
function parseSellingPrice(raw, label = '') {
  // Lazily required, like `saleDate.util` does it: `error.middleware` drags in
  // the logger and config, and this has to stay usable from scripts and seeders
  // with no app context.
  const { AppError } = require('../middleware/error.middleware');

  if (raw === undefined || raw === null || raw === '') return null;

  const parsed = Number(raw);

  // Validated hard rather than coerced, exactly like `unitPrice`: a malformed
  // price silently becoming NaN → 0 is how a shop ends up selling at nothing,
  // and this number is written straight onto the product where every future
  // sale reads it.
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AppError(
      `Invalid selling price${label ? ` for ${label}` : ''}`,
      `${label ? `"${label}" এর ` : ''}বিক্রয় মূল্য ঠিকভাবে লিখুন`,
      400
    );
  }

  if (parsed === 0) return null;

  return Math.round(parsed * 100) / 100;
}

/**
 * The bulkWrite op that writes a line's price onto its product.
 *
 * A plain `$set` with the positional `$` for the variant case — safe here, and
 * unlike `buildVariantCostUpdate` this needs no `$map`: a pipeline is required
 * only when the new value must be computed from the document's own fields, and
 * a literal has nothing to read.
 *
 * @param {Object} input
 * @param {ObjectId|string} input.productId
 * @param {ObjectId|string} [input.variantId]  the variant this line is for
 * @param {boolean} [input.hasVariants]        whether the product is a variant one
 * @param {number|null} input.sellingPrice
 * @returns {Object|null} a bulkWrite op, or null when nothing is to be written
 */
function buildSellingPriceUpdate({ productId, variantId = null, hasVariants = false, sellingPrice }) {
  if (sellingPrice == null || !(sellingPrice > 0)) return null;

  // A variant line prices its OWN variant. Writing the parent's field for a
  // variant product would set a number that nothing reads — `pricing.util`
  // resolves a variant sale off the variant.
  const isVariantLine = Boolean(variantId && hasVariants);

  return {
    updateOne: {
      filter: isVariantLine
        ? { _id: productId, 'variants._id': variantId }
        : { _id: productId },
      update: {
        $set: { [isVariantLine ? 'variants.$.sellingPrice' : 'sellingPrice']: sellingPrice },
      },
    },
  };
}

/**
 * The bulkWrite op that undoes it, or null when this delivery no longer owns
 * the number.
 *
 * `sellingPriceBefore` of `null`/absent means the product had NO price before
 * this line set one, and the reversal restores that absence with `$unset`
 * rather than writing 0 — "there was no price" and "the price was zero" are
 * different states, and only one of them gives the goods away.
 *
 * @param {Object} input
 * @param {ObjectId|string} input.productId
 * @param {ObjectId|string} [input.variantId]
 * @param {boolean} [input.hasVariants]
 * @param {number|null|undefined} input.sellingPrice        what the line set
 * @param {number|null|undefined} input.sellingPriceBefore  what it was before
 * @param {number|null|undefined} input.currentPrice        what it is NOW
 * @returns {Object|null}
 */
function buildSellingPriceRestore({
  productId,
  variantId = null,
  hasVariants = false,
  sellingPrice,
  sellingPriceBefore,
  currentPrice,
}) {
  // The line never wrote a price, so there is nothing to undo.
  if (sellingPrice == null || !(sellingPrice > 0)) return null;

  // Someone has repriced since. That change owns the number now; reversing past
  // it would discard a price a person deliberately chose.
  if (currentPrice == null) return null;
  if (Math.abs(currentPrice - sellingPrice) >= PRICE_EPSILON) return null;

  const isVariantLine = Boolean(variantId && hasVariants);
  const path = isVariantLine ? 'variants.$.sellingPrice' : 'sellingPrice';
  const hadPrice = sellingPriceBefore != null && Number.isFinite(sellingPriceBefore);

  return {
    updateOne: {
      filter: isVariantLine
        ? { _id: productId, 'variants._id': variantId }
        : { _id: productId },
      update: hadPrice
        ? { $set: { [path]: sellingPriceBefore } }
        : { $unset: { [path]: '' } },
    },
  };
}

module.exports = {
  PRICE_EPSILON,
  parseSellingPrice,
  buildSellingPriceUpdate,
  buildSellingPriceRestore,
};
