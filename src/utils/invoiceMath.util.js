/**
 * Invoice arithmetic — ONE definition, shared by the service and the model hook.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `createSale` computed `total`, `due` and `status` in the service and wrote
 * those figures to `Customer` / `CustomerBalance`. `Sale.pre('save')` then
 * computed the SAME three figures again, its own way, and stored its answers on
 * the invoice. The two arithmetics were not identical, so the invoice and the
 * customer's ledger disagreed in three routine cases:
 *
 *   1. OVERPAYMENT. A cashier types the tendered ৳500 on a ৳420 bill (the POS
 *      paid box is a free text input — nothing clamps it). The hook clamped
 *      `paid` down to the total; the service did not, so the customer was
 *      credited ৳500 against a ৳420 purchase and `deriveDue` understated their
 *      debt by the change handed back, permanently.
 *
 *   2. A DISCOUNT LARGER THAN THE BILL. `discountType: 'percentage'` was never
 *      bounded to 100. At 150% the service's `total` went negative; the hook
 *      clamped the stored total to 0, and `customer.totalPurchases` went DOWN
 *      by the difference for a sale that reads ৳0.
 *
 *   3. UNCOERCED INPUT. `deliveryCharge` and `advancePaid` were passed through
 *      `Number()`; `tax` and `discount` were not, on either side. There is no
 *      Joi schema on the sale routes, so `tax: "50"` turned
 *      `subtotal - discountAmount + tax` into string concatenation.
 *
 * None of those are edge cases in a shop — the first happens at every till that
 * takes cash. So the fix is not to patch three expressions, it is to make it
 * impossible for the two call sites to disagree again: both now call
 * `computeInvoiceTotals`, and neither does any money arithmetic of its own.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY FIGURE IS QUANTIZED TO PAISA
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Line totals already went through `quantizeMoney`; `subtotal`, `discountAmount`
 * and `total` did not. Summing paisa-exact doubles reintroduces float dust
 * (0.1 + 0.2 = 0.30000000000000004), and `due = total - paid` then lands on
 * 1.4e-14 instead of 0. That is not cosmetic: the invoice's status becomes
 * 'partial', it joins the বাকি list (`due: { $gt: 0 }`), and `Customer.totalDue`
 * accumulates dust that no payment can ever clear. Same class of bug
 * `quantity.util.js` exists to prevent for quantities — this is the money half.
 */
const { quantizeMoney } = require('./quantity.util');

/**
 * Ceiling on any single money figure. Matches the bound `Sale.pre('save')` and
 * `Purchase.pre('save')` already applied — a defence against a fat-fingered or
 * hostile payload turning into an amount that breaks every downstream sum.
 */
const MAX_INVOICE_AMOUNT = 1e11;

/**
 * Coerce anything a client may send into a usable, non-negative paisa figure.
 *
 * `null`, `''`, `undefined`, `'abc'`, `NaN`, `Infinity` and negatives all read
 * as 0 rather than throwing: this is the LAST line of defence, called on values
 * that have already passed whatever validation the route has. Refusing here
 * would turn a stray empty string into a failed checkout.
 *
 * @param {*} raw
 * @returns {number}
 */
function toMoney(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return quantizeMoney(Math.min(n, MAX_INVOICE_AMOUNT));
}

/**
 * The taka value of an invoice-level discount.
 *
 * Percentage is bounded to 100 and fixed is bounded to the subtotal, so the
 * discount can never exceed what is being discounted. Without both bounds the
 * total goes negative and every consumer clamps it differently — which is
 * exactly how the invoice and the customer ledger drifted apart.
 *
 * Shared with `salesReturn.service`, which allocates this same amount across
 * the returned lines. Before, it recomputed the raw unclamped figure and so
 * could allocate more discount than the invoice actually gave.
 *
 * @param {number} subtotal    already quantized
 * @param {*} discount         raw client value
 * @param {string} discountType 'fixed' | 'percentage'
 * @returns {number}
 */
function discountAmountFor(subtotal, discount, discountType) {
  const sub = toMoney(subtotal);
  const raw = toMoney(discount);

  if (discountType === 'percentage') {
    return quantizeMoney((sub * Math.min(raw, 100)) / 100);
  }
  return Math.min(raw, sub);
}

/**
 * Every derived figure on an invoice, from its raw inputs.
 *
 * `returnedAdjustment` is the part of a return settled AGAINST THE DUE rather
 * than refunded in cash — see the field's note on `Sale`. A cash refund hands
 * money back and leaves the obligation alone, so only the adjustment term
 * reduces what is owed.
 *
 * `ledgerSettled` is the third and last way a due comes down: money collected
 * against the customer's খাতা as a whole rather than against this invoice by
 * name — বাকি আদায় on the customer page, or the surplus settled at a later
 * checkout. It is DELIBERATELY not folded into `paid`, for the same reason
 * `returnedAdjustment` is not: `paid` means "tendered at or against this
 * invoice", and `cancelSale` unwinds exactly `-sale.paid` from the customer's
 * ledger. Folding a ৳2,200 khata collection into a ৳7,000 invoice's `paid`
 * would make cancelling that invoice claw back ৳2,200 the customer really did
 * hand over, and the `Payment{type:'due_collection'}` row would survive to
 * prove it. Three terms, three meanings, one subtraction.
 *
 * @param {Object} input
 * @param {number} input.subtotal            sum of line totals
 * @param {*} [input.discount]               invoice-level discount, raw
 * @param {string} [input.discountType]      'fixed' | 'percentage'
 * @param {*} [input.tax]
 * @param {*} [input.deliveryCharge]
 * @param {*} [input.paid]
 * @param {*} [input.returnedAdjustment]
 * @param {*} [input.ledgerSettled]
 * @returns {{
 *   subtotal: number,
 *   discountAmount: number,
 *   tax: number,
 *   deliveryCharge: number,
 *   merchandise: number,   subtotal less discount — the returnable base
 *   total: number,
 *   paid: number,          clamped to total
 *   due: number
 * }}
 */
function computeInvoiceTotals(input = {}) {
  const subtotal = toMoney(input.subtotal);
  const discountAmount = discountAmountFor(subtotal, input.discount, input.discountType);
  const tax = toMoney(input.tax);
  const deliveryCharge = toMoney(input.deliveryCharge);

  // What the GOODS came to, after the invoice discount. This is the base a
  // return can refund against — tax and delivery are not refunded, which is why
  // "is this sale fully returned?" must be asked against this figure and not
  // against `total`. See `salesReturn.service`.
  const merchandise = quantizeMoney(Math.max(0, subtotal - discountAmount));
  const total = quantizeMoney(Math.min(merchandise + tax + deliveryCharge, MAX_INVOICE_AMOUNT));

  // Clamped, not rejected. A cashier keying the tendered amount is recording
  // what crossed the counter, not claiming the customer overpaid; the change
  // goes back in the drawer and the invoice is settled in full.
  const paid = Math.min(toMoney(input.paid), total);
  const { ledgerSettled, due } = settlementFor({
    total,
    paid,
    returnedAdjustment: input.returnedAdjustment,
    ledgerSettled: input.ledgerSettled,
  });

  return {
    subtotal, discountAmount, tax, deliveryCharge, merchandise, total, paid,
    ledgerSettled, due,
  };
}

/**
 * The two non-tendered reductions and the due that survives them.
 *
 * Split out of `computeInvoiceTotals` because it is the only part of the invoice
 * arithmetic that `dueSettlement.reallocateCustomerInvoices` needs, and it is
 * the only part it can compute: the allocator walks a customer's invoices to
 * move ONE number on each, and loading every line item of every invoice just to
 * re-derive a `subtotal` that has not changed would make a hot path
 * proportional to basket size for no gain.
 *
 * The alternative — the allocator doing `total - paid - …` inline — is the
 * mistake `invoiceMath.util` exists to prevent. Two call sites, one definition,
 * extracted rather than copied.
 *
 * `capped` reports whether the stored `ledgerSettled` had to be trimmed, which
 * is how the allocator learns that a return has shrunk an invoice and freed
 * khata money that belongs on the next one.
 *
 * @param {Object} p
 * @param {number} p.total                the invoice total, already derived
 * @param {number} p.paid                 tendered at or against this invoice
 * @param {*} [p.returnedAdjustment]      return settled against the due
 * @param {*} [p.ledgerSettled]           khata money allocated here
 * @returns {{returnedAdjustment: number, ledgerSettled: number, due: number, capped: boolean}}
 */
function settlementFor({ total, paid, returnedAdjustment: rawAdj, ledgerSettled: rawLedger }) {
  const returnedAdjustment = Math.min(toMoney(rawAdj), total);

  // Bounded by what is actually left after the other two terms, not by `total`.
  // The allocator never hands over more than this, but the clamp has to hold
  // here as well: a stored `ledgerSettled` from before a return was recorded
  // would otherwise drive `due` below zero, and `Math.max(0, …)` would hide it
  // by silently writing off the difference.
  const headroom = Math.max(0, quantizeMoney(total - paid - returnedAdjustment));
  const wanted = toMoney(rawLedger);
  const ledgerSettled = Math.min(wanted, headroom);

  return {
    returnedAdjustment,
    ledgerSettled,
    due: quantizeMoney(Math.max(0, headroom - ledgerSettled)),
    capped: wanted > headroom,
  };
}

/**
 * Trim split-payment legs so they sum to at most `cap`.
 *
 * Needed because `paid` is clamped to the total (above) while `payments[]` is
 * whatever the till sent. The cash register sums the *legs* to work out what is
 * in the drawer (`cashRegister._calculateCashFlows`), so leaving a ৳500 cash leg
 * on a ৳420 invoice would count the ৳80 of change as takings and report the
 * drawer over by that much every time a cashier keys a tendered amount.
 *
 * Trimmed from the LAST leg backwards: the first method entered is the one the
 * customer actually handed over in full, and the overshoot sits on whichever
 * method was used to top the payment up.
 *
 * @param {Array<{method: string, amount: number}>} payments
 * @param {number} cap
 * @returns {Array<{method: string, amount: number}>}
 */
function clampPaymentLegs(payments, cap) {
  if (!Array.isArray(payments) || payments.length === 0) return [];

  const legs = payments
    .map((p) => ({ ...p, amount: toMoney(p?.amount) }))
    .filter((p) => p.amount > 0);

  let remaining = quantizeMoney(Math.max(0, cap));
  const kept = [];

  for (const leg of legs) {
    if (remaining <= 0) break;
    const amount = Math.min(leg.amount, remaining);
    kept.push({ ...leg, amount: quantizeMoney(amount) });
    remaining = quantizeMoney(remaining - amount);
  }

  return kept;
}

/**
 * The payment status derived from a due.
 *
 * `cancelled` is a lifecycle state, not a payment state, so it is never
 * recomputed away — the same guard `Sale` and `Purchase` already carried
 * separately.
 *
 * `settled` is anything that has come off the obligation without being tendered
 * at this invoice — khata money allocated here (`ledgerSettled`) and returns
 * taken against the due (`returnedAdjustment`). It only affects the
 * partial/unpaid split, and it has to: an invoice a customer has paid ৳2,000
 * towards through বাকি আদায় is not "unpaid", and telling the shopkeeper it is
 * is how they end up chasing money they have already banked. Optional, so
 * `Purchase` and every existing caller keep the two-term behaviour they had.
 *
 * @param {Object} input
 * @param {number} input.due
 * @param {number} input.paid
 * @param {number} [input.settled]  non-tendered reductions, if any
 * @param {string} [input.current]  the document's existing status
 * @returns {string}
 */
function statusFor({ due, paid, settled = 0, current }) {
  if (current === 'cancelled') return 'cancelled';
  if (due <= 0) return 'completed';
  return (paid > 0 || settled > 0) ? 'partial' : 'unpaid';
}

module.exports = {
  MAX_INVOICE_AMOUNT,
  toMoney,
  discountAmountFor,
  computeInvoiceTotals,
  settlementFor,
  clampPaymentLegs,
  statusFor,
};
