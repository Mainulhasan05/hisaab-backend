/**
 * What a register row or a printed voucher may say about a fund account.
 *
 * `method` says HOW money moved (`bank`); the account says WHERE (which bank
 * account). A supplier payment register that prints only the method cannot
 * answer the question an owner opens it to ask — "কোন অ্যাকাউন্ট থেকে গেছে" —
 * as soon as the shop holds two accounts of one kind.
 *
 * ── Why the number is cut to its last four digits ──────────────────────────
 *
 * The voucher is handed to the SUPPLIER. Four digits are enough for the owner
 * to tell their own accounts apart on paper and for the vendor to match a
 * transfer against their statement; the full number is not this slip's to
 * give away. The options endpoint withholds it from cashiers for the same
 * reason, and this keeps every reader of it on one rule.
 *
 * Never a balance: what is IN the account is `accounts.view` territory, and
 * this travels on screens gated by `purchases.view`.
 */

/** The projection every reader populates with — no balance field. */
const ACCOUNT_DISPLAY_FIELDS = 'name type method bankName accountNumber';

/** `$lookup` sub-pipeline twin of `ACCOUNT_DISPLAY_FIELDS`. */
const ACCOUNT_DISPLAY_PROJECT = { name: 1, type: 1, method: 1, bankName: 1, accountNumber: 1 };

/**
 * @param {object|null} doc a populated / looked-up PaymentAccount, or anything else
 * @returns {{_id, name, type, method, bankName, accountTail}|null}
 *   `null` for an unpopulated id or no account at all — a shop without
 *   `features.fundAccounts` has none, and the method alone is its record.
 */
function accountDisplay(doc) {
  if (!doc || typeof doc !== 'object' || !doc.name) return null;
  const digits = String(doc.accountNumber || '').replace(/\s+/g, '');
  return {
    _id: doc._id,
    name: doc.name,
    type: doc.type || '',
    method: doc.method || '',
    bankName: doc.bankName || '',
    accountTail: digits ? digits.slice(-4) : '',
  };
}

module.exports = { ACCOUNT_DISPLAY_FIELDS, ACCOUNT_DISPLAY_PROJECT, accountDisplay };
