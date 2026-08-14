/**
 * Recipient list hygiene for bulk SMS.
 *
 * A campaign assembled from a shop's customer book is not a clean list. Real
 * books contain landlines typed into a mobile field, numbers saved twice under
 * a nickname and a full name, blank phone fields on walk-in customers, and the
 * same household reached through two entries. Sent as-is, every one of those
 * costs the shopkeeper a segment and returns nothing:
 *
 *   - an unusable number is billed by the gateway and rejected downstream;
 *   - a duplicate texts the same person twice and reads as spam;
 *   - a blank aborts the whole batch it happens to land in.
 *
 * So the list is cleaned BEFORE the quota is reserved, and what was dropped is
 * reported back rather than silently discarded — "৩৪২ জনকে পাঠানো হয়েছে, ৮টি
 * নম্বর বাদ" is an answer; "৩৫০ জনকে পাঠানো হয়েছে" when eight never arrived is
 * not.
 *
 * Dedup keys on the FORMATTED number, not the stored one: `01712345678` and
 * `+8801712345678` are two spellings of one phone and must collapse to one
 * send. The first spelling wins so the customer name shown in the log is the
 * one the shopkeeper saw when they picked the audience.
 */

const { formatPhone, isValidPhone } = require('./phone.util');

const SKIP_REASONS = {
  MISSING: 'no_phone',
  INVALID: 'invalid_phone',
  DUPLICATE: 'duplicate_phone',
  EMPTY_MESSAGE: 'empty_message',
};

/** How many dropped entries we keep on the log document. */
const MAX_SKIPPED_STORED = 50;

/**
 * Clean a recipient list.
 *
 * @param {Array<{phone: string, customerId?: any, customerName?: string, message?: string}>} recipients
 * @param {{ requireMessage?: boolean }} [options]
 *        `requireMessage` is set for personalised (dynamic) campaigns, where a
 *        recipient with no body of their own has nothing to send.
 * @returns {{
 *   valid: Array<{phone: string, customerId: any, customerName: string, message?: string}>,
 *   skipped: Array<{phone: string, customerName: string, reason: string}>,
 *   skippedCount: number
 * }}
 */
function normalizeRecipients(recipients = [], options = {}) {
  const { requireMessage = false } = options;

  const valid = [];
  const skipped = [];
  const seen = new Set();

  for (const raw of recipients) {
    if (!raw) continue;

    const customerName = raw.customerName || '';
    const rawPhone = raw.phone;

    if (!rawPhone || !String(rawPhone).trim()) {
      skipped.push({ phone: '', customerName, reason: SKIP_REASONS.MISSING });
      continue;
    }

    if (!isValidPhone(rawPhone)) {
      skipped.push({ phone: String(rawPhone), customerName, reason: SKIP_REASONS.INVALID });
      continue;
    }

    const phone = formatPhone(rawPhone);

    if (seen.has(phone)) {
      skipped.push({ phone, customerName, reason: SKIP_REASONS.DUPLICATE });
      continue;
    }

    if (requireMessage && !String(raw.message || '').trim()) {
      skipped.push({ phone, customerName, reason: SKIP_REASONS.EMPTY_MESSAGE });
      continue;
    }

    seen.add(phone);

    const entry = {
      phone,
      customerId: raw.customerId || raw.customer || null,
      customerName,
    };
    if (raw.message !== undefined) entry.message = raw.message;

    valid.push(entry);
  }

  return { valid, skipped, skippedCount: skipped.length };
}

/**
 * Split a list into fixed-size batches.
 *
 * Bulk sending is chunked because MimSMS takes recipients as one
 * comma-delimited string: five thousand numbers is a ~70KB field in a single
 * request, against a gateway that answers in seconds under load and behind a
 * 10s client timeout. One oversized call is all-or-nothing — it either
 * succeeds entirely or fails entirely, and a timeout leaves the shop unable to
 * tell which. Batches of a hundred fail in units of a hundred, and the other
 * thirty-nine hundred still go out.
 */
function chunk(items, size) {
  const batchSize = Math.max(1, size);
  const batches = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

module.exports = {
  normalizeRecipients,
  chunk,
  SKIP_REASONS,
  MAX_SKIPPED_STORED,
};
