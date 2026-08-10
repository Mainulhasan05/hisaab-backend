/**
 * Pricing Utility — which price list a sale is rung up against, decided once.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A shop with `features.wholesale` on keeps two prices per product:
 *
 *     sellingPrice     what a walk-in pays          (always present)
 *     wholesalePrice   what a পাইকারি buyer pays    (optional, often absent)
 *
 * and marks the buyers who get the second one with `Customer.isWholesale`.
 * Everything that question touches is here, in two functions:
 *
 *     priceTierFor(req, customer)      -> 'retail' | 'wholesale'
 *     sellingPriceFor(entity, tier)    -> a number
 *
 * `entity` is a product OR a variant subdocument, deliberately: both carry
 * `sellingPrice` and `wholesalePrice` with identical meaning, and giving the
 * two shapes two functions is how one of them silently keeps charging retail.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FALLBACK IS THE FEATURE, NOT A DEGRADED MODE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A product with no wholesale price sells to a wholesale customer at the RETAIL
 * price, silently. That is not a gap to be closed later — it is what makes the
 * feature adoptable. A shop turns it on holding a thousand priced products; if
 * a wholesale sale required a second price on every one of them first, nobody
 * would get past the first invoice. They fill them in as they go, and every
 * unfilled product keeps behaving exactly as it did yesterday.
 *
 * The client is told which lines fell back, so it is visible rather than
 * mysterious — but the sale always goes through. A till that refuses to sell is
 * worse than a till that charges the price already on the shelf.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE TIER IS RESOLVED FROM THE CUSTOMER DOCUMENT, NOT FROM THE REQUEST
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The client never says "this is a wholesale sale". It says "this sale is for
 * customer X", and the server looks X up. Anything else is a price list the
 * caller can pick, which at a till means any cashier with the network tab open
 * can buy at wholesale.
 *
 * That is also why `createSale` resolves its customer BEFORE the item loop
 * rather than after it, where the customer block used to live. See the note at
 * that call site — the ordering is load-bearing, not tidiness.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ZERO IS ABSENT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `wholesalePrice: 0` reads as "no wholesale rate", exactly as
 * `packSellingPrice: 0` does. A cleared number input posts 0, and billing a
 * carton of rice at ৳0 because someone emptied a box is not a discount. Only a
 * finite positive figure overrides. This is why the form may send '' freely.
 */
const { hasFeature } = require('./features.util');

/** The two price lists. `retail` is what every shop has always had. */
const PRICE_TIERS = Object.freeze(['retail', 'wholesale']);

/** The tier a shop without the feature — or without a customer — is on. */
const DEFAULT_TIER = 'retail';

/**
 * Which price list applies to this request's customer?
 *
 * Fails CLOSED on every uncertainty: no request, no flag, no customer, a
 * walk-in, a customer document that predates the field. Retail is the answer
 * that cannot overcharge or undercharge anyone who was not deliberately marked.
 *
 * @param {Object|null} req       the Express request (needs `req.shop`)
 * @param {Object|null} customer  the resolved Customer document, or null
 * @returns {'retail'|'wholesale'}
 */
function priceTierFor(req, customer) {
  if (!hasFeature(req, 'wholesale')) return DEFAULT_TIER;
  return customer?.isWholesale === true ? 'wholesale' : DEFAULT_TIER;
}

/**
 * Is there a usable wholesale rate on this product or variant?
 *
 * Separate from `sellingPriceFor` because the POS needs to SAY when a line fell
 * back to retail, and re-deriving that from "the two numbers came out equal"
 * would be wrong for any product whose two prices genuinely match.
 *
 * @param {Object|null} entity  a product document, variant subdoc, lean object
 * @returns {boolean}
 */
function hasWholesalePrice(entity) {
  const n = Number(entity?.wholesalePrice);
  return Number.isFinite(n) && n > 0;
}

/**
 * The price one base unit of `entity` sells for on `tier`.
 *
 * Never throws and never returns undefined — a missing `sellingPrice` comes
 * back as 0, which is what the callers already assumed when they read
 * `product.sellingPrice` directly. Guarding it here does not fix a product with
 * no price; `createSale`'s own check does that, with the product's name in the
 * message.
 *
 * @param {Object|null} entity
 * @param {'retail'|'wholesale'} tier
 * @returns {number}
 */
function sellingPriceFor(entity, tier) {
  if (tier === 'wholesale' && hasWholesalePrice(entity)) {
    return Number(entity.wholesalePrice);
  }
  const retail = Number(entity?.sellingPrice);
  return Number.isFinite(retail) ? retail : 0;
}

/**
 * Validate a wholesale price on product create/update.
 *
 * Returns the value to STORE: `undefined` clears the field, so a shopkeeper who
 * empties the box gets no wholesale rate rather than a ৳0 one that would bill
 * the next পাইকারি customer nothing.
 *
 * Mirrors `packaging.util.normalizePackaging`, including the 403: a client
 * posting a wholesale price without the flag is out of sync with its own
 * entitlements, and swallowing it would ship a product whose form showed
 * ৳৮/পিস and whose data held nothing. Saying so is how that gets noticed.
 *
 * A cleared or absent value is NOT a violation, even with the flag off — that
 * is the shape every product form in a flag-off shop posts, and refusing it
 * would 403 every ordinary product edit on the platform.
 *
 * @param {*} raw                    the client's `wholesalePrice`
 * @param {boolean} wholesaleEnabled the shop's feature flag
 * @param {Object} [opts]
 * @param {string} [opts.label]      what to name in the error (variant SKU)
 * @returns {number|undefined}
 * @throws {AppError} 403 flag off, 400 malformed
 */
function normalizeWholesalePrice(raw, wholesaleEnabled = false, opts = {}) {
  // Required lazily: error.middleware pulls in the logger, which pulls in
  // config — importing it at module scope makes this util unusable from the
  // scripts and seeders that have no app context.
  const { AppError } = require('../middleware/error.middleware');

  if (raw === undefined || raw === null || raw === '') return undefined;

  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new AppError(
      `Invalid wholesale price${opts.label ? ` for ${opts.label}` : ''}`,
      'পাইকারি দাম ঠিকভাবে লিখুন',
      400
    );
  }

  // Cleared, or explicitly zero. Both mean "no wholesale rate", and both are
  // legal with the flag off — otherwise every product edit in every flag-off
  // shop would 403 the moment a form sent an empty box.
  if (n === 0) return undefined;

  if (!wholesaleEnabled) {
    throw new AppError(
      'Wholesale pricing is not enabled for this shop',
      'এই দোকানে পাইকারি বিক্রি সুবিধা চালু নেই',
      403
    );
  }

  return n;
}

/**
 * What `Customer.isWholesale` should become, given what the client sent.
 *
 * ── Why this exists rather than just reading `updateData.isWholesale` ────────
 *
 * `customer.service.updateCustomer` ends in `Object.assign(customer, body)`,
 * and the customer routes carry no Joi schema. So a field added to the Customer
 * schema is settable by ANY caller with `customers.update` the moment it
 * exists — no flag check, no role check, nothing. This particular field decides
 * what the shop charges, which makes that a cashier granting themselves
 * wholesale rates.
 *
 * Two gates, both required:
 *
 *   1. the shop must have `features.wholesale`, or the flag is meaningless and
 *      setting it arms a capability nobody bought
 *   2. the caller must be the owner (or the platform admin) — the rule
 *      `openingDue` already follows, for the same reason: a cashier must not
 *      move money on their own authority
 *
 * `undefined` back means "the client said nothing about this field, leave the
 * stored value alone". That case matters most on the flag-OFF path: an ordinary
 * name edit at a shop whose capability was just switched off must not silently
 * demote a wholesale customer, because switching it back on is supposed to
 * restore exactly what was there.
 *
 * @param {*} raw           the client's `isWholesale`
 * @param {Object|null} req
 * @returns {boolean|undefined}
 * @throws {AppError} 403
 */
function resolveWholesaleFlag(raw, req) {
  const { AppError } = require('../middleware/error.middleware');

  if (raw === undefined || raw === null || raw === '') return undefined;

  const next = raw === true || raw === 'true';

  if (!hasFeature(req, 'wholesale')) {
    throw new AppError(
      'Wholesale pricing is not enabled for this shop',
      'এই দোকানে পাইকারি বিক্রি সুবিধা চালু নেই',
      403
    );
  }

  // `req` absent = a script or seeder, which has no cashier to distrust.
  // `isAdmin` is the platform admin writing into a shop, who carries no
  // `req.user.isOwner` — without the exemption every admin-side customer edit
  // in a wholesale shop would 403 (M-7).
  if (req && !req.user?.isOwner && !req.isAdmin) {
    throw new AppError(
      'Only the shop owner can mark a customer as wholesale',
      'শুধুমাত্র দোকান মালিক কাউকে পাইকারি কাস্টমার করতে পারবেন',
      403
    );
  }

  return next;
}

module.exports = {
  PRICE_TIERS,
  DEFAULT_TIER,
  priceTierFor,
  hasWholesalePrice,
  sellingPriceFor,
  normalizeWholesalePrice,
  resolveWholesaleFlag,
};
