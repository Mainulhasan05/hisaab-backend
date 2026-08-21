/**
 * Verify — and optionally repair — `PaymentAccount.balance` against the rows
 * that moved it.
 *
 *   node scripts/recalc-account-balances.js                      # dry-run, every shop with accounts
 *   node scripts/recalc-account-balances.js --shop <id>          # dry-run, one shop
 *   node scripts/recalc-account-balances.js --shop <id> --apply
 *
 * ── Why this exists BEFORE anything writes a balance ────────────────────────
 *
 * `balance` is a stored rollup. Stored rollups drift the moment a second write
 * path appears that does not know about them, and they drift SILENTLY — that is
 * exactly what happened to `variants[].stock`, which disagreed with
 * `product.stock` on live data for months because the sale and cancel paths
 * moved one and not the other.
 *
 * Two things are supposed to make that impossible here: every movement goes
 * through `paymentAccount.service.applyAccountDelta`, and this script re-derives
 * the same figure from source documents so a divergence is findable rather than
 * theoretical. Shipping the second one first is deliberate — a rollup with no
 * checker is a rollup nobody will notice going wrong.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 *
 *     balance  ===  openingBalance
 *                 + Σ money in   (sale legs, due collections, transfers in)
 *                 − Σ money out  (purchases, supplier payments, expenses,
 *                                 refunds, transfers out)
 *
 * Everything is bounded by `openingDate`: day one is the day the account was
 * created (FUND_ACCOUNT_PLAN Q-3, settled), so movements before it are NOT
 * replayed — they are already inside the opening figure the owner typed in.
 *
 * ── This is a second opinion, so it reads source rows only ──────────────────
 *
 * It never reads `balance` to compute the expected `balance`. It also reads the
 * collections directly rather than through the models, so a schema default
 * cannot quietly supply a figure the database does not actually hold.
 *
 * A note on what "money in from a sale" means: the truth for a split invoice
 * lives in `Sale.payments[]`, one leg per method, each naming its own account.
 * `Sale.paymentMethod` is only the LARGEST leg and must never be summed here —
 * that is the same trap `report.service` fell into (see FUND_ACCOUNT_PLAN
 * Phase 0).
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *
 * Dry-run by default. Exits 1 when any account is out, whether or not --apply
 * was given, because a drift is a code bug in a write path and rewriting the
 * figure here would hide it. Repair only once you have read the list and know
 * which write path was wrong.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const shopArgIdx = process.argv.indexOf('--shop');
const SHOP_ARG = shopArgIdx !== -1 ? process.argv[shopArgIdx + 1] : null;

/**
 * The SAME rounding the live write paths use.
 *
 * A second opinion that rounds differently from the code it checks manufactures
 * its own disagreements — `recalc-customer-balances` learned this the hard way
 * with a hand-rolled `Number.EPSILON` nudge that diverged above ~2.
 */
const { quantizeMoney: round } = require('../src/utils/quantity.util');

/** Money is only counted from the day the account's opening figure was struck. */
const since = (account, field = 'createdAt') => ({
  [field]: { $gte: account.openingDate || new Date(0) },
});

/**
 * Re-derive one shop's account balances from source documents.
 *
 * Returns a Map of accountId -> expected balance.
 */
async function rebuildShop(db, shopId, accounts) {
  const expected = new Map();
  for (const a of accounts) {
    expected.set(String(a._id), round(a.openingBalance || 0));
  }

  const add = (accountId, amount) => {
    if (!accountId) return;
    const key = String(accountId);
    if (!expected.has(key)) return; // another shop's account, or a stale pointer
    expected.set(key, round(expected.get(key) + (Number(amount) || 0)));
  };

  // The window differs per account, so each is queried against its own
  // `openingDate`. Shops hold a handful of accounts, not thousands, so this
  // stays a handful of bounded queries rather than one unbounded scan.
  for (const account of accounts) {
    const accountId = account._id;

    // ── IN: money taken at the counter, leg by leg ──────────────────────────
    //
    // `$unwind` on `payments[]`, never `$sum: '$paid'` grouped by
    // `paymentMethod` — a ৳400 cash + ৳600 bKash invoice would otherwise credit
    // ৳1000 to whichever leg happened to be larger.
    const saleLegs = await db.collection('sales').aggregate([
      { $match: { shop: shopId, status: { $ne: 'cancelled' }, ...since(account) } },
      { $unwind: '$payments' },
      { $match: { 'payments.account': accountId } },
      { $group: { _id: null, total: { $sum: '$payments.amount' } } },
    ]).toArray();
    add(accountId, saleLegs[0]?.total || 0);

    // ── IN: money against invoices AFTER checkout ───────────────────────────
    //
    // `atCheckout: { $ne: true }` is what keeps this disjoint from the legs
    // above. Checkout writes BOTH a `Sale.payments[]` leg and a `Payment` row
    // by design; counting both is the double-count that made the cash drawer
    // read short by exactly the day's takings.
    //
    // Bucketed on `paidAt` — the day the money changed hands — because a
    // backdated বাকি আদায় belongs to the period it was collected in.
    const collections = await db.collection('payments').aggregate([
      {
        $match: {
          shop: shopId,
          account: accountId,
          atCheckout: { $ne: true },
          // `advance` is customer money that entered a real account, so a
          // rebuild that omitted it would DESTROY that cash from the balance it
          // is recomputing — the script's whole purpose is to be a second
          // opinion, and a second opinion missing a payment type is worse than
          // none. Mirrors the `$in` in cashRegister._calculateCashFlows.
          type: { $in: ['sale_payment', 'due_collection', 'advance'] },
          ...since(account, 'paidAt'),
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]).toArray();
    add(accountId, collections[0]?.total || 0);

    // ── OUT: paid to suppliers, at purchase time and after ──────────────────
    const purchaseLegs = await db.collection('purchases').aggregate([
      { $match: { shop: shopId, status: { $ne: 'cancelled' }, ...since(account, 'date') } },
      { $unwind: '$payments' },
      { $match: { 'payments.account': accountId } },
      { $group: { _id: null, total: { $sum: '$payments.amount' } } },
    ]).toArray();
    add(accountId, -(purchaseLegs[0]?.total || 0));

    const supplierPayments = await db.collection('payments').aggregate([
      {
        $match: {
          shop: shopId,
          account: accountId,
          atCheckout: { $ne: true },
          type: 'purchase_payment',
          ...since(account, 'paidAt'),
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]).toArray();
    add(accountId, -(supplierPayments[0]?.total || 0));

    // ── OUT: expenses ───────────────────────────────────────────────────────
    //
    // Voided expenses are excluded: a void is the only way an expense can be
    // undone (the row itself is immutable), and the money comes back.
    const expenses = await db.collection('expenses').aggregate([
      {
        $match: {
          shop: shopId,
          account: accountId,
          isVoided: { $ne: true },
          ...since(account, 'date'),
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]).toArray();
    add(accountId, -(expenses[0]?.total || 0));

    // ── OUT: refunds handed back to customers ───────────────────────────────
    const refunds = await db.collection('payments').aggregate([
      {
        $match: {
          shop: shopId,
          account: accountId,
          type: 'refund',
          ...since(account, 'paidAt'),
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]).toArray();
    add(accountId, -(refunds[0]?.total || 0));

    // ── Transfers, both directions (Phase 3) ────────────────────────────────
    //
    // `amountOut` and `amountIn` differ by the MFS or bank charge, which is why
    // they are separate fields rather than one amount: ৳50,925 leaves bKash and
    // ৳50,000 arrives in the drawer. Reading one figure for both legs would
    // lose the charge and leave every cash-out permanently ৳925 adrift.
    //
    // Harmless before Phase 3 lands — the collection simply does not exist yet.
    const transfersOut = await db.collection('accounttransfers').aggregate([
      { $match: { shop: shopId, fromAccount: accountId, ...since(account, 'date') } },
      { $group: { _id: null, total: { $sum: '$amountOut' } } },
    ]).toArray();
    add(accountId, -(transfersOut[0]?.total || 0));

    const transfersIn = await db.collection('accounttransfers').aggregate([
      { $match: { shop: shopId, toAccount: accountId, ...since(account, 'date') } },
      { $group: { _id: null, total: { $sum: '$amountIn' } } },
    ]).toArray();
    add(accountId, transfersIn[0]?.total || 0);

    // ── Owner deposits and withdrawals (Phase 4) ────────────────────────────
    //
    // These move the balance and never touch profit — a withdrawal is not an
    // expense. Same note as transfers: the collection does not exist yet.
    const entries = await db.collection('accountentries').aggregate([
      { $match: { shop: shopId, account: accountId, ...since(account, 'date') } },
      {
        $group: {
          _id: '$direction',
          total: { $sum: '$amount' },
        },
      },
    ]).toArray();
    for (const e of entries) {
      add(accountId, e._id === 'out' ? -(e.total || 0) : (e.total || 0));
    }
  }

  return expected;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
  });

  const db = mongoose.connection.db;
  console.log(`Connected to ${mongoose.connection.host}/${db.databaseName} (${APPLY ? 'APPLY' : 'DRY-RUN'})\n`);

  const accountFilter = {};
  if (SHOP_ARG) accountFilter.shop = new mongoose.Types.ObjectId(SHOP_ARG);

  const allAccounts = await db.collection('paymentaccounts').find(accountFilter).toArray();

  if (allAccounts.length === 0) {
    console.log('No fund accounts found. Nothing to check — shops without `features.fundAccounts` have none by design.');
    await mongoose.connection.close();
    return;
  }

  const byShop = new Map();
  for (const a of allAccounts) {
    const key = String(a.shop);
    if (!byShop.has(key)) byShop.set(key, []);
    byShop.get(key).push(a);
  }

  const shops = await db.collection('shops')
    .find({ _id: { $in: [...byShop.keys()].map((id) => new mongoose.Types.ObjectId(id)) } })
    .project({ name: 1 })
    .toArray();
  const shopName = new Map(shops.map((s) => [String(s._id), s.name]));

  let drifted = 0;
  let written = 0;

  for (const [shopKey, accounts] of byShop) {
    console.log(`\n${shopName.get(shopKey) || shopKey} — ${accounts.length} account(s)`);

    const expected = await rebuildShop(db, new mongoose.Types.ObjectId(shopKey), accounts);
    const ops = [];

    for (const account of accounts) {
      const want = expected.get(String(account._id));
      const have = round(account.balance || 0);

      if (want === have) {
        console.log(`  ok       ${account.name.padEnd(24)} ৳${have}`);
        continue;
      }

      drifted += 1;
      console.log(
        `  DRIFT    ${account.name.padEnd(24)} stored ৳${have}  derived ৳${want}  (out by ৳${round(have - want)})`
      );
      ops.push({
        updateOne: {
          filter: { _id: account._id },
          update: { $set: { balance: want, updatedAt: new Date() } },
        },
      });
    }

    if (APPLY && ops.length > 0) {
      const res = await db.collection('paymentaccounts').bulkWrite(ops, { ordered: false });
      written += res.modifiedCount || 0;
      console.log(`  applied: ${res.modifiedCount || 0} balance(s) rewritten`);
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Accounts checked: ${allAccounts.length}`);
  console.log(`Drifted: ${drifted}`);
  if (APPLY) console.log(`Balances rewritten: ${written}`);
  else if (drifted > 0) console.log('DRY-RUN — nothing written. Re-run with --apply once you know which write path was wrong.');

  await mongoose.connection.close();

  // Drift means a write path moved money without going through
  // `applyAccountDelta`. That is a code bug, not a data blip, so fail loudly —
  // including after --apply, so a repair run cannot be mistaken for a clean
  // bill of health. Re-run without --apply to confirm it is back to zero.
  if (drifted > 0) {
    console.error('\nBalances drifted. Find the write path that skipped applyAccountDelta before trusting these figures.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
