/**
 * What a delivery actually cost — discount, ভাড়া, and the landed price.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `costing.util` re-blends `Product.buyingPrice` as a moving weighted average
 * the moment goods are received, and `Sale.profit` is computed from that
 * number. Until now the figure it blended from was `item.unitPrice` — the rate
 * on the supplier's bill and nothing else.
 *
 * So a shop that paid ৳1,80,000 for goods plus ৳6,000 of truck hire recorded a
 * cost basis 3.3% below what the consignment actually cost it, and every margin
 * report on the platform agreed that this was fine. The same is true in the
 * other direction for a trade discount the supplier gave: the goods cost LESS
 * than the bill's line rate, and the shelf never learned it.
 *
 * Freight and discount are not memo lines. They are part of what the stock
 * cost, and they have to reach the cost basis. That is the whole job of this
 * file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO PRICES PER LINE, AND WHY IT IS NOT ONE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   unitPrice        what the supplier BILLED, per base unit. Untouched by
 *                    anything here. It is what makes a stored purchase
 *                    reconcile line-for-line against the paper in the
 *                    shopkeeper's hand, which is the same reason `packSize`
 *                    and `unit` are snapshotted on the line.
 *
 *   landedUnitPrice  what the goods COST, per base unit, once this line's share
 *                    of the discount and the charges is folded in. This is what
 *                    `costing.util` and the stock ledger read.
 *
 * Collapsing them into one field looks like tidiness and destroys the ability
 * to check Hisaab against a supplier statement. Keep both.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ALLOCATION IS BY VALUE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Pro-rata on each line's net value, because that is what a supplier's own bill
 * does when it discounts, and because Hisaab does not store shipping weight.
 * By-quantity would load ৳6,000 of truck hire equally onto 100 sacks of rice
 * and 100 sachets of shampoo.
 *
 * By-quantity IS the fallback, for the one case where by-value cannot answer: a
 * whole delivery received at zero cost. A free consignment that still cost ৳500
 * to unload has a real landed cost, and dividing by a zero total would produce
 * NaN and write it onto every product in the delivery.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REMAINDER IS LOAD-BEARING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Rounding each share to paisa leaves `Σ shares` a paisa or two off the charge
 * being allocated. That is not cosmetic here. The residue enters
 * `landedUnitPrice`, `landedUnitPrice` feeds the moving average, and the moving
 * average is never recomputed from source — so the error compounds into
 * `Product.buyingPrice` on every delivery, forever, on data nobody is looking
 * at. `_prorate` settles the remainder onto the largest line so the identity
 *
 *     Σ shares === charge
 *
 * holds exactly, every time. Same class of defect `quantity.util` exists to
 * prevent for quantities and `invoiceMath` for invoice money.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NOT `computeInvoiceTotals`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * That function runs for every sale on the platform. A purchase's totals are a
 * similar shape, but the allocation back ONTO the lines has no sale-side
 * counterpart, and putting a purchase branch inside the invoice path would put
 * it in the way of every checkout. The primitives are shared instead — `toMoney`
 * and `discountAmountFor` are imported, not reimplemented, so the two paths
 * cannot start disagreeing about what a percentage means.
 */

const { quantizeMoney } = require('./quantity.util');
const { toMoney, discountAmountFor, MAX_INVOICE_AMOUNT } = require('./invoiceMath.util');

/**
 * Split `charge` across `weights`, pro-rata, summing to exactly `charge`.
 *
 * Returns `null` — not an array of zeros — when the weights carry no signal
 * (all zero, or empty). Null is the caller's cue to try a different basis;
 * zeros would silently drop the charge on the floor, which for a ৳6,000 freight
 * bill means the cost basis is wrong and nothing says so.
 *
 * @param {number[]} weights   any non-negative basis; negatives read as 0
 * @param {number} charge      already coerced by `toMoney`
 * @returns {number[]|null}
 */
function _prorate(weights, charge) {
  if (!Array.isArray(weights) || weights.length === 0) return null;

  const safe = weights.map((w) => {
    const n = Number(w);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });

  const totalWeight = safe.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) return null;

  if (charge === 0) return safe.map(() => 0);

  const shares = safe.map((w) => quantizeMoney((charge * w) / totalWeight));

  // The paisa the rounding lost or invented. Settled onto the largest line
  // because it is the one that can absorb ±0.02 without going negative, and
  // because spreading it would just recreate the problem at a smaller scale.
  const allocated = shares.reduce((sum, s) => quantizeMoney(sum + s), 0);
  const remainder = quantizeMoney(charge - allocated);

  if (remainder !== 0) {
    let largest = 0;
    for (let i = 1; i < safe.length; i += 1) {
      if (safe[i] > safe[largest]) largest = i;
    }
    shares[largest] = Math.max(0, quantizeMoney(shares[largest] + remainder));
  }

  return shares;
}

/**
 * Every derived figure on a purchase, from its raw inputs — including what each
 * line's goods actually cost once the bill's discounts and charges are spread
 * back over them.
 *
 * Nothing here throws. Like `computeInvoiceTotals`, this is the last line of
 * defence on values that have already passed the service's own validation:
 * a malformed figure reads as 0, which is the safe direction — it records the
 * delivery at the billed rate rather than refusing to record it at all.
 *
 * ── The identities this guarantees ─────────────────────────────────────────
 *
 *     subtotal      === Σ line.total                    (billed, per line)
 *     itemDiscount  === Σ line.lineDiscount
 *     Σ line.discountShare === discountAmount
 *     Σ line.chargeShare   === freightCharge + otherCharge
 *     totalAmount   === subtotal − itemDiscount − discountAmount
 *                          + freightCharge + otherCharge
 *
 * The two Σ identities are exact, not approximate. See `_prorate`.
 *
 * ── Zero charges must be a no-op, byte for byte ────────────────────────────
 *
 * A shop that types no discount and no ভাড়া — which is every shop that exists
 * today — must come out of here with `landedUnitPrice === unitPrice` EXACTLY,
 * not to within a paisa. That is what keeps `Product.buyingPrice` identical to
 * what it would have been before this file existed (I-1). The zero-charge path
 * therefore assigns `unitPrice` straight across rather than dividing a
 * recomputed net by the quantity.
 *
 * @param {Object} input
 * @param {Array}  input.lines            [{ quantity, unitPrice, lineDiscount }]
 * @param {*} [input.discount]            invoice-level, raw
 * @param {string} [input.discountType]   'fixed' | 'percentage'
 * @param {*} [input.freightCharge]       ভাড়া
 * @param {*} [input.otherCharge]         labour / unloading
 * @param {*} [input.paid]
 * @returns {{
 *   subtotal: number, itemDiscount: number, discountAmount: number,
 *   freightCharge: number, otherCharge: number, merchandise: number,
 *   totalAmount: number, paid: number, due: number, lines: Array
 * }}
 */
function computePurchaseTotals(input = {}) {
  const rawLines = Array.isArray(input.lines) ? input.lines : [];

  // ── Pass 1: what the bill says, line by line ────────────────────────────
  //
  // `gross` is `item.total` and stays `item.total`: quantity × the billed rate.
  // Nothing below rewrites it. A shopkeeper checking Hisaab against the paper
  // must find the same number on both.
  const lines = rawLines.map((line) => {
    const quantity = Number(line?.quantity);
    const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
    const unitPrice = toMoney(line?.unitPrice);
    const gross = quantizeMoney(qty * unitPrice);

    // Clamped to the line it sits on. A ৳200 concession on a ৳150 line is a
    // typo, and letting it through drives the line negative and drags the
    // allocation weights with it.
    const lineDiscount = Math.min(toMoney(line?.lineDiscount), gross);

    return {
      quantity: qty,
      unitPrice,
      lineDiscount,
      gross,
      net: quantizeMoney(gross - lineDiscount),
    };
  });

  const subtotal = quantizeMoney(lines.reduce((sum, l) => quantizeMoney(sum + l.gross), 0));
  const itemDiscount = quantizeMoney(lines.reduce((sum, l) => quantizeMoney(sum + l.lineDiscount), 0));
  const merchandise = quantizeMoney(Math.max(0, subtotal - itemDiscount));

  // ── The invoice-level discount ──────────────────────────────────────────
  //
  // Resolved against MERCHANDISE, not against `subtotal` — deliberately unlike
  // `Sale`. On a supplier's bill the per-line concessions are already struck
  // off before the trade discount is applied to the foot of the invoice, so a
  // 5% trade discount means 5% of what is left, not 5% of the list column.
  // Taking it off `subtotal` would over-discount every bill that also carried
  // line concessions.
  const discountAmount = discountAmountFor(merchandise, input.discount, input.discountType);

  const freightCharge = toMoney(input.freightCharge);
  const otherCharge = toMoney(input.otherCharge);

  // Freight and unloading are one pool for allocation purposes: both are costs
  // of getting this consignment onto the shelf, both are spread the same way,
  // and a line carrying two near-identical share fields would be two chances to
  // read the wrong one. They stay separate at the INVOICE level, where the
  // shopkeeper typed them and the printed slip states them.
  const charges = quantizeMoney(freightCharge + otherCharge);

  // ── Pass 2: spread the invoice figures back over the lines ──────────────
  //
  // By value; by quantity when the delivery has no value to weight by (a free
  // consignment that still cost money to unload); equal shares when it has
  // neither, which a schema-valid purchase cannot reach but a script can.
  const byValue = lines.map((l) => l.net);
  const byQuantity = lines.map((l) => l.quantity);
  const equal = lines.map(() => 1);

  const spread = (charge) =>
    _prorate(byValue, charge)
    || _prorate(byQuantity, charge)
    || _prorate(equal, charge)
    || lines.map(() => 0);

  const discountShares = spread(discountAmount);
  const chargeShares = spread(charges);

  const pricedLines = lines.map((line, i) => {
    const discountShare = discountShares[i] || 0;
    const chargeShare = chargeShares[i] || 0;

    // The no-op path, and it must be an assignment rather than arithmetic.
    // `(qty * unitPrice) / qty` is not `unitPrice` for every float — receiving
    // 12.5 kg at ৳33.33 round-trips to 33.329999999999998 — and that difference
    // would blend into `Product.buyingPrice` on a delivery where the shopkeeper
    // changed nothing. Every shop on the platform takes this branch today.
    const untouched = discountShare === 0 && chargeShare === 0 && line.lineDiscount === 0;

    const landedTotal = Math.max(0, quantizeMoney(line.net - discountShare + chargeShare));
    const landedUnitPrice = untouched
      ? line.unitPrice
      : (line.quantity > 0 ? landedTotal / line.quantity : 0);

    return {
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineDiscount: line.lineDiscount,
      discountShare,
      chargeShare,
      // Unrounded on purpose, exactly as the pack-rate division in
      // `createPurchase` is: rounding ৳1000/3 to ৳333.33 and multiplying back
      // books ৳999.99 against a consignment that cost ৳1000.
      landedUnitPrice,
      // What this line cost in total, landed. Stored so nothing downstream has
      // to re-multiply an unrounded per-unit figure to get back to it.
      landedTotal,
      // `item.total` — the BILLED figure, untouched by any of the above.
      total: line.gross,
    };
  });

  const totalAmount = quantizeMoney(
    Math.min(Math.max(0, merchandise - discountAmount + freightCharge + otherCharge), MAX_INVOICE_AMOUNT)
  );

  // Clamped to the bill, matching what `Purchase.pre('save')` already does to
  // `paid`. Over-tendering against a single purchase is a real thing that
  // happens at a supplier's counter, but it is a settlement against the
  // supplier's whole খাতা and does not belong on this document.
  const paid = Math.min(toMoney(input.paid), totalAmount);

  return {
    subtotal,
    itemDiscount,
    discountAmount,
    freightCharge,
    otherCharge,
    merchandise,
    totalAmount,
    paid,
    due: quantizeMoney(Math.max(0, totalAmount - paid)),
    lines: pricedLines,
  };
}

module.exports = {
  _prorate,
  computePurchaseTotals,
};
