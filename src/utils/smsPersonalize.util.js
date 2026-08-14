/**
 * Campaign placeholder substitution.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MIRRORED ON THE CLIENT: `hisaab-frontend/lib/sms/personalize.js`.
 * KEEP THEM IDENTICAL.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The SMS page lets a shopkeeper write `Dear {customer_name}, your due is
 * Tk{due_amount}` once and send four hundred different messages from it. Two
 * things then have to agree exactly: the preview panel, which promises "this is
 * what your customer will receive", and the campaign engine, which builds the
 * body that actually goes.
 *
 * They disagreed before. The preview substituted invented sample data while the
 * send substituted real figures, so the panel showed a message no customer
 * would ever get — and, because the two differed in LENGTH, the cost shown next
 * to the send button could be a whole segment short of what was billed. This
 * file is the fix: one set of rules, mirrored character-for-character, read by
 * both sides.
 *
 * `src/tests/smsPersonalize.test.js` pins the substitutions.
 */

const { formatSmsAmount, gsmSafeShopName } = require('./smsTemplates.util');

/**
 * Every placeholder the composer offers.
 *
 * Exported so the UI can build its insert buttons from this list rather than
 * hard-coding a second, drift-prone copy — a button that inserts a token this
 * file does not substitute produces a message with a literal `{brace}` in it,
 * sent to a real customer at the shop's expense.
 */
const PLACEHOLDERS = [
  { token: '{customer_name}', labelBn: 'কাস্টমারের নাম' },
  { token: '{due_amount}', labelBn: 'বকেয়া টাকা' },
  { token: '{shop_name}', labelBn: 'দোকানের নাম' },
];

/** Does this body need per-recipient rendering, or is one body enough for all? */
const PERSONALIZABLE_TOKENS = [
  '{customer_name}',
  '{due_amount}',
  '{amount}',
  '{remaining_due}',
  '{due}',
  '{invoice_no}',
  '{total}',
  '{paid}',
];

/**
 * `{shop_name}` is deliberately NOT in the list above. It resolves to the same
 * value for every recipient, so a message using only it is still one identical
 * body and should go out as a cheap one-call bulk send rather than as several
 * hundred individually-addressed ones.
 */
function isPersonalized(message) {
  const body = String(message || '');
  return PERSONALIZABLE_TOKENS.some((token) => body.includes(token));
}

/**
 * Render one recipient's message.
 *
 * A campaign is not attached to a sale or a payment, so `{invoice_no}`,
 * `{total}` and `{paid}` have nothing truthful behind them. They render as
 * `N/A` and `0` rather than as flattering placeholders, because whatever goes
 * here is what the customer reads — and the same values go into the preview, so
 * the shopkeeper sees the awkwardness before four hundred customers do.
 *
 * `{amount}` and `{remaining_due}` come from the payment-receipt template. On a
 * campaign there is no payment, so both resolve to the customer's outstanding
 * due — which is the only figure about them this send actually knows.
 */
function personalizeMessage(template, customer = {}, shopName = '') {
  const due = customer.due ?? customer.totalDue ?? 0;
  const dueText = formatSmsAmount(due);

  return String(template || '')
    .replace(/{customer_name}/g, customer.name || customer.customerName || 'Customer')
    .replace(/{due_amount}/g, dueText)
    .replace(/{remaining_due}/g, dueText)
    .replace(/{amount}/g, dueText)
    .replace(/{due}/g, dueText)
    .replace(/{shop_name}/g, gsmSafeShopName(shopName))
    .replace(/{invoice_no}/g, 'N/A')
    .replace(/{total}/g, '0')
    .replace(/{paid}/g, '0');
}

module.exports = {
  PLACEHOLDERS,
  PERSONALIZABLE_TOKENS,
  isPersonalized,
  personalizeMessage,
};
