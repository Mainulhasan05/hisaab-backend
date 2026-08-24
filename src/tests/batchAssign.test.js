/**
 * Assigning an ORPHANED batch onto a variant.
 *
 * ── THE SITUATION THIS EXISTS FOR ───────────────────────────────────────────
 *
 * A shop dates a plain product — one expiry, one batch, `variantId: null`,
 * because at the time the product itself was the only sellable thing. Later
 * they edit that product and give it variants. `PUT /products/:id` flips
 * `hasVariants` and rebuilds `variants[]`, and `batches` is `Joi.forbidden()`
 * on that route, so the dated row survives the conversion belonging to nothing.
 *
 * What that cost, before this: the batch panel built its rows from
 * `product.variants` alone, so the batch stopped being rendered at all. Not
 * deleted — unreachable. Nothing could edit it, nothing could delete it, and
 * FEFO skipped it at the till forever, because a sale of ১০০ মিলি never matches
 * an owner of null. The expiry screen meanwhile went on warning about it daily
 * with no variant name beside the date. Seen in the wild as 137 dated units
 * against two variants summing to 40.
 *
 * Groups (AGENT_WORKFLOW.md §7.1):
 *
 *   A. THE ORPHAN IS VISIBLE — REGRESSION. `getProductBatches` must surface a
 *      row nothing owns. Fails against the old code, which could not.
 *
 *   B. ASSIGNING — the feature. Whole-row moves, splits, and the arithmetic
 *      that stops a move inventing stock.
 *
 *   C. GUARDS — a plain product, a bad variant, a quantity larger than the row.
 */

const mongoose = require('mongoose');
const Product = require('../models/Product.model');
const productService = require('../services/product.service');

const oid = () => new mongoose.Types.ObjectId();

/**
 * A product converted from plain to variants, with its old dated batch still
 * belonging to the product itself. `save` is stubbed — none of this needs a DB,
 * and the point of the test is the arithmetic and the ownership.
 */
function makeConvertedProduct({ orphanQty = 137, variantStock = [17, 23] } = {}) {
  const product = new Product({
    name: 'নাপা সিরাপ',
    shop: oid(),
    category: oid(),
    code: 'MED3164',
    trackBatches: true,
    hasVariants: true,
    stock: variantStock.reduce((a, b) => a + b, 0),
    variants: variantStock.map((stock, i) => ({
      sku: `MED3164-${i === 0 ? '100MILI' : '1L'}`,
      stock,
      buyingPrice: 37,
      sellingPrice: 50,
      attributes: {},
    })),
    batches: [{
      variantId: null,               // the orphan: dated while it was one product
      batchNumber: 'B-2028-05-05',
      expiryDate: new Date('2028-05-05'),
      quantity: orphanQty,
    }],
  });

  product.save = jest.fn().mockResolvedValue(product);
  return product;
}

/** Point the service at an in-memory document instead of the database. */
function stubService(product) {
  jest.spyOn(productService, '_loadProductForBatches').mockResolvedValue(product);
  jest.spyOn(productService, '_logBatchAudit').mockResolvedValue(undefined);
}

afterEach(() => jest.restoreAllMocks());

// ══ A. THE ORPHAN IS VISIBLE ════════════════════════════════════════════════

describe('A — batches nothing owns are still shown', () => {
  it('gives the orphans a row of their own, flagged unassigned', async () => {
    const product = makeConvertedProduct();
    stubService(product);

    const out = await productService.getProductBatches(product.shop, product._id, null);

    const orphan = out.owners.find(o => o.unassigned);
    expect(orphan).toBeDefined();
    expect(orphan.batches).toHaveLength(1);
    expect(orphan.batches[0].batchNumber).toBe('B-2028-05-05');
    // Its stock is what is IN the batches — there is no pool behind it.
    expect(orphan.stock).toBe(137);
    // And it offers no remainder to date, because there is nothing to date.
    expect(orphan.untracked).toBe(0);
  });

  it('lists it FIRST, ahead of the variants that need fixing', async () => {
    const product = makeConvertedProduct();
    stubService(product);

    const out = await productService.getProductBatches(product.shop, product._id, null);
    expect(out.owners[0].unassigned).toBe(true);
    expect(out.owners).toHaveLength(3); // orphan + two variants
  });

  it('adds no such row when every batch already belongs to a variant', async () => {
    const product = makeConvertedProduct();
    product.batches[0].variantId = product.variants[0]._id;
    stubService(product);

    const out = await productService.getProductBatches(product.shop, product._id, null);
    expect(out.owners.some(o => o.unassigned)).toBe(false);
    expect(out.owners).toHaveLength(2);
  });

  it('leaves a plain product exactly as it was — one row, named for the product', async () => {
    const product = makeConvertedProduct();
    product.hasVariants = false;
    product.variants = [];
    product.stock = 137;
    stubService(product);

    const out = await productService.getProductBatches(product.shop, product._id, null);
    expect(out.owners).toHaveLength(1);
    expect(out.owners[0].unassigned).toBeUndefined();
    expect(out.owners[0].variantId).toBeNull();
    expect(out.owners[0].batches).toHaveLength(1);
  });
});

// ══ B. ASSIGNING ════════════════════════════════════════════════════════════

describe('B — moving a batch onto a variant', () => {
  it('moves the whole row when no quantity is named, keeping its id', async () => {
    const product = makeConvertedProduct({ orphanQty: 17 });
    stubService(product);
    const target = product.variants[0]._id;
    const batchId = product.batches[0]._id;

    await productService.assignBatchToVariant(
      product.shop, oid(), product._id, batchId, { variantId: target }, null
    );

    expect(product.batches).toHaveLength(1);
    expect(String(product.batches[0]._id)).toBe(String(batchId));
    expect(String(product.batches[0].variantId)).toBe(String(target));
    expect(product.batchesFor(null)).toHaveLength(0);
    expect(product.save).toHaveBeenCalled();
  });

  it('SPLITS when only part of the row is moved, and the date travels to both', async () => {
    // The real case: 137 dated units, and 17 of them are the ১০০ মিলি.
    const product = makeConvertedProduct();
    stubService(product);
    const target = product.variants[0]._id;

    await productService.assignBatchToVariant(
      product.shop, oid(), product._id, product.batches[0]._id,
      { variantId: target, quantity: 17 }, null
    );

    expect(product.batches).toHaveLength(2);

    const moved = product.batchesFor(target);
    const left = product.batchesFor(null);
    expect(moved).toHaveLength(1);
    expect(moved[0].quantity).toBe(17);
    expect(left).toHaveLength(1);
    expect(left[0].quantity).toBe(120);

    // The expiry date is the whole point — losing it on either half would be
    // the same as deleting the batch.
    expect(moved[0].expiryDate).toEqual(new Date('2028-05-05'));
    expect(left[0].expiryDate).toEqual(new Date('2028-05-05'));
    expect(moved[0].batchNumber).toBe('B-2028-05-05');
  });

  it('two splits clear the orphan row entirely', async () => {
    const product = makeConvertedProduct({ orphanQty: 40, variantStock: [17, 23] });
    stubService(product);
    const [a, b] = product.variants.map(v => v._id);

    await productService.assignBatchToVariant(
      product.shop, oid(), product._id, product.batches[0]._id, { variantId: a, quantity: 17 }, null
    );
    const remaining = product.batchesFor(null)[0];
    await productService.assignBatchToVariant(
      product.shop, oid(), product._id, remaining._id, { variantId: b }, null
    );

    expect(product.batchesFor(null)).toHaveLength(0);
    expect(product.batchesFor(a)[0].quantity).toBe(17);
    expect(product.batchesFor(b)[0].quantity).toBe(23);
  });
});

// ══ C. GUARDS ═══════════════════════════════════════════════════════════════

describe('C — a move must never invent stock', () => {
  it('refuses more than the destination variant holds', async () => {
    // 137 dated units cannot all be ১০০ মিলি when only 17 of them exist.
    const product = makeConvertedProduct();
    stubService(product);

    await expect(
      productService.assignBatchToVariant(
        product.shop, oid(), product._id, product.batches[0]._id,
        { variantId: product.variants[0]._id }, null
      )
    ).rejects.toThrow(/exceeds untracked stock/i);

    // And nothing moved.
    expect(product.batchesFor(null)).toHaveLength(1);
    expect(product.batches).toHaveLength(1);
  });

  it('counts what the variant already has batched', async () => {
    const product = makeConvertedProduct({ orphanQty: 20, variantStock: [17, 23] });
    // 10 of the ১০০ মিলি's 17 are already dated, leaving room for 7.
    product.batches.push({
      variantId: product.variants[0]._id,
      batchNumber: 'B-EARLIER', expiryDate: new Date('2027-01-01'), quantity: 10,
    });
    stubService(product);

    await expect(
      productService.assignBatchToVariant(
        product.shop, oid(), product._id, product.batches[0]._id,
        { variantId: product.variants[0]._id, quantity: 8 }, null
      )
    ).rejects.toThrow(/exceeds untracked stock/i);

    // 7 fits exactly.
    await productService.assignBatchToVariant(
      product.shop, oid(), product._id, product.batches[0]._id,
      { variantId: product.variants[0]._id, quantity: 7 }, null
    );
    expect(product.batchesFor(product.variants[0]._id)
      .reduce((s, b) => s + b.quantity, 0)).toBe(17);
  });

  it('refuses to move more than the batch actually holds', async () => {
    const product = makeConvertedProduct({ orphanQty: 5, variantStock: [100, 23] });
    stubService(product);

    await expect(
      productService.assignBatchToVariant(
        product.shop, oid(), product._id, product.batches[0]._id,
        { variantId: product.variants[0]._id, quantity: 6 }, null
      )
    ).rejects.toThrow(/holds only/i);
  });

  it('refuses a variant the product does not have', async () => {
    const product = makeConvertedProduct({ orphanQty: 5, variantStock: [100, 23] });
    stubService(product);

    await expect(
      productService.assignBatchToVariant(
        product.shop, oid(), product._id, product.batches[0]._id,
        { variantId: oid() }, null
      )
    ).rejects.toThrow(/Variant not found/i);
  });

  it('refuses on a product with no variants at all', async () => {
    const product = makeConvertedProduct();
    product.hasVariants = false;
    product.variants = [];
    stubService(product);

    await expect(
      productService.assignBatchToVariant(
        product.shop, oid(), product._id, product.batches[0]._id,
        { variantId: oid() }, null
      )
    ).rejects.toThrow(/no variants/i);
  });

  it('refuses an unknown batch', async () => {
    const product = makeConvertedProduct();
    stubService(product);

    await expect(
      productService.assignBatchToVariant(
        product.shop, oid(), product._id, oid(), { variantId: product.variants[0]._id }, null
      )
    ).rejects.toThrow(/Batch not found/i);
  });
});
