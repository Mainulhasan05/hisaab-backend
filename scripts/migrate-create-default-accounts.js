/**
 * Seed a shop's fund accounts from the payment methods it has actually used.
 *
 *   node scripts/migrate-create-default-accounts.js --shop <id>            # dry-run
 *   node scripts/migrate-create-default-accounts.js --shop <id> --apply
 *   node scripts/migrate-create-default-accounts.js --apply                # every shop with the flag on
 *
 * ── What it does, and why it can be automatic ───────────────────────────────
 *
 * Every money row a shop has ever written already carries a `method` — `cash`,
 * `bkash`, `nagad`, `card`, `bank`. So "which accounts does this shop need?" has
 * an answer already in the data, and it needs no judgement call and no
 * conversation with the shopkeeper: one account per method the shop has
 * actually used, each marked as that method's default so a POS still posting a
 * bare `method` resolves to it.
 *
 * What it deliberately does NOT do is guess a BALANCE. Opening balances are
 * typed in by the owner (FUND_ACCOUNT_PLAN D-4) — every account here starts at
 * zero and the owner corrects it on the accounts screen. Deriving one from
 * history would be wrong in the one direction that matters: a shop's bank
 * account holds money that never passed through this app.
 *
 * ── Order matters ───────────────────────────────────────────────────────────
 *
 * Run this BEFORE flipping `features.fundAccounts`, and flip the flag last —
 * the ordering `enableMultiBranch` uses (M-6). An interruption then leaves the
 * shop with unused accounts, which is harmless, rather than with the capability
 * on and nothing behind it, which is a broken screen.
 *
 * This script never touches the flag itself. That stays an explicit admin
 * action, so nobody can enable a capability for a shop by running a migration.
 *
 * ── The branch rule ─────────────────────────────────────────────────────────
 *
 * One CASH account per branch — a drawer belongs to a counter. One shared
 * account per other method, `branch: null` — a shop has one bank account, not
 * one per counter (FUND_ACCOUNT_PLAN D-3). A single-branch shop has no branches
 * at all, so its cash account is `branch: null` too and the rule collapses.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *
 * Dry-run by default. Idempotent: it skips any {shop, branch, name} that
 * already exists, so an interrupted run resumes by being re-run and a second
 * run over a live shop creates nothing.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const shopArgIdx = process.argv.indexOf('--shop');
const SHOP_ARG = shopArgIdx !== -1 ? process.argv[shopArgIdx + 1] : null;

/**
 * How a method presents as an account.
 *
 * `type` drives the branch rule and the icon; the Bengali name is what the
 * shopkeeper sees, and it is what they will rename the moment they have two
 * bKash numbers — which is the whole point of the feature.
 */
const METHOD_ACCOUNTS = {
  cash:  { type: 'cash', name: 'ক্যাশ বাক্স' },
  bkash: { type: 'mfs',  name: 'বিকাশ' },
  nagad: { type: 'mfs',  name: 'নগদ' },
  card:  { type: 'card', name: 'কার্ড' },
  bank:  { type: 'bank', name: 'ব্যাংক' },
};

/** Every method this shop has actually moved money through. */
async function methodsUsed(db, shopId) {
  const found = new Set();

  const collect = (rows) => rows.forEach((r) => r._id && found.add(r._id));

  // Sale legs, not `Sale.paymentMethod` — on a split invoice the latter names
  // only the largest leg, so a shop that took bKash exclusively in ৳200 chunks
  // beside larger cash sales would never see a bKash account created.
  collect(await db.collection('sales').aggregate([
    { $match: { shop: shopId } },
    { $unwind: { path: '$payments', preserveNullAndEmptyArrays: false } },
    { $group: { _id: '$payments.method' } },
  ]).toArray());

  // Older sales predating split payments carry only the scalar.
  collect(await db.collection('sales').aggregate([
    { $match: { shop: shopId } },
    { $group: { _id: '$paymentMethod' } },
  ]).toArray());

  collect(await db.collection('payments').aggregate([
    { $match: { shop: shopId } },
    { $group: { _id: '$method' } },
  ]).toArray());

  collect(await db.collection('purchases').aggregate([
    { $match: { shop: shopId } },
    { $group: { _id: '$paymentMethod' } },
  ]).toArray());

  collect(await db.collection('expenses').aggregate([
    { $match: { shop: shopId } },
    { $group: { _id: '$paymentMethod' } },
  ]).toArray());

  // `credit` is a Purchase-only value meaning "not paid yet". It is the absence
  // of a payment, not a place money sits, so it must never become an account.
  found.delete('credit');

  // Cash always, even for a shop that has somehow never recorded a cash sale.
  // Every shop has a drawer, and an accounts screen without one reads as broken.
  found.add('cash');

  return [...found].filter((m) => METHOD_ACCOUNTS[m]);
}

async function planShop(db, shop, ownerId) {
  const shopId = shop._id;
  const methods = await methodsUsed(db, shopId);

  const branches = shop.multiBranchEnabled
    ? await db.collection('branches').find({ shop: shopId }).project({ name: 1 }).toArray()
    : [];

  const existing = await db.collection('paymentaccounts')
    .find({ shop: shopId }).project({ name: 1, branch: 1 }).toArray();
  const taken = new Set(existing.map((a) => `${a.branch || 'null'}|${a.name}`));

  const planned = [];
  const now = new Date();

  const push = (method, branch, name) => {
    if (taken.has(`${branch || 'null'}|${name}`)) return;
    taken.add(`${branch || 'null'}|${name}`);
    planned.push({
      shop: shopId,
      branch: branch || null,
      name,
      type: METHOD_ACCOUNTS[method].type,
      method,
      openingBalance: 0,
      openingDate: now,
      // Zero, and the owner fixes it. See the header — a derived opening
      // balance would be confidently wrong for every account that holds money
      // this app has never seen.
      balance: 0,
      // One default per method per branch scope, which is what
      // `resolveAccountForMethod` needs to answer a bare `method: 'bkash'`.
      isDefault: true,
      isActive: true,
      createdBy: ownerId,
      createdAt: now,
      updatedAt: now,
    });
  };

  for (const method of methods) {
    if (method === 'cash' && branches.length > 0) {
      // A drawer per counter. Named after the branch so two 'ক্যাশ বাক্স' rows
      // are distinguishable on screen, not merely in the database.
      for (const branch of branches) {
        push('cash', branch._id, `ক্যাশ বাক্স — ${branch.name}`);
      }
    } else {
      push(method, null, METHOD_ACCOUNTS[method].name);
    }
  }

  return planned;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
  });

  const db = mongoose.connection.db;
  console.log(`Connected to ${mongoose.connection.host}/${db.databaseName} (${APPLY ? 'APPLY' : 'DRY-RUN'})\n`);

  const filter = SHOP_ARG
    ? { _id: new mongoose.Types.ObjectId(SHOP_ARG) }
    : { 'features.fundAccounts': true };

  const shops = await db.collection('shops')
    .find(filter).project({ name: 1, multiBranchEnabled: 1, features: 1 }).toArray();

  if (shops.length === 0) {
    console.log(SHOP_ARG
      ? 'Shop not found.'
      : 'No shop has `features.fundAccounts` on. Name one with --shop to seed it before flipping the flag.');
    await mongoose.connection.close();
    return;
  }

  let created = 0;

  for (const shop of shops) {
    // Accounts are stamped with a creator, and for a migration the honest
    // answer is the shop's owner rather than a fabricated system user.
    const owner = await db.collection('users').findOne({ shop: shop._id, isOwner: true }, { projection: { _id: 1 } });
    if (!owner) {
      console.log(`\n${shop.name} — SKIPPED, no owner user found`);
      continue;
    }

    const planned = await planShop(db, shop, owner._id);

    console.log(`\n${shop.name} — ${planned.length} account(s) to create` +
      (shop.features?.fundAccounts ? '' : '   [flag is OFF — seed first, flip after]'));
    for (const a of planned) {
      console.log(`  + ${a.name.padEnd(28)} type=${a.type.padEnd(5)} method=${a.method}`);
    }
    if (planned.length === 0) console.log('  (nothing to do — already seeded)');

    if (APPLY && planned.length > 0) {
      const res = await db.collection('paymentaccounts').insertMany(planned, { ordered: false });
      created += res.insertedCount || 0;
      console.log(`  applied: ${res.insertedCount} created`);
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Shops processed: ${shops.length}`);
  if (APPLY) {
    console.log(`Accounts created: ${created}`);
    console.log('\nNext: have the owner set each opening balance, THEN turn on `features.fundAccounts`.');
    console.log('Then: node scripts/recalc-account-balances.js --shop <id>   (must report zero drift)');
  } else {
    console.log('DRY-RUN — nothing written. Re-run with --apply.');
  }

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
