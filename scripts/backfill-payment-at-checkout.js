/**
 * Backfill `Payment.atCheckout` on rows written before the field existed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `createSale` writes a `Payment{type:'sale_payment'}` for the amount settled at
 * the till, and that same money is ALSO inside `Sale.payments[]`. The cash
 * register reads both streams, so every cash sale was counted twice and the
 * till's expected closing ran over by roughly the day's takings.
 *
 * `Payment.atCheckout` is the discriminator that fixes it going forward. This
 * script stamps the historical rows so the register stops double-counting them
 * too.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW A CHECKOUT ROW IS IDENTIFIED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * There is no stored marker, so it is inferred — and the inference has to be
 * conservative, because a false positive UNDERSTATES the drawer (a real later
 * collection stops being counted), which is worse than the bug being fixed.
 *
 * Two conditions, both required:
 *
 *   1. The row was created within CHECKOUT_WINDOW_MS of its own sale. Both
 *      documents are written inside one `createSale` transaction, so in practice
 *      the gap is milliseconds; a later collection against the same invoice is
 *      minutes away at the very least, and usually days.
 *
 *   2. The row's amount appears among the sale's `payments[]` legs, or equals
 *      the sale's total settled amount. This is what actually makes it a
 *      duplicate — if the money is not in the legs, the register never
 *      double-counted it and stamping the row would lose it.
 *
 * A row that fails either test is left alone. Being cautious here means a few
 * legacy rows may stay double-counted on old registers, which is the same
 * position they are in today and affects no future reconciliation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT DONE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Closed registers are NOT recalculated. `getTodayRegister` already refuses to
 * rewrite a closed day — a reconciliation the shopkeeper has signed off on must
 * not change underneath them months later. Only open registers recalculate, and
 * they will pick up the corrected figures on their next read.
 *
 * Usage:
 *   node scripts/backfill-payment-at-checkout.js            # report only
 *   node scripts/backfill-payment-at-checkout.js --apply    # write
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

/**
 * How close in time a payment must sit to its sale to count as the checkout leg.
 * Both are written in one transaction; 60s is generous by three orders of
 * magnitude and still far short of any realistic later collection.
 */
const CHECKOUT_WINDOW_MS = 60 * 1000;

/** Paisa tolerance when matching an amount against a leg. */
const EPSILON = 0.005;

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const Payment = require('../src/models/Payment.model');
  const Sale = require('../src/models/Sale.model');

  const candidates = await Payment.find({
    type: 'sale_payment',
    atCheckout: { $ne: true },
    sale: { $ne: null },
  })
    .select('_id sale amount createdAt')
    .lean();

  console.log(`${candidates.length} untagged sale_payment rows to examine.`);
  if (candidates.length === 0) {
    await mongoose.connection.close();
    return;
  }

  const saleIds = [...new Set(candidates.map((p) => String(p.sale)))];
  const sales = await Sale.find({ _id: { $in: saleIds } })
    .select('_id createdAt paid payments')
    .lean();
  const saleMap = new Map(sales.map((s) => [String(s._id), s]));

  const toStamp = [];
  let noSale = 0;
  let outsideWindow = 0;
  let amountMismatch = 0;

  for (const payment of candidates) {
    const sale = saleMap.get(String(payment.sale));
    if (!sale) {
      // The sale is gone (hard-deleted before the immutable guard, or a broken
      // reference). Nothing to compare against, so leave the row untouched.
      noSale += 1;
      continue;
    }

    const gap = Math.abs(new Date(payment.createdAt) - new Date(sale.createdAt));
    if (gap > CHECKOUT_WINDOW_MS) {
      outsideWindow += 1;
      continue;
    }

    const legs = Array.isArray(sale.payments) ? sale.payments : [];
    const matchesLeg = legs.some((l) => Math.abs((Number(l?.amount) || 0) - payment.amount) < EPSILON);
    const matchesTotal = Math.abs((Number(sale.paid) || 0) - payment.amount) < EPSILON;

    if (!matchesLeg && !matchesTotal) {
      amountMismatch += 1;
      continue;
    }

    toStamp.push(payment._id);
  }

  console.log(`
  matched as checkout legs : ${toStamp.length}
  skipped, sale missing    : ${noSale}
  skipped, outside window  : ${outsideWindow}
  skipped, amount mismatch : ${amountMismatch}
`);

  if (!APPLY) {
    console.log('Dry run — nothing written. Re-run with --apply to stamp them.');
    await mongoose.connection.close();
    return;
  }

  if (toStamp.length > 0) {
    const result = await Payment.updateMany(
      { _id: { $in: toStamp } },
      { $set: { atCheckout: true } }
    );
    console.log(`Stamped ${result.modifiedCount} payment rows.`);
  }

  await mongoose.connection.close();
  console.log('Done.');
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.connection.close(); } catch { /* already closed */ }
  process.exit(1);
});
