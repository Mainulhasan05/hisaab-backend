/**
 * `Product.stock` on a variant product is the sum across `variants[]`.
 *
 * ── The bug this locks down ─────────────────────────────────────────────────
 *
 * Every read-time consumer already recomputed it that way — the inventory-value
 * aggregation, the stock-count stat, the `totalStock` virtual. The WRITE paths
 * did not: `buildVariantStockUpdate` wrote `variants.$.stock` and nothing else,
 * so the stored rollup drifted upward by whatever was sold and never returned.
 * Only the sales-return path maintained it, which made the drift asymmetric — a
 * sale overstated `stock`, a return of the same line silently corrected it.
 *
 * Found live on a shop whose পানি পাএ read `stock: 74` against variants summing
 * 64, overstated by exactly the ten units on an open invoice.
 *
 * The pipeline half is asserted in packagingUnits.test.js. This file covers the
 * `pre('save')` hook, which is what stops the `.save()` paths — a manual recount,
 * most of all — from reintroducing the drift the moment it is repaired.
 *
 * No database: the hook is a synchronous function on the schema, so it is
 * invoked directly against a plain object with the right shape.
 */

const Product = require('../models/Product.model');

/**
 * The rule under test, applied the way the `pre('save')` hook applies it:
 * `null` means "not a variant product, leave `stock` alone".
 */
const rolled = (doc) => {
  const v = Product.deriveVariantStock(doc);
  return v === null ? doc.stock : v;
};

describe('the product-level stock rollup', () => {
  test('a variant product has its stock re-derived from the array', () => {
    expect(rolled({
      hasVariants: true,
      stock: 74, // stale: what the drift left behind
      variants: [{ stock: 17 }, { stock: 39 }, { stock: 8 }],
    })).toBe(64);
  });

  test('inactive variants still count — they are stock, just not sellable', () => {
    // Deactivating a variant hides it from the POS. It does not make the goods
    // vanish from the shop, and the inventory-value aggregation counts them, so
    // the stored rollup has to agree or the two reports disagree by that amount.
    expect(rolled({
      hasVariants: true,
      stock: 0,
      variants: [{ stock: 10, isActive: true }, { stock: 5, isActive: false }],
    })).toBe(15);
  });

  test('a plain product keeps its own stock', () => {
    expect(rolled({ hasVariants: false, stock: 42, variants: [] })).toBe(42);
  });

  test('the hook writes the derived value onto the document', () => {
    // The static states the rule; this is the wiring that applies it, and a hook
    // that computed correctly but assigned nothing would pass every test above.
    const doc = new Product({
      shop: new (require('mongoose').Types.ObjectId)(),
      name: 'পানি পাএ',
      hasVariants: true,
      stock: 74,
      variants: [{ sku: 'A', stock: 17 }, { sku: 'B', stock: 39 }, { sku: 'C', stock: 8 }],
      createdBy: new (require('mongoose').Types.ObjectId)(),
    });

    const hook = Product.schema.s.hooks._pres.get('save')
      .find((h) => h.fn.toString().includes('deriveVariantStock'));
    hook.fn.call(doc, () => {});

    expect(doc.stock).toBe(64);
  });

  test('a product converted BACK to plain is not rolled up', () => {
    // ── The case that makes `hasVariants` load-bearing here ─────────────────
    //
    // Four products in the live database look exactly like this: `hasVariants`
    // false beside a stale `variants[]` whose rows were zeroed by the
    // conversion, with the real stock at the product level and a
    // stock-transaction trail that is entirely product-level.
    //
    // The virtuals on this schema guard on `variants.length` alone and ignore
    // the flag — "believe the data, not the flag" — which is right for a READ
    // that degrades to a sensible number. Applied to a WRITE it is destructive:
    // `Brazil P.E Home` (stock 61, abandoned variants summing 0) would have 61
    // units of real inventory written down to zero on its next save.
    expect(rolled({
      hasVariants: false,
      stock: 61,
      variants: [{ stock: 0 }, { stock: 0 }, { stock: 0 }, { stock: 0 }, { stock: 0 }],
    })).toBe(61);

    // And the inflating direction, from the same population: `Old Money Shirt`
    // carries a real 16 beside abandoned variants summing 57.
    expect(rolled({
      hasVariants: false,
      stock: 16,
      variants: [{ stock: 30 }, { stock: 27 }],
    })).toBe(16);
  });

  test('a flag ticked ahead of the data does not zero the stock', () => {
    // The mirror image: mid-edit, `hasVariants` set true before any variant has
    // been added. Summing an empty array would write 0 over a real figure.
    expect(rolled({ hasVariants: true, stock: 30, variants: [] })).toBe(30);
  });

  test('fractional variant stock does not accumulate a float residue', () => {
    // Stock is quantized to 3 dp everywhere (quantity.util). Without the round
    // here the rollup carries a residue the per-variant figures do not have, and
    // the two stop comparing equal — which is what a drift check compares.
    expect(rolled({
      hasVariants: true,
      stock: 0,
      variants: [{ stock: 0.1 }, { stock: 0.2 }],
    })).toBe(0.3);
  });
});
