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

/**
 * Derived availability and live cost of one combo.
 *
 * `available` = min over components of floor(componentStock / quantity).
 * `cost`      = Σ component buyingPrice × quantity — what one combo costs the
 *               shop TODAY, which is what the margin warning compares against
 *               the combo's fixed sellingPrice.
 *
 * A component that is missing, soft-deleted, deactivated, or whose variant has
 * been removed makes the combo unsellable: `available` is 0 and `broken` names
 * the reason, so the UI can say WHY instead of showing a mute zero. This is
 * advisory — the sale path re-checks everything under its own atomic guard.
 *
 * @param {Object} combo    a combo product (lean or hydrated)
 * @param {Map}    compMap  Map<string productId, component doc>
 * @returns {{available: number, cost: number, broken: string|null}}
 */
function computeComboAvailability(combo, compMap) {
  const items = Array.isArray(combo?.comboItems) ? combo.comboItems : [];
  if (!items.length) return { available: 0, cost: 0, broken: 'empty' };

  let available = Infinity;
  let cost = 0;

  for (const ci of items) {
    const comp = compMap.get(String(ci.product));
    if (!comp || comp.isDeleted) {
      return { available: 0, cost: 0, broken: 'component_deleted' };
    }
    if (comp.isActive === false) {
      return { available: 0, cost: 0, broken: 'component_inactive' };
    }

    let stock;
    let buying;
    if (ci.variantId) {
      const variant = findComponentVariant(comp, ci.variantId);
      if (!variant || variant.isActive === false) {
        return { available: 0, cost: 0, broken: 'variant_missing' };
      }
      stock = variant.stock || 0;
      buying = variant.buyingPrice ?? comp.buyingPrice ?? 0;
    } else {
      stock = comp.stock || 0;
      buying = comp.buyingPrice || 0;
    }

    const qty = Number(ci.quantity) || 0;
    if (qty <= 0) return { available: 0, cost: 0, broken: 'empty' };

    available = Math.min(available, Math.floor(stock / qty));
    cost += buying * qty;
  }

  return {
    available: Number.isFinite(available) ? Math.max(0, available) : 0,
    cost: quantizeMoney(cost),
    broken: null,
  };
}

module.exports = {
  isCombo,
  assertNotCombo,
  findComponentVariant,
  computeComboAvailability,
};
