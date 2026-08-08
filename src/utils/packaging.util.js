/**
 * Packaging Utility — turning "৫ কার্টন" into a base-unit quantity, once.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A cart line can arrive two ways:
 *
 *     { quantity: 100 }                          sold loose, in the base unit
 *     { saleUnit: 'pack', packQuantity: 5 }      sold as 5 whole packs
 *
 * `resolveLineQuantity` collapses both into ONE number in the product's base
 * unit, plus a snapshot of how the customer actually bought it. Everything
 * downstream — the `$gte` stock guard, the bulkWrite, FEFO, the stock ledger,
 * the profit calculation — keeps seeing exactly the shape it has always seen.
 *
 * That is the whole design. There is no second stock column, no unpacking
 * transaction, no "which carton did this piece come from". The carton is a
 * multiplication that happens here and nowhere else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE PACK SIZE IS SNAPSHOTTED ONTO THE LINE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Suppliers change pack sizes. A carton of 20 becomes a carton of 24 next
 * quarter, the shopkeeper edits the product, and every invoice ever printed
 * would silently re-read "5 cartons" as 120 pieces instead of 100 — the totals
 * would no longer match the money that changed hands.
 *
 * So the line stores `packSize` as it was at the moment of sale. The product
 * holds the CURRENT default; the line holds the HISTORICAL fact. Same reason
 * `productName` is denormalised onto the line rather than joined.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FEATURE GATE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Without `features.packaging` a pack sale is not merely hidden, it is REFUSED:
 * `packSaleAllowed` returns false and the line falls back to the plain
 * `quantity` path. A shop that never turned the feature on posts and receives
 * byte-identical payloads to before this file existed (I-6).
 */
const { AppError } = require('../middleware/error.middleware');
const { hasFeature } = require('../utils/features.util');
const { unitLabel, outerUnitsFor, DEFAULT_UNIT } = require('../config/units');
const { parseQuantity, quantize, quantizeMoney } = require('./quantity.util');

/** The two ways a line can be priced and counted. */
const SALE_UNIT_MODES = Object.freeze(['base', 'pack']);

/**
 * Pack size for a product, as a plain number, safe on any document shape.
 *
 * Works on hydrated documents, `.lean()` results and cached plain objects
 * alike — `packaging` is `default: undefined`, so `product.packaging.x` throws
 * for most products and a hydrated-only helper would be a landmine in the lean
 * read paths.
 *
 * @param {Object|null} product
 * @returns {number|null} null when the product has no usable pack
 */
function packSizeOf(product) {
  const p = product?.packaging;
  if (!p || !p.enabled) return null;
  const n = Number(p.unitsPerPack);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The pack's unit key ('carton'), or null. */
function packUnitOf(product) {
  return packSizeOf(product) != null ? (product.packaging.packUnit || null) : null;
}

/**
 * Price of one whole pack.
 *
 * An empty `packSellingPrice` is not zero — it means "no wholesale rate, just
 * charge the retail price times the count", which is what most shops do. Only
 * an explicitly positive figure overrides.
 *
 * @param {Object} product
 * @returns {number|null}
 */
function packSellingPriceOf(product) {
  const size = packSizeOf(product);
  if (size == null) return null;
  const explicit = Number(product.packaging.packSellingPrice);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return quantizeMoney((product.sellingPrice || 0) * size);
}

/** As above, for cost. Used by purchase entry when the supplier quotes packs. */
function packBuyingPriceOf(product) {
  const size = packSizeOf(product);
  if (size == null) return null;
  const explicit = Number(product.packaging.packBuyingPrice);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return quantizeMoney((product.buyingPrice || 0) * size);
}

/**
 * May THIS request sell THIS product by the pack?
 *
 * Three conditions, all required. The flag is checked first and separately from
 * the data so that turning the feature off instantly stops pack sales without
 * having to touch a single product document.
 *
 * @param {Object|null} req
 * @param {Object} product
 * @returns {boolean}
 */
function packSaleAllowed(req, product) {
  if (!hasFeature(req, 'packaging')) return false;
  if (packSizeOf(product) == null) return false;
  return product.packaging.sellByPack !== false;
}

/**
 * May THIS request RECEIVE this product by the pack?
 *
 * Deliberately does NOT consult `sellByPack`. That switch answers "will a
 * customer ever walk out with a whole one of these", and the answer is
 * routinely no for something that is nevertheless always *bought* by the sack —
 * loose rice, loose sugar, anything decanted on arrival. Gating purchase entry
 * on a selling preference would force shopkeepers to toggle a sales setting to
 * record a delivery.
 *
 * @param {Object|null} req
 * @param {Object} product
 * @returns {boolean}
 */
function packPurchaseAllowed(req, product) {
  if (!hasFeature(req, 'packaging')) return false;
  return packSizeOf(product) != null;
}

/**
 * Validate a product's packaging block on create/update.
 *
 * Returns the value to store — `undefined` to clear it, so an update that
 * disables packaging removes the subdocument instead of leaving a half-filled
 * one behind that `packSizeOf` would then have to keep stepping around.
 *
 * @param {Object|undefined} raw     the client's `packaging` object
 * @param {string} baseUnit          the product's `unit`
 * @param {boolean} packagingEnabled the shop's feature flag
 * @returns {Object|undefined}
 * @throws {AppError} 400
 */
function normalizePackaging(raw, baseUnit = DEFAULT_UNIT, packagingEnabled = false) {
  if (!raw || raw.enabled !== true) return undefined;

  // Not a silent drop: a shop posting packaging without the flag is a client
  // out of sync with its own entitlements, and silently ignoring it would ship
  // a product whose form said "20 per carton" and whose data said nothing.
  if (!packagingEnabled) {
    throw new AppError(
      'Packaging is not enabled for this shop',
      'এই দোকানে মোড়ক সুবিধা চালু নেই',
      403
    );
  }

  const packUnit = String(raw.packUnit || '').trim();
  if (!packUnit) {
    throw new AppError('packUnit is required', 'মোড়কের ধরন বাছাই করুন', 400);
  }

  // The one rule that stops a লিটার-per-কেজি pack from ever being stored. Same
  // list the product form renders from, so the UI can never offer a choice the
  // server rejects.
  const allowed = outerUnitsFor(baseUnit);
  if (!allowed.includes(packUnit)) {
    throw new AppError(
      `"${packUnit}" cannot hold "${baseUnit}"`,
      `${unitLabel(baseUnit)} এর মোড়ক হিসেবে ${unitLabel(packUnit)} ব্যবহার করা যাবে না`,
      400
    );
  }

  // Parsed against the BASE unit, not the pack: "how many kg in a sack" must
  // obey the kg precision rule, and "how many pieces in a carton" must refuse
  // 20.5 the same way a piece quantity does.
  const unitsPerPack = parseQuantity(raw.unitsPerPack, baseUnit, {
    label: 'প্রতি মোড়কে পরিমাণ',
  });

  const money = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return quantizeMoney(n);
  };

  return {
    enabled: true,
    packUnit,
    unitsPerPack,
    packBuyingPrice: money(raw.packBuyingPrice),
    packSellingPrice: money(raw.packSellingPrice),
    // `!== false` rather than `=== true`: an older client that does not send
    // these fields at all must get the schema's permissive default, not have
    // both selling modes switched off.
    sellByPack: raw.sellByPack !== false,
    sellByUnit: raw.sellByUnit !== false,
  };
}

/**
 * Collapse one incoming line into a base-unit quantity plus its snapshot.
 *
 * This is the ONLY place a pack count becomes a base quantity. If you find
 * yourself writing `x * packSize` anywhere else, route it through here instead
 * — the validation, the flag gate and the snapshot all live together on
 * purpose.
 *
 * @param {Object} item     the raw client line
 * @param {Object} product  the resolved product document
 * @param {Object|null} req for the feature flag
 * @param {Object} [opts]
 * @param {string} opts.qtyUnit  the unit `parseQuantity` should gate against
 *                               (`quantityUnit(req, product)` — flag-dependent)
 * @param {string} [opts.flow]   'sale' (default) or 'purchase'. Only changes
 *                               which gate applies — see `packPurchaseAllowed`.
 * @returns {{
 *   quantity: number,        always in the base unit
 *   mode: string,            'base' | 'pack'
 *   unit: string,            base unit snapshot
 *   packUnit: string|null,
 *   packSize: number|null,
 *   packQuantity: number|null
 * }}
 * @throws {AppError} 400
 */
function resolveLineQuantity(item, product, req, opts = {}) {
  const baseUnit = product?.unit || DEFAULT_UNIT;
  const qtyUnit = opts.qtyUnit || DEFAULT_UNIT;
  const flow = opts.flow === 'purchase' ? 'purchase' : 'sale';

  const wantsPack = item?.saleUnit === 'pack' || item?.purchaseUnit === 'pack';

  if (!wantsPack) {
    return {
      quantity: parseQuantity(item.quantity, qtyUnit, { label: product.name }),
      mode: 'base',
      unit: baseUnit,
      packUnit: null,
      packSize: null,
      packQuantity: null,
    };
  }

  const allowed = flow === 'purchase'
    ? packPurchaseAllowed(req, product)
    : packSaleAllowed(req, product);

  if (!allowed) {
    throw new AppError(
      `Product ${product.name} cannot be transacted by the pack`,
      flow === 'purchase'
        ? `${product.name} এর মোড়কের তথ্য দেওয়া নেই`
        : `${product.name} মোড়ক হিসেবে বিক্রি করা যাবে না`,
      400
    );
  }

  const packSize = packSizeOf(product);
  const packUnit = packUnitOf(product);

  // Pack COUNT is parsed against the pack unit — every `pack`-group unit is
  // `decimals: 0`, so "2.5 cartons" is refused here rather than turning into a
  // half-carton of stock nobody can put on a shelf. A shopkeeper selling half a
  // carton sells the pieces instead, which is the whole point of the feature.
  const packQuantity = parseQuantity(item.packQuantity ?? item.quantity, packUnit, {
    label: product.name,
  });

  // Quantized at the BASE unit: 3 packs of 0.333 kg is 0.999 kg, not
  // 0.9990000000000001, and that value is about to be compared against stock
  // by an exact `$gte`.
  const quantity = quantize(packQuantity * packSize, baseUnit);

  return {
    quantity,
    mode: 'pack',
    unit: baseUnit,
    packUnit,
    packSize,
    packQuantity,
  };
}

/**
 * Per-base-unit price for a resolved line.
 *
 * `unitPrice` stays the per-BASE-unit figure on every line, pack or not, so
 * every existing report, profit calculation and CSV export keeps working
 * without learning what a pack is. A pack line simply derives it by division.
 *
 * The division is deliberately NOT rounded to paisa here. Rounding 1000/3 to
 * 333.33 and multiplying back gives ৳999.99 for a pack the customer was quoted
 * ৳1000 at — the line total must reproduce the price the shopkeeper actually
 * said. Money is rounded once, on the total, by `quantizeMoney`.
 *
 * @param {Object} resolved  the return of `resolveLineQuantity`
 * @param {number} basePrice the product's per-base-unit price
 * @param {number|null} packPrice price of one whole pack, when selling by pack
 * @returns {number}
 */
function unitPriceFor(resolved, basePrice, packPrice) {
  if (resolved.mode !== 'pack') return basePrice;
  if (!Number.isFinite(packPrice) || packPrice <= 0) return basePrice;
  if (!resolved.packSize) return basePrice;
  return packPrice / resolved.packSize;
}

module.exports = {
  SALE_UNIT_MODES,
  packSizeOf,
  packUnitOf,
  packSellingPriceOf,
  packBuyingPriceOf,
  packSaleAllowed,
  packPurchaseAllowed,
  normalizePackaging,
  resolveLineQuantity,
  unitPriceFor,
};
