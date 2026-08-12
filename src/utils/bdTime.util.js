/**
 * Bangladesh local time helpers.
 *
 * The server clock is UTC but every date a user types, every "today" on a
 * report and every scheduled digest is Bangladesh local time (UTC+6, no DST).
 * These four functions are the single definition of that conversion —
 * report.service.js imports them rather than keeping its own copies, so a
 * report's idea of "today" and the digest job's idea of "today" can never
 * drift apart.
 */

// Bangladesh is UTC+6 year-round. No daylight saving, so a fixed offset is
// correct here in a way it would not be for most timezones.
const BD_OFFSET_MS = 6 * 60 * 60 * 1000;

/** Current date in Bangladesh as "YYYY-MM-DD". */
function getBangladeshTodayStr() {
  const bdNow = new Date(Date.now() + BD_OFFSET_MS);
  return bdNow.toISOString().split('T')[0];
}

/** Convert a Bangladesh date string ("YYYY-MM-DD") to UTC start/end instants. */
function getBangladeshDayRange(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  // Bangladesh midnight = UTC midnight minus 6 hours (BD is UTC+6)
  const startOfDay = new Date(Date.UTC(year, month - 1, day) - BD_OFFSET_MS);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { startOfDay, endOfDay };
}

/**
 * Current Bangladesh wall-clock time as "HH:MM" (24h).
 *
 * Compared as a string against the owner's configured digest time, which is
 * stored in the same format. String comparison is deliberate: it sidesteps
 * every off-by-one that arises from doing minute arithmetic across a date
 * boundary.
 */
function getBangladeshTimeStr() {
  const bdNow = new Date(Date.now() + BD_OFFSET_MS);
  return bdNow.toISOString().slice(11, 16);
}

/**
 * Minutes since Bangladesh midnight for an "HH:MM" string, or null if the
 * string is malformed. Used to measure how far past a scheduled time we are.
 */
function minutesOfDay(hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** The Bangladesh calendar date of an instant, as "YYYY-MM-DD". */
function toBangladeshDateStr(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + BD_OFFSET_MS).toISOString().split('T')[0];
}

/**
 * The last instant of a Bangladesh calendar day — 23:59:59.999 (+06).
 *
 * Every "paid through" date in billing goes through here. A date picker sends
 * "2026-08-31", which `new Date()` reads as UTC midnight = 06:00 Dhaka, so a
 * shop paid through the 31st would have gone read-only mid-morning ON the 31st.
 * Storing the end of the day instead means the date the operator typed is the
 * last date the shop can trade, which is what both sides of the conversation
 * meant.
 *
 * Accepts "YYYY-MM-DD", a Date, or anything Date can parse; a bare date string
 * is read as a Bangladesh date, not a UTC one.
 */
function endOfBangladeshDay(dateLike) {
  const dateStr =
    typeof dateLike === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateLike)
      ? dateLike
      : toBangladeshDateStr(dateLike);
  if (!dateStr) return null;
  return getBangladeshDayRange(dateStr).endOfDay;
}

/**
 * Whole Bangladesh calendar days from `from` to `to`. Positive = `to` is in the
 * future. Same-day = 0.
 *
 * Calendar days, deliberately, not 24h blocks: "expires tomorrow" has to mean
 * tomorrow's date. A subtraction of timestamps would call 23:00 tonight →
 * 01:00 tomorrow "0 days" and tell an owner their shop expires today.
 */
function bangladeshDaysBetween(from, to) {
  const a = toBangladeshDateStr(from);
  const b = toBangladeshDateStr(to);
  if (!a || !b) return null;
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / dayMs);
}

/**
 * `days` Bangladesh calendar days after `from`, at the end of that day.
 * `addBangladeshDays(now, 14)` is "the trial runs through the 14th day".
 */
function addBangladeshDays(from, days) {
  const base = toBangladeshDateStr(from);
  if (!base) return null;
  const shifted = new Date(Date.parse(`${base}T00:00:00Z`) + days * 24 * 60 * 60 * 1000);
  return endOfBangladeshDay(shifted.toISOString().split('T')[0]);
}

module.exports = {
  BD_OFFSET_MS,
  getBangladeshTodayStr,
  getBangladeshDayRange,
  getBangladeshTimeStr,
  minutesOfDay,
  toBangladeshDateStr,
  endOfBangladeshDay,
  bangladeshDaysBetween,
  addBangladeshDays,
};
