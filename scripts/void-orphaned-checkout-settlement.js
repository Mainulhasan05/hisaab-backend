/**
 * ─────────────────────────────────────────────────────────────────────────────
 * বাকি আদায় left standing by a VOIDED checkout
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── The situation ────────────────────────────────────────────────────────────
 *
 * A cashier can clear part of a customer's old খাতা in the same breath as
 * ringing up a new bill. `createSale` books that as its own immutable row —
 * `Payment{type:'due_collection', viaSale:<the invoice>}` — precisely so that
 * it is NOT folded into `Sale.paid`.
 *
 * `cancelSale` then reverses only the invoice's own legs (`sale.payments[]`)
 * and leaves the settlement alone. That is deliberate and documented at the
 * `ledgerSettled` field on `Sale`: khata money is money the customer really
 * handed over, and voiding the invoice it happened to ride in on must not claw
 * it back.
 *
 * ── Where that reasoning stops holding ───────────────────────────────────────
 *
 * It assumes the payment happened. When the whole checkout was a mis-punch —
 * rung up and voided seconds later, `cancelReason` "ভুল" — no money crossed the
 * counter at all, and the settlement is now a collection with nothing behind
 * it. The customer's due stays reduced and the cash account stays credited for
 * a receipt that was never issued in earnest.
 *
 * Nothing in the app surfaces this: the invoice reads "বাতিল" and the orphaned
 * receipt sits on the customer's রসিদ list looking ordinary. Hence this script.
 *
 * ── A REVISION is not this ───────────────────────────────────────────────────
 *
 * `reviseSale` cancels the original and writes a replacement, so a revised
 * invoice also reads `status: 'cancelled'`. Its settlement is NOT orphaned —
 * the money was collected and the replacement inherits the snapshot. Rows whose
 * invoice carries `cancelReason: 'revised'` or a `revisedTo` link are therefore
 * excluded from the scan, and `--payment` refuses them outright.
 *
 * ── This script owns no arithmetic ───────────────────────────────────────────
 *
 * The void is `customerService.cancelDueCollection` — the same call behind the
 * owner-only button at `POST /api/customers/receipts/:paymentId/cancel`. It
 * runs in one transaction and does all five steps: marks the row cancelled,
 * debits the fund account, moves `totalPaid` and re-derives both balance halves
 * through `applyBalances`, restores each branch row from the payment's own
 * `branchAllocation` snapshot, reallocates the customer's open invoices, and
 * writes the audit entry. A repair script with its own arithmetic is a second
 * implementation, and a second implementation is how these books drift apart.
 *
 * It follows that this is NOT a migration to be run across the database. Only
 * the shop owner knows whether the cash was actually taken, so the scan reports
 * and `--payment` voids exactly one receipt at a time, by hand, with a reason.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   node scripts/void-orphaned-checkout-settlement.js                    # scan every shop
 *   node scripts/void-orphaned-checkout-settlement.js --shop <id>        # scan one shop
 *   node scripts/void-orphaned-checkout-settlement.js --payment <id> --reason "..."          # dry run
 *   node scripts/void-orphaned-checkout-settlement.js --payment <id> --reason "..." --apply  # write
 *
 * DRY RUN IS THE DEFAULT AND `--apply` IS THE ONLY WAY PAST IT. The dry run
 * prints the customer's due and the account balance, before and after.
 *
 * Take a backup first: `node scripts/backup-db.js` (there is no mongodump on
 * this machine — see the note in that file).
 */

require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
};
const APPLY = args.includes('--apply');
const ONLY_SHOP = flag('--shop');
const PAYMENT_ID = flag('--payment');
const REASON = flag('--reason');
const USER_ID = flag('--user');

const taka = (n) => `৳${(Math.round((n || 0) * 100) / 100).toLocaleString('en-IN')}`;
const oid = (s) => new mongoose.Types.ObjectId(String(s));

/**
 * The invoices whose settlement really is orphaned.
 *
 * `status: 'cancelled'` alone is too wide — it catches revisions, which are a
 * rewritten basket rather than an undone payment. See the header.
 */
const VOIDED_NOT_REVISED = {
  'inv.status': 'cancelled',
  'inv.cancelReason': { $ne: 'revised' },
  'inv.revisedTo': { $in: [null, undefined] },
};

/**
 * `status: {$ne:'cancelled'}` and never `status:'active'` — rows written before
 * the field existed carry no `status` at all, and an equality test would report
 * every shop's history as already voided. Same rule as `LIVE_PAYMENT`.
 */
const LIVE = { status: { $ne: 'cancelled' } };

/**
 * Both halves of a settlement.
 *
 * `settleCustomerDue` splits one tendered amount into up to two rows — the debt
 * it cleared, and a deposit if the customer handed over more than they owed.
 * Scanning only `due_collection` would report the invoice as clean while its
 * `advance` half sat orphaned in exactly the same way.
 */
const SETTLEMENT_TYPES = ['due_collection', 'advance'];

async function findOrphans(db, shopFilter) {
  const match = { type: { $in: SETTLEMENT_TYPES }, viaSale: { $ne: null }, ...LIVE };
  if (shopFilter) match.shop = oid(shopFilter);

  return db.collection('payments').aggregate([
    { $match: match },
    { $lookup: { from: 'sales', localField: 'viaSale', foreignField: '_id', as: 'inv' } },
    { $unwind: '$inv' },
    { $match: VOIDED_NOT_REVISED },
    { $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: 'cust' } },
    { $lookup: { from: 'shops', localField: 'shop', foreignField: '_id', as: 'shopDoc' } },
    { $sort: { paidAt: -1 } },
  ]).toArray();
}

async function scan(db) {
  const orphans = await findOrphans(db, ONLY_SHOP);
  console.log('\n--- SCAN: live খাতা settlements whose checkout was voided (not revised) ---\n');

  if (orphans.length === 0) {
    console.log('None found.\n');
    return;
  }

  for (const r of orphans) {
    const gapSec = r.inv.cancelledAt
      ? Math.round((new Date(r.inv.cancelledAt) - new Date(r.inv.createdAt)) / 1000)
      : null;
    const due = r.cust[0]?.totalDue || 0;
    console.log(`  ${r.shopDoc[0]?.name || r.shop}`);
    console.log(`    receipt   ${r.receiptNo || r._id}   ${taka(r.amount)}   payment ${r._id}`);
    console.log(`    customer  ${r.cust[0]?.name || r.customer} — due now ${taka(due)}`);
    console.log(`    invoice   ${r.inv._id} voided${gapSec !== null ? ` ${gapSec}s after checkout` : ''} — "${r.inv.cancelReason}"`);
    console.log(`    would restore due to ${taka(due + r.amount)}\n`);
  }

  console.log(`${orphans.length} found. Void one with:`);
  console.log('  node scripts/void-orphaned-checkout-settlement.js --payment <id> --reason "..." --apply\n');
}

async function voidOne({ Payment, Customer, PaymentAccount, Sale, customerService }) {
  if (!REASON) throw new Error('--reason is required (it is written to the audit log)');

  const payment = await Payment.findById(oid(PAYMENT_ID));
  if (!payment) throw new Error(`Payment ${PAYMENT_ID} not found`);
  if (!SETTLEMENT_TYPES.includes(payment.type)) {
    throw new Error(`Payment is type '${payment.type}', not a settlement`);
  }
  if (payment.status === 'cancelled') throw new Error('Already cancelled — nothing to do');

  const invoice = payment.viaSale ? await Sale.findById(payment.viaSale) : null;
  if (!invoice) {
    throw new Error('This collection did not ride in on a checkout — void it from the UI instead');
  }
  if (invoice.status !== 'cancelled') {
    throw new Error(`Its invoice ${invoice._id} is '${invoice.status}', not cancelled`);
  }
  // The revision guard. A revised invoice is cancelled too, and its settlement stands.
  if (invoice.cancelReason === 'revised' || invoice.revisedTo) {
    throw new Error(`Invoice ${invoice._id} was REVISED, not voided — its settlement is not orphaned. Refusing.`);
  }

  const customer = await Customer.findById(payment.customer);
  const account = payment.account ? await PaymentAccount.findById(payment.account) : null;
  // The audit entry needs a name on it. Default to whoever voided the invoice.
  const userId = USER_ID || invoice.cancelledBy;
  if (!userId) throw new Error('No --user given and the invoice has no cancelledBy');

  console.log(`\n${APPLY ? '*** APPLYING ***' : '--- DRY RUN (no writes) ---'}\n`);
  console.log(`  receipt   ${payment.receiptNo || payment._id}   ${taka(payment.amount)}`);
  console.log(`  customer  ${customer?.name}`);
  console.log(`  invoice   ${invoice._id} — "${invoice.cancelReason}"`);
  console.log(`  reason    ${REASON}\n`);
  console.log(`  customer due   ${taka(customer?.totalDue)}  ->  ${taka((customer?.totalDue || 0) + payment.amount)}`);
  if (account) {
    console.log(`  ${account.name}   ${taka(account.balance)}  ->  ${taka((account.balance || 0) - payment.amount)}`);
  }
  console.log('');

  if (!APPLY) {
    console.log('Nothing written. Re-run with --apply.\n');
    return;
  }

  const out = await customerService.cancelDueCollection(
    String(payment.shop),
    String(userId),
    String(payment._id),
    { reason: REASON },
    null
  );

  const after = await Customer.findById(payment.customer);
  const acctAfter = payment.account ? await PaymentAccount.findById(payment.account) : null;
  console.log(`DONE. ${taka(out.amount)} reversed.`);
  console.log(`  customer due   ${taka(after.totalDue)}   advance ${taka(after.advanceBalance)}`);
  if (acctAfter) console.log(`  ${acctAfter.name}   ${taka(acctAfter.balance)}`);
  console.log(`  invoices reallocated: ${(out.allocations || []).length}\n`);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  // Required after the connection so the models register against it.
  const deps = {
    Payment: require('../src/models/Payment.model'),
    Customer: require('../src/models/Customer.model'),
    PaymentAccount: require('../src/models/PaymentAccount.model'),
    Sale: require('../src/models/Sale.model'),
    customerService: require('../src/services/customer.service'),
  };

  if (PAYMENT_ID) await voidOne(deps);
  else await scan(db);
}

main()
  .catch((e) => { console.error(`\n${e.message}\n`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
