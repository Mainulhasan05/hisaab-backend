/**
 * Cost basis — what the shop actually paid for the goods it is selling.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Sale.pre('save')` computes profit as `(unitPrice - buyingPrice) * quantity`,
 * and `buyingPrice` is snapshotted off the product at the moment of sale
 * (`sale.service`). So every profit figure in the app — the dashboard, the P&L,
 * the staff report, the per-product margin — rests on `Product.buyingPrice`.
 *
 * And nothing maintained it. `createPurchase` incremented stock, wrote a batch
 * carrying the real `costPrice`, and never touched `buyingPrice`. The cost basis
 * was therefore whatever a shopkeeper last typed into the product form, possibly
 * a year and twenty deliveries ago. As supplier prices moved, reported profit
 * drifted away from real profit with nothing anywhere to indicate it — the shop
 * saw healthy margins on goods it was selling at a loss.
 *
 * The data needed to fix it was already being captured and thrown away.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY MOVING AVERAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three costing methods were available and only one fits this product:
 *
 *   FIFO/FEFO layer costing  The most exact — cost each sale against the batch
 *                            it actually drew from. But `batches` is optional
 *                            (`trackBatches`), so it exists for a minority of
 *                            products; every other product would need a second,
 *                            different costing path. Two methods in one ledger
 *                            is how a book stops reconciling.
 *
 *   Last purchase price      One line of code, and wrong in the common case: one
 *                            small top-up delivery at a promotional rate
 *                            restates the cost of the whole shelf.
 *
 *   Moving weighted average  What the shelf actually cost, blended as goods
 *                            arrive. It needs only `stock` and `buyingPrice`,
 *                            which every product has, and it is what small-shop
 *                            accounting (and every POS this one competes with)
 *                            means by "ক্রয় মূল্য".
 *
 * The formula, applied on receipt and nowhere else:
 *
 *     newCost = (onHand x oldCost + received x unitCost) / (onHand + received)
 *
 * Selling does not change it — that is the defining property of the method and
 * the reason it is cheap: only the purchase path needs to write.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO PROPERTIES WORTH KNOWING BEFORE CHANGING THIS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   • `onHand` is clamped at 0. A product oversold into negative stock (possible
 *     through `clampAtZero` reversals) would otherwise produce a negative or
 *     wildly inflated denominator. With no stock on hand there is nothing to
 *     blend, so the delivery's own rate simply becomes the cost.
 *
 *   • The update is a PIPELINE, so `onHand` and `oldCost` are read server-side at
 *     write time. Computing the average in JS from the document as it was read
 *     at the top of `createPurchase` would be a read-modify-write with no guard —
 *     the same defect the stock write in that file was fixed for.
 *
 * The op must be ordered BEFORE the stock increment, because the formula wants
 * the stock as it was BEFORE the delivery landed. `bulkWrite` is ordered, so
 * pushing this op first is sufficient.
 */
const mongoose = require('mongoose');

/**
 * Paisa precision. Deliberately a literal matching `quantity.util.quantizeMoney`
 * rather than an import: that function hard-codes `x 100` too, and a cost basis
 * rounded to a different number of places than every other money figure is a
 * drift nobody would look for.
 */
const COST_DP = 2;

/**
 * `$expr` for the blended cost of one shelf, given the paths its stock and cost
 * live at. Shared by the product-level and variant-level builders so the two can
 * never blend differently.
 *
 * @param {string} stockPath  e.g. `'$stock'` or `'$$v.stock'`
 * @param {string} costPath   e.g. `'$buyingPrice'` or `'$$v.buyingPrice'`
 * @param {number} received   base-unit quantity arriving, > 0
 * @param {number} unitCost   per-base-unit cost of what is arriving
 */
function blendExpr(stockPath, costPath, received, unitCost) {
  const onHand = { $max: [0, { $ifNull: [stockPath, 0] }] };
  const denominator = { $add: [onHand, received] };

  return {
    $round: [
      {
        $cond: [
          { $gt: [denominator, 0] },
          {
            $divide: [
              {
                $add: [
                  { $multiply: [onHand, { $ifNull: [costPath, 0] }] },
                  received * unitCost,
                ],
              },
              denominator,
            ],
          },
          // Nothing on the shelf to blend with — the delivery IS the cost.
          unitCost,
        ],
      },
      COST_DP,
    ],
  };
}

/**
 * Should a received line move the cost basis at all?
 *
 * A zero or absent cost is a shopkeeper recording a delivery they have not been
 * billed for yet (samples, a replacement for damaged goods, an opening count).
 * Blending ৳0 into the average would write the shelf's cost down to nothing and
 * report the next sale as pure profit — a far worse answer than leaving the
 * previous cost in place.
 *
 * @param {number} received
 * @param {number} unitCost
 * @returns {boolean}
 */
function shouldRecost(received, unitCost) {
  return Number.isFinite(received) && received > 0
    && Number.isFinite(unitCost) && unitCost > 0;
}

/**
 * Pipeline update that re-blends a non-variant product's `buyingPrice`.
 *
 * @param {number} received
 * @param {number} unitCost
 * @returns {Array|null} null when the line must not move the cost
 */
function buildProductCostUpdate(received, unitCost) {
  if (!shouldRecost(received, unitCost)) return null;
  return [{ $set: { buyingPrice: blendExpr('$stock', '$buyingPrice', received, unitCost) } }];
}

/**
 * Pipeline update that re-blends ONE variant's `buyingPrice`.
 *
 * `$map` rather than the positional `$` for the reason `buildVariantStockUpdate`
 * documents: a pipeline update has no positional operator. `variantId` MUST be
 * cast — inside a pipeline `$eq` compares BSON types, so a string id matches no
 * element and the update silently does nothing (I-3).
 *
 * @param {ObjectId|string} variantId
 * @param {number} received
 * @param {number} unitCost
 * @returns {Array|null}
 */
function buildVariantCostUpdate(variantId, received, unitCost) {
  if (!shouldRecost(received, unitCost)) return null;

  const vid = new mongoose.Types.ObjectId(variantId);

  return [{
    $set: {
      variants: {
        $map: {
          input: { $ifNull: ['$variants', []] },
          as: 'v',
          in: {
            $cond: [
              { $eq: ['$$v._id', vid] },
              {
                $mergeObjects: [
                  '$$v',
                  { buyingPrice: blendExpr('$$v.stock', '$$v.buyingPrice', received, unitCost) },
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

/**
 * The blended cost, computed in JS.
 *
 * Used for two things the pipeline cannot do: telling the caller what the cost
 * BECAME (so a cancellation can recognise its own effect — see
 * `Purchase.items[].costAfter`), and unit testing the formula without a database.
 *
 * Must stay arithmetically identical to `blendExpr`. `packagingUnits`-style
 * tests pin them against each other.
 *
 * @param {number} onHandRaw
 * @param {number} oldCostRaw
 * @param {number} received
 * @param {number} unitCost
 * @returns {number}
 */
function blendedCost(onHandRaw, oldCostRaw, received, unitCost) {
  if (!shouldRecost(received, unitCost)) {
    const previous = Number(oldCostRaw);
    return Number.isFinite(previous) ? previous : 0;
  }

  const onHand = Math.max(0, Number(onHandRaw) || 0);
  const oldCost = Number(oldCostRaw) || 0;
  const denominator = onHand + received;
  if (denominator <= 0) return unitCost;

  const factor = Math.pow(10, COST_DP);
  return Math.round(((onHand * oldCost + received * unitCost) / denominator) * factor) / factor;
}

module.exports = {
  COST_DP,
  shouldRecost,
  buildProductCostUpdate,
  buildVariantCostUpdate,
  blendedCost,
};
