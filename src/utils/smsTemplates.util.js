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
 * ── The two extra lines, and why they are conditional ──────────────────────
 *
 * When a customer settles part of their খাতা out of surplus tendered at the
 * till, the receipt has to say so. Without it the message reads "Due:Tk0" on a
 * ৳500 bill the customer just handed ৳2,700 for — a receipt that silently
 * denies the ৳2,200 collection, over the one channel the customer actually
 * reads. The alternative, firing buildPaymentReceipt as a second message,
 * bills the shop twice for one visit.
 *
 * "Due:" stays the INVOICE's own due; "Total due:" is what the customer still
 * owes the shop after the visit. On a settling sale both are usually 0, and
 * printing them either side of the settled line is what stops the ৳2,200
 * reading like a third, unexplained figure.
 *
 * Emitted only when something was actually settled, so an ordinary receipt is
 * byte-for-byte what it was before this existed — no shop's segment count
 * moves for a feature it does not use.
 */
const buildSaleReceipt = ({ invoiceNo, total, paid, due, dueSettled = 0, totalDue = 0, shopName }) => {
  const settled = Number(dueSettled) || 0;
  const settledLines = settled > 0
    ? `\nOld due paid:Tk${formatSmsAmount(settled)}\nTotal due:Tk${formatSmsAmount(totalDue)}`
    : '';
  return `Inv:${invoiceNo}\nTotal:Tk${formatSmsAmount(total)}\nPaid:Tk${formatSmsAmount(paid)}\nDue:Tk${formatSmsAmount(due)}${settledLines}\nThanks for visiting\n- ${gsmSafeShopName(shopName)}`;
};

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

/**
 * Password-reset code. Same platform-account, unbranded, unbilled category as
 * `buildOtp` — and, like it, NOT mirrored in `lib/sms/templates.js`. The mirror
 * exists so the dashboard can show a shopkeeper what their CUSTOMER will
 * receive; nobody previews this one, so a second copy would be drift with no
 * reader.
 *
 * Deliberately worded differently from `buildOtp`. Both codes arrive on the
 * same number from the same sender, and a message that does not say what it
 * authorises trains people to type any six digits they are asked for — which is
 * exactly the behaviour a reset-code phishing call relies on. "Do not share"
 * costs 14 characters and the whole body still fits one GSM-7 segment.
 */
const buildPasswordResetOtp = (otp) =>
  `Hisaab password reset code: ${otp}\nValid for 5 minutes. Do not share this code.`;

/* ────────────────────────────────────────────────────────────────────────────
 * The shop's sign-off
 *
 * Every message this app sends on a shop's behalf ends with the shop's name.
 * Not as a nicety — an SMS arrives from a numeric short code with no sender
 * name a customer recognises, so a message that does not say who it is from
 * reads as spam and gets ignored, or worse, answered by a call to the wrong
 * number.
 *
 * The builders above bake it into their bodies. Free-text campaigns written on
 * the SMS page do not, so `appendShopSignature` puts it there. It is applied on
 * the SERVER, immediately before the segment count and the gateway call, which
 * makes it the one thing a caller cannot forget or strip: the dashboard, the
 * API and any future automation all pass through the same door.
 * ──────────────────────────────────────────────────────────────────────────── */

/** `- Shop Name`, the exact tail every message ends on. */
const buildShopSignature = (shopName) => `- ${gsmSafeShopName(shopName)}`;

/**
 * Does this message already sign off with the shop's name?
 *
 * Checked on the tail rather than anywhere in the body, because a due reminder
 * that happens to MENTION the shop mid-sentence still needs the sign-off, while
 * one built by `buildDueReminder` — which already ends in `- Shop Name` — must
 * not get a second one. Case-insensitive and dash-optional so a shopkeeper who
 * typed the sign-off by hand isn't charged for a duplicate.
 */
const hasShopSignature = (message, shopName) => {
  const name = gsmSafeShopName(shopName).trim().toLowerCase();
  if (!name) return false;
  const tail = String(message || '').trimEnd().toLowerCase();
  return tail.endsWith(name);
};

/**
 * Append the shop's sign-off unless it is already there.
 *
 * Idempotent by design: running it twice on the same message changes nothing,
 * which matters because the campaign engine appends before counting segments
 * and the preview appends before rendering, and both may run over a template
 * that already carries the sign-off.
 */
const appendShopSignature = (message, shopName) => {
  const body = String(message || '').replace(/\s+$/, '');
  const signature = buildShopSignature(shopName);

  if (!body) return signature;
  if (hasShopSignature(body, shopName)) return body;

  return `${body}\n${signature}`;
};

module.exports = {
  formatSmsAmount,
  gsmSafeShopName,
  buildSaleReceipt,
  buildPaymentReceipt,
  buildDueReminder,
  buildOtp,
  buildPasswordResetOtp,
  buildShopSignature,
  hasShopSignature,
  appendShopSignature,
};
