const { toBangladeshDateStr } = require('./bdTime.util');

/**
 * রসিদ নং — the number printed on a money receipt.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS DERIVED AND NOT COUNTED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every other numbered document in this app is handed out by a counter
 * collection — `InvoiceCounter` for sales, `ReturnCounter` for returns — and
 * the obvious move here was a third one for `due_collection` payments.
 *
 * It is not worth it. A counter buys ONE property: a gapless-looking human
 * series (`0001`, `0002`). It costs a collection on a cluster whose 500-slot
 * budget is shared with thirty unrelated databases and has been exhausted
 * once already, plus a TTL, plus a seeding path, plus the "aborted transaction
 * burns a number" caveat both existing counters carry anyway.
 *
 * A receipt number only has to do two things: identify ONE payment
 * unambiguously, and be short enough for a customer to read back over the
 * phone. An ObjectId already contains a unique, per-process-monotonic 3-byte
 * counter — the same guarantee, already paid for. So the number is a rendering
 * of the payment's own identity:
 *
 *     RCP-260825-A3F19C
 *      │      │      └── the ObjectId's counter bytes, uppercase hex
 *      │      └───────── the BANGLADESH date the money came in (YYMMDD)
 *      └──────────────── what kind of document this is
 *
 * Two consequences worth stating plainly:
 *
 *  - **It is not sequential.** A shopkeeper cannot tell from two receipts which
 *    came first, and cannot audit for missing numbers. If that is ever
 *    required, this function is the only place to change — the number is stored
 *    on the Payment, so switching to a counter later leaves history intact.
 *
 *  - **It cannot collide.** 16.7M counter values per date segment, and the
 *    input is a value MongoDB has already guaranteed unique.
 *
 * ── The date is the money's date, not the row's ──────────────────────────────
 *
 * `paidAt`, not `createdAt`. A বাকি আদায় entered on Monday for money handed
 * over on Saturday is Saturday's receipt — the same rule the audit log,the cash
 * register and the reports already follow for backdated collections. Passing
 * the wrong one would put a receipt in the customer's hand dated a day their
 * own khata does not mention.
 */
const buildPaymentReceiptNo = (objectId, paidAt) => {
  const id = String(objectId || '');
  // `-6` is the ObjectId's 3-byte counter. Anything shorter than a full
  // ObjectId is not one, and silently emitting a short number would be worse
  // than emitting none — the caller stores whatever comes back.
  if (id.length !== 24) return '';

  // 'YYYY-MM-DD' in Bangladesh time, minus the century and the separators.
  const day = toBangladeshDateStr(paidAt || new Date()).slice(2).replace(/-/g, '');

  return `RCP-${day}-${id.slice(-6).toUpperCase()}`;
};

module.exports = { buildPaymentReceiptNo };
