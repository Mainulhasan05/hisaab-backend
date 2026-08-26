/**
 * The পাইকারি rate a delivery sets, and the landed cost it blends.
 *
 * Two subjects, one file, because they are the two halves of the same change
 * and they fail together: a purchase now decides THREE prices (cost, retail,
 * wholesale) and the cost it decides is no longer the one on the bill.
 *
 * Groups (AGENT_WORKFLOW.md §7.1):
 *
 *   A. THE FLAG (I-7). A shop without `features.wholesale` must stay
 *      byte-identical — no key accepted, no field written. And a cleared box
 *      must NOT 403, or every ordinary delivery in a flag-off shop breaks.
 *
 *   B. ZERO IS ABSENT, NOT FREE. A cleared money box posts 0. Writing that as a
 *      wholesale rate bills the next পাইকারি customer nothing.
 *
 *   C. THE WRITE. Set, never blended; a variant line prices its own variant;
 *      the two price fields do not collide.
 *
 *   D. THE REVERSAL. Ownership-checked, and it restores an ABSENCE rather than
 *      a zero — the difference between a product that bills পাইকারি customers
 *      at retail and one that bills them nothing.
 *
 *   E. THE LANDED-COST WIRING. The one that cannot be caught by reading a
 *      number: the cost blend and the ownership snapshot must read the SAME
 *      rate. If they diverge, `cancelPurchase` silently stops restoring the
 *      cost it moved — no error, no log, wrong margins months later.
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const {
  buildWholesalePriceUpdate,
  buildWholesalePriceRestore,
  buildSellingPriceUpdate,
} = require('../utils/purchasePrice.util');
const { normalizeWholesalePrice } = require('../utils/pricing.util');

const id = () => new mongoose.Types.ObjectId();

/* ════════════════════════════════════════════════════════════════════════
 * A. THE FLAG (I-7)
 * ════════════════════════════════════════════════════════════════════════ */
describe('A. a shop without features.wholesale is untouched', () => {
  test('a rate posted without the capability is refused, not swallowed', () => {
    // Swallowing it would ship a delivery whose form showed ৳৮/পিস and whose
    // data held nothing. Saying so is how that gets noticed.
    expect(() => normalizeWholesalePrice(8, false)).toThrow();
    try {
      normalizeWholesalePrice(8, false);
    } catch (err) {
      expect(err.statusCode).toBe(403);
    }
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['zero', 0],
  ])('%s is legal with the flag OFF and writes nothing', (_label, raw) => {
    // THE invariant. Every delivery a flag-off shop has ever recorded takes
    // this path. A 403 here would break every ordinary purchase on the
    // platform the moment a form sent an empty box.
    expect(normalizeWholesalePrice(raw, false)).toBeUndefined();
    expect(buildWholesalePriceUpdate({ productId: id(), wholesalePrice: undefined })).toBeNull();
  });

  test('with the flag on, a real rate comes through', () => {
    expect(normalizeWholesalePrice(8, true)).toBe(8);
  });

  test('a malformed rate fails loudly rather than coercing to zero', () => {
    // This number is written straight onto the product, where every future
    // wholesale sale reads it. NaN → 0 is how the goods get given away.
    for (const bad of ['abc', -5, NaN, Infinity]) {
      expect(() => normalizeWholesalePrice(bad, true)).toThrow();
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * B. ZERO IS ABSENT, NOT FREE
 * ════════════════════════════════════════════════════════════════════════ */
describe('B. zero means "no wholesale rate"', () => {
  test('zero writes no op', () => {
    expect(buildWholesalePriceUpdate({ productId: id(), wholesalePrice: 0 })).toBeNull();
  });

  test('zero is not a violation even with the flag off', () => {
    expect(normalizeWholesalePrice(0, false)).toBeUndefined();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C. THE WRITE
 * ════════════════════════════════════════════════════════════════════════ */
describe('C. writing the rate onto the product', () => {
  test('a simple line sets the product field', () => {
    const productId = id();
    const op = buildWholesalePriceUpdate({ productId, wholesalePrice: 8 });
    expect(op.updateOne.filter).toEqual({ _id: productId });
    expect(op.updateOne.update).toEqual({ $set: { wholesalePrice: 8 } });
  });

  test('a variant line prices its OWN variant', () => {
    // Writing the parent's field for a variant product sets a number nothing
    // reads — `pricing.util` resolves a variant sale off the variant.
    const productId = id();
    const variantId = id();
    const op = buildWholesalePriceUpdate({
      productId, variantId, hasVariants: true, wholesalePrice: 8,
    });
    expect(op.updateOne.filter).toEqual({ _id: productId, 'variants._id': variantId });
    expect(op.updateOne.update).toEqual({ $set: { 'variants.$.wholesalePrice': 8 } });
  });

  test('a variantId on a NON-variant product still prices the parent', () => {
    const op = buildWholesalePriceUpdate({
      productId: id(), variantId: id(), hasVariants: false, wholesalePrice: 8,
    });
    expect(op.updateOne.update).toEqual({ $set: { wholesalePrice: 8 } });
  });

  test('the retail and wholesale writes touch different fields', () => {
    // The pair `sellingPriceFor(entity, tier)` exists to keep apart. Two ops
    // built from the same line must not collide on one key.
    const productId = id();
    const retail = buildSellingPriceUpdate({ productId, sellingPrice: 12 });
    const bulk = buildWholesalePriceUpdate({ productId, wholesalePrice: 8 });
    expect(Object.keys(retail.updateOne.update.$set)).toEqual(['sellingPrice']);
    expect(Object.keys(bulk.updateOne.update.$set)).toEqual(['wholesalePrice']);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * D. THE REVERSAL
 * ════════════════════════════════════════════════════════════════════════ */
describe('D. cancelling only undoes what it still owns', () => {
  test('restores the previous rate when nothing has moved since', () => {
    const op = buildWholesalePriceRestore({
      productId: id(), wholesalePrice: 8, wholesalePriceBefore: 6, currentPrice: 8,
    });
    expect(op.updateOne.update).toEqual({ $set: { wholesalePrice: 6 } });
  });

  test('refuses when someone has repriced since', () => {
    // That change owns the number now. A wholesale rate is negotiated with a
    // named buyer, so reverting one agreed after this delivery would quote
    // them a price nobody settled on.
    expect(buildWholesalePriceRestore({
      productId: id(), wholesalePrice: 8, wholesalePriceBefore: 6, currentPrice: 9,
    })).toBeNull();
  });

  test('tolerates paisa drift, matching the cost comparison', () => {
    expect(buildWholesalePriceRestore({
      productId: id(), wholesalePrice: 8, wholesalePriceBefore: 6, currentPrice: 8.001,
    })).not.toBeNull();
  });

  test('restores an ABSENCE with $unset, never a zero', () => {
    // "There was no wholesale rate" and "the wholesale rate was zero" are
    // different states, and only one of them gives the carton away.
    const op = buildWholesalePriceRestore({
      productId: id(), wholesalePrice: 8, wholesalePriceBefore: null, currentPrice: 8,
    });
    expect(op.updateOne.update).toEqual({ $unset: { wholesalePrice: '' } });
  });

  test('a line that never set a rate has nothing to undo', () => {
    expect(buildWholesalePriceRestore({
      productId: id(), wholesalePrice: undefined, currentPrice: 8,
    })).toBeNull();
  });

  test('a variant reversal unsets the variant field', () => {
    const op = buildWholesalePriceRestore({
      productId: id(), variantId: id(), hasVariants: true,
      wholesalePrice: 8, wholesalePriceBefore: null, currentPrice: 8,
    });
    expect(op.updateOne.update).toEqual({ $unset: { 'variants.$.wholesalePrice': '' } });
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * E. THE LANDED-COST WIRING
 * ════════════════════════════════════════════════════════════════════════ */
describe('E. the cost basis blends the landed rate', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../services/purchase.service.js'),
    'utf8'
  );

  it('resolves one cost rate and uses it for the blend', () => {
    // The billed rate excludes the ভাড়া. Blending it is what made every margin
    // report agree that a consignment whose freight was never recorded had
    // cost less than it did.
    expect(src).toMatch(/const costRate = item\.landedUnitPrice \?\? item\.unitPrice/);
    expect(src).toMatch(/buildProductCostUpdate\(item\.quantity, costRate\)/);
    expect(src).toMatch(/buildVariantCostUpdate\(item\.variantId, item\.quantity, costRate\)/);
  });

  it('snapshots costAfter from that SAME rate', () => {
    // THE one that cannot be caught by reading a number off a screen.
    // `cancelPurchase` decides whether it still owns the cost by comparing the
    // product's current buyingPrice against `costAfter`. Compute the two from
    // different prices and the comparison stops matching — the cancellation
    // silently stops restoring the cost it moved, with nothing in any log.
    expect(src).toMatch(/blendedCost\(previousStock, previousCost, item\.quantity, costRate\)/);
  });

  it('values the stock ledger and the batch at landed cost too', () => {
    // These are what an inventory value is rebuilt from. Valuing them off the
    // bill while the cost basis uses landed makes the two disagree, and the
    // disagreement is exactly the freight.
    expect(src).toMatch(/costPrice: item\.landedUnitPrice \?\? item\.unitPrice/);
    expect(src).toMatch(/unitCost: item\.landedUnitPrice \?\? item\.unitPrice/);
  });

  it('leaves the BILLED figures on the invoice alone', () => {
    // A stored purchase has to reconcile line-for-line against the paper in
    // the shopkeeper's hand. `unitPrice` and `total` are that paper.
    expect(src).toMatch(/preparedItems\[i\]\.total = line\.total/);
    expect(src).toMatch(/unitPrice,\s*\n\s*packUnitPrice/);
  });

  it('routes every invoice figure through the one math function', () => {
    // Computing any of these in a second place is how the invoice and the
    // ledger drifted apart on the sale side.
    expect(src).toMatch(/computePurchaseTotals\(\{/);
    expect(src).toMatch(/totalAmount = totals\.totalAmount/);
    expect(src).toMatch(/subtotal: totals\.subtotal/);
    expect(src).toMatch(/discountAmount: totals\.discountAmount/);
    expect(src).toMatch(/freightCharge: totals\.freightCharge/);
  });

  it('gates the wholesale rate on the capability, once', () => {
    expect(src).toMatch(/const wholesaleEnabled = hasFeature\(req, 'wholesale'\)/);
    expect(src).toMatch(/normalizeWholesalePrice\(\s*item\.wholesalePrice/);
  });

  it('reverses the wholesale rate on cancellation WITHOUT re-checking the flag', () => {
    // A capability switched off between the delivery and the cancellation must
    // not strand the rate this delivery wrote. The write path enforces the
    // entitlement; the reversal only has to be faithful.
    expect(src).toMatch(/buildWholesalePriceRestore\(\{/);
    const idx = src.indexOf('buildWholesalePriceRestore({');
    const window = src.slice(Math.max(0, idx - 900), idx);
    expect(window).not.toMatch(/hasFeature\([^)]*wholesale/);
  });
});
