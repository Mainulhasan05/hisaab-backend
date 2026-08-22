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
  // The invoice-receipt tokens. `{total_due}` was missing here and in
  // `personalizeMessage` below, which was not cosmetic: the SMS page's "Sale
  // Receipt" body has carried `{total_due}` since the balance line was added,
  // so a shopkeeper who picked it and sent, sent a literal `{total_due}` to
  // every customer on the list, and — because nothing here reported the body as
  // personalized — sent it as ONE bulk body, so every one of them got the same
  // braces. The rest arrived with per-shop invoice templates, which put all of
  // these in front of the shopkeeper at once.
  '{total_due}',
  '{previous_due}',
  '{due_settled}',
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
 *
 * `{total_due}` and `{previous_due}` are the same figure for the same reason: a
 * campaign has no invoice to sit before or after, so "what they owed before"
 * and "what they owe in total" are both just what they owe. `{due_settled}` is
 * `0` — nothing was settled by a text message.
 *
 * EVERY token this file knows about must appear below. A token in
 * `PERSONALIZABLE_TOKENS` with no `.replace()` here is worse than one in
 * neither list: the body is billed as personalized, rendered per recipient, and
 * still arrives with braces in it.
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
    .replace(/{total_due}/g, dueText)
    .replace(/{previous_due}/g, dueText)
    .replace(/{due_settled}/g, '0')
    .replace(/{shop_name}/g, gsmSafeShopName(shopName))
    .replace(/{invoice_no}/g, 'N/A')
    .replace(/{date}/g, formatCampaignDate())
    .replace(/{total}/g, '0')
    .replace(/{paid}/g, '0');
}

/**
 * Today, in Dhaka, as `17/8/2026` — the shape `{date}` takes on a receipt.
 *
 * A campaign has no invoice date, and the only date it can honestly claim is
 * the day it is being sent. Rendered here rather than left as a brace because a
 * shop with a custom invoice template can pick that body on the SMS page, and
 * `{date}` would otherwise be the one token that survives into the send.
 */
function formatCampaignDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const pick = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${Number(pick('day'))}/${Number(pick('month'))}/${pick('year')}`;
}

module.exports = {
  PLACEHOLDERS,
  PERSONALIZABLE_TOKENS,
  isPersonalized,
  personalizeMessage,
};
