/**
 * বাকির সীমা — the ceiling on what one customer may owe.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `creditLimit` was named in `auditDiff.util.js`'s tracked-field list and in
 * `auditDiff.test.js` before any such field existed — a dangling reference to a
 * control nobody had built. Until it did, every staff member could extend
 * unlimited credit to anyone, and the owner learned about it at the aging
 * report: after the money was already out of the door.
 *
 * For a shop whose whole trade runs on বাকি, that was the most valuable control
 * the product was missing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SOFT, NOT HARD — AND WHY THAT IS THE STRONGER CONTROL
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A cashier who physically cannot complete a sale at 9pm, with the customer
 * standing there and the owner asleep, does not stop extending credit. They
 * stop RECORDING it — and an unrecorded sale is worse than an over-limit one in
 * every direction at once: the stock is wrong, the money is missing, and the
 * debt exists only in someone's memory.
 *
 * So the block is passable by anyone holding `customers.credit_override`, and
 * the control is not the refusal. It is that every pass writes an audit entry
 * naming who approved what, so "who let them run up ৳40,000" has an answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `0` IS NO LIMIT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The default for every customer already in the database, so no shop's checkout
 * changes until an owner sets a real figure. Absent, null, zero, negative and
 * malformed all read the same way — unlimited — because a limit that came out
 * of a cleared number input as `NaN` must not start refusing sales.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CHECKED SHOP-WIDE, EVEN UNDER SEPARATE BOOKS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Customer` is one document per human (I-4) and creditworthiness is a property
 * of the human, not of the till they walk up to. The projection below is built
 * from `Customer.totalDue`, the shop-wide rollup, and NOT from the branch book
 * the invoice's "পূর্বের বাকি" line prints.
 *
 * The two differ only for a shop keeping SEPARATE customer books, and there the
 * branch figure is the wrong one: a ৳10,000 limit checked per branch is a
 * ৳30,000 limit across three of them, which is the exact hole this exists to
 * close. The error message says "শাখা মিলিয়ে" so a cashier reading a smaller
 * number on the invoice is not left thinking the app is wrong.
 */
const { quantizeMoney } = require('./quantity.util');
const { AppError } = require('../middleware/error.middleware');
const { hasPermission } = require('../middleware/permission.middleware');

/**
 * The one refusal a cashier can legitimately answer by asking for approval, so
 * the POS keys its confirm-and-retry dialog on this rather than on the message.
 * Same convention as `branchScope.util`'s `BRANCH_REQUIRED`.
 */
const CREDIT_LIMIT_EXCEEDED = 'CREDIT_LIMIT_EXCEEDED';

/**
 * The customer's ceiling, or `0` for none.
 *
 * Bounded rather than trusted: a stored negative — which the schema's `min`
 * refuses but a pre-schema document could carry — must read as "no limit", not
 * as a ceiling every sale breaches.
 */
function limitFor(customer) {
  const raw = Number(customer?.creditLimit);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw;
}

/**
 * What this customer will owe, shop-wide, once this checkout lands.
 *
 * `totalDue − dueSettled + newDue`, floored at zero. The settlement term is
 * load-bearing: a customer at their ceiling who walks in and pays ৳5,000 off
 * before buying ৳3,000 more has gone DOWN, and refusing that sale would punish
 * exactly the behaviour the limit is trying to encourage.
 */
function projectedDue({ customer, dueSettled = 0, newDue = 0 }) {
  const current = Number(customer?.totalDue) || 0;
  return quantizeMoney(Math.max(0, current - (Number(dueSettled) || 0) + (Number(newDue) || 0)));
}

/**
 * Decide whether this checkout may proceed.
 *
 * Rules, in the order they are checked. The order is what makes "a walk-in is
 * never blocked" and "paying money off is never blocked" true without either
 * needing to be special-cased downstream:
 *
 *   1. no customer            -> null   (a walk-in has no খাতা to over-draw)
 *   2. no limit set           -> null   (every shop, until an owner sets one)
 *   3. projection within it   -> null   (the ordinary case, including sales
 *                                        that REDUCE the balance)
 *   4. over, no override      -> 400    (the block)
 *   5. over, override, no perm-> 403    (asking is not the same as being able)
 *   6. over, override, perm   -> a record for the caller to audit
 *
 * @returns {null|{limit, previousDue, projectedDue, exceededBy, customerName}}
 *   `null` when there was nothing to decide. An object ONLY on an approved
 *   override — the caller must write that to the audit log, which is the whole
 *   control (see the header).
 */
function assertWithinCreditLimit({ customer, dueSettled = 0, newDue = 0, override = false }, req = null) {
  // 1 & 2.
  if (!customer) return null;
  const limit = limitFor(customer);
  if (limit === 0) return null;

  // 3.
  const projected = projectedDue({ customer, dueSettled, newDue });
  if (projected <= limit) return null;

  const exceededBy = quantizeMoney(projected - limit);
  const previousDue = quantizeMoney(Number(customer.totalDue) || 0);

  // 4. The block. Named figures, because "limit exceeded" tells a cashier
  // nothing they can act on — they need to know how much to collect first.
  if (!override) {
    const err = new AppError(
      `Credit limit exceeded for ${customer.name || customer.phone || 'customer'}: ` +
      `limit ৳${limit}, this sale would take the balance to ৳${projected}.`,
      `${customer.name || 'কাস্টমার'} এর বাকির সীমা ৳${limit} (শাখা মিলিয়ে)। ` +
      `এই বিক্রয়ের পর বাকি হবে ৳${projected} — ৳${exceededBy} বেশি। ` +
      `আগে টাকা জমা নিন, অথবা মালিকের অনুমতি নিন।`,
      400
    );
    /**
     * A machine-readable code, following `branchScope.util`'s `BRANCH_REQUIRED`
     * convention — `error.middleware` copies `err.code` onto the response.
     *
     * The POS needs this rather than matching on the message: it is the ONE
     * refusal a cashier can legitimately answer by asking for approval, so the
     * client shows a confirm-and-retry dialog for it and a plain red toast for
     * every other 400. Matching Bengali prose to decide that would break the
     * first time anyone reworded the sentence.
     */
    err.code = CREDIT_LIMIT_EXCEEDED;
    // No structured payload alongside it, deliberately. `passthroughFields` in
    // error.middleware carries `code`, `phone` and `branch` and nothing else,
    // and widening that contract for one dialog is not worth it when
    // `messageBn` above already names the ceiling, the resulting balance and
    // the overage in the sentence the cashier has to read anyway.
    throw err;
  }

  // 5. `hasPermission` already answers true for the owner and for the platform
  // admin acting inside the shop, so neither needs an arm of its own here.
  // `req` absent is a script or an internal call with no cashier to distrust —
  // `reviseSale` re-runs a checkout that was already approved once, and
  // re-refusing it would make an over-limit sale uncorrectable.
  if (req && !hasPermission(req, 'customers', 'credit_override')) {
    throw new AppError(
      'You do not have permission to sell past a customer\'s credit limit',
      'বাকির সীমা অতিক্রম করার অনুমতি আপনার নেই',
      403
    );
  }

  // 6.
  return {
    limit,
    previousDue,
    projectedDue: projected,
    exceededBy,
    customerName: customer.name || customer.phone || '',
  };
}

/**
 * Validate and authorise a বাকির সীমা arriving on a customer create/update.
 *
 * The write-side twin of `assertWithinCreditLimit`, shaped exactly like
 * `pricing.util.resolveWholesaleFlag` — and used the same way, by DELETING the
 * key from the update object and re-adding the resolved value. Leaving the raw
 * value in place and merely validating it would still let it through the
 * `Object.assign` at the end of `updateCustomer`, which is the trap that
 * comment already describes.
 *
 * ── Gated on `customers.credit_override`, not on owner-only ───────────────
 *
 * `openingDue` and `isWholesale` are owner-only, and this deliberately is not.
 * The reason there is no escalation in that: anyone holding `credit_override`
 * can already sell straight past any ceiling, so being able to raise the
 * ceiling grants them nothing they did not have. One gate for "may this person
 * decide how much credit a customer gets" is simpler than two, and simpler is
 * what stops the second one being forgotten.
 *
 * `hasPermission` already answers true for the owner and for the platform admin
 * acting inside the shop, so neither needs an arm of its own.
 *
 * @returns {number|undefined} `undefined` when nothing was asked for — which is
 *   every ordinary customer edit, and what keeps this inert.
 */
function resolveCreditLimit(raw, req) {
  if (raw === undefined || raw === null || raw === '') return undefined;

  const next = Number(raw);
  if (!Number.isFinite(next) || next < 0) {
    throw new AppError(
      'Credit limit must be a non-negative number',
      'বাকির সীমা সঠিক সংখ্যা হতে হবে',
      400
    );
  }

  // `req` absent = a script, a seeder, or an import with no cashier to
  // distrust. Same carve-out `resolveWholesaleFlag` makes, for the same reason.
  if (req && !hasPermission(req, 'customers', 'credit_override')) {
    throw new AppError(
      'You do not have permission to set a customer\'s credit limit',
      'কাস্টমারের বাকির সীমা নির্ধারণ করার অনুমতি আপনার নেই',
      403
    );
  }

  return quantizeMoney(next);
}

module.exports = {
  CREDIT_LIMIT_EXCEEDED,
  limitFor,
  projectedDue,
  assertWithinCreditLimit,
  resolveCreditLimit,
};
