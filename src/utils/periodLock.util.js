/**
 * খাতা বন্ধ — the period lock.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PROTECTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Backdating in this codebase is deliberate and honest: a sale backdated to
 * Thursday IS a Thursday sale, everywhere, with no second date to disagree with
 * the first. `utils/saleDate.util.js` argues that model at length and it is the
 * right one.
 *
 * What it was not, was BOUNDED. Anyone holding `sales.backdate` or
 * `customers.backdate` could post into any prior month or year, and the same
 * header names the consequence:
 *
 *     "you read it on Friday; after a Saturday backdate it is ৳45,000."
 *
 * The owner has no way to notice. There is no diff, no alert; the report simply
 * reads differently the next time they open it. For a product whose entire
 * proposition is a number a shopkeeper trusts, that is the fastest available
 * way to lose the trust.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS NOT A ROLLING WINDOW
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `saleDate.util` rule 5 says, correctly, that there is deliberately no policy
 * window on how far back a date may reach — "an owner entering last year's
 * books is doing something legitimate". That still stands, and this does not
 * contradict it.
 *
 * A window moves on its own and refuses work nobody objected to. This is a line
 * the OWNER draws, once, after they are finished with a period. The shop
 * entering last year's books leaves it unset until they are done, then closes
 * the year in one move. Unset — `null` — is the default and the state of every
 * shop on the platform until someone chooses otherwise.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BOUNDARY IS THE END OF THE BANGLADESH DAY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Closing "31 July" must close ALL of 31 July. Comparing against the stored
 * instant would let anything after midnight through — and since a bare
 * `YYYY-MM-DD` is stored at noon BD by `resolveSaleDate`, half the closed day
 * would stay open. That is a taka-level bug that would only ever show up as an
 * unexplained figure months later, so the comparison lives HERE and nowhere
 * else: no caller gets to make it themselves.
 */
const { toBangladeshDateStr, getBangladeshDayRange } = require('./bdTime.util');

/**
 * The instant after which writing is allowed, or `null` when nothing is closed.
 *
 * Anything unparseable reads as `null` — OPEN. A malformed lock that refused
 * every write would take a shop's till offline with no way for them to
 * self-diagnose, which is a worse failure than the one being prevented.
 */
function closedThrough(shop) {
  const raw = shop?.settings?.booksClosedThrough;
  if (!raw) return null;

  const when = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(when.getTime())) return null;

  // End of that Bangladesh calendar day — see the header.
  const { endOfDay } = getBangladeshDayRange(toBangladeshDateStr(when));
  return endOfDay;
}

/**
 * Refuse a write that would land in a closed period.
 *
 * Rules, in order. As with the two backdate utils, the ORDER is what keeps
 * "nothing asked for" from ever being an error:
 *
 *   1. no date to judge  -> pass (an undated write is today's, by definition)
 *   2. nothing closed    -> pass (every shop, until an owner draws the line)
 *   3. after the line    -> pass (the ordinary case once a line exists)
 *   4. on or before it   -> 400
 *
 * ── Not permission-gated, deliberately ─────────────────────────────────────
 *
 * There is no "close override". The owner is not exempt either, and that is the
 * point: a lock its holder can step over on the spot is a reminder, not a lock.
 * The way past it is to MOVE the line — a settings change, owner-only, audited,
 * and visible afterwards — rather than to quietly write behind it.
 *
 * @param {Object}  input
 * @param {Date}   [input.when]   the business date the write would land on
 * @param {Object} [input.shop]   the Shop document (carries the setting)
 * @param {string}  input.label   English noun for the thing being written
 * @param {string}  input.labelBn Bengali noun for the same
 * @throws {AppError} 400 when the date falls inside a closed period
 */
function assertPeriodOpen({ when, shop, label = 'entry', labelBn = 'এন্ট্রি' } = {}) {
  // Lazy, like `saleDate.util` — `error.middleware` pulls in the logger and
  // then config, and importing that at module scope makes this util unusable
  // from the scripts and seeders that have no app context.
  const { AppError } = require('../middleware/error.middleware');

  // 1.
  if (!when) return;
  const at = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(at.getTime())) return; // malformed dates are someone else's 400

  // 2.
  const line = closedThrough(shop);
  if (!line) return;

  // 3 & 4.
  if (at.getTime() > line.getTime()) return;

  const lineStr = toBangladeshDateStr(line);
  throw new AppError(
    `The books are closed through ${lineStr}. This ${label} cannot be dated on or before it.`,
    `${lineStr} পর্যন্ত খাতা বন্ধ করা হয়েছে — ওই তারিখ বা তার আগের ${labelBn} দেওয়া যাবে না। ` +
    `প্রয়োজন হলে মালিক সেটিংস থেকে খাতা বন্ধের তারিখ পরিবর্তন করতে পারবেন।`,
    400
  );
}

module.exports = {
  closedThrough,
  assertPeriodOpen,
};
