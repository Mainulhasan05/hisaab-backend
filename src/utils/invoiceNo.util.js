/**
 * Shop-chosen invoice numbers — one number, decided once, for one invoice.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Most shops take the generated `INV-<BRANCH>-<YYYYMMDD>-####` number and never
 * think about it. Some cannot: the trader is copying from a manual invoice book
 * whose numbers are already written on the customer's carbon copy, or is
 * carrying a series across from whatever they used before, and their books have
 * to keep running on it.
 *
 *     resolveCustomInvoiceNo({ raw, req, shop }) -> string | null
 *
 * `null` means "no number named", which is what every ordinary checkout on the
 * platform sends. The caller then generates one exactly as before.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS AND IS NOT HANDED TO THE CLIENT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The CHOICE of number, not the guarantee of uniqueness. That stays where it
 * has always been: the `{shop, invoiceNo}` unique index in `Sale.model.js`,
 * which is enforced by the database on the insert itself and cannot be raced.
 * Nothing here checks whether a number is free — a check would be a read
 * followed by a write, and two tills could pass it in the same millisecond.
 * `createSale` lets the insert fail and reports the duplicate; see the note
 * there on why that path must NOT retry.
 *
 * So this file answers three narrower questions — may this caller name a number
 * at all, is the string well-formed, and is it safe to store — and nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A REFUSAL RATHER THAN SILENTLY IGNORING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A shop without the capability that posts a number gets a 400, not a generated
 * number. The invoice is a physical object: if the owner typed `A-1043` and the
 * paper came out `INV-MAIN-20260816-0004`, the customer's copy and the shop's
 * book disagree, and nobody finds out until someone goes looking for invoice
 * A-1043 months later. Failing loudly costs one error message; failing silently
 * costs a reconciliation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHO MAY DO IT — `features.customInvoiceNo` + `sales.invoice_no`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two axes, deliberately, exactly as `lineDiscount` has: the platform switches
 * the capability on for a shop that asked for it, and the owner decides who
 * inside the shop may use it. Unlike `backdate` and `revise` no preset grants
 * the permission, so it starts owner-only — which series the shop's paper runs
 * on is not a decision that belongs to whoever is standing at the till.
 */
const { AppError } = require('../middleware/error.middleware');

/**
 * The longest number we will store. Generous — `INV-DHANMONDI-20260816-0004` is
 * 28 — and the ceiling exists so a paste accident cannot put a kilobyte on an
 * invoice that has to print on 58mm thermal paper.
 */
const MAX_LENGTH = 40;

/**
 * `~` is RESERVED and this is the only place that says so out loud.
 *
 * `sale.service.reviseSale` frees the unique key by renaming a superseded
 * invoice to `<number>~r1`, and that trick is only safe because `~` appears in
 * no invoice number that exists. Allowing an owner to type one would let
 * `A-1043~r1` be a real, live invoice that a later revision of `A-1043` then
 * collides with — inside a transaction, at the till, for a reason nobody could
 * reconstruct from the error.
 */
const REVISION_MARKER = '~';

/**
 * Letters (any script, so Bengali is in), digits (ASCII and Bengali), and the
 * punctuation these books actually use: `2026/A-1043`, `HFG-1043`, `#1043`,
 * `A.1043`, `INV 1043`, `হিসাব-১০৪৩`.
 *
 * A whitelist rather than a blocklist because the failure being prevented is
 * not one known bad character — it is control characters, RTL overrides and
 * zero-width joiners reaching a string that gets printed, texted, searched with
 * a regex and read back by a human comparing it to a piece of paper.
 *
 * `\p{M}` is in the TAIL class and is not optional: Bengali vowel signs (ি, া,
 * ে) are combining marks, not letters, so a class of `\p{L}\p{N}` alone rejects
 * every ordinary Bengali word — `হিসাব` included. A shop that numbers its
 * invoices in its own script is exactly the shop this capability is for.
 *
 * The FIRST character is narrower — a letter, a digit or `#` — so a number
 * cannot begin with a separator (`-1043`, `.1043`), which reads as a typo and
 * sorts strangely, or with a combining mark, which is not a word.
 */
const ALLOWED = /^[\p{L}\p{N}#][\p{L}\p{M}\p{N} \-/_.#()]*$/u;

/**
 * Resolve the invoice number the client asked for.
 *
 * Rules, in the order they are checked — the order is why "not asked for" can
 * never 400 or 403 for the shops that have never heard of this:
 *
 *   1. nothing named          -> null, no error, whoever is asking
 *   2. capability off         -> 400 (see "why a refusal" above)
 *   3. no `sales.invoice_no`  -> 403
 *   4. not a string           -> 400
 *   5. too long / empty       -> 400
 *   6. contains `~`           -> 400 (reserved, see REVISION_MARKER)
 *   7. disallowed characters  -> 400
 *   8. otherwise              -> the normalised string
 *
 * Normalisation is deliberately minimal: NFC, trimmed, and internal whitespace
 * runs collapsed to one space. Case is NOT touched — `HFG/26-1043` is stored as
 * typed, because this string is printed and an owner who capitalises their
 * series a particular way is entitled to have it come out that way.
 *
 * @param {Object}  input
 * @param {*}       input.raw   the client's `invoiceNo`
 * @param {Object} [input.req]  the Express request (the permission check)
 * @param {Object} [input.shop] the Shop document (the capability check)
 * @returns {string|null}
 * @throws {AppError} 403 without the permission, 400 for everything else
 */
function resolveCustomInvoiceNo({ raw, req = null, shop = null } = {}) {
  // Required lazily for the same reason `saleDate.util` does it: `permission
  // .middleware` reaches config, which makes this unusable from the scripts and
  // seeders that have no app context.
  const { hasPermission } = require('../middleware/permission.middleware');
  const { shopHasFeature } = require('./features.util');

  // 1. Nothing asked for. Not a violation — this is every ordinary checkout,
  //    and it is checked FIRST so that a shop without the capability, or a
  //    cashier without the permission, can still sell.
  if (raw === undefined || raw === null || raw === '') return null;

  // 2. The platform has not sold this shop its own numbering.
  //
  //    `shop` absent = a script or an internal call with no shop context, and
  //    it passes — the same carve-out `resolveSaleDate` makes for `req`. No
  //    request path can reach here without one.
  if (shop && !shopHasFeature(shop, 'customInvoiceNo')) {
    throw new AppError(
      'This shop does not have its own invoice numbering enabled',
      'এই দোকানে নিজের ইনভয়েস নম্বর দেওয়ার সুবিধা চালু নেই',
      400
    );
  }

  // 3. The owner has not given this person the series.
  if (req && !hasPermission(req, 'sales', 'invoice_no')) {
    throw new AppError(
      'You do not have permission to set an invoice number',
      'আপনার নিজে ইনভয়েস নম্বর দেওয়ার অনুমতি নেই',
      403
    );
  }

  // 4. A number is a string. An object or an array here is a malformed client,
  //    not a typo, and `String(raw)` would happily store "[object Object]".
  if (typeof raw !== 'string') {
    throw new AppError(
      'Invoice number must be text',
      'ইনভয়েস নম্বর ঠিকভাবে দিন',
      400
    );
  }

  const value = raw.normalize('NFC').trim().replace(/\s+/g, ' ');

  // 5. Whitespace only, or longer than a receipt can carry.
  if (!value) {
    throw new AppError(
      'Invoice number cannot be blank',
      'ইনভয়েস নম্বর খালি রাখা যাবে না',
      400
    );
  }
  if (value.length > MAX_LENGTH) {
    throw new AppError(
      `Invoice number cannot be longer than ${MAX_LENGTH} characters`,
      `ইনভয়েস নম্বর ${MAX_LENGTH} অক্ষরের বেশি হতে পারবে না`,
      400
    );
  }

  // 6. Reserved. Checked before the charset so the message names the real
  //    reason rather than "invalid character".
  if (value.includes(REVISION_MARKER)) {
    throw new AppError(
      `Invoice number cannot contain "${REVISION_MARKER}" — it is reserved for revisions`,
      `ইনভয়েস নম্বরে "${REVISION_MARKER}" ব্যবহার করা যাবে না`,
      400
    );
  }

  // 7. Everything else printable-and-sane.
  if (!ALLOWED.test(value)) {
    throw new AppError(
      'Invoice number may use letters, numbers and - / _ . # ( ) only',
      'ইনভয়েস নম্বরে শুধু অক্ষর, সংখ্যা এবং - / _ . # ( ) ব্যবহার করা যাবে',
      400
    );
  }

  return value;
}

module.exports = {
  resolveCustomInvoiceNo,
  MAX_LENGTH,
  REVISION_MARKER,
};
