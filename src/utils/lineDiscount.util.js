/**
 * Per-line negotiated pricing — one rate, decided once, for one line.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A shop with `features.lineDiscount` on lets a cashier agree a different rate
 * on a single line: the rice is ৳১০০ a kilo, this buyer takes fifty and haggles
 * it to ৳৯০. Everything that decision touches is here, in one function:
 *
 *     resolveLineRate({ raw, listUnitPrice, quantity, ... })
 *         -> { agreedUnitPrice: number|undefined, discount: number }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CLIENT SENDS A PRICE. THE SERVER STORES A DISCOUNT. BOTH ARE KEPT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `agreedUnitPrice` is what the human typed, per base unit. The line's stored
 * `unitPrice` stays the LIST rate — whatever `sellingPriceFor` and the pack
 * logic resolved — and the concession becomes
 *
 *     discount = (listUnitPrice - agreedUnitPrice) x quantity
 *
 * Simply lowering `unitPrice` to ৯০ is the obvious move and it is wrong three
 * ways. The concession vanishes, so no report can answer "what did I give away
 * this month" — the owner's first question after switching this on. The invoice
 * cannot print "৳১০০ → ৳৯০", because ৳১০০ is no longer stored anywhere, and
 * showing the customer what they got is the entire ask. And `Sale.priceTier`
 * becomes a lie: it is documented as a snapshot of which price LIST was applied,
 * which a hand-typed number is not.
 *
 * `agreedUnitPrice` is then ALSO stored on the line, and that is not redundancy
 * for its own sake. Re-deriving it as `unitPrice - discount / quantity` does not
 * round-trip once BOTH a paisa rate and a fractional quantity are in play, which
 * `features.packaging` makes ordinary: 750 g agreed at ৳৯০.৫০ off a ৳১০০ list is
 * a ৳7.125 concession, quantized to ৳7.13 like every other money figure on the
 * invoice — and divided back out that reads ৳৯০.৪৯. Printing a rate the customer
 * never agreed to, on the invoice they are holding, is the failure that field
 * exists to prevent.
 *
 * (A whole-taka rate on a whole quantity round-trips exactly. The field is not
 * for that case; it is for the one that does not, and there is no way to know
 * which a line is without storing it.)
 *
 * It is display-only — nothing sums it — exactly as `packUnitPrice` already is.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CLIENT'S `discount` IS IGNORED WHEN THIS IS ON
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * One direction only: price in, discount out. `pricing.util`'s header states the
 * same rule for the wholesale tier — "the client never says 'this is a wholesale
 * sale'… anything else is a price list the caller can pick, which at a till
 * means any cashier with the network tab open can buy at wholesale". Same trap,
 * same answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ABSENT IS NOT A VIOLATION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A line with no `agreedUnitPrice` returns `{ discount: 0 }` and throws nothing,
 * **even with the flag off**. That is the shape every ordinary POS payload on
 * the platform sends, and 403-ing it would refuse every checkout in every shop.
 * Only a line that actually names a rate is gated. Same carve-out
 * `normalizeWholesalePrice` makes for a cleared price box.
 */
const { quantizeMoney } = require('./quantity.util');
const { hasFeature } = require('./features.util');
const { hasPermission } = require('../middleware/permission.middleware');

/**
 * Is the caller the shop owner (or the platform admin acting inside the shop)?
 *
 * `req` absent = a script, a seeder, or an internal call with no cashier to
 * distrust. `req.isAdmin` is the platform admin, who carries no
 * `req.user.isOwner` — without that arm every admin-side sale in an enabled
 * shop would be refused the below-cost path (the M-7 trap `resolveWholesaleFlag`
 * already documents).
 */
function isOwnerLike(req) {
  if (!req) return true;
  return req.user?.isOwner === true || req.isAdmin === true;
}

/**
 * The shop's ceiling on a single line's discount, as a percent off the list
 * rate. `null`/absent/malformed = no cap, which is every shop that has never
 * set one. Bounded to 0..100 so a stored 500 cannot read as "unlimited" by
 * accident.
 *
 * @param {Object|null} shop
 * @returns {number|null}
 */
function maxLineDiscountPercentFor(shop) {
  const raw = shop?.settings?.maxLineDiscountPercent;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, 100);
}

/**
 * Resolve one line's negotiated rate into a stored rate + a derived discount.
 *
 * Rules, in the order they are checked — the order is the design, not an
 * accident, and it is why the "not asked for" case can never 403:
 *
 *   1. no rate named          -> { discount: 0 }, no error, flag or no flag
 *   2. capability off         -> 403
 *   3. caller lacks the perm  -> 403
 *   4. malformed / negative   -> 400
 *   5. equal to the list rate -> { discount: 0 }, no error ("never mind")
 *   6. above the list rate    -> 400 (a price INCREASE, not a negotiation)
 *   7. below cost, not owner  -> 403, naming no figure
 *   8. beyond the shop's cap  -> 400
 *   9. otherwise              -> the concession, quantized to paisa
 *
 * @param {Object}  input
 * @param {*}       input.raw            the client's `agreedUnitPrice`
 * @param {number}  input.listUnitPrice  the resolved list/tier rate, per base unit
 * @param {number}  input.quantity       the line quantity, in base units
 * @param {number} [input.buyingPrice]   per-base-unit cost, for the floor check
 * @param {Object} [input.shop]          the Shop document (for the cap)
 * @param {Object} [input.req]           the Express request (flag + permission)
 * @param {string} [input.productName]   named in every error message
 * @returns {{ agreedUnitPrice: number|undefined, discount: number }}
 * @throws {AppError} 403 capability/permission/floor, 400 malformed or capped
 */
function resolveLineRate({
  raw,
  listUnitPrice,
  quantity,
  buyingPrice = 0,
  shop = null,
  req = null,
  productName = '',
} = {}) {
  // Required lazily: `error.middleware` pulls in the logger, which pulls in
  // config — importing it at module scope makes this util unusable from the
  // scripts and seeders that have no app context. Same reason `pricing.util`
  // does it.
  const { AppError } = require('../middleware/error.middleware');

  const none = { agreedUnitPrice: undefined, discount: 0 };

  // 1. The line said nothing about a rate. Not a violation — see the header.
  if (raw === undefined || raw === null || raw === '') return none;

  const named = productName ? ` (${productName})` : '';
  const namedBn = productName ? ` (${productName})` : '';

  // 2. The shop was never given the capability.
  if (!hasFeature(req, 'lineDiscount')) {
    throw new AppError(
      `Per-item discount is not enabled for this shop${named}`,
      `এই দোকানে পণ্যভিত্তিক ছাড় সুবিধা চালু নেই${namedBn}`,
      403
    );
  }

  // 3. This cashier may sell, but may not give money away doing it.
  if (req && !hasPermission(req, 'sales', 'discount')) {
    throw new AppError(
      'You do not have permission to give a per-item discount',
      'আপনার পণ্যভিত্তিক ছাড় দেওয়ার অনুমতি নেই',
      403
    );
  }

  // 4. Malformed. Refused rather than coerced to 0: a cashier who typed
  //    something must not be told the sale went through at the list price.
  const agreed = Number(raw);
  if (!Number.isFinite(agreed) || agreed < 0) {
    throw new AppError(
      `Invalid agreed price${named}`,
      `দাম ঠিকভাবে লিখুন${namedBn}`,
      400
    );
  }

  const list = Number(listUnitPrice);
  const qty = Number(quantity);
  if (!Number.isFinite(list) || list <= 0 || !Number.isFinite(qty) || qty <= 0) {
    // Nothing to discount FROM. Not the client's fault and not worth failing a
    // sale over — a ৳0 product is already refused upstream by `createSale`.
    return none;
  }

  // 5. The list price typed back in. "Never mind" — store nothing, so the
  //    invoice does not print a strikethrough against an identical number.
  if (agreed === list) return none;

  // 6. A price INCREASE. Almost always a fat finger (৯০০ for ৯০), and the
  //    negative discount it would produce is caught by the schema's `min: 0`
  //    only by luck.
  if (agreed > list) {
    throw new AppError(
      `Agreed price is above the list price${named}`,
      `দাম তালিকা মূল্যের চেয়ে বেশি হতে পারবে না${namedBn}`,
      400
    );
  }

  // 7. Below cost. THE guard this feature exists to have — a cashier selling
  //    under the buying price unsupervised is the real loss, and clearing
  //    short-dated stock at a loss is a decision the owner makes.
  //
  //    The message names NO figure. `buyingPrice` sits behind
  //    `products.view_cost`, and an error that leaks it would hand every
  //    cashier a cost oracle: type ৳1, read the refusal, binary search.
  const cost = Number(buyingPrice);
  if (Number.isFinite(cost) && cost > 0 && agreed < cost && !isOwnerLike(req)) {
    throw new AppError(
      `Agreed price is below cost — owner approval required${named}`,
      `এই দামে বিক্রি করা যাবে না — মালিকের অনুমতি লাগবে${namedBn}`,
      403
    );
  }

  // 8. The shop's own leash. Checked on the PERCENTAGE off list, not on the
  //    taka, so one cap is meaningful across a ৳10 pen and a ৳10,000 sack.
  const cap = maxLineDiscountPercentFor(shop);
  if (cap !== null) {
    const percentOff = ((list - agreed) / list) * 100;
    // Tolerance of a hundredth of a percent: the cashier types a PRICE and the
    // cap is a PERCENT, so a shop capped at 15% has no typeable rate that lands
    // exactly on 15% for most list prices. Without it, the obvious ৳85 against
    // a ৳100 list at a 15% cap fails on float dust.
    if (percentOff > cap + 0.01) {
      throw new AppError(
        `Discount exceeds this shop's limit of ${cap}%${named}`,
        `এই দোকানে সর্বোচ্চ ${cap}% ছাড় দেওয়া যাবে${namedBn}`,
        400
      );
    }
  }

  // 9. The concession. Quantized for the same reason every other line figure is
  //    — an unrounded product of a fractional quantity and a paisa price
  //    propagates into the subtotal, the profit and every report downstream.
  return {
    agreedUnitPrice: agreed,
    discount: quantizeMoney((list - agreed) * qty),
  };
}

module.exports = {
  maxLineDiscountPercentFor,
  resolveLineRate,
};
