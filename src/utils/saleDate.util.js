/**
 * Backdated sales — one date, decided once, for one invoice.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Shops do not always ring a sale up at the moment it happens. Goods go out on
 * a Thursday, the owner enters them on Saturday, and the invoice has to say
 * Thursday — otherwise the customer's copy disagrees with the shop's book, and
 * the day's takings are attributed to a day the money did not move.
 *
 *     resolveSaleDate({ raw, req, shop }) -> Date | null
 *
 * `null` means "no backdating asked for", which is what every ordinary checkout
 * on the platform sends.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SALE MOVES WHOLESALE. THAT IS THE DECISION, AND IT HAS A COST.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The returned Date becomes the sale's `createdAt`, and everything downstream
 * keys off `createdAt`: the day and month reports, the staff report and its day
 * series, the cash-register drawer, the customer's ledger position, the stock
 * transactions, and the `INV-<branch>-<YYYYMMDD>-####` number itself. So a sale
 * backdated to Thursday IS a Thursday sale, everywhere, with no second date to
 * keep in step.
 *
 * The alternative — a separate `saleDate` for business purposes with `createdAt`
 * left as the true entry time — is the more honest accounting model, and it was
 * deliberately NOT chosen: it requires every aggregation in `report.service` and
 * `staffReport.service` to move off `createdAt` at once, and a single one missed
 * reports a figure that disagrees with the invoice beside it.
 *
 * What that costs, and what is done about it:
 *
 *   -  **A day you already closed changes.** Thursday's total was ৳40,000 when
 *      you read it on Friday; after a Saturday backdate it is ৳45,000. This is
 *      inherent to the choice and cannot be designed away.
 *   -  **The real entry time would otherwise be lost.** It is not: `createSale`
 *      writes an audit entry carrying both the backdated instant and the true
 *      wall-clock moment the invoice was typed, so "when was this actually
 *      entered" is always answerable even though the Sale itself no longer says.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHO MAY DO IT — `sales.backdate`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Moving a sale between days moves money between reporting periods, between
 * staff members' figures and between cash drawers. Someone who can do it can
 * also paper over a discrepancy in yesterday's till, so it is not implied by
 * `sales.create` — it is a permission of its own that an owner can revoke from
 * one role without also stopping them selling.
 *
 * It shipped owner-only and was widened the same day, because the shops were
 * right: goods leave before anyone reaches the till, and the cashier who sold
 * them is the one who knows which day it was. The counter presets carry it
 * (PRESET_UPGRADES v5); salesperson and inventory_manager do not.
 *
 * What bounds it now that it is not the owner's alone:
 *   -  it can never reach the future, or a date before the shop existed;
 *   -  EVERY use writes a `sale_create` audit entry carrying both the date
 *      claimed and the wall-clock moment the invoice was really typed, so a
 *      sale moved out of its day is always reconstructable.
 */
const { toBangladeshDateStr, getBangladeshDayRange } = require('./bdTime.util');
const { hasPermission } = require('../middleware/permission.middleware');
const { assertPeriodOpen } = require('./periodLock.util');

/** A minute of tolerance for a client clock that runs slightly fast. */
const FUTURE_SKEW_MS = 60 * 1000;

/**
 * Resolve the invoice date the client asked for.
 *
 * Rules, in the order they are checked — the order is why "not asked for" can
 * never 403:
 *
 *   1. no date named        -> null, no error, whoever is asking
 *   2. no `sales.backdate`  -> 403
 *   3. unparseable          -> 400
 *   4. in the future        -> 400 (this is BACKdating; a forward-dated invoice
 *                                   would be counted in a day that has not
 *                                   traded yet and would then be invisible in
 *                                   today's takings)
 *   5. before the shop opened -> 400 (catches the fat-fingered year, e.g. 1026
 *                                   or 2016, which would otherwise bury an
 *                                   invoice a decade deep in the reports)
 *   6. otherwise            -> the instant
 *
 * A bare "YYYY-MM-DD" is placed at **noon Bangladesh time** on that date. Not
 * midnight: midnight BD sits exactly on the boundary `getBangladeshDayRange`
 * uses, and any rounding at all puts the sale in the wrong day — the one thing
 * this feature must never do. Noon is unambiguous under every rounding, and it
 * reads sensibly on a receipt that has to print a time.
 *
 * A full ISO datetime is honoured as given, so an owner who knows the sale was
 * at 7pm can say so.
 *
 * @param {Object}  input
 * @param {*}       input.raw   the client's `saleDate`
 * @param {Object} [input.req]  the Express request (the permission check)
 * @param {Object} [input.shop] the Shop document (its `createdAt` is the floor)
 * @returns {Date|null}
 * @throws {AppError} 403 without the permission, 400 malformed or out of bounds
 */
function resolveSaleDate({ raw, req = null, shop = null } = {}) {
  // Required lazily: `error.middleware` pulls in the logger, which pulls in
  // config — importing it at module scope makes this util unusable from the
  // scripts and seeders that have no app context. Same reason `pricing.util`
  // does it.
  const { AppError } = require('../middleware/error.middleware');

  // 1. Nothing asked for. Not a violation — this is every ordinary checkout.
  if (raw === undefined || raw === null || raw === '') return null;

  // 2. Moving money between days is a permission of its own.
  //
  //    `req` absent = a script, a seeder or an internal call with nobody to
  //    distrust, and it passes — the same carve-out `resolveLineRate` makes at
  //    its own rule 3. `hasPermission` already answers true for the owner and
  //    for the platform admin (who carries no `user.isOwner` — the M-7 trap),
  //    so neither needs an arm of its own here.
  if (req && !hasPermission(req, 'sales', 'backdate')) {
    throw new AppError(
      'You do not have permission to set an invoice date',
      'আপনার আগের তারিখে বিক্রি করার অনুমতি নেই',
      403
    );
  }

  // 3. Parse. A bare date is a Bangladesh calendar date, never a UTC instant —
  //    `new Date('2026-08-10')` is UTC midnight, which is 06:00 Dhaka, so a
  //    naive parse would be right by luck and wrong at the edges.
  let when;
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    const { startOfDay } = getBangladeshDayRange(raw.trim());
    when = new Date(startOfDay.getTime() + 12 * 60 * 60 * 1000); // noon BD
  } else {
    when = raw instanceof Date ? raw : new Date(raw);
  }

  if (!(when instanceof Date) || Number.isNaN(when.getTime())) {
    throw new AppError(
      'Invalid invoice date',
      'বিক্রির তারিখ ঠিকভাবে দিন',
      400
    );
  }

  // 4. The future is not a thing that has been sold yet.
  if (when.getTime() > Date.now() + FUTURE_SKEW_MS) {
    throw new AppError(
      'Invoice date cannot be in the future',
      'বিক্রির তারিখ ভবিষ্যতের হতে পারবে না',
      400
    );
  }

  // 5. A sale cannot predate the shop. This is the typo guard — it is not a
  //    policy window, and there deliberately is none: an owner entering last
  //    year's books is doing something legitimate.
  const floor = shop?.createdAt ? new Date(shop.createdAt) : null;
  if (floor && !Number.isNaN(floor.getTime()) && when.getTime() < floor.getTime()) {
    throw new AppError(
      'Invoice date is before this shop existed',
      `দোকান খোলার (${toBangladeshDateStr(floor)}) আগের তারিখ দেওয়া যাবে না`,
      400
    );
  }

  // 6. The owner has signed off on everything up to a date, and this would land
  //    inside it.
  //
  //    NOT the policy window rule 5 rejects — that comment stands, and there is
  //    still no rolling limit on how far back a date may reach. This is an
  //    explicit line the owner draws after they are done with a period, and the
  //    way past it is to move the line in settings, not to write behind it. See
  //    utils/periodLock.util.js.
  assertPeriodOpen({ when, shop, label: 'invoice', labelBn: 'বিক্রয়' });

  return when;
}

module.exports = { resolveSaleDate };
