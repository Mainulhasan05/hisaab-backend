const mongoose = require('mongoose');

/**
 * Per-(shop, branch, day) invoice sequence.
 *
 * ── What this replaces ───────────────────────────────────────────────────────
 *
 * Invoice numbers used to come from `Sale.countDocuments()` over the current
 * day, which had two defects that had nothing to do with each other:
 *
 *  1. **It raced.** Two cashiers checking out at once both read the same count
 *     and both built the same number. The unique index on `{shop, invoiceNo}`
 *     caught the collision and a retry loop absorbed it — by counting again.
 *     Correct, but the busier the till the more often it happened.
 *
 *  2. **The count was shop-wide while the PREFIX was branch-specific.** A sale
 *     at the Dhanmondi branch bumped the number Chattogram would generate next,
 *     so each branch's own sequence came out gappy and the two were coupled for
 *     no reason.
 *
 * An atomic `$inc` fixes both: the number is handed out by the database, once,
 * to exactly one caller, and the key includes the branch.
 *
 * ── Migration ────────────────────────────────────────────────────────────────
 *
 * There is no migration script. The counter seeds itself on first use for a
 * given (shop, branch, day) from the sales already recorded that day — see
 * `nextSeq`. A shop that switches over mid-trading-day continues from where it
 * was rather than restarting at 0001, which is the one thing this change must
 * not get wrong.
 *
 * ── On gaps ──────────────────────────────────────────────────────────────────
 *
 * The increment deliberately does NOT join the sale's transaction. A sequence
 * that rolls back would hand the same number to the next caller, which is the
 * behaviour being removed. So an aborted sale burns its number.
 *
 * That is not new: cancelled sales already keep their numbers, and the old
 * retry loop already burned them on collision. Invoice numbers here are
 * identifiers, not a gapless statutory series.
 */
const invoiceCounterSchema = new mongoose.Schema(
  {
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shop',
      required: true,
    },
    // Null for single-branch shops — MongoDB treats null as a value in a unique
    // index, so {shop, null, date} is a perfectly good key and needs no special
    // casing here or at the call site.
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
    },
    // Bangladesh-local 'YYYY-MM-DD'. A string, not a Date, because the key is
    // the calendar day in BD time and a Date would reintroduce the timezone
    // question this is meant to settle.
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

invoiceCounterSchema.index({ shop: 1, branch: 1, date: 1 }, { unique: true });

// Yesterday's counters are dead weight. 30 days rather than 2 leaves room for
// clock skew and any backdated entry without the row vanishing underneath one.
invoiceCounterSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

/**
 * Hand out the next sequence number for (shop, branch, date).
 *
 * Steady state is a single atomic `findOneAndUpdate`. Only the first call of a
 * given day pays for the seeding path below.
 *
 * @param {ObjectId|string} shopId
 * @param {ObjectId|string|null} branchId
 * @param {string} dateStr - Bangladesh-local 'YYYY-MM-DD'
 * @param {Function} countExisting - async () => number, invoked ONLY when no
 *        counter exists yet; returns how many invoices that (shop, branch, day)
 *        already has, so the sequence resumes instead of restarting.
 * @returns {Promise<number>} the sequence number to use (1-based)
 */
invoiceCounterSchema.statics.nextSeq = async function (shopId, branchId, dateStr, countExisting) {
  const key = { shop: shopId, branch: branchId || null, date: dateStr };

  // Fast path — the counter already exists for today.
  const existing = await this.findOneAndUpdate(key, { $inc: { seq: 1 } }, { new: true });
  if (existing) return existing.seq;

  // First invoice of the day for this branch: seed from what is already there.
  //
  // `$setOnInsert` is what makes this safe under concurrency — if two cashiers
  // reach here together, only one insert lands and the loser's seed value is
  // discarded rather than overwriting the winner's. Both then increment, and
  // they get distinct numbers.
  const base = typeof countExisting === 'function' ? await countExisting() : 0;
  await this.updateOne(key, { $setOnInsert: { ...key, seq: base } }, { upsert: true });

  const seeded = await this.findOneAndUpdate(key, { $inc: { seq: 1 } }, { new: true });
  return seeded ? seeded.seq : base + 1;
};

module.exports = mongoose.model('InvoiceCounter', invoiceCounterSchema);
