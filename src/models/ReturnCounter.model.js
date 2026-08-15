const mongoose = require('mongoose');

/**
 * Per-(shop, day) sales-return sequence.
 *
 * ── What this replaces ───────────────────────────────────────────────────────
 *
 * `SalesReturn.generateReturnNo` built its number by finding the day's highest
 * `returnNo` with a regex, parsing the last four characters, and adding one. It
 * is the same read-modify-write `InvoiceCounter` was created to remove from the
 * sales path — returns simply never got the same treatment, and carried three
 * defects because of it:
 *
 *  1. **It raced, and unlike sales it had no retry.** Two returns processed at
 *     once both read the same last row and both built the same number. The
 *     unique index on `{shop, returnNo}` caught it, but the losing caller was
 *     inside `runInTransaction` with nothing to absorb the duplicate — so a
 *     legitimate refund failed with E11000 and the cashier saw a 500.
 *
 *  2. **The date came from the SERVER clock**, via `getFullYear/getMonth/
 *     getDate`. On a UTC host that is 06:00 Dhaka, so between midnight and 6am
 *     a return was stamped with the previous day while the sale it reversed
 *     carried the correct Bangladesh day from `InvoiceCounter`. Two documents
 *     about the same transaction, dated a day apart.
 *
 *  3. **It broke past 9,999 in a day.** `String(10000).padStart(4,'0')` is five
 *     characters, so the next `slice(-4)` read "0000", parsed to 0, and the
 *     sequence silently restarted at 1 — straight into the unique index.
 *
 * ── Why the key has no branch ────────────────────────────────────────────────
 *
 * Deliberately unlike `InvoiceCounter`. The return number's prefix is
 * `RET<YYYYMMDD>` with no branch code in it, so a per-branch sequence would make
 * the numbering gappy for no visible reason — the same reasoning
 * `Purchase.generateInvoiceNo` documents for shop-wide purchase numbers.
 *
 * ── On gaps ──────────────────────────────────────────────────────────────────
 *
 * As with `InvoiceCounter`: the increment does not join the return's
 * transaction, so an aborted return burns its number. Return numbers are
 * identifiers, not a gapless statutory series.
 */
const returnCounterSchema = new mongoose.Schema(
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

returnCounterSchema.index({ shop: 1, date: 1 }, { unique: true });

// Yesterday's counters are dead weight. 30 days rather than 2 leaves room for
// clock skew and any backdated entry without the row vanishing underneath one.
returnCounterSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

/**
 * Hand out the next sequence number for (shop, date).
 *
 * Steady state is a single atomic `findOneAndUpdate`. Only the first call of a
 * given day pays for the seeding path below, which is what lets a shop switch
 * over mid-day and continue its sequence instead of restarting at 0001.
 *
 * @param {ObjectId|string} shopId
 * @param {string} dateStr - Bangladesh-local 'YYYY-MM-DD'
 * @param {Function} countExisting - async () => number, invoked ONLY when no
 *        counter exists yet; returns how many returns that (shop, day) already
 *        has, so the sequence resumes instead of restarting.
 * @returns {Promise<number>} the sequence number to use (1-based)
 */
returnCounterSchema.statics.nextSeq = async function (shopId, dateStr, countExisting) {
  const key = { shop: shopId, date: dateStr };

  // Fast path — the counter already exists for today.
  const existing = await this.findOneAndUpdate(key, { $inc: { seq: 1 } }, { new: true });
  if (existing) return existing.seq;

  // First return of the day for this shop: seed from what is already there.
  //
  // `$setOnInsert` is what makes this safe under concurrency — if two callers
  // reach here together, only one insert lands and the loser's seed value is
  // discarded rather than overwriting the winner's. Both then increment, and
  // they get distinct numbers.
  const base = typeof countExisting === 'function' ? await countExisting() : 0;
  await this.updateOne(key, { $setOnInsert: { ...key, seq: base } }, { upsert: true });

  const seeded = await this.findOneAndUpdate(key, { $inc: { seq: 1 } }, { new: true });
  return seeded ? seeded.seq : base + 1;
};

module.exports = mongoose.model('ReturnCounter', returnCounterSchema);
