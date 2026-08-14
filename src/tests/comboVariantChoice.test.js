/**
 * Combos whose variant is chosen at the till — the invariants.
 *
 * The problem this exists to kill: a shirt sold in six colours used to need
 * SIX combo products, because a combo component had to name one variant when
 * the combo was built. It now says "this shirt, any colour" and the cashier
 * answers at billing, which is where the customer actually decides.
 *
 *   1. SLOT SHAPE. `variantMode: 'choose'` on a component means "decided at
 *      the till"; `variantId` must be absent. Default is 'fixed', so every
 *      combo built before this is unchanged.
 *   2. SLOTS MAY REPEAT. Two 'choose' rows of ONE product are two independent
 *      slots — that is how "১টা কিনলে ১টা ফ্রি, দুইটা আলাদা রঙ" is expressed —
 *      while two rows pinned to the same variant are still a duplicate.
 *   3. POOLED AVAILABILITY. A 'choose' slot draws from the SUM of active
 *      variants, and slots of one product compete for that one pool rather
 *      than each dividing it separately.
 *   4. WORST-CASE COST. The combo's price is fixed; its cost is not, because
 *      variants cost different amounts. `cost` is the priciest combination —
 *      the only one that can answer "can I lose money on this?" — with
 *      `costMin` alongside.
 *   5. CONFIDENTIALITY. The new cost figures are cost figures: stripped for
 *      roles without view_cost, exactly like `buyingPrice`.
 *   6. UNCHANGED. A pinned combo behaves exactly as it did.
 */

const mongoose = require('mongoose');

const Product = require('../models/Product.model');
const HeldCart = require('../models/HeldCart.model');
const Sale = require('../models/Sale.model');
const {
  computeComboAvailability,
  isChooseSlot,
  eligibleVariants,
} = require('../utils/combo.util');
const { sanitizeProducts, COST_KEYS } = require('../utils/dataSanitizer.util');
const productValidation = require('../validations/product.validation');

const id = () => new mongoose.Types.ObjectId();
const SHOP = id();

/** A component product with variants, priced so cost and retail differ per variant. */
const shirtWithVariants = (variants) => ({
  _id: id(),
  name: 'Shirt',
  code: 'SH',
  hasVariants: true,
  buyingPrice: 100,
  sellingPrice: 200,
  variants,
});

const variant = (over = {}) => ({
  _id: id(), sku: 'SKU', attributes: { color: 'blue' },
  stock: 10, buyingPrice: 100, sellingPrice: 200, isActive: true, ...over,
});

// ── 1. Slot shape ───────────────────────────────────────────────────────────

describe('comboItemSchema: variantMode', () => {
  it('defaults to fixed, so every combo built before this is untouched', () => {
    const p = new Product({
      shop: SHOP, code: 'CMB', name: 'Eid Pack', type: 'combo', sellingPrice: 250,
      comboItems: [{ product: id(), quantity: 1 }],
    });
    expect(p.comboItems[0].variantMode).toBe('fixed');
    expect(p.comboItems[0].variantId).toBeNull();
  });

  it('accepts a choose slot and rejects an unknown mode', () => {
    const ok = new Product({
      shop: SHOP, code: 'CMB', name: 'Eid Pack', type: 'combo', sellingPrice: 250,
      comboItems: [{ product: id(), variantMode: 'choose', quantity: 1 }],
    });
    expect(ok.validateSync()).toBeUndefined();
    expect(isChooseSlot(ok.comboItems[0])).toBe(true);

    const bad = new Product({
      shop: SHOP, code: 'CMB', name: 'Eid Pack', type: 'combo', sellingPrice: 250,
      comboItems: [{ product: id(), variantMode: 'whatever', quantity: 1 }],
    });
    expect(bad.validateSync()?.errors?.['comboItems.0.variantMode']).toBeDefined();
  });

  it('every slot carries its own _id, which is what a till selection names', () => {
    const p = new Product({
      shop: SHOP, code: 'CMB', name: 'BOGO', type: 'combo', sellingPrice: 500,
      comboItems: [
        { product: id(), variantMode: 'choose', quantity: 1 },
        { product: id(), variantMode: 'choose', quantity: 1 },
      ],
    });
    const [a, b] = p.comboItems;
    expect(a._id).toBeDefined();
    expect(String(a._id)).not.toBe(String(b._id));
  });

  it('Joi admits variantMode and still admits a payload without it', () => {
    const base = {
      name: 'Pack', category: String(id()), sellingPrice: 500, type: 'combo',
    };
    const withMode = productValidation.createProduct.validate({
      ...base,
      comboItems: [{ product: String(id()), variantMode: 'choose', quantity: 1 }],
    });
    expect(withMode.error).toBeUndefined();

    const legacy = productValidation.createProduct.validate({
      ...base,
      comboItems: [{ product: String(id()), variantId: String(id()), quantity: 1 }],
    });
    expect(legacy.error).toBeUndefined();

    const bogus = productValidation.createProduct.validate({
      ...base,
      comboItems: [{ product: String(id()), variantMode: 'any', quantity: 1 }],
    });
    expect(bogus.error).toBeDefined();
  });
});

// ── 2. Availability: one pool per product ───────────────────────────────────

describe('computeComboAvailability: choose slots', () => {
  it('a choose slot draws from the SUM of active variants, not from one', () => {
    const shirt = shirtWithVariants([
      variant({ stock: 3 }), variant({ stock: 4 }),
    ]);
    const combo = { comboItems: [{ product: shirt._id, variantMode: 'choose', quantity: 1 }] };
    const map = new Map([[String(shirt._id), shirt]]);

    expect(computeComboAvailability(combo, map).available).toBe(7);
  });

  it('ignores a deactivated variant — the till would refuse it too', () => {
    const shirt = shirtWithVariants([
      variant({ stock: 3 }), variant({ stock: 100, isActive: false }),
    ]);
    const combo = { comboItems: [{ product: shirt._id, variantMode: 'choose', quantity: 1 }] };

    expect(computeComboAvailability(combo, new Map([[String(shirt._id), shirt]])).available).toBe(3);
    expect(eligibleVariants(shirt)).toHaveLength(1);
  });

  it('two slots of one product COMPETE for the pool instead of each dividing it', () => {
    // 6 shirts, two slots of 1 each -> 3 combos. Dividing row by row would
    // count the same shirts twice and claim 6.
    const shirt = shirtWithVariants([variant({ stock: 6 })]);
    const combo = {
      comboItems: [
        { product: shirt._id, variantMode: 'choose', quantity: 1 },
        { product: shirt._id, variantMode: 'choose', quantity: 1 },
      ],
    };
    expect(computeComboAvailability(combo, new Map([[String(shirt._id), shirt]])).available).toBe(3);
  });

  it('a free slot is charged against a pinned variant’s stock too', () => {
    // Blue 10, Red 0. One slot pinned to Blue, one free: with only Blue on the
    // shelf every combo eats 2 Blue, so 5 — not the 10 the pinned row alone
    // would suggest.
    const blue = variant({ stock: 10 });
    const red = variant({ stock: 0 });
    const shirt = shirtWithVariants([blue, red]);
    const combo = {
      comboItems: [
        { product: shirt._id, variantMode: 'fixed', variantId: blue._id, quantity: 1 },
        { product: shirt._id, variantMode: 'choose', quantity: 1 },
      ],
    };
    expect(computeComboAvailability(combo, new Map([[String(shirt._id), shirt]])).available).toBe(5);
  });

  it('a choose slot on a component with no active variant is broken, not zero-by-accident', () => {
    const shirt = shirtWithVariants([variant({ isActive: false })]);
    const combo = { comboItems: [{ product: shirt._id, variantMode: 'choose', quantity: 1 }] };
    const out = computeComboAvailability(combo, new Map([[String(shirt._id), shirt]]));
    expect(out).toMatchObject({ available: 0, broken: 'variant_missing' });
  });
});

// ── 3. Cost is a range; the headline is the worst case ──────────────────────

describe('computeComboAvailability: cost with a choose slot', () => {
  it('cost is the priciest eligible variant, costMin the cheapest', () => {
    const shirt = shirtWithVariants([
      variant({ buyingPrice: 100 }), variant({ buyingPrice: 160 }),
    ]);
    const combo = { comboItems: [{ product: shirt._id, variantMode: 'choose', quantity: 2 }] };

    const out = computeComboAvailability(combo, new Map([[String(shirt._id), shirt]]));
    expect(out.cost).toBe(320);     // 160 x 2 — what the shop risks
    expect(out.costMin).toBe(200);  // 100 x 2
  });

  it('a pinned combo reports one number, exactly as it always did', () => {
    const v = variant({ buyingPrice: 130 });
    const shirt = shirtWithVariants([v, variant({ buyingPrice: 999 })]);
    const combo = {
      comboItems: [{ product: shirt._id, variantMode: 'fixed', variantId: v._id, quantity: 2 }],
    };
    const out = computeComboAvailability(combo, new Map([[String(shirt._id), shirt]]));
    expect(out.cost).toBe(260);
    expect(out.costMin).toBe(260);
  });
});

// ── 4. The new cost figures are confidential ────────────────────────────────

describe('sanitizers: the range is as confidential as the number', () => {
  it('registers every new cost key', () => {
    expect(COST_KEYS.has('comboCostMin')).toBe(true);
    expect(COST_KEYS.has('buyingPriceMin')).toBe(true);
  });

  it('strips comboCostMin and the per-row floor without view_cost', () => {
    const payload = [{
      _id: id(), name: 'Pack', type: 'combo', sellingPrice: 500,
      comboCost: 380, comboCostMin: 320,
      comboItems: [{ product: id(), variantMode: 'choose', buyingPrice: 160, buyingPriceMin: 100 }],
    }];

    const staffReq = { user: { isOwner: false, permissions: {} } };
    const ownerReq = { user: { isOwner: true } };

    const [hidden] = sanitizeProducts(payload, staffReq);
    expect(hidden.comboCost).toBeUndefined();
    expect(hidden.comboCostMin).toBeUndefined();
    expect(hidden.comboItems[0].buyingPrice).toBeUndefined();
    expect(hidden.comboItems[0].buyingPriceMin).toBeUndefined();

    const [shown] = sanitizeProducts(payload, ownerReq);
    expect(shown.comboCostMin).toBe(320);
  });
});

// ── 5. The picks must survive being parked ──────────────────────────────────

describe('HeldCart: a parked combo keeps its picks', () => {
  it('stores comboSelections instead of dropping them on a strict schema', () => {
    const slot = id();
    const chosen = id();
    const cart = new HeldCart({
      shop: SHOP,
      heldBy: id(),
      items: [{
        product: id(), productName: 'Eid Pack', quantity: 1, unitPrice: 500,
        itemType: 'combo',
        comboSelections: [{ comboItemId: slot, variantId: chosen, variantSku: 'SH-RED' }],
      }],
    });

    expect(cart.validateSync()).toBeUndefined();
    expect(cart.items[0].itemType).toBe('combo');
    expect(String(cart.items[0].comboSelections[0].comboItemId)).toBe(String(slot));
    expect(String(cart.items[0].comboSelections[0].variantId)).toBe(String(chosen));
  });

  it('an ordinary parked line carries no combo keys at all', () => {
    const cart = new HeldCart({
      shop: SHOP, heldBy: id(),
      items: [{ product: id(), productName: 'Soap', quantity: 1, unitPrice: 50 }],
    });
    expect(cart.items[0].itemType).toBe('standard');
    expect(cart.items[0].comboSelections).toBeUndefined();
  });
});

// ── 6. The sale snapshot records what was actually picked ───────────────────

describe('Sale snapshot: the pick is the only record of itself', () => {
  it('freezes the chosen variant and the slot it answered', () => {
    const slot = id();
    const chosenVariant = id();
    const sale = new Sale({
      shop: SHOP, invoiceNo: 'INV-1', createdBy: id(),
      items: [{
        product: id(), productName: 'Eid Pack', quantity: 2,
        unitPrice: 500, buyingPrice: 320, total: 1000,
        itemType: 'combo',
        comboComponents: [{
          product: id(), comboItemId: slot, productName: 'Shirt',
          variantId: chosenVariant, variantSku: 'SH-RED',
          variantAttributes: { color: 'red' },
          quantityPerCombo: 1, totalQuantity: 2, unitCost: 160,
        }],
      }],
      subtotal: 1000, total: 1000, paid: 1000,
    });

    const comp = sale.items[0].comboComponents[0];
    expect(String(comp.comboItemId)).toBe(String(slot));
    expect(String(comp.variantId)).toBe(String(chosenVariant));
    expect(comp.variantSku).toBe('SH-RED');
    // The line's cost follows the variant that actually went out, which is
    // what keeps profit exact even though the price is flat.
    expect(sale.items[0].buyingPrice).toBe(320);
  });

  it('a line sold before slots existed has no comboItemId and still validates', () => {
    const sale = new Sale({
      shop: SHOP, invoiceNo: 'INV-2', createdBy: id(),
      items: [{
        product: id(), productName: 'Eid Pack', quantity: 1,
        unitPrice: 250, buyingPrice: 150, total: 250,
        itemType: 'combo',
        comboComponents: [{
          product: id(), productName: 'Soap', unit: 'piece',
          quantityPerCombo: 2, totalQuantity: 2, unitCost: 75,
        }],
      }],
      subtotal: 250, total: 250, paid: 250,
    });
    expect(sale.validateSync()).toBeUndefined();
    expect(sale.items[0].comboComponents[0].comboItemId).toBeNull();
  });
});
