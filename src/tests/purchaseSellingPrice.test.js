/**
 * The retail price a delivery sets.
 *
 * `costing.util` already re-blends `buyingPrice` on receipt, so after a supplier
 * price rise the shelf's cost basis moves whether or not anyone looks at it.
 * Nothing moved `sellingPrice`, and the only way to respond was to leave the
 * purchase screen and edit each product — which in practice did not happen. The
 * purchase form now carries the price; this pins what that is allowed to mean.
 *
 * Groups (AGENT_WORKFLOW.md §7.1):
 *
 *   A. ABSENT MEANS "LEAVE IT ALONE" — INVARIANT GUARDS. Every purchase every
 *      shop has ever posted omits this field, and every one of them must keep
 *      writing no price. These pass before and after by construction; they are
 *      the tripwire that stops a later "simplification" from defaulting the
 *      field to 0 and zeroing a catalogue.
 *
 *   B. ZERO IS ABSENT, NOT FREE. A cleared number input posts 0. Writing that
 *      as a price gives the goods away, so it is read as "no change" — the same
 *      reading `packSellingPrice` and `wholesalePrice` already use.
 *
 *   C. VALIDATION. A malformed price must fail loudly rather than coerce to 0,
 *      because it is written straight onto the product where every future sale
 *      reads it.
 *
 *   D. THE WRITE. Set, never blended; the variant line prices its own variant.
 *
 *   E. THE REVERSAL. A cancellation restores the old price only while this
 *      delivery still owns the number, and restores an ABSENCE rather than a
 *      zero when the product had no price before.
 */

const mongoose = require('mongoose');

const {
  parseSellingPrice,
  buildSellingPriceUpdate,
  buildSellingPriceRestore,
} = require('../utils/purchasePrice.util');

const id = () => new mongoose.Types.ObjectId();

/* ════════════════════════════════════════════════════════════════════════
 * A. ABSENT MEANS "LEAVE IT ALONE" — INVARIANT GUARDS
 * ════════════════════════════════════════════════════════════════════════ */
describe('A. absent means "leave the price alone"', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
  ])('%s parses to null', (_label, raw) => {
    expect(parseSellingPrice(raw)).toBeNull();
  });

  test('null writes no op at all', () => {
    // THE invariant. Every purchase written before this feature existed, and
    // every one posted by a shop that ignores the box, takes this path. An op
    // here would rewrite prices across a catalogue on an ordinary delivery.
    expect(buildSellingPriceUpdate({ productId: id(), sellingPrice: null })).toBeNull();
  });

  test('undefined writes no op either', () => {
    expect(buildSellingPriceUpdate({ productId: id(), sellingPrice: undefined })).toBeNull();
  });

  test('a line that set no price has nothing to reverse', () => {
    expect(
      buildSellingPriceRestore({
        productId: id(),
        sellingPrice: null,
        sellingPriceBefore: 90,
        currentPrice: 120,
      })
    ).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * B. ZERO IS ABSENT, NOT FREE
 * ════════════════════════════════════════════════════════════════════════ */
describe('B. zero is absent, not free', () => {
  test.each([
    ['the number 0', 0],
    ['the string "0"', '0'],
    ['"0.00"', '0.00'],
  ])('%s parses to null, not to 0', (_label, raw) => {
    // A cleared number input posts 0. Charging ৳0 for a sack of rice because
    // someone emptied a box is not a price, it is a bug.
    expect(parseSellingPrice(raw)).toBeNull();
  });

  test('a zero never reaches the write path', () => {
    expect(buildSellingPriceUpdate({ productId: id(), sellingPrice: 0 })).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C. VALIDATION
 * ════════════════════════════════════════════════════════════════════════ */
describe('C. validation', () => {
  test.each([
    ['a negative price', -5],
    ['text', 'একশো'],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('%s is refused 400 rather than coerced', (_label, raw) => {
    expect.assertions(2);
    try {
      parseSellingPrice(raw, 'চাল');
    } catch (err) {
      expect(err.statusCode).toBe(400);
      // Named, so a twenty-line delivery says WHICH line is wrong.
      expect(err.messageBn).toContain('চাল');
    }
  });

  test('a numeric string is accepted — the form posts strings', () => {
    expect(parseSellingPrice('120')).toBe(120);
  });

  test('quantized to paisa, like every other money figure', () => {
    // Unrounded, a price entered as a third of something drifts against every
    // total computed from it.
    expect(parseSellingPrice('12.345')).toBe(12.35);
    expect(parseSellingPrice(99.999)).toBe(100);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * D. THE WRITE
 * ════════════════════════════════════════════════════════════════════════ */
describe('D. the write', () => {
  test('a simple product gets a plain $set — no blend', () => {
    // Cost is an average of what the shop paid; a price is a decision the
    // shopkeeper just made. Averaging prices would produce a number nobody
    // chose and no customer was ever charged.
    const pid = id();
    const op = buildSellingPriceUpdate({ productId: pid, sellingPrice: 120 });
    expect(op.updateOne.filter).toEqual({ _id: pid });
    expect(op.updateOne.update).toEqual({ $set: { sellingPrice: 120 } });
  });

  test('a variant line prices its OWN variant', () => {
    // Writing the parent's field for a variant product sets a number nothing
    // reads — a sale of a variant resolves its price off the variant.
    const pid = id();
    const vid = id();
    const op = buildSellingPriceUpdate({
      productId: pid,
      variantId: vid,
      hasVariants: true,
      sellingPrice: 120,
    });
    expect(op.updateOne.filter).toEqual({ _id: pid, 'variants._id': vid });
    expect(op.updateOne.update).toEqual({ $set: { 'variants.$.sellingPrice': 120 } });
  });

  test('a variantId on a NON-variant product writes the top-level price', () => {
    // Defensive: the flag is the authority, not the presence of an id. A
    // positional write against a product with no `variants` array matches
    // nothing and would silently drop the price.
    const op = buildSellingPriceUpdate({
      productId: id(),
      variantId: id(),
      hasVariants: false,
      sellingPrice: 120,
    });
    expect(op.updateOne.update).toEqual({ $set: { sellingPrice: 120 } });
  });

  test('the update is not a pipeline — nothing here reads the document', () => {
    // `buildVariantCostUpdate` needs `$map` because a blend must read the
    // document's own stock and cost server-side. Setting a literal does not,
    // and a pipeline would forfeit the positional `$` for no gain.
    const op = buildSellingPriceUpdate({
      productId: id(),
      variantId: id(),
      hasVariants: true,
      sellingPrice: 120,
    });
    expect(Array.isArray(op.updateOne.update)).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * E. THE REVERSAL
 * ════════════════════════════════════════════════════════════════════════ */
describe('E. the reversal', () => {
  const base = { productId: id(), sellingPrice: 120, sellingPriceBefore: 90 };

  test('restores the old price while this delivery still owns the number', () => {
    const op = buildSellingPriceRestore({ ...base, currentPrice: 120 });
    expect(op.updateOne.update).toEqual({ $set: { sellingPrice: 90 } });
  });

  test('tolerates a paisa of drift, since both sides were rounded', () => {
    const op = buildSellingPriceRestore({ ...base, currentPrice: 120.001 });
    expect(op).not.toBeNull();
  });

  test('does NOTHING once someone has repriced since', () => {
    // The important one. A price is something a person chose; silently undoing
    // a choice made after this delivery is worse than leaving a stale price.
    expect(buildSellingPriceRestore({ ...base, currentPrice: 150 })).toBeNull();
  });

  test('does nothing when the product has no price at all now', () => {
    expect(buildSellingPriceRestore({ ...base, currentPrice: null })).toBeNull();
  });

  test('restores an ABSENCE, not a zero, when there was no price before', () => {
    // "There was no price" and "the price was zero" are different states, and
    // only one of them hands the goods away.
    const op = buildSellingPriceRestore({
      productId: id(),
      sellingPrice: 120,
      sellingPriceBefore: null,
      currentPrice: 120,
    });
    expect(op.updateOne.update).toEqual({ $unset: { sellingPrice: '' } });
  });

  test('an absent `sellingPriceBefore` unsets too — old rows carry no snapshot', () => {
    const op = buildSellingPriceRestore({
      productId: id(),
      sellingPrice: 120,
      sellingPriceBefore: undefined,
      currentPrice: 120,
    });
    expect(op.updateOne.update).toEqual({ $unset: { sellingPrice: '' } });
  });

  test('a variant reversal targets the variant', () => {
    const pid = id();
    const vid = id();
    const op = buildSellingPriceRestore({
      productId: pid,
      variantId: vid,
      hasVariants: true,
      sellingPrice: 120,
      sellingPriceBefore: 90,
      currentPrice: 120,
    });
    expect(op.updateOne.filter).toEqual({ _id: pid, 'variants._id': vid });
    expect(op.updateOne.update).toEqual({ $set: { 'variants.$.sellingPrice': 90 } });
  });

  test('a price of 0 before is restored as 0, not unset', () => {
    // Deliberate: 0 is refused on the WAY IN (group B), so a stored 0 came from
    // somewhere else — an import, an older form — and reversing it to "no
    // price" would be this code inventing a change nobody made.
    const op = buildSellingPriceRestore({
      productId: id(),
      sellingPrice: 120,
      sellingPriceBefore: 0,
      currentPrice: 120,
    });
    expect(op.updateOne.update).toEqual({ $set: { sellingPrice: 0 } });
  });
});
