/**
 * Backfill `Sale.returnedAdjustment` and `Sale.returnedProfit` from the
 * SalesReturn collection.
 *
 *   node scripts/backfill-sale-return-terms.js                 # dry-run, all shops
 *   node scripts/backfill-sale-return-terms.js --shop <id>     # dry-run, one shop
 *   node scripts/backfill-sale-return-terms.js --apply
 *
 * WHY THIS IS NEEDED
 * ------------------
 * `Sale.pre('save')` used to derive `due` and `profit` from `items` alone, so
 * the returns path wrote both with `updateOne` specifically to bypass it. That
 * worked exactly until anything else saved the document — `recordPayment`,
 * `cancelSale` — at which point the hook recomputed from `items` and threw the
 * return away. Collecting the rest of a due on a partly-returned invoice put
 * back the money the return had just taken off it.
 *
 * The fix makes the hook carry the returns terms, which means it needs them
 * ON the document:
 *
 *     due    = max(0, total − paid − returnedAdjustment)
 *     profit = itemsProfit − discountAmount − returnedProfit
 *
 * Sales that already carry returns have neither field. Their `due` and `profit`
 * columns in the database are correct TODAY (the old `updateOne` set them), so
 * nothing is visibly wrong — but both default to 0, so the first save of any
 * such sale would derive the pre-return figures and silently undo the return.
 * This script fills them in before that can happen.
 *
 * WHAT IT DERIVES, AND FROM WHERE
 * -------------------------------
 * Source documents only — the SalesReturn rows themselves, never the `Sale`
 * columns being corrected:
 *
 *     returnedAdjustment = Σ totalAmount    where refundMethod = 'adjustment'
 *     returnedProfit     = Σ profitReduction
 *
 * `returnedAmount` is left alone. It has always been maintained and is the one
 * figure of the three that was never in doubt; recomputing it here would turn a
 * targeted backfill into an unreviewed rewrite of live data.
 *
 * A `store_credit` return contributes to `returnedProfit` (the goods came back
 * when the return was created) but not to `returnedAdjustment` — settling it
 * later pays cash out, it does not write the debt off. That mirrors
 * `createReturn` and `settleRefund` exactly.
 *
 * SAFETY
 * ------
 * Dry-run by default. Idempotent — it computes absolute values rather than
 * increments, so re-running it after an interrupted run is safe and converges.
 * Reports (but does not rewrite) any sale whose stored `due` disagrees with what
 * the corrected formula produces, because that is a real discrepancy someone
 * should look at rather than something to paper over.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const shopArgIdx = process.argv.indexOf('--shop');
const SHOP_ARG = shopArgIdx !== -1 ? process.argv[shopArgIdx + 1] : null;

const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 20000,
  });

  const db = mongoose.connection.db;
  const mode = APPLY ? 'APPLY' : 'DRY-RUN';
  console.log(`Connected to ${mongoose.connection.host}/${db.databaseName} (${mode})\n`);

  const match = {};
  if (SHOP_ARG) match.shop = new mongoose.Types.ObjectId(SHOP_ARG);

  // One row per sale that has ever been returned against.
  const perSale = await db.collection('salesreturns').aggregate([
    { $match: match },
    {
      $group: {
        _id: '$sale',
        shop: { $first: '$shop' },
        returnedProfit: { $sum: { $ifNull: ['$profitReduction', 0] } },
        returnedAdjustment: {
          $sum: {
            $cond: [{ $eq: ['$refundMethod', 'adjustment'] }, { $ifNull: ['$totalAmount', 0] }, 0],
          },
        },
        returnCount: { $sum: 1 },
      },
    },
  ]).toArray();

  console.log(`${perSale.length} sale(s) with returns\n`);

  let updated = 0;
  let alreadyCorrect = 0;
  const dueMismatches = [];

  for (const row of perSale) {
    const sale = await db.collection('sales').findOne(
      { _id: row._id },
      { projection: { total: 1, paid: 1, due: 1, profit: 1, invoiceNo: 1, returnedAdjustment: 1, returnedProfit: 1, status: 1 } }
    );
    if (!sale) {
      console.log(`  ! return references a missing sale: ${row._id}`);
      continue;
    }

    const wantAdjustment = round(row.returnedAdjustment);
    const wantProfit = round(row.returnedProfit);

    const haveAdjustment = round(sale.returnedAdjustment || 0);
    const haveProfit = round(sale.returnedProfit || 0);

    if (haveAdjustment === wantAdjustment && haveProfit === wantProfit) {
      alreadyCorrect++;
      continue;
    }

    // What the corrected hook will derive once the fields are present. A
    // cancelled sale is excluded — a fully-returned invoice legitimately holds
    // a due of 0 that this formula does not reproduce.
    const derivedDue = Math.max(0, round((sale.total || 0) - (sale.paid || 0) - wantAdjustment));
    if (sale.status !== 'cancelled' && Math.abs(derivedDue - round(sale.due || 0)) > 0.01) {
      dueMismatches.push({
        invoiceNo: sale.invoiceNo,
        stored: round(sale.due || 0),
        derived: derivedDue,
      });
    }

    console.log(
      `  ${sale.invoiceNo || row._id}  ` +
      `adjustment ${haveAdjustment} -> ${wantAdjustment}, ` +
      `profitReduction ${haveProfit} -> ${wantProfit}  (${row.returnCount} return(s))`
    );

    if (APPLY) {
      await db.collection('sales').updateOne(
        { _id: row._id },
        { $set: { returnedAdjustment: wantAdjustment, returnedProfit: wantProfit } }
      );
    }
    updated++;
  }

  console.log('');
  console.log(`already correct : ${alreadyCorrect}`);
  console.log(`${APPLY ? 'updated' : 'would update'} : ${updated}`);

  if (dueMismatches.length) {
    console.log('');
    console.log(`${dueMismatches.length} sale(s) whose stored \`due\` disagrees with the corrected formula.`);
    console.log('NOT rewritten — this is the residue of the bug being fixed (a save that');
    console.log('recomputed the pre-return due), and it should be read before it is touched:');
    for (const m of dueMismatches.slice(0, 25)) {
      console.log(`  ${m.invoiceNo}: stored ৳${m.stored}, derived ৳${m.derived}`);
    }
    if (dueMismatches.length > 25) console.log(`  ... and ${dueMismatches.length - 25} more`);
  }

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
  }

  await mongoose.connection.close();
  process.exit(dueMismatches.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.connection.close(); } catch { /* already closed */ }
  process.exit(1);
});
