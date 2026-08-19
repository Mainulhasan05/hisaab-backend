const mongoose = require('mongoose');
const { PAYMENT_METHODS } = require('../config/constants');

/**
 * A place the shop's money actually sits.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Every money row in this system carries a `method` — `cash`, `bkash`, `nagad`,
 * `card`, `bank`. That is a LABEL, not a place. `bkash` does not say which bKash
 * number, `bank` does not say which bank account, and neither carries a balance.
 * The only balance in the app before this collection was `CashRegister`'s, and
 * every query behind it hardcodes `method: 'cash'` to keep it that way.
 *
 * So the app could not answer the question owners ask most — "আমার কত টাকা
 * আছে?" — for anything but the drawer, could not record money moving from one
 * place to another, and had nowhere to put the MFS and bank charges that eat a
 * real percentage of a shop's turnover. See `FUND_ACCOUNT_PLAN.md`.
 *
 * ── `type` and `method` are different questions ─────────────────────────────
 *
 * `type` is what the thing IS — used for grouping, icons, and the branch rule
 * below. `method` is which of the existing `PAYMENT_METHODS` values this account
 * answers to, and it is what makes adopting this feature a pure back-fill: every
 * historical `Sale`, `Purchase`, `Expense` and `Payment` already carries a
 * `method`, so each maps to that method's default account with no judgement call
 * to make and nothing to ask the shopkeeper.
 *
 * They are not merged because they are not one-to-one in either direction: a
 * shop can hold three `mfs` accounts whose `method` is `bkash`, `nagad` and
 * `bkash` again, and `card` money that settles into a bank is still `card` at
 * the till.
 *
 * ── The branch rule (FUND_ACCOUNT_PLAN D-3) ─────────────────────────────────
 *
 *   type 'cash'  →  `branch` is the branch that holds the drawer
 *   everything else → `branch: null`, shared shop-wide
 *
 * A cash box belongs to a counter; a bank account and a bKash number belong to
 * the business. This is what the owner described and it is how the shops
 * actually run.
 *
 * A single-branch shop has `req.branchId === null`, so its cash account is
 * `branch: null` too and the rule collapses to nothing — **I-1 holds by
 * construction**, not by a conditional. Reads must go through
 * `utils/accountScope.util.accountFilter`, never `branchFilter`: a plain
 * `{ branch: X }` predicate would hide every shared account, which is the
 * silent-zero failure I-2 exists to prevent.
 */
const paymentAccountSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন'],
    index: true
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  name: {
    type: String,
    required: [true, 'অ্যাকাউন্টের নাম দিন'],
    trim: true,
    maxlength: [80, 'নাম ৮০ অক্ষরের বেশি হতে পারবে না']
  },
  type: {
    type: String,
    enum: {
      values: ['cash', 'bank', 'mfs', 'card', 'other'],
      message: 'অবৈধ অ্যাকাউন্টের ধরন'
    },
    required: [true, 'অ্যাকাউন্টের ধরন নির্বাচন করুন']
  },
  method: {
    type: String,
    enum: {
      values: Object.values(PAYMENT_METHODS),
      message: 'অবৈধ পেমেন্ট পদ্ধতি'
    },
    required: [true, 'পেমেন্ট পদ্ধতি নির্বাচন করুন']
  },
  /**
   * Free text, and deliberately never a key.
   *
   * Two shops write the same bKash number four different ways, and a bank
   * account number is not unique across banks. Matching on it would either
   * reject a legitimate second account or silently merge two real ones. It is
   * here so the owner can tell their own accounts apart on screen.
   */
  accountNumber: {
    type: String,
    trim: true,
    maxlength: [40, 'অ্যাকাউন্ট নম্বর ৪০ অক্ষরের বেশি হতে পারবে না']
  },
  bankName: {
    type: String,
    trim: true,
    maxlength: [80, 'ব্যাংকের নাম ৮০ অক্ষরের বেশি হতে পারবে না']
  },
  /**
   * What was in the account on the day the shop started using this feature.
   *
   * OWNER-ENTERED (D-4). Not inferred, and not zero by default in any
   * meaningful sense — a shop adopting this holds real money already, and a
   * balance that starts at zero is wrong from the first screen.
   *
   * Owner-only at the service layer, the same shape as `Customer.openingDue`
   * and `Customer.isWholesale` (I-7): it sets the origin of every future figure
   * this account will ever show, so a staff member must not be able to type it.
   *
   * May be NEGATIVE — an overdrawn current account is a real thing, and
   * clamping it at zero would misstate the shop's position in the one direction
   * that matters.
   */
  openingBalance: {
    type: Number,
    default: 0
  },
  /**
   * Day one. Movements before this date are not replayed into `balance`
   * (FUND_ACCOUNT_PLAN Q-3, settled: today is day one), which is exactly what
   * `CashRegister` already does with its own opening figure.
   */
  openingDate: {
    type: Date,
    default: Date.now
  },
  /**
   * The running figure.
   *
   * ── Stored, not derived, and why that is the risky choice ────────────────
   *
   * This is the `CustomerBalance` pattern — `$inc` inside the same transaction
   * as the money movement. It is also exactly the pattern that produced the
   * variant-stock drift, where one write path moved `variants[].stock` and
   * forgot `product.stock`, and nothing noticed for months.
   *
   * The defence is not care. It is that **there is one writer**:
   * `paymentAccount.service.applyAccountDelta`. No other code may touch this
   * field, and `scripts/recalc-account-balances.js` re-derives it from the
   * source rows so drift is findable rather than theoretical.
   */
  balance: {
    type: Number,
    default: 0
  },
  /**
   * Which account a `method` resolves to when the caller did not name one.
   *
   * This is what lets the capability be adopted without touching a single
   * existing form: a shop with the flag ON but a POS that still posts only
   * `method: 'bkash'` gets its money booked to the default bKash account rather
   * than nowhere. One per `method` per branch scope, enforced in the service.
   */
  isDefault: {
    type: Boolean,
    default: false
  },
  /**
   * Soft delete. Accounts are never removed: `Sale.payments[]`, `Payment`,
   * `Purchase` and `Expense` rows point at them, and a dangling reference turns
   * a settled invoice into an unreadable one. A closed bank account stops being
   * offered and keeps its history.
   */
  isActive: {
    type: Boolean,
    default: true
  },
  notes: {
    type: String,
    trim: true,
    maxlength: [500, 'নোট ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Listing, per §9.2 — the branch predicate is an `$or` (see accountScope.util),
// but the leading {shop, branch} prefix still serves it.
paymentAccountSchema.index({ shop: 1, branch: 1, isActive: 1 });
// Default resolution on the write paths — hit on every sale with the flag on.
paymentAccountSchema.index({ shop: 1, method: 1, isDefault: 1 });
// Two accounts called 'বিকাশ' in one branch is a data-entry slip, not a
// business fact. Scoped to {shop, branch} so two branches may each have a
// 'ক্যাশ বাক্স' — which is the normal case, not an edge one.
paymentAccountSchema.index({ shop: 1, branch: 1, name: 1 }, { unique: true });

/** Cash boxes belong to a counter; everything else belongs to the business. */
paymentAccountSchema.virtual('isShared').get(function () {
  return this.type !== 'cash';
});

/**
 * The branch a new account of this type must carry.
 *
 * One function so the rule is stated once. `activeBranch` is `requireBranch`'s
 * answer — `null` for a single-branch shop, which is why this needs no
 * multi-branch special case.
 */
paymentAccountSchema.statics.branchFor = function (type, activeBranch) {
  return type === 'cash' ? (activeBranch || null) : null;
};

const PaymentAccount = mongoose.model('PaymentAccount', paymentAccountSchema);

module.exports = PaymentAccount;
