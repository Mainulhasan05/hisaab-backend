/**
 * Close out a gateway order whose money an operator already keyed in by hand.
 *
 *   node scripts/settle-order-manually.js <orderId>            # dry run
 *   node scripts/settle-order-manually.js <orderId> --apply
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT `refulfilOrder`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `refulfilOrder` GRANTS the thing the order bought. That is right when the
 * money arrived and nothing was delivered. It is wrong — and expensive — in the
 * case this script exists for:
 *
 *   the customer paid, the gateway took the money, our code failed to
 *   recognise it, the shop phoned support, and an admin keyed the payment in
 *   manually while the order was still sitting at `initiated`.
 *
 * The shop has already been extended and the ledger already has its row. Running
 * fulfilment now would extend a second month and write a second ৳800 against the
 * same payment, which is a harder problem to unpick than the one it fixes.
 *
 * So this grants NOTHING. It records that the order was settled elsewhere:
 * status `fulfilled`, the claim taken so no sweep or browser can re-enter
 * fulfilment, and `platformPayment` pointed at the manual row an operator
 * already created. The order stops being chased, stops being a candidate for the
 * 24-hour abandon rule, and reads correctly in a dispute six months from now.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CHECK THAT MAKES IT SAFE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It refuses to run unless it can FIND the manual payment it is settling
 * against: same shop, `source: 'manual'`, same amount, within a few days. If no
 * such row exists the money was never credited, this is the wrong tool, and the
 * right answer is to fix the recognition bug and let the sweep fulfil normally.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const PlatformOrder = require('../src/models/PlatformOrder.model');
const { PLATFORM_ORDER_STATUS } = require('../src/models/PlatformOrder.model');
const PlatformPayment = require('../src/models/PlatformPayment.model');
const Shop = require('../src/models/Shop.model');

/** How far either side of the order to look for the operator's manual entry. */
const MATCH_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

async function main() {
  const orderId = process.argv[2];
  const apply = process.argv.includes('--apply');

  if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
    console.error('Usage: node scripts/settle-order-manually.js <orderId> [--apply]');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log(`\nSettle order manually${apply ? '' : '  (DRY RUN)'}\n${'─'.repeat(60)}`);

  const order = await PlatformOrder.findById(orderId);
  if (!order) {
    console.error(`No order ${orderId}`);
    process.exit(1);
  }

  const shop = await Shop.findById(order.shop).select('name subscription.expiresAt').lean();

  console.log(`order      ${order._id}`);
  console.log(`shop       ${shop?.name || order.shop}`);
  console.log(`invoice    ${order.invoiceNumber}`);
  console.log(`kind       ${order.kind}${order.months ? ` (${order.months} month(s))` : ''}`);
  console.log(`amount     ৳${order.amount}`);
  console.log(`status     ${order.status}`);
  console.log(`gateway    trx ${order.gateway?.trxId || '—'} via ${order.gateway?.paymentMethod || '—'}`);
  console.log(`checked    ${order.gateway?.checkCount || 0} time(s)`);

  if (order.status === PLATFORM_ORDER_STATUS.FULFILLED) {
    console.log('\nAlready fulfilled. Nothing to do.');
    return;
  }

  // The whole safety of this script. No manual row means the money was never
  // credited, and settling here would quietly lose a shop its subscription.
  const around = order.paidAt || order.createdAt;
  const manual = await PlatformPayment.findOne({
    shop: order.shop,
    source: 'manual',
    amount: order.amount,
    receivedAt: {
      $gte: new Date(around.getTime() - MATCH_WINDOW_MS),
      $lte: new Date(around.getTime() + MATCH_WINDOW_MS),
    },
  }).sort({ receivedAt: -1 }).lean();

  if (!manual) {
    console.error(
      `\nREFUSING: no manual ৳${order.amount} payment found for this shop within `
      + `${MATCH_WINDOW_MS / 86400000} days of the order.`
    );
    console.error('The money was never credited, so this is the wrong tool — the order');
    console.error('should be fulfilled normally once the gateway reply is read correctly.');
    process.exit(1);
  }

  console.log(
    `\nmatched manual payment ${manual._id} — ৳${manual.amount} via ${manual.method} `
    + `on ${manual.receivedAt.toISOString().slice(0, 10)}, `
    + `recorded by ${manual.recordedBy?.name || 'unknown'}`
  );
  console.log(`shop expiry is currently ${shop?.subscription?.expiresAt?.toISOString().slice(0, 10) || '—'}`);
  console.log('\nThis grants NOTHING. It only stops the order being chased or written off.');

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }

  order.status = PLATFORM_ORDER_STATUS.FULFILLED;
  order.paidAt = order.paidAt || manual.receivedAt;
  // Taking the claim is what makes this stick: an unclaimed `fulfilled` order is
  // not re-entered today, but a future "fulfil manually" click would be.
  order.fulfilmentClaimedAt = order.fulfilmentClaimedAt || new Date();
  order.fulfilledAt = new Date();
  order.platformPayment = manual._id;
  order.failureReason = `Settled against manual payment ${manual._id} — gateway money was keyed in by hand`;
  await order.save();

  console.log(`\nOrder ${order._id} marked fulfilled and linked to payment ${manual._id}.`);
}

main()
  .catch((err) => { console.error(`\nFailed: ${err.message}`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
