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

module.exports = {
  BD_OFFSET_MS,
  getBangladeshTodayStr,
  getBangladeshDayRange,
  getBangladeshTimeStr,
  minutesOfDay,
};
