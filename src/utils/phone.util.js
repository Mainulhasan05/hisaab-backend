/**
 * Phone Number Utility
 * Handles Bangladesh phone number formatting and validation
 */

/**
 * Format phone number to Bangladesh format (8801XXXXXXXXX)
 * MimSMS requires this format without + sign
 */
const formatPhone = (phone) => {
  if (!phone) return null;

  // Remove all non-digit characters
  let cleaned = phone.toString().replace(/\D/g, '');

  // Handle different input formats
  if (cleaned.startsWith('0')) {
    // Local format: 01712345678 -> 8801712345678
    cleaned = '88' + cleaned;
  } else if (cleaned.startsWith('88')) {
    // Already in correct format
  } else if (cleaned.startsWith('+88')) {
    // Remove + sign
    cleaned = cleaned.substring(1);
  } else if (cleaned.length === 10) {
    // Missing leading 0: 1712345678 -> 8801712345678
    cleaned = '880' + cleaned;
  } else if (cleaned.length === 11 && !cleaned.startsWith('0')) {
    // 11 digits without leading 0
    cleaned = '88' + cleaned;
  }

  return cleaned;
};

/**
 * Format phone for display (01712-345678)
 */
const formatPhoneDisplay = (phone) => {
  if (!phone) return '';

  let cleaned = phone.toString().replace(/\D/g, '');

  // Convert to local format first
  if (cleaned.startsWith('88')) {
    cleaned = cleaned.substring(2);
  }

  // Format as 01712-345678
  if (cleaned.length === 11) {
    return `${cleaned.substring(0, 5)}-${cleaned.substring(5)}`;
  }

  return cleaned;
};

/**
 * Validate Bangladesh phone number
 */
const isValidPhone = (phone) => {
  if (!phone) return false;

  const cleaned = phone.toString().replace(/\D/g, '');

  // Valid Bangladesh mobile prefixes
  const validPrefixes = [
    '013', '014', '015', '016', '017', '018', '019', // Local
    '8801', // International without +
  ];

  // Check length
  if (cleaned.length !== 11 && cleaned.length !== 13) {
    return false;
  }

  // Check prefix
  const hasValidPrefix = validPrefixes.some(prefix => {
    if (cleaned.length === 11) {
      return cleaned.startsWith(prefix.replace('880', '0'));
    }
    return cleaned.startsWith(prefix);
  });

  return hasValidPrefix;
};

/**
 * Extract local phone number (without country code)
 */
const getLocalPhone = (phone) => {
  if (!phone) return null;

  let cleaned = phone.toString().replace(/\D/g, '');

  if (cleaned.startsWith('88')) {
    cleaned = cleaned.substring(2);
  }

  if (!cleaned.startsWith('0')) {
    cleaned = '0' + cleaned;
  }

  return cleaned;
};

/**
 * Normalize phone for database storage (consistent format)
 */
const normalizePhone = (phone) => {
  if (!phone) return null;

  let cleaned = phone.toString().replace(/\D/g, '');

  // Store in local format without country code (01712345678)
  if (cleaned.startsWith('88')) {
    cleaned = cleaned.substring(2);
  }

  if (!cleaned.startsWith('0') && cleaned.length === 10) {
    cleaned = '0' + cleaned;
  }

  return cleaned;
};

/**
 * The EXTRA numbers a shop or branch prints on its invoices, cleaned up.
 *
 * ── WHY THESE ARE NOT PUT THROUGH `normalizePhone` ──────────────────────────
 *
 * `normalizePhone` exists to make a number DIALLABLE and comparable — it strips
 * every non-digit so `01712-345678` and `+8801712345678` become one key. That
 * is exactly right for a customer's number, which the app rings and sends SMS
 * to and deduplicates on.
 *
 * These are not that. They are the numbers printed under the shop name at the
 * top of an invoice, and the only thing that happens to them is that a customer
 * reads them. Many are landlines (`0781-52345`), and some shops write two on
 * one line the way they always have. Stripping the separators would reformat
 * the shop's own stationery on their behalf, and coercing a 9-digit landline
 * through the mobile rules would corrupt it outright. So the shop's typing is
 * kept, and only the things that would break a layout are removed.
 *
 * `phone` — the shop's ONE canonical number — is untouched by this and stays
 * where it was. It is what the storefront's WhatsApp link, the billing record
 * and the admin console read, and none of them can take a list.
 *
 * @param {unknown} value  an array from the client, or a single string
 * @returns {string[]} trimmed, de-duplicated, and capped in both directions
 */
const MAX_INVOICE_PHONES = 4;
const MAX_INVOICE_PHONE_LENGTH = 32;

const normalizeInvoicePhones = (value) => {
  const list = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);

  const out = [];
  // Compared on digits alone, so "01712-345678" and "01712345678" are one
  // number and the invoice does not print the same line twice.
  const seen = new Set();

  for (const entry of list) {
    if (typeof entry !== 'string' && typeof entry !== 'number') continue;

    const cleaned = String(entry).replace(/\s+/g, ' ').trim().slice(0, MAX_INVOICE_PHONE_LENGTH);
    if (!cleaned) continue;

    const key = cleaned.replace(/\D/g, '');
    // An entry with no digits at all is not a phone number; it is a stray
    // keystroke, and it would print as one.
    if (!key || seen.has(key)) continue;

    seen.add(key);
    out.push(cleaned);
    if (out.length >= MAX_INVOICE_PHONES) break;
  }

  return out;
};

module.exports = {
  MAX_INVOICE_PHONES,
  MAX_INVOICE_PHONE_LENGTH,
  normalizeInvoicePhones,
  formatPhone,
  formatPhoneDisplay,
  isValidPhone,
  getLocalPhone,
  normalizePhone
};
