/**
 * SMS message bodies — the single source of truth for every message this app
 * sends on a shop's behalf.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MIRRORED ON THE CLIENT. KEEP THEM IDENTICAL.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `hisaab-frontend/lib/sms/templates.js` is a character-for-character copy of
 * the builders below, and the dashboard shows its output to the shopkeeper as
 * "this is what your customer will receive" before anything is sent.
 *
 * That promise is only as good as the two files agreeing. A preview that drifts
 * from what actually goes out is worse than no preview at all — it is a wrong
 * answer delivered confidently, and the shopkeeper is paying per segment for
 * the difference. So: any edit here is an edit there, in the same commit.
 * `src/tests/smsTemplates.test.js` pins the exact strings on this side.
 *
 * The duplication is deliberate and follows the precedent already set by
 * `smsCounter.util.js` / `lib/utils/smsCounter.js`. The alternative — asking the
 * server what it would send — costs a round trip in the POS hot path and is
 * simply unavailable when the till is offline, which is exactly when a sale is
 * being parked for later sync and the cashier still needs to know what the
 * customer will get.
 *
 * These bodies stay inside GSM-7 on purpose. A single Bangla character flips the
 * whole message to UCS-2 and cuts the per-segment budget from 160 characters to
 * 70 — more than doubling the cost of every receipt the shop sends. The shop
 * name is the one part we cannot control; see `gsmSafeShopName`.
 */

/**
 * Money, as it appears in a message.
 *
 * Whole taka print bare (`1500`, not `1500.00`) because trailing zeros cost two
 * characters each in a 160-character budget and read as noise to a shopkeeper.
 * Paisa survive when they exist.
 *
 * A non-numeric string passes through untouched, which is what lets the SMS
 * page's template picker run `{due_amount}` through these same builders instead
 * of keeping a second, drift-prone copy of every message. Without the escape
 * hatch `Number('{due_amount}') || 0` renders the placeholder as `0` and the
 * shopkeeper is offered a template that reads "Your due: Tk0".
 */
const formatSmsAmount = (amount) => {
  if (typeof amount === 'string' && amount.trim() !== '' && Number.isNaN(Number(amount))) {
    return amount;
  }
  const value = Number(amount) || 0;
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
};

/**
 * The shop's sign-off. Falls back to the product name for shops that somehow
 * have none, so a message never ends on a dangling dash.
 */
const gsmSafeShopName = (shopName) => {
  if (!shopName) {
    return 'Hisaab';
  }
  return shopName;
};

/**
 * Sale receipt — sent on sale creation, either by the shop's auto-send setting
 * or because the cashier ticked the SMS box at the till.
 *
 * The shop name signs off at the bottom only. It used to head the message as
 * well, so every receipt named the shop twice — wasted characters in a message
 * that is billed by 160-character segment.
 */
const buildSaleReceipt = ({ invoiceNo, total, paid, due, shopName }) =>
  `Inv:${invoiceNo}\nTotal:Tk${formatSmsAmount(total)}\nPaid:Tk${formatSmsAmount(paid)}\nDue:Tk${formatSmsAmount(due)}\nThanks for visiting\n- ${gsmSafeShopName(shopName)}`;

/**
 * Payment receipt — sent when a due is collected, either against a specific
 * invoice or against the customer's running balance.
 *
 * `remainingDue` is the balance AFTER this payment lands. Previewing it before
 * the collection is recorded therefore means subtracting the amount yourself;
 * the client mirror does exactly that.
 */
const buildPaymentReceipt = ({ customerName, amount, remainingDue, shopName }) =>
  `${customerName},\nTk${formatSmsAmount(amount)} payment received.\nCurrent due: Tk${formatSmsAmount(remainingDue)}\nThank you - ${gsmSafeShopName(shopName)}`;

/**
 * Due reminder — sent from the SMS page to customers carrying a balance.
 */
const buildDueReminder = ({ customerName, due, shopName }) =>
  `Dear ${customerName},\nYour due: Tk${formatSmsAmount(due)}\nPlease pay as soon as possible.\nThank you - ${gsmSafeShopName(shopName)}`;

/**
 * Registration / login OTP. Not shop-branded and not billed to a shop's quota,
 * so it takes no shop name.
 */
const buildOtp = (otp) => `Your Hisaab OTP: ${otp}\nValid for 5 minutes`;

module.exports = {
  formatSmsAmount,
  gsmSafeShopName,
  buildSaleReceipt,
  buildPaymentReceipt,
  buildDueReminder,
  buildOtp,
};
