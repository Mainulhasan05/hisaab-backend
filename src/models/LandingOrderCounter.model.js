/**
 * Per-(shop, day) landing order sequence.
 *
 * The mechanism is `OrderCounter`'s, copied deliberately — an atomic `$inc` that
 * hands each number to exactly one caller, seeded on the first call of the day
 * so a shop that starts taking orders mid-afternoon continues rather than
 * restarting at 0001. That reasoning is written up in `InvoiceCounter.model.js`
 * and is not repeated here.
 *
 * ── WHY A THIRD COUNTER ─────────────────────────────────────────────────────
 *
 * `InvoiceCounter` numbers money that has moved. `OrderCounter` numbers
 * storefront orders, which may still become invoices. A landing order becomes
 * NEITHER — it never reaches the ledger at all (I-17) — and it arrives in the
 * volumes an ad campaign produces, prank orders included.
 *
 * Sharing `OrderCounter` would mean a shop running both a storefront and a
 * campaign finds its storefront order series jumping by hundreds overnight, for
 * orders that never appear in its storefront worklist. The shopkeeper reads that
 * series as "how many orders did my website take", and they would be right to
 * think something was broken.
 *
 * ── NO PAGE IN THE KEY ──────────────────────────────────────────────────────
 *
 * Keyed on (shop, day), not (page, day) — so a shop running three campaigns gets
 * one continuous daily series and can tell them apart by the prefix
 * (`AAM-0007` vs `MOU-0008`) rather than by three colliding number series. The
 * prefix comes from `LandingPage.orderPrefix`; the sequence is the shop's.
 */

const mongoose = require('mongoose');

const landingOrderCounterSchema = new mongoose.Schema(
  {
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shop',
      required: true,
    },
    // Bangladesh-local 'YYYY-MM-DD'. A string for the same reason as
    // InvoiceCounter: the key is a calendar day in BD time, and a Date would
    // reintroduce the timezone question this is meant to settle.
    date: {
      type: String,
      required: true,
    },
    seq: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

landingOrderCounterSchema.index({ shop: 1, date: 1 }, { unique: true });

// Same 30-day sweep as the other counters — long enough to absorb clock skew,
// short enough that these rows never accumulate.
landingOrderCounterSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

/**
 * Hand out the next sequence for (shop, date).
 *
 * @param {ObjectId|string} shopId
 * @param {string} dateStr        Bangladesh-local 'YYYY-MM-DD'
 * @param {Function} countExisting async () => number, invoked ONLY when no
 *        counter exists yet, so the sequence resumes rather than restarting.
 * @returns {Promise<number>} 1-based sequence number
 */
landingOrderCounterSchema.statics.nextSeq = async function nextSeq(shopId, dateStr, countExisting) {
  const key = { shop: shopId, date: dateStr };

  const existing = await this.findOneAndUpdate(key, { $inc: { seq: 1 } }, { new: true });
  if (existing) return existing.seq;

  // `$setOnInsert` is what makes the seeding path safe under concurrency: if two
  // customers submit in the same second on a shop's first order of the day, only
  // one insert lands and the loser's seed is discarded rather than overwriting
  // the winner's. Both then increment and get distinct numbers.
  const base = typeof countExisting === 'function' ? await countExisting() : 0;
  await this.updateOne(key, { $setOnInsert: { ...key, seq: base } }, { upsert: true });

  const seeded = await this.findOneAndUpdate(key, { $inc: { seq: 1 } }, { new: true });
  return seeded ? seeded.seq : base + 1;
};

module.exports = mongoose.model('LandingOrderCounter', landingOrderCounterSchema);
