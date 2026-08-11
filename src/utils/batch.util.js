/**
 * FEFO batch arithmetic — First-Expiry-First-Out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A UTILITY AND NOT FOUR COPIES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Batch quantities are a second bookkeeping of the same goods `stock` counts,
 * and the two only stay in agreement if EVERY path that moves stock also moves
 * batches. Before this file there was exactly one such path — the non-variant
 * branch of `sale.service` — and four that were not:
 *
 *   - selling a VARIANT (the whole reason per-variant expiry was added)
 *   - a sales return putting goods back on the shelf
 *   - a stock transfer moving goods between branches
 *   - a manual stock adjustment / recount
 *
 * Each of those moved `stock` and left `batches` untouched, so `sum(batches)`
 * drifted away from `stock` a little at a time. The visible symptom is always
 * the same and always the worst one: the expiry screen warning about goods that
 * left the shop months ago, which teaches a shopkeeper to ignore the screen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT "OWNER" MEANS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A batch belongs to one sellable thing: a variant, or the product itself when
 * it has no variants (`variantId: null`). Deducting must never cross that line
 * — selling ৫০০ গ্রাম packets cannot consume the ১ কেজি batch, even though both
 * live in the same `batches` array on the same document.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THESE FUNCTIONS MUTATE `product.batches` IN MEMORY AND RETURN A WRITE OP
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Callers hold the product document already (loaded for the stock guard) and
 * write through `bulkWrite`, not `save()`. Mutating in memory is what makes a
 * multi-line cart correct: two lines against two variants of the same product
 * both deduct from the same in-memory array, and the LAST `$set` carries both
 * deductions. An ordered bulkWrite applies them in sequence, so the final state
 * is right even though the earlier op is redundant.
 *
 * The whole array is rewritten rather than patched per element because a single
 * deduction can empty several batches at once, and the in-memory copy is
 * already the exact desired end state. Anything cleverer needs positional
 * operators that cannot address a filtered subset.
 */

const sameOwner = (a, b) => {
  const norm = (v) => (v === null || v === undefined || v === '' ? null : String(v));
  return norm(a) === norm(b);
};

/** Plain-object form of the batches array, for a `$set`. */
const plainBatches = (batches) =>
  (batches || []).map((b) => (typeof b.toObject === 'function' ? b.toObject() : b));

/**
 * The bulkWrite op that persists whatever `product.batches` currently holds.
 * Returned separately so a caller can decide WHEN to queue it — the sale path
 * keeps batch writes out of the bulk whose `modifiedCount` is the oversell
 * guard, so that a lost stock race cannot hide behind a successful batch write.
 */
const batchWriteOp = (product) => ({
  updateOne: {
    filter: { _id: product._id },
    update: { $set: { batches: plainBatches(product.batches) } },
  },
});

/**
 * Take `quantity` out of one owner's batches, soonest expiry first.
 *
 * Undated batches are consumed LAST. "No expiry recorded" is not "expires
 * never" — it is "nobody typed it in" — and draining those first would leave
 * the short-dated stock sitting on the shelf, which is the exact outcome FEFO
 * exists to prevent.
 *
 * Under-coverage is NOT an error. A shop that turned expiry tracking on
 * mid-life has stock older than its batch records, so selling 10 when only 6
 * are batched deducts the 6 and stops. Throwing here would refuse a sale of
 * goods that are physically present, and the stock guard — which is the real
 * authority on whether the sale is possible — has already passed by this point.
 *
 * @returns {boolean} whether anything changed (false = nothing to write)
 */
const takeBatches = (product, variantId, quantity) => {
  const none = { changed: false, taken: [] };
  if (!product?.trackBatches) return none;
  if (!Array.isArray(product.batches) || product.batches.length === 0) return none;
  if (!(quantity > 0)) return none;

  const sorted = product.batches
    .filter((b) => sameOwner(b.variantId, variantId) && b.quantity > 0)
    .sort((a, b) => {
      if (!a.expiryDate && !b.expiryDate) return 0;
      if (!a.expiryDate) return 1;
      if (!b.expiryDate) return -1;
      return new Date(a.expiryDate) - new Date(b.expiryDate);
    });

  if (sorted.length === 0) return none;

  let remaining = quantity;
  const taken = [];
  for (const batch of sorted) {
    if (remaining <= 0) break;
    const deduct = Math.min(remaining, batch.quantity);
    batch.quantity -= deduct;
    remaining -= deduct;
    taken.push({
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate || null,
      quantity: deduct,
      costPrice: batch.costPrice,
    });
  }

  if (taken.length === 0) return none;

  // Drop emptied rows. Keeping them would make the expiry screen show ০টি rows
  // forever and grow the array without bound across a product's life.
  product.batches = product.batches.filter((b) => b.quantity > 0);
  return { changed: true, taken };
};

/** `takeBatches` when the caller only needs to know whether to write. */
const deductBatches = (product, variantId, quantity) =>
  takeBatches(product, variantId, quantity).changed;

/**
 * Add batches to an owner verbatim — used by the RECEIVING side of a transfer,
 * where the dispatching branch already recorded which dated goods left.
 *
 * Merges into an existing row with the same batch number AND expiry date rather
 * than appending a duplicate: a branch that receives the same batch on two
 * transfers should hold one row of 30, not two rows of 15 that the shopkeeper
 * has to add up on screen.
 *
 * @returns {boolean} whether anything changed
 */
const addBatches = (product, variantId, batches) => {
  if (!product?.trackBatches) return false;
  if (!Array.isArray(batches) || batches.length === 0) return false;
  if (!Array.isArray(product.batches)) product.batches = [];

  const sameDate = (a, b) => {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return new Date(a).getTime() === new Date(b).getTime();
  };

  let changed = false;
  for (const incoming of batches) {
    const qty = Number(incoming?.quantity) || 0;
    if (qty <= 0) continue;

    const existing = product.batches.find(
      (b) => sameOwner(b.variantId, variantId)
        && b.batchNumber === incoming.batchNumber
        && sameDate(b.expiryDate, incoming.expiryDate)
    );

    if (existing) {
      existing.quantity += qty;
    } else {
      product.batches.push({
        variantId: variantId || null,
        batchNumber: incoming.batchNumber,
        expiryDate: incoming.expiryDate || null,
        quantity: qty,
        costPrice: incoming.costPrice,
        receivedDate: new Date(),
      });
    }
    changed = true;
  }
  return changed;
};

/**
 * Put `quantity` back, newest-expiry-first — the mirror of `deductBatches`.
 *
 * Used by returns and by the receiving side of a cancelled transfer. Restoring
 * to the LATEST-dated batch is deliberate: FEFO sold the soonest-dated stock
 * first, so a return is most likely the long-dated goods, and crediting it to
 * an about-to-expire batch would resurrect an expiry warning for stock that is
 * not actually short-dated.
 *
 * When the owner has no batches left at all — every one was sold through —
 * there is nothing to restore into, and this returns false rather than
 * inventing a batch with a date nobody recorded. The stock still comes back;
 * it is simply untracked, which `getProductBatches` reports honestly as
 * `untracked` rather than hiding.
 *
 * @returns {boolean} whether anything changed
 */
const restoreBatches = (product, variantId, quantity) => {
  if (!product?.trackBatches) return false;
  if (!Array.isArray(product.batches) || product.batches.length === 0) return false;
  if (!(quantity > 0)) return false;

  const owned = product.batches
    .filter((b) => sameOwner(b.variantId, variantId))
    .sort((a, b) => {
      if (!a.expiryDate && !b.expiryDate) return 0;
      // Undated last here too, for the same reason: a return should not be
      // credited to a row nobody has dated when a dated one is available.
      if (!a.expiryDate) return 1;
      if (!b.expiryDate) return -1;
      return new Date(b.expiryDate) - new Date(a.expiryDate);
    });

  if (owned.length === 0) return false;

  owned[0].quantity += quantity;
  return true;
};

/**
 * Force one owner's batch total to be no greater than `stock`.
 *
 * For the manual-recount path, where a shopkeeper types "actually there are 8"
 * over a system that thought there were 30. The batches are the only record of
 * WHICH 30 those were, so the excess is trimmed soonest-expiry-first: if 22
 * packets are unaccounted for at a recount, the ones that expired are far and
 * away the likeliest to have been thrown out.
 *
 * Never grows the batches — a recount UP means new stock arrived without a
 * delivery being recorded, and there is no honest expiry date to give it.
 *
 * @returns {boolean} whether anything changed
 */
const capBatchesToStock = (product, variantId, stock) => {
  if (!product?.trackBatches) return false;
  if (!Array.isArray(product.batches) || product.batches.length === 0) return false;

  const total = product.batches
    .filter((b) => sameOwner(b.variantId, variantId))
    .reduce((sum, b) => sum + (Number(b.quantity) || 0), 0);

  const excess = total - (Number(stock) || 0);
  if (excess <= 0) return false;

  return deductBatches(product, variantId, excess);
};

module.exports = {
  sameOwner,
  plainBatches,
  batchWriteOp,
  takeBatches,
  deductBatches,
  addBatches,
  restoreBatches,
  capBatchesToStock,
};
