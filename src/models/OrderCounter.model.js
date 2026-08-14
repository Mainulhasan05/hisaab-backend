const mongoose = require('mongoose');

/**
 * Per-(shop, day) online order sequence.
 *
 * ── WHY THIS IS NOT `InvoiceCounter` ────────────────────────────────────────
 *
 * The mechanism is identical and deliberately copied — an atomic `$inc` that
 * hands each number to exactly one caller, seeded on the first call of the day
 * so a shop that starts taking orders mid-afternoon continues rather than
 * restarting at 0001. The reasoning for all of that is written up in
 * `InvoiceCounter.model.js` and is not repeated here.
 *
 * What differs is what the number MEANS, and that is why the two series must
 * not share a counter.
 *
 * An invoice number belongs to a `Sale` — money that has moved, stock that has
 * left a shelf, a due that may be outstanding. An order number belongs to a
 * request from a stranger on the internet that the shopkeeper has not yet
 * agreed to fulfil. Invariant I-9 is that an order touches nothing until it is
 * confirmed, and most of what arrives on a public storefront never will be:
 * COD abandonment is ordinary, and spam is the reason this feature ships with
 * rate limiting attached.
 *
 * Share one counter and every abandoned order burns an invoice number. A shop
 * doing thirty counter sales and two hundred junk orders a day would find its
 * invoice series jumping by hundreds overnight, and the shopkeeper — who reads
 * that series as "how much did I sell" — would be right to think something was
 * broken.
 *
 * So: two series, two collections, no coupling. `Order.orderNo` is issued here;
 * `Sale.invoiceNo` is issued by `InvoiceCounter` at CONFIRM time, which is the
 * moment the order becomes something the books know about.
 *
 * ── NO BRANCH IN THE KEY ────────────────────────────────────────────────────
 *
 * `InvoiceCounter` keys on branch because two tills trade simultaneously and
 * each wants its own readable series. A storefront is one website — orders
 * arrive at the shop, not at a counter — so the key is (shop, day) and the
 * branch that ends up fulfilling is a property of the order, not of its number.
 * See `Order.branch`.
 */
const orderCounterSchema = new mongoose.Schema(
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

orderCounterSchema.index({ shop: 1, date: 1 }, { unique: true });

// Same 30-day sweep as InvoiceCounter — long enough to absorb clock skew and a
// backdated entry, short enough that these rows never accumulate.
orderCounterSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

/**
 * Hand out the next order sequence for (shop, date).
 *
 * @param {ObjectId|string} shopId
 * @param {string} dateStr - Bangladesh-local 'YYYY-MM-DD'
 * @param {Function} countExisting - async () => number, invoked ONLY when no
 *        counter exists yet, so the sequence resumes rather than restarting.
 * @returns {Promise<number>} 1-based sequence number
 */
orderCounterSchema.statics.nextSeq = async function (shopId, dateStr, countExisting) {
  const key = { shop: shopId, date: dateStr };

  const existing = await this.findOneAndUpdate(key, { $inc: { seq: 1 } }, { new: true });
  if (existing) return existing.seq;

  // `$setOnInsert` is what makes the seeding path safe under concurrency: if
  // two customers check out in the same second on a shop's first order of the
  // day, only one insert lands and the loser's seed is discarded rather than
  // overwriting the winner's. Both then increment and get distinct numbers.
  const base = typeof countExisting === 'function' ? await countExisting() : 0;
  await this.updateOne(key, { $setOnInsert: { ...key, seq: base } }, { upsert: true });

  const seeded = await this.findOneAndUpdate(key, { $inc: { seq: 1 } }, { new: true });
  return seeded ? seeded.seq : base + 1;
};

module.exports = mongoose.model('OrderCounter', orderCounterSchema);
