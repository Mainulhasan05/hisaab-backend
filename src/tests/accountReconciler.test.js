/**
 * `recalc-account-balances.js` — the fund accounts' only second opinion.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PINS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The script bounded every source document by the account's `openingDate`, on
 * the reasoning that anything earlier is already inside the opening figure the
 * owner typed in. True for history that predates the account — and false for
 * anything RECORDED after the account was created and dated before it, because
 * `applyAccountDelta` really did move `balance` when that row was written.
 *
 * It was wrong in one direction only: the balance moved, the rebuild did not
 * replay it. Two shapes reached it, and neither is exotic:
 *
 *   · a বাকি আদায় backdated a day (`paidAt` has been backdatable since
 *     2026-08-18) and entered today;
 *   · a purchase or expense dated TODAY, entered a few hours after the account
 *     was created — `Purchase.date` and `Expense.date` are midnight-anchored
 *     while `openingDate` is a precise timestamp, so an account created at
 *     04:23 dropped every same-day bill entered after it. That is the account's
 *     first day, for every shop that has ever made one.
 *
 * On মেসার্স নাঈম ফিস those two accounted for ৳4,14,610 of reported drift, to
 * the paisa, across two accounts whose books were entirely correct. Both read
 * `ok` after the fix.
 *
 * REGRESSION, against the SOURCE. What the script counts cannot be reached
 * without a database (FINANCE_GAP_ANALYSIS.md F17), so the properties are
 * pinned where they are written — the same reason `codCourier` reads this very
 * script off disk for its money-in types.
 */

const fs = require('fs');
const mongoose = require('mongoose');

const source = fs.readFileSync(
  require.resolve('../../scripts/recalc-account-balances.js'), 'utf8'
);

describe('the replay window is the insert moment, not the business date', () => {
  it('bounds on _id and on nothing else', () => {
    // `since()` is the whole rule, and every aggregate spreads it.
    const fn = source.slice(source.indexOf('const since = (account)'), source.indexOf('const LIVE'));
    expect(fn).toContain('_id:');
    expect(fn).toContain('createFromTime');

    // No caller may reintroduce a business-date window by passing a field.
    expect(source).not.toMatch(/since\(account, ['"]/);
  });

  it('does not bound on createdAt either', () => {
    // `createSale` MOVES `createdAt` when an invoice is backdated (its
    // `pinnedAt`), so a backdated sale's legs would drop out of the window the
    // same way `paidAt` dropped the collections. `_id` is the only field no
    // write path can rewrite.
    const fn = source.slice(source.indexOf('const since = (account)'), source.indexOf('const LIVE'));
    expect(fn).not.toContain('createdAt:');
  });

  it('builds a boundary id that actually orders against real documents', () => {
    // Not a formality: `createFromTime` takes SECONDS. Handing it milliseconds
    // produces a boundary ~55,000 years in the future, every aggregate matches
    // nothing, and every account reads as drifted by its entire history.
    const openingDate = new Date('2026-08-28T04:23:30.846Z');
    const boundary = mongoose.Types.ObjectId.createFromTime(
      Math.floor(openingDate.getTime() / 1000)
    );

    expect(boundary.getTimestamp().getTime()).toBe(
      Math.floor(openingDate.getTime() / 1000) * 1000
    );

    // A row inserted a minute later sorts after the boundary; one inserted an
    // hour earlier sorts before it.
    const later = mongoose.Types.ObjectId.createFromTime(
      Math.floor(openingDate.getTime() / 1000) + 60
    );
    const earlier = mongoose.Types.ObjectId.createFromTime(
      Math.floor(openingDate.getTime() / 1000) - 3600
    );
    expect(String(later) > String(boundary)).toBe(true);
    expect(String(earlier) < String(boundary)).toBe(true);
  });
});

describe('voided rows are not replayed', () => {
  it('filters cancelled payments out of every payment aggregate', () => {
    // `dueSettlement.voidPayment` and `cancelPurchase` both mark the row
    // cancelled AND call `applyAccountDelta` with the opposite sign. Counting
    // the row as if it still stood double-counts the reversal.
    expect(source).toContain("const LIVE = { status: { $ne: 'cancelled' } }");

    // The RULE, not a count: every aggregate that reads the payments collection
    // must carry it. Asserting a fixed number would fail on a legitimate
    // ADDITION — which is exactly what happened when the `purchase_refund`
    // money-in bucket was added — and that tests the punctuation rather than
    // the invariant.
    const paymentReads = (source.match(/collection\('payments'\)/g) || []).length;
    const liveUses = (source.match(/\.\.\.LIVE,/g) || []).length;

    expect(paymentReads).toBeGreaterThanOrEqual(4);
    expect(liveUses).toBe(paymentReads);
  });
});

describe('it stays a second opinion', () => {
  it('never reads balance to compute balance', () => {
    const rebuild = source.slice(
      source.indexOf('async function rebuildShop'),
      source.indexOf('const allAccounts')
    );
    // `openingBalance` is a typed-in constant and is allowed; the running
    // figure it is checking is not.
    expect(rebuild).toContain('openingBalance');
    expect(rebuild).not.toMatch(/\$sum: '\$balance'|a\.balance|account\.balance/);
  });

  it('sums sale money leg by leg, never by the largest method', () => {
    // A ৳400 cash + ৳600 bKash invoice would otherwise credit ৳1,000 to
    // whichever leg happened to be larger — the trap `report.service` fell into.
    //
    // Asserted on the aggregate rather than the whole file, because the header
    // legitimately NAMES the anti-pattern in prose while explaining it.
    const saleLegs = source.slice(
      source.indexOf("const saleLegs"),
      source.indexOf('add(accountId, saleLegs')
    );
    expect(saleLegs).toContain("$unwind: '$payments'");
    expect(saleLegs).toContain("$sum: '$payments.amount'");
    expect(saleLegs).not.toContain("$paid");
  });
});
