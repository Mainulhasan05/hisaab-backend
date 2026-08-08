/**
 * Rendering helpers for Telegram messages.
 *
 * Messages are sent with parse_mode HTML rather than Markdown. Both are
 * supported by Telegram, but Markdown reserves eighteen characters and
 * MarkdownV2 rejects the whole message with a 400 if any of them appears
 * unescaped — and shop names, branch names and owner names here are free text
 * that regularly contains `-`, `.`, `(` and `!`. HTML reserves three.
 */

const { BENGALI_MONTHS } = require('./bengali.util');

/**
 * Escape the only three characters Telegram's HTML parser treats specially.
 *
 * Must be applied to every piece of user-controlled text — shop name, branch
 * name, owner name. Skipping it on one field is how a shop called "M&S" stops
 * receiving its digest with an unexplained 400.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Money in Bangladeshi grouping with Latin digits: ৳ 1,24,500.
 *
 * `en-IN` is used for the lakh/crore grouping (1,24,500 rather than 124,500),
 * which is how amounts are read here. Decimals appear only when there are any,
 * so a clean daily total stays clean.
 */
function formatMoney(amount) {
  const value = Number(amount) || 0;
  // Whole amounts print clean; fractional ones print both paisa digits, so a
  // total never reads as "৳ 1,24,500.5".
  const hasFraction = Math.abs(value % 1) > 0;
  const formatted = Math.abs(value).toLocaleString('en-IN', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `-৳ ${formatted}` : `৳ ${formatted}`;
}

/** Plain integer with the same grouping — invoice counts. */
function formatCount(value) {
  return (Number(value) || 0).toLocaleString('en-IN');
}

/** "YYYY-MM-DD" → "8 আগস্ট 2026" (Bengali month, Latin numerals). */
function formatDate(dateStr) {
  const [year, month, day] = String(dateStr || '').split('-').map(Number);
  if (!year || !month || !day) return String(dateStr || '');
  return `${day} ${BENGALI_MONTHS[month - 1]} ${year}`;
}

/**
 * "22:00" → "রাত 10:00".
 *
 * Bengali splits the day into six parts rather than am/pm, and "১০টা" alone is
 * ambiguous between morning and night. The period word is what makes the
 * "as of" line unambiguous.
 */
function formatTime(hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!match) return String(hhmm || '');
  const hours = Number(match[1]);
  const minutes = match[2];

  let period;
  if (hours >= 4 && hours < 6) period = 'ভোর';
  else if (hours >= 6 && hours < 12) period = 'সকাল';
  else if (hours >= 12 && hours < 15) period = 'দুপুর';
  else if (hours >= 15 && hours < 18) period = 'বিকাল';
  else if (hours >= 18 && hours < 20) period = 'সন্ধ্যা';
  else period = 'রাত';

  const hour12 = hours % 12 || 12;
  return `${period} ${hour12}:${minutes}`;
}

module.exports = {
  escapeHtml,
  formatMoney,
  formatCount,
  formatDate,
  formatTime,
};
