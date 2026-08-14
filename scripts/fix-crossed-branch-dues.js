/**
 * Net out crossed per-branch customer dues.
 *
 *   node scripts/fix-crossed-branch-dues.js                 # dry-run, every shop
 *   node scripts/fix-crossed-branch-dues.js --shop <id>
 *   node scripts/fix-crossed-branch-dues.js --shop <id> --apply
 *
 * WHAT IT REPAIRS
 * ---------------
 * A `CustomerBalance` row with a NEGATIVE `totalDue`, against the same
 * customer's positive row at another branch. It is the fingerprint of a due
 * reduction that was charged to the branch the owner happened to be standing in
 * rather than to the branch that actually held the debt:
 *
 *     আব্দুল কাদের   আক্কেলপুর −৳3,835   নয়াগোলা +৳3,835
 *     মোঃ বাবুল      আক্কেলপুর +৳7,040   নয়াগোলা −৳7,040
 *
 * Both net to zero shop-wide, so `Customer.totalDue` is correct, the Σ invariant
 * holds, and `recalc-customer-balances.js` reports a clean book — while one
 * branch's dashboard is overstated and the other shows a due below zero. That is
 * exactly why this needs its own script: the existing recalc cannot see it.
 *
 * WHY NOT JUST RE-RUN THE RECALC
 * ------------------------------
 * `recalc-customer-balances.js` rebuilds each row from source documents, and the
 * source is already wrong here — the `DueAdjustment` row carries the branch the
 * correction was entered at. Worse, its per-row `max(0, …)` clamp would floor
 * the negative row at ৳0 and leave the positive one standing, turning a
 * self-cancelling pair into a real ৳3,835 that the shop does not owe. Run this
 * BEFORE any recalc, never instead of reading what it prints.
 *
 * WHAT IT DOES NOT TOUCH
 * ----------------------
 * `Customer.totalDue` — already correct, by construction, in every case this
 * repairs. A run that would change a shop-wide total is a different problem and
 * is refused rather than guessed at.
 *
 * The `DueAdjustment` history is left exactly as written. It is the audit trail
 * of what the shop actually did, including the mistake; this script corrects the
 * derived rollup, not the record.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const shopArgIdx = process.argv.indexOf('--shop');
const SHOP_ARG = shopArgIdx !== -1 ? process.argv[shopArgIdx + 1] : null;

const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const taka = (n) => `৳${round(n).toLocaleString('en-US')}`;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    autoIndex: false,
  });

  const db = mongoose.connection.db;
  console.log(`Connected to ${mongoose.connection.host}/${db.databaseName} (${APPLY ? 'APPLY' : 'DRY-RUN'})\n`);

  const shopFilter = { multiBranchEnabled: true };
  if (SHOP_ARG) shopFilter._id = new mongoose.Types.ObjectId(SHOP_ARG);
  const shops = await db.collection('shops').find(shopFilter).project({ name: 1 }).toArray();

  let repaired = 0;
  let skipped = 0;

  for (const shop of shops) {
    // Only customers who HAVE a negative row are candidates, so a healthy shop
    // costs one indexed query and nothing else.
    const negatives = await db.collection('customerbalances')
      .find({ shop: shop._id, totalDue: { $lt: -0.01 } })
      .toArray();

    if (negatives.length === 0) continue;

    const branches = await db.collection('branches')
      .find({ shop: shop._id }).project({ name: 1 }).toArray();
    const branchName = (id) =>
      (branches.find((b) => String(b._id) === String(id)) || {}).name || String(id);

    console.log(`\n=== ${shop.name} (${shop._id}) — ${negatives.length} negative row(s)`);

    const customerIds = [...new Set(negatives.map((r) => String(r.customer)))];

    for (const customerId of customerIds) {
      const cid = new mongoose.Types.ObjectId(customerId);
      const customer = await db.collection('customers').findOne({ _id: cid });
      const rows = await db.collection('customerbalances')
        .find({ shop: shop._id, customer: cid }).toArray();

      const branchSum = round(rows.reduce((s, r) => s + (r.totalDue || 0), 0));
      const shopWide = round(customer?.totalDue || 0);

      console.log(`\n  ${customer?.name || customerId}${customer?.isActive === false ? ' (deleted)' : ''}`);
      rows.forEach((r) => console.log(`    ${branchName(r.branch)}: totalDue ${taka(r.totalDue || 0)}  openingDue ${taka(r.openingDue || 0)}`));
      console.log(`    Σ branches ${taka(branchSum)}  vs Customer.totalDue ${taka(shopWide)}`);

      // The repair preserves Σ, so it is only valid where Σ is already right.
      // A customer failing this has a second, different problem underneath and
      // netting the rows out would bury it.
      if (Math.abs(branchSum - shopWide) > 0.01) {
        console.log('    SKIP — Σ branches already disagrees with the shop-wide rollup; fix that first');
        skipped++;
        continue;
      }

      const negRows = rows.filter((r) => (r.totalDue || 0) < -0.01);
      const posRows = rows
        .filter((r) => (r.totalDue || 0) > 0.01)
        .sort((a, b) => (b.totalDue || 0) - (a.totalDue || 0));

      // Netting mutates the in-memory rows; nothing is written until every
      // negative on this customer has been fully absorbed, so a customer that
      // cannot be repaired is left completely untouched rather than half-moved.
      let aborted = false;

      for (const neg of negRows) {
        let owed = -(neg.totalDue || 0); // magnitude to move off this row

        // Largest creditor branch first: it is the one most likely to be the
        // branch the debt was really entered against, and it keeps the number of
        // rows touched to a minimum.
        for (const pos of posRows) {
          if (owed <= 0.01) break;
          if (round(pos.totalDue || 0) <= 0.01) continue;

          const take = Math.min(owed, round(pos.totalDue));
          pos.totalDue = round(pos.totalDue - take);
          // `openingDue` moves with it: these rows are pure opening debt, and
          // leaving it behind would break `deriveDue` on the next sales return.
          pos.openingDue = round((pos.openingDue || 0) - take);
          neg.totalDue = round((neg.totalDue || 0) + take);
          neg.openingDue = round((neg.openingDue || 0) + take);
          owed = round(owed - take);

          console.log(`    move ${taka(take)} : ${branchName(pos.branch)} -> ${branchName(neg.branch)}`);
        }

        if (owed > 0.01) {
          console.log(`    SKIP — ${taka(owed)} of the negative has no positive row to net against`);
          skipped++;
          aborted = true;
          break;
        }
      }

      if (aborted) continue;

      const ops = [...negRows, ...posRows].map((r) => ({
        updateOne: {
          filter: { _id: r._id },
          update: { $set: { totalDue: r.totalDue, openingDue: r.openingDue, updatedAt: new Date() } },
        },
      }));

      if (ops.length === 0) continue;

      if (APPLY) {
        const res = await db.collection('customerbalances').bulkWrite(ops, { ordered: false });
        console.log(`    applied: ${res.modifiedCount} row(s) rewritten`);
        repaired += res.modifiedCount;
      } else {
        console.log(`    would rewrite ${ops.length} row(s)`);
        repaired += ops.length;
      }
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Shops scanned: ${shops.length}`);
  console.log(`${APPLY ? 'Rows rewritten' : 'Rows that would change'}: ${repaired}`);
  if (skipped) console.log(`Skipped (needs a human): ${skipped}`);
  if (!APPLY) console.log('\nDRY-RUN — nothing written. Re-run with --apply.');

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
