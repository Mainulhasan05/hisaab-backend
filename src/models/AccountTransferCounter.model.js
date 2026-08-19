const mongoose = require('mongoose');

/**
 * Per-shop transfer sequence.
 *
 * ── Why not `countDocuments` like StockTransfer ─────────────────────────────
 *
 * `StockTransfer` builds its number from a live `countDocuments({shop})`, which
 * races: two transfers created at once both read the same count and both build
 * `TRF-000007`. There the unique index catches it and the caller sees an
 * E11000 — survivable for a stock transfer someone can retry from a form.
 *
 * A fund transfer is created INSIDE a transaction that also moves two account
 * balances, and this codebase has already been bitten by exactly that
 * combination: `SalesReturn.generateReturnNo` raced the same way, and the
 * losing caller's legitimate refund failed with a 500 because there was nothing
 * inside `runInTransaction` to absorb a duplicate key. See the long note on
 * `ReturnCounter`, whose shape this copies.
 *
 * ── Why the key has no date ────────────────────────────────────────────────
 *
 * `ReturnCounter` is keyed `{shop, date}` because a return number embeds the
 * day. A transfer number does not — `TFR-000001` runs for the life of the shop,
 * the way `StockTransfer`'s does — so there is nothing to reset and no TTL to
 * expire. The row is permanent, which is also why there is no `expireAfterSeconds`
 * index here.
 *
 * ── On gaps ────────────────────────────────────────────────────────────────
 *
 * As with every counter here: the increment does not join the transfer's
 * transaction, so an aborted transfer burns its number. Transfer numbers are
 * identifiers, not a gapless statutory series.
 */
const accountTransferCounterSchema = new mongoose.Schema(
  {
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shop',
      required: true,
      unique: true,
    },
    seq: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

/**
 * Hand out the next transfer sequence number for a shop.
 *
 * Steady state is one atomic `findOneAndUpdate`. Only a shop's FIRST transfer
 * pays for the seeding path, which exists so a shop that somehow already holds
 * transfers (a restored backup, a hand-inserted row) resumes its sequence
 * instead of restarting at 1 and colliding with the unique index.
 *
 * @param {ObjectId|string} shopId
 * @param {Function} countExisting - async () => number, called ONLY when no
 *        counter row exists yet.
 * @returns {Promise<number>} 1-based sequence number
 */
accountTransferCounterSchema.statics.nextSeq = async function (shopId, countExisting) {
  const key = { shop: shopId };

  const existing = await this.findOneAndUpdate(key, { $inc: { seq: 1 } }, { new: true });
  if (existing) return existing.seq;

  // `$setOnInsert` is what makes the seeding safe under concurrency: if two
  // callers arrive together only one insert lands, the loser's seed is
  // discarded rather than overwriting the winner's, and both then increment to
  // distinct numbers.
  const base = typeof countExisting === 'function' ? await countExisting() : 0;
  await this.updateOne(key, { $setOnInsert: { ...key, seq: base } }, { upsert: true });

  const seeded = await this.findOneAndUpdate(key, { $inc: { seq: 1 } }, { new: true });
  return seeded ? seeded.seq : base + 1;
};

module.exports = mongoose.model('AccountTransferCounter', accountTransferCounterSchema);
