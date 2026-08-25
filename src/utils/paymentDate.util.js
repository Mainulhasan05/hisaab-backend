/**
 * When a payment actually happened, as opposed to when it was typed in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every other money row in this app already separates the two. `Expense.date`
 * and `Purchase.date` are backdatable, and the cash register, the P&L and the
 * daily summary all read THAT field rather than `createdAt` — so a shopkeeper
 * entering Tuesday's bazaar bill on Thursday gets it booked on Tuesday.
 *
 * `Payment` was the one exception. A বাকি আদায় could only ever be dated the
 * moment it was saved, which is wrong for the most common way small shops
 * actually work: the customer pays at the shop, and the entry gets made when
 * someone next sits down with the phone. Two days later the collection lands on
 * the wrong day in every report, and the day it really belonged to reads short.
 *
 * `paidAt` is that field. `createdAt` stays exactly what it always was — when
 * the row was written — so the audit trail still says who typed what and when.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY EVERY READER GOES THROUGH HERE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `paidAt` carries a schema default, so every row written from now on has one.
 * Rows written BEFORE the field existed do not, and there are a lot of them —
 * so a reader that filters on `paidAt` alone would make every historical
 * payment vanish from every date-ranged report, silently, the moment this
 * deploys. `scripts/backfill-payment-paid-at.js` stamps them, but a backfill
 * that has not been run yet must not be able to lose data.
 *
 * So the matcher below covers both shapes, and it does it with `$or` over two
 * plain field predicates rather than an `$expr` on `$ifNull` — `$expr` cannot
 * use an index, and these run inside the cash register's close path where a
 * collection scan over every payment a shop has ever taken is not acceptable.
 * (`{ paidAt: null }` matches missing AND null in MongoDB, which is what makes
 * the legacy branch a single predicate.)
 *
 * Use `paidAtMatch` in `$match` / `find`, and `PAID_AT_EXPR` anywhere an
 * aggregation needs the value itself — `$addFields`, `$group` keys, `$sort`.
 */
const {
  endOfBangladeshDay,
  getBangladeshTodayStr,
  getBangladeshDayRange,
  toBangladeshDateStr,
} = require('./bdTime.util');

/**
 * The effective date of a payment, for use inside an aggregation expression.
 * Legacy rows fall back to when they were written, which for them IS the day
 * the money moved — nothing could backdate them.
 */
const PAID_AT_EXPR = { $ifNull: ['$paidAt', '$createdAt'] };

/**
 * A date-range predicate that matches on the effective date.
 *
 * @param {object|null|undefined} range  a Mongo range object, e.g.
 *                                       `{ $gte: start, $lte: end }`. Falsy
 *                                       returns `{}` so callers can spread it
 *                                       unconditionally.
 * @returns {object} spread into a `$match` / `find` filter
 */
function paidAtMatch(range) {
  if (!range) return {};
  return { $or: [{ paidAt: range }, { paidAt: null, createdAt: range }] };
}

/**
 * Resolve the date a collection is to be booked on.
 *
 * The sibling of `saleDate.util.resolveSaleDate`, and deliberately shaped like
 * it — same order of checks, same reasons, same noon-Bangladesh placement.
 * Read that file's header for the long form of the argument; what follows is
 * only where this one differs.
 *
 * Rules, in the order they are checked. The order is what makes "no backdating
 * asked for" incapable of 403-ing:
 *
 *   1. no date named          -> now. Every internal caller, every script.
 *   2. today's date named     -> now. The date picker always posts something,
 *                                and posting today is not backdating — gating
 *                                it would 403 every cashier taking a payment.
 *                                Also keeps the TIME real: a bare 'YYYY-MM-DD'
 *                                placed at noon would stamp 12:00 on a
 *                                collection taken at 8pm, and the customer's
 *                                payment list prints the time.
 *   3. no `customers.backdate`-> 403
 *   4. unparseable            -> 400
 *   5. in the future          -> 400
 *   6. before the shop opened -> 400 (the fat-fingered year)
 *   7. otherwise              -> the instant, at noon BD for a bare date
 *
 * ── Why the future is refused ────────────────────────────────────────────────
 *
 * Money that has not been handed over is not a payment, and a row dated forward
 * is invisible in every report until that day arrives — the collection looks
 * lost. One typed year is all it takes.
 *
 * ── Why the past is bounded only by the shop's own age ───────────────────────
 *
 * A shop catching up on three months of খাতা entries is exactly who this is
 * for, so there is no policy window. The shop's `createdAt` is a typo guard,
 * not a policy: it catches 1026 and 2016 without refusing honest data.
 *
 * @param {Object}  input
 * @param {*}       input.raw    the client's `paidAt` / `date`
 * @param {Object} [input.req]   the Express request (permission + shop)
 * @param {Object} [input.shop]  the Shop document; falls back to `req.shop`
 * @param {string} [input.label] Bangla noun for the error messages
 * @returns {Date}
 * @throws {AppError} 403 without the permission, 400 malformed or out of bounds
 */
function resolvePaidAt({ raw, req = null, shop = null, label = 'আদায়ের তারিখ' } = {}) {
  // Required lazily for the reason `saleDate.util` documents: `error.middleware`
  // drags in the logger and config, and this util has to stay usable from
  // scripts and seeders that have no app context.
  const { AppError } = require('../middleware/error.middleware');
  const { hasPermission } = require('../middleware/permission.middleware');

  // 1. Nothing asked for.
  if (raw === undefined || raw === null || raw === '') return new Date();

  const bare = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())
    ? raw.trim()
    : null;

  // 2. Today is not a backdate.
  if (bare && bare === getBangladeshTodayStr()) return new Date();

  // 3. Moving money between days is a permission of its own — it moves the
  //    figure between report periods and between cash drawers, so someone who
  //    can do it can also paper over yesterday's till. `req` absent means an
  //    internal caller with nobody to distrust, the same carve-out
  //    `resolveSaleDate` makes.
  if (req && !hasPermission(req, 'customers', 'backdate')) {
    throw new AppError(
      'You do not have permission to backdate a collection',
      'আপনার আগের তারিখে আদায় করার অনুমতি নেই',
      403
    );
  }

  // 4. Parse. Noon Bangladesh time for a bare date, never UTC midnight: midnight
  //    BD sits exactly on the boundary `getBangladeshDayRange` uses, and any
  //    rounding at all files the collection into the neighbouring day — the one
  //    thing this feature must never do.
  const when = bare
    ? new Date(getBangladeshDayRange(bare).startOfDay.getTime() + 12 * 60 * 60 * 1000)
    : (raw instanceof Date ? raw : new Date(raw));

  if (!(when instanceof Date) || Number.isNaN(when.getTime())) {
    throw new AppError('Invalid payment date', `${label} ঠিকভাবে দিন`, 400);
  }

  // 5. The ceiling is the end of the Bangladesh day, not `Date.now()`, so a
  //    client whose clock runs a little fast can still record today.
  const latest = endOfBangladeshDay(getBangladeshTodayStr());
  if (when.getTime() > latest.getTime()) {
    throw new AppError(
      'Payment date cannot be in the future',
      `${label} আজকের পরের হতে পারবে না`,
      400
    );
  }

  // 6. A payment cannot predate the shop.
  const shopDoc = shop || req?.shop || null;
  const floor = shopDoc?.createdAt ? new Date(shopDoc.createdAt) : null;
  if (floor && !Number.isNaN(floor.getTime()) && when.getTime() < floor.getTime()) {
    throw new AppError(
      'Payment date is before this shop existed',
      `দোকান খোলার (${toBangladeshDateStr(floor)}) আগের তারিখ দেওয়া যাবে না`,
      400
    );
  }

  return when;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * "MONEY THAT ACTUALLY COUNTS"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Spread this into the `$match` or filter of EVERY Payment read that sums,
 * counts or lists money. A cancelled row is a collection that should never have
 * been taken — the customer's খাতা has been put back, the fund account has
 * given the money up, and any reader that still counts it is reporting cash the
 * shop does not have.
 *
 * ── Why `$ne` and never `status: 'active'` ───────────────────────────────────
 *
 * Every Payment written before the field existed carries no `status` at all.
 * `$ne: 'cancelled'` matches a missing field; `status: 'active'` does not — so
 * the equality version would silently report every shop's entire history as
 * zero, on every report, with no error anywhere. There is deliberately no
 * migration backfilling `active`: the absence of the field IS active, and a
 * predicate that depends on a migration having run is a predicate that will be
 * wrong on the day it does not.
 *
 * ── The two places that must NOT use this ────────────────────────────────────
 *
 * The customer's খতিয়ান and the রসিদ lookup, which have to SHOW a cancelled
 * row — struck through, marked বাতিল. "Not found" is indistinguishable from the
 * shop having lost the record, and the receipt number is already in the
 * customer's hand. Both opt out explicitly, in writing, at the call site.
 *
 * Lives here rather than in its own file because every one of those readers
 * already imports `paidAtMatch` from this module — the effective-date rule and
 * the is-it-real rule are asked together, every time.
 */
const LIVE_PAYMENT = Object.freeze({ status: { $ne: 'cancelled' } });

module.exports = {
  PAID_AT_EXPR,
  paidAtMatch,
  resolvePaidAt,
  LIVE_PAYMENT,
};
