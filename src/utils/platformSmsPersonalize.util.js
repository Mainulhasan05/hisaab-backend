/**
 * Placeholder substitution for PLATFORM broadcasts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MIRRORED ON THE CLIENT: `hisaab-frontend/lib/sms/platformPersonalize.js`.
 * KEEP THEM IDENTICAL.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Separate from `smsPersonalize.util.js` rather than an extension of it, because
 * the two vocabularies describe different people. A shop's campaign talks to a
 * CUSTOMER about their due at that shop; a broadcast talks to a SHOPKEEPER about
 * their own subscription. Merging them would put `{customer_name}` in the
 * operator's composer, where it has nothing behind it and renders as the word
 * "Customer" in a message addressed to a business owner.
 *
 * The mirroring rule is the one that already governs `smsPersonalize.util.js`:
 * the composer promises "this is what they will receive" and prices the send off
 * that promise, so a drift between the two files is a wrong preview AND a wrong
 * quote. Any edit here is an edit there, in the same commit.
 */

/**
 * Every placeholder the broadcast composer offers.
 *
 * The UI builds its insert buttons from this list. A button that inserts a token
 * this file does not substitute produces a literal `{brace}` in a message sent
 * to every shopkeeper on the platform.
 */
const PLATFORM_PLACEHOLDERS = [
  { token: '{name}', label: 'Recipient name', labelBn: 'প্রাপকের নাম' },
  { token: '{shop_name}', label: 'Shop name', labelBn: 'দোকানের নাম' },
  { token: '{days_left}', label: 'Days remaining', labelBn: 'বাকি দিন' },
  { token: '{expires_on}', label: 'Expiry date', labelBn: 'মেয়াদ শেষের তারিখ' },
  { token: '{sms_balance}', label: 'SMS balance', labelBn: 'এসএমএস ব্যালেন্স' },
  { token: '{monthly_price}', label: 'Monthly price', labelBn: 'মাসিক মূল্য' },
];

/**
 * Which tokens make a message per-recipient.
 *
 * All of them, here — unlike the shop-side list, where `{shop_name}` resolves
 * identically for every recipient and is deliberately excluded so a plain promo
 * still goes out as one cheap bulk call. On a broadcast the shop name IS the
 * thing that differs between recipients, so a message using it must be rendered
 * one at a time.
 */
const PLATFORM_PERSONALIZABLE_TOKENS = [
  '{name}',
  '{shop_name}',
  '{days_left}',
  '{expires_on}',
  '{sms_balance}',
  '{monthly_price}',
];

function isPlatformPersonalized(message) {
  const body = String(message || '');
  return PLATFORM_PERSONALIZABLE_TOKENS.some((token) => body.includes(token));
}

/**
 * Render one recipient's message.
 *
 * Unknown values render as a plain dash rather than as `0`, `null` or an
 * invented figure. A shopkeeper on an unlimited plan reading "your subscription
 * ends in 0 days" is worse than one reading "ends in -", and the operator sees
 * the dash in the preview before eight hundred people see it in their inbox.
 */
function personalizePlatformMessage(template, recipient = {}, senderName = '') {
  const value = (v) => (v === null || v === undefined || v === '' ? '-' : String(v));

  return String(template || '')
    .replace(/{name}/g, recipient.name || 'there')
    .replace(/{shop_name}/g, recipient.shopName || senderName || '-')
    .replace(/{days_left}/g, value(recipient.daysLeft))
    .replace(/{expires_on}/g, value(recipient.expiresOn))
    .replace(/{sms_balance}/g, value(recipient.smsBalance))
    .replace(/{monthly_price}/g, value(recipient.monthlyPrice));
}

module.exports = {
  PLATFORM_PLACEHOLDERS,
  PLATFORM_PERSONALIZABLE_TOKENS,
  isPlatformPersonalized,
  personalizePlatformMessage,
};
