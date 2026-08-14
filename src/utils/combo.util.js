/**
 * Combo products — shared helpers.
 *
 * A combo (`Product.type === 'combo'`) is a sellable bundle of other products.
 * It carries NO stock of its own: how many can be sold is derived from its
 * components' stock, and selling one deducts each component through the same
 * $gte-guarded bulk ops an ordinary line uses. See the block comment on
 * `comboItemSchema` in models/Product.model.js.
 *
 * These helpers exist so the sale, purchase, transfer and product paths all
 * answer "is this a combo / what can it do" the same way.
 */

const { AppError } = require('../middleware/error.middleware');
const { quantizeMoney } = require('./quantity.util');

/** Is this product a combo? Null-safe: absent `type` means 'standard'. */
function isCombo(product) {
  return product?.type === 'combo';
}

/**
 * Refuse an operation that makes no sense on a combo.
 *
 * A combo has no stock, so it cannot be purchased, manually adjusted,
 * transferred between branches, or batch/serial tracked. Every one of those
 * paths calls this right after resolving the product — a combo reaching a
 * stock-in write would mint phantom inventory that no shelf holds.
 *
 * @param {Object} product
 * @param {string} contextBn  what the caller was trying to do, in Bengali
 */
function assertNotCombo(product, contextBn = 'এই কাজটি') {
  if (isCombo(product)) {
    throw new AppError(
      `"${product.name}" is a combo — it has no stock of its own. Adjust the component products instead.`,
      `"${product.name}" একটি কম্বো — এর নিজস্ব স্টক নেই। ${contextBn} কম্বোতে করা যাবে না, উপাদান পণ্যগুলোতে করুন।`,
      400
    );
  }
}

/** The component's variant subdocument, tolerant of lean and hydrated docs. */
function findComponentVariant(component, variantId) {
  if (!variantId || !component) return null;
  const variants = component.variants;
  if (!variants) return null;
  if (typeof variants.id === 'function') return variants.id(variantId);
  return variants.find((v) => String(v._id || v.id) === String(variantId)) || null;
}

/** Is this slot's variant decided at the till rather than at build time? */
function isChooseSlot(comboItem) {
  return comboItem?.variantMode === 'choose';
}

/**
 * The variants a 'choose' slot may draw from: every ACTIVE one.
 *
 * A deactivated variant is not sellable on its own, so it must not prop up a
 * combo's availability either — otherwise the badge counts stock the till will
 * refuse.
 */
function eligibleVariants(component) {
  return (component?.variants || []).filter((v) => v && v.isActive !== false);
}

/**
 * Derived availability and live cost of one combo.
 *
 * ── AVAILABILITY ─────────────────────────────────────────────────────────────
 * A 'fixed' slot draws from one variant's stock. A 'choose' slot draws from the
 * SUM of the component's active variants, because the cashier may pick any of
 * them — and slots of the same product COMPETE for that one pool, so their
 * requirements are grouped per product before dividing rather than divided row
 * by row. Dividing per row would count the same shirt twice.
 *
 * Per product, the answer is the smaller of:
 *   • each pinned variant's own stock ÷ what the fixed slots want from it, and
 *   • the whole active pool ÷ what EVERY slot wants (choose slots can eat the
 *     pinned variants' stock too, so both demands are charged to the pool).
 *
 * That is an upper bound, not an exact count: deciding whether N combos fit is
 * an assignment problem once a pinned and a free slot contend for one variant.
 * The looseness is deliberate and safe — this number has always been advisory,
 * and `createSale` re-checks every component under its own atomic $gte guard,
 * so a generous badge can never oversell. It can only show 3 where the till
 * then says "স্টক নেই", which is the staleness the feature already accepts.
 *
 * ── COST ─────────────────────────────────────────────────────────────────────
 * With a 'choose' slot the shop's cost depends on which variant goes out, so
 * cost is a range. `cost` is the WORST case (the priciest eligible variant of
 * every slot) because the only question the margin warning has to answer is
 * "can I lose money on this?", and the cheapest combination cannot answer it.
 * `costMin` is exposed alongside for the builder's second line. For a combo
 * with no 'choose' slot the two are equal and `cost` is what it always was.
 *
 * A component that is missing, soft-deleted, deactivated, or whose pinned
 * variant has been removed makes the combo unsellable: `available` is 0 and
 * `broken` names the reason, so the UI can say WHY instead of showing a mute
 * zero.
 *
 * @param {Object} combo    a combo product (lean or hydrated)
 * @param {Map}    compMap  Map<string productId, component doc>
 * @returns {{available: number, cost: number, costMin: number, broken: string|null}}
 */
function computeComboAvailability(combo, compMap) {
  const items = Array.isArray(combo?.comboItems) ? combo.comboItems : [];
  if (!items.length) return { available: 0, cost: 0, costMin: 0, broken: 'empty' };

  const broke = (reason) => ({ available: 0, cost: 0, costMin: 0, broken: reason });

  let costMax = 0;
  let costMin = 0;
  // Per component product: what the pinned variants owe, what every slot owes,
  // and the pool they share. Keyed by product id so slots of one product are
  // charged against one set of shelves.
  const demand = new Map();

  for (const ci of items) {
    const productId = String(ci.product);
    const comp = compMap.get(productId);
    if (!comp || comp.isDeleted) return broke('component_deleted');
    if (comp.isActive === false) return broke('component_inactive');

    const qty = Number(ci.quantity) || 0;
    if (qty <= 0) return broke('empty');

    let entry = demand.get(productId);
    if (!entry) {
      entry = { comp, totalNeed: 0, pinned: new Map(), pooled: false };
      demand.set(productId, entry);
    }
    entry.totalNeed += qty;

    if (isChooseSlot(ci)) {
      const variants = eligibleVariants(comp);
      if (!variants.length) return broke('variant_missing');

      entry.pooled = true;
      const buyings = variants.map((v) => v.buyingPrice ?? comp.buyingPrice ?? 0);
      costMax += Math.max(...buyings) * qty;
      costMin += Math.min(...buyings) * qty;
    } else if (ci.variantId) {
      const variant = findComponentVariant(comp, ci.variantId);
      if (!variant || variant.isActive === false) return broke('variant_missing');

      const key = String(variant._id || variant.id);
      entry.pinned.set(key, {
        stock: variant.stock || 0,
        need: (entry.pinned.get(key)?.need || 0) + qty,
      });
      const buying = variant.buyingPrice ?? comp.buyingPrice ?? 0;
      costMax += buying * qty;
      costMin += buying * qty;
    } else {
      // No variants at all — the product's own shelf is the pool.
      const buying = comp.buyingPrice || 0;
      costMax += buying * qty;
      costMin += buying * qty;
    }
  }

  let available = Infinity;
  for (const entry of demand.values()) {
    const { comp, totalNeed, pinned, pooled } = entry;

    for (const { stock, need } of pinned.values()) {
      if (need > 0) available = Math.min(available, Math.floor(stock / need));
    }

    if (pooled) {
      // Every slot of this product — pinned and free alike — is charged to the
      // shared pool, because a free slot may take the pinned variant's units.
      const poolStock = eligibleVariants(comp).reduce((sum, v) => sum + (v.stock || 0), 0);
      available = Math.min(available, Math.floor(poolStock / totalNeed));
    } else if (!pinned.size) {
      available = Math.min(available, Math.floor((comp.stock || 0) / totalNeed));
    }
  }

  return {
    available: Number.isFinite(available) ? Math.max(0, available) : 0,
    cost: quantizeMoney(costMax),
    costMin: quantizeMoney(costMin),
    broken: null,
  };
}

module.exports = {
  isCombo,
  assertNotCombo,
  findComponentVariant,
  isChooseSlot,
  eligibleVariants,
  computeComboAvailability,
};
