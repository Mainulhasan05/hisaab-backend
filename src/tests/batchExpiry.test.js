/**
 * Per-variant batch / expiry tracking.
 *
 * Groups, and it matters which is which (AGENT_WORKFLOW.md §7.1):
 *
 *   A. NO-BATCH IDENTITY — INVARIANT GUARDS. A product that does not track
 *      batches, and a shop that has never turned the toggle on, must behave
 *      exactly as before. These pass on the old code by construction; they fail
 *      only if someone later makes batch handling unconditional.
 *
 *   B. PER-VARIANT OWNERSHIP — REGRESSIONS. These fail against the old code,
 *      which had no `variantId` on a batch at all and therefore could not tell
 *      the ৫০০ গ্রাম batch from the ১ কেজি one. This is the feature.
 *
 *   C. DRIFT — REGRESSIONS. Returns, transfers and recounts moved `stock` and
 *      left `batches` alone, so `sum(batches)` and `stock` diverged over time.
 *      The visible symptom was the expiry screen warning about goods sold
 *      months earlier.
 *
 *   D. THE UPDATE-SCHEMA WIPE — REGRESSION, and the sharpest one: editing any
 *      product's price destroyed its batches, expiry dates, images, tags and
 *      serials, because `updateProduct` inherited Joi `.default()`s and
 *      `validate.middleware` writes the validated value back over `req.body`.
 */

const mongoose = require('mongoose');
const {
  sameOwner,
  takeBatches,
  deductBatches,
  addBatches,
  restoreBatches,
  capBatchesToStock,
} = require('../utils/batch.util');
const productValidation = require('../validations/product.validation');

const oid = () => new mongoose.Types.ObjectId();

/** A bare product-shaped object; the util only reads these fields. */
const makeProduct = (batches, trackBatches = true) => ({
  _id: oid(),
  trackBatches,
  batches: batches.map(b => ({ variantId: null, costPrice: 0, ...b })),
});

const totalFor = (product, variantId = null) =>
  product.batches
    .filter(b => sameOwner(b.variantId, variantId))
    .reduce((s, b) => s + b.quantity, 0);

// ══ A. NO-BATCH IDENTITY (guards) ═══════════════════════════════════════════

describe('A — a product that does not track batches is untouched', () => {
  it('deducts nothing when trackBatches is off', () => {
    const p = makeProduct([{ batchNumber: 'B1', quantity: 10 }], false);
    expect(deductBatches(p, null, 5)).toBe(false);
    expect(totalFor(p)).toBe(10);
  });

  it('deducts nothing when there are no batches', () => {
    const p = makeProduct([]);
    expect(deductBatches(p, null, 5)).toBe(false);
  });

  it('restores nothing into a product with no batches', () => {
    const p = makeProduct([]);
    expect(restoreBatches(p, null, 5)).toBe(false);
  });

  it('treats a zero or negative quantity as a no-op', () => {
    const p = makeProduct([{ batchNumber: 'B1', quantity: 10 }]);
    expect(deductBatches(p, null, 0)).toBe(false);
    expect(deductBatches(p, null, -3)).toBe(false);
    expect(totalFor(p)).toBe(10);
  });
});

// ══ B. PER-VARIANT OWNERSHIP (regressions — the feature) ════════════════════

describe('B — batches belong to one variant and only that variant', () => {
  const v500 = oid();
  const v1000 = oid();

  const milk = () => makeProduct([
    { variantId: v500, batchNumber: 'B-101', quantity: 25, expiryDate: new Date('2026-06-30') },
    { variantId: v1000, batchNumber: 'B-102', quantity: 12, expiryDate: new Date('2026-12-31') },
  ]);

  it('selling ৫০০ গ্রাম does not touch the ১ কেজি batch', () => {
    const p = milk();
    expect(deductBatches(p, v500, 10)).toBe(true);
    expect(totalFor(p, v500)).toBe(15);
    expect(totalFor(p, v1000)).toBe(12);
  });

  it('selling a variant does not touch product-level batches', () => {
    const p = makeProduct([
      { variantId: null, batchNumber: 'B-PROD', quantity: 40 },
      { variantId: v500, batchNumber: 'B-101', quantity: 25 },
    ]);
    deductBatches(p, v500, 25);
    expect(totalFor(p, null)).toBe(40);
    expect(totalFor(p, v500)).toBe(0);
  });

  it('a legacy batch with no variantId is reachable as the product owner', () => {
    // Rows written before per-variant expiry existed have no `variantId` key at
    // all — not null, ABSENT. `String(undefined) !== String(null)`, so a naive
    // stringify comparison would orphan every batch in the database.
    const p = { _id: oid(), trackBatches: true, batches: [{ batchNumber: 'OLD', quantity: 10 }] };
    expect(deductBatches(p, null, 4)).toBe(true);
    expect(p.batches[0].quantity).toBe(6);
  });

  it('sameOwner treats null, undefined and empty string as the product', () => {
    expect(sameOwner(null, undefined)).toBe(true);
    expect(sameOwner('', null)).toBe(true);
    expect(sameOwner(v500, String(v500))).toBe(true);
    expect(sameOwner(v500, v1000)).toBe(false);
    expect(sameOwner(v500, null)).toBe(false);
  });
});

describe('B — FEFO order', () => {
  const soon = new Date('2026-06-01');
  const later = new Date('2026-12-01');

  it('drains the soonest-expiring batch first', () => {
    const p = makeProduct([
      { batchNumber: 'LATE', quantity: 10, expiryDate: later },
      { batchNumber: 'SOON', quantity: 10, expiryDate: soon },
    ]);
    deductBatches(p, null, 10);
    expect(p.batches.find(b => b.batchNumber === 'SOON')).toBeUndefined();
    expect(p.batches.find(b => b.batchNumber === 'LATE').quantity).toBe(10);
  });

  it('consumes UNDATED batches last, not first', () => {
    // "No expiry recorded" is not "expires never". Draining undated stock first
    // would leave the short-dated goods on the shelf — the exact outcome FEFO
    // exists to prevent.
    const p = makeProduct([
      { batchNumber: 'UNDATED', quantity: 10 },
      { batchNumber: 'SOON', quantity: 10, expiryDate: soon },
    ]);
    deductBatches(p, null, 10);
    expect(p.batches.find(b => b.batchNumber === 'UNDATED').quantity).toBe(10);
  });

  it('spans several batches and drops the emptied ones', () => {
    const p = makeProduct([
      { batchNumber: 'A', quantity: 5, expiryDate: soon },
      { batchNumber: 'B', quantity: 5, expiryDate: later },
    ]);
    deductBatches(p, null, 8);
    expect(p.batches).toHaveLength(1);
    expect(p.batches[0].batchNumber).toBe('B');
    expect(p.batches[0].quantity).toBe(2);
  });

  it('under-coverage deducts what it can rather than throwing', () => {
    // A shop that turned tracking on mid-life has stock older than its batch
    // records. The stock guard is the authority on whether the sale is
    // possible; refusing here would block a sale of goods that are present.
    const p = makeProduct([{ batchNumber: 'A', quantity: 3 }]);
    expect(deductBatches(p, null, 10)).toBe(true);
    expect(p.batches).toHaveLength(0);
  });

  it('reports which batches were taken, for a transfer to replay', () => {
    const p = makeProduct([
      { batchNumber: 'SOON', quantity: 4, expiryDate: soon },
      { batchNumber: 'LATE', quantity: 9, expiryDate: later },
    ]);
    const { changed, taken } = takeBatches(p, null, 6);
    expect(changed).toBe(true);
    expect(taken).toEqual([
      expect.objectContaining({ batchNumber: 'SOON', quantity: 4 }),
      expect.objectContaining({ batchNumber: 'LATE', quantity: 2 }),
    ]);
  });
});

// ══ C. DRIFT (regressions) ══════════════════════════════════════════════════

describe('C — returns put stock back into a batch', () => {
  it('credits the LONGEST-dated batch', () => {
    // FEFO sold the shortest-dated first, so a return is most likely the
    // long-dated goods. Crediting an about-to-expire batch would invent an
    // expiry warning for stock that is not short-dated.
    const p = makeProduct([
      { batchNumber: 'SOON', quantity: 2, expiryDate: new Date('2026-06-01') },
      { batchNumber: 'LATE', quantity: 2, expiryDate: new Date('2026-12-01') },
    ]);
    expect(restoreBatches(p, null, 3)).toBe(true);
    expect(p.batches.find(b => b.batchNumber === 'LATE').quantity).toBe(5);
    expect(p.batches.find(b => b.batchNumber === 'SOON').quantity).toBe(2);
  });

  it('restores into the right variant', () => {
    const v = oid();
    const p = makeProduct([
      { variantId: null, batchNumber: 'P', quantity: 5 },
      { variantId: v, batchNumber: 'V', quantity: 5 },
    ]);
    restoreBatches(p, v, 4);
    expect(totalFor(p, v)).toBe(9);
    expect(totalFor(p, null)).toBe(5);
  });
});

describe('C — transfers carry expiry dates across the branch boundary', () => {
  it('merges an identical batch instead of duplicating the row', () => {
    const p = makeProduct([
      { batchNumber: 'B-1', quantity: 5, expiryDate: new Date('2026-06-01') },
    ]);
    addBatches(p, null, [{ batchNumber: 'B-1', quantity: 7, expiryDate: new Date('2026-06-01') }]);
    expect(p.batches).toHaveLength(1);
    expect(p.batches[0].quantity).toBe(12);
  });

  it('keeps a same-numbered batch with a DIFFERENT date separate', () => {
    const p = makeProduct([
      { batchNumber: 'B-1', quantity: 5, expiryDate: new Date('2026-06-01') },
    ]);
    addBatches(p, null, [{ batchNumber: 'B-1', quantity: 7, expiryDate: new Date('2027-01-01') }]);
    expect(p.batches).toHaveLength(2);
  });

  it('does not force tracking on a destination that has it off', () => {
    const p = makeProduct([], false);
    expect(addBatches(p, null, [{ batchNumber: 'X', quantity: 5 }])).toBe(false);
  });
});

describe('C — a recount trims batches down to the counted stock', () => {
  it('removes the excess soonest-expiry-first', () => {
    const p = makeProduct([
      { batchNumber: 'SOON', quantity: 22, expiryDate: new Date('2026-06-01') },
      { batchNumber: 'LATE', quantity: 8, expiryDate: new Date('2026-12-01') },
    ]);
    expect(capBatchesToStock(p, null, 8)).toBe(true);
    expect(totalFor(p)).toBe(8);
    expect(p.batches.map(b => b.batchNumber)).toEqual(['LATE']);
  });

  it('never grows batches when stock is counted UP', () => {
    // A recount up means goods arrived without a delivery being recorded, and
    // there is no honest expiry date to give them.
    const p = makeProduct([{ batchNumber: 'A', quantity: 5 }]);
    expect(capBatchesToStock(p, null, 50)).toBe(false);
    expect(totalFor(p)).toBe(5);
  });

  it('only caps the variant that was recounted', () => {
    const v = oid();
    const p = makeProduct([
      { variantId: null, batchNumber: 'P', quantity: 30 },
      { variantId: v, batchNumber: 'V', quantity: 30 },
    ]);
    capBatchesToStock(p, v, 5);
    expect(totalFor(p, null)).toBe(30);
    expect(totalFor(p, v)).toBe(5);
  });
});

// ══ D. THE UPDATE-SCHEMA WIPE (regression) ══════════════════════════════════

describe('D — editing a product must not erase what the form never showed', () => {
  // The real edit form's payload: no batches, no tags, no images, no serials.
  const editFormBody = () => ({
    name: 'নাপা ট্যাবলেট',
    category: '507f1f77bcf86cd799439011',
    buyingPrice: 10,
    sellingPrice: 12,
    stock: 40,
    minStock: 5,
    hasVariants: false,
  });

  const validated = (schema, body) =>
    schema.validate(body, { abortEarly: false, stripUnknown: true });

  it.each([
    'batches', 'trackBatches', 'serials', 'trackSerials',
    'tags', 'images', 'isAvailableOnline', 'isFeaturedOnline',
  ])('does not invent a value for %s', (field) => {
    const { error, value } = validated(productValidation.updateProduct, editFormBody());
    expect(error).toBeUndefined();
    expect(value).not.toHaveProperty(field);
  });

  it('refuses a batches array on the product form outright', () => {
    const { error } = validated(productValidation.updateProduct, {
      ...editFormBody(),
      batches: [{ batchNumber: 'X', quantity: 1 }],
    });
    expect(error?.message).toMatch(/batches/);
  });

  it('still applies those defaults on CREATE, where absent means new', () => {
    const { error, value } = validated(productValidation.createProduct, editFormBody());
    expect(error).toBeUndefined();
    expect(value.batches).toEqual([]);
    expect(value.trackBatches).toBe(false);
    expect(value.isAvailableOnline).toBe(true);
  });

  it('accepts a per-variant opening batch on create', () => {
    const { error, value } = validated(productValidation.createProduct, {
      ...editFormBody(),
      hasVariants: true,
      trackBatches: true,
      variants: [
        { sku: 'M-500', buyingPrice: 400, sellingPrice: 450, stock: 25,
          openingBatch: { batchNumber: 'B-101', expiryDate: '2026-06-30' } },
        { sku: 'M-1000', buyingPrice: 800, sellingPrice: 880, stock: 12,
          openingBatch: { batchNumber: 'B-102', expiryDate: '2026-12-31' } },
      ],
    });
    expect(error).toBeUndefined();
    expect(value.variants[0].openingBatch.batchNumber).toBe('B-101');
    expect(value.variants[1].openingBatch.batchNumber).toBe('B-102');
  });
});
