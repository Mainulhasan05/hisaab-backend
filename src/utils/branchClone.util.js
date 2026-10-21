/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SAME PRODUCT IN ANOTHER BRANCH
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Each branch owns its own product documents (its own price, its own stock),
 * so "the same item" in another branch is a different document. Three callers
 * need to find or make that document, and they must agree on how:
 *
 *   stockTransfer.service   which copy does an arriving line credit?
 *   product.service         "অন্য শাখায় কপি" — the owner fills a branch's shelf
 *   admin.service           a new branch's catalogue, copied once at creation
 *
 * They used to hold three versions of this. The matching rule lived only in the
 * transfer service, and the admin clone never counted the photo references its
 * copies held — see `attachClonedMedia`.
 */

const Product = require('../models/Product.model');
const mediaService = require('../services/media.service');

const operationalError = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.messageBn = message;
  err.isOperational = true;
  return err;
};

/** A hydrated doc or a plain object, as a plain object. */
const plainOf = (doc) => (typeof doc?.toObject === 'function' ? doc.toObject({ virtuals: false }) : { ...doc });

/**
 * Resolve the destination branch's copy of a product.
 *
 * They are matched by `code` — the clone that seeds a new branch keeps the code
 * identical — with `clonedFrom` lineage as a fallback for products whose code
 * was later edited.
 *
 * Returns null when the destination branch does not stock the item, which the
 * callers surface as a named error rather than silently transferring nothing.
 */
const findCounterpart = async (sourceProduct, shopId, branchId, session = null) => {
  const q = (filter) => Product.findOne(filter).session(session || null);

  return (
    (await q({ shop: shopId, branch: branchId, code: sourceProduct.code, isDeleted: { $ne: true } })) ||
    (await q({ shop: shopId, branch: branchId, clonedFrom: sourceProduct.clonedFrom || sourceProduct._id, isDeleted: { $ne: true } })) ||
    (await q({ shop: shopId, branch: branchId, _id: sourceProduct.clonedFrom, isDeleted: { $ne: true } }))
  );
};

/**
 * Batched twin of `findCounterpart` — resolves every source product's
 * copy in `branchId` in ONE query instead of up to three per line.
 *
 * `findCounterpart` is kept above because it is still the clearest statement of
 * the matching RULE, and the precedence here is a faithful copy of it:
 *
 *   1. same `code` in the other branch          (the clone keeps the code)
 *   2. same `clonedFrom` lineage               (code was edited since)
 *   3. the other product IS the original the source was cloned from
 *
 * Candidates for all three arms are fetched together, then resolved in memory
 * in that same order. If you change the rule, change both — or delete the
 * single-item version and route its callers here.
 *
 * Symmetric: it answers "A's copy in B" and "B's copy in A" alike, which is
 * what lets the transfer suggestions walk from a low destination shelf back to
 * the source.
 *
 * @returns {Map<string, Product>} keyed by the SOURCE product's id
 */
const findCounterpartsBatch = async (sourceProducts, shopId, branchId, session = null) => {
  if (sourceProducts.length === 0) return new Map();

  const codes = [...new Set(sourceProducts.map((p) => p.code).filter(Boolean))];
  const lineage = [...new Set(
    sourceProducts.map((p) => String(p.clonedFrom || p._id)).filter(Boolean)
  )];
  const originIds = [...new Set(
    sourceProducts.map((p) => p.clonedFrom).filter(Boolean).map(String)
  )];

  const or = [];
  if (codes.length) or.push({ code: { $in: codes } });
  if (lineage.length) or.push({ clonedFrom: { $in: lineage } });
  if (originIds.length) or.push({ _id: { $in: originIds } });
  if (or.length === 0) return new Map();

  const candidates = await Product.find({
    shop: shopId, branch: branchId, isDeleted: { $ne: true }, $or: or,
  }).session(session || null);

  const byCode = new Map();
  const byClonedFrom = new Map();
  const byId = new Map();
  for (const c of candidates) {
    if (c.code && !byCode.has(c.code)) byCode.set(c.code, c);
    if (c.clonedFrom && !byClonedFrom.has(String(c.clonedFrom))) byClonedFrom.set(String(c.clonedFrom), c);
    byId.set(String(c._id), c);
  }

  const resolved = new Map();
  for (const src of sourceProducts) {
    const match =
      (src.code && byCode.get(src.code)) ||
      byClonedFrom.get(String(src.clonedFrom || src._id)) ||
      (src.clonedFrom && byId.get(String(src.clonedFrom))) ||
      null;
    if (match) resolved.set(String(src._id), match);
  }
  return resolved;
};

/**
 * One source product as a new document for `toBranch`, at zero stock.
 *
 * Copied: name, code, barcode, category, unit, prices, variants (with their
 * prices), minStock, images, tags. Reset: stock 0, batches/serials empty,
 * sales counters cleared. `code` is kept so the copy is the counterpart every
 * later transfer finds, and `clonedFrom` records the lineage.
 *
 * `keepOnline` is the admin clone's historical behaviour (a whole new branch
 * mirrors the old one). Everything else copies with online OFF: a storefront
 * with no fulfilment branch lists every branch's catalogue, so an online copy
 * shows the item twice. Whether the destination sells it online is its call.
 */
const cloneDocFor = (p, toBranch, { keepOnline = false } = {}) => {
  const { _id, id, createdAt, updatedAt, __v, ...rest } = plainOf(p);
  return {
    ...rest,
    branch: toBranch,
    clonedFrom: p.clonedFrom || p._id,
    stock: 0,
    variants: (rest.variants || []).map((v) => ({ ...plainOf(v), stock: 0 })),
    batches: [],
    serials: [],
    totalSold: 0,
    lastSold: null,
    ...(keepOnline ? {} : { isAvailableOnline: false, isFeaturedOnline: false }),
  };
};

/**
 * Insert zero-stock copies of `sources` into `toBranch`. Returns the inserted
 * documents. Call `attachClonedMedia` with them AFTER the surrounding
 * transaction commits.
 */
const cloneIntoBranch = async (sources, toBranch, session = null, options = {}) => {
  if (sources.length === 0) return [];

  const docs = sources.map((p) => cloneDocFor(p, toBranch, options));

  try {
    return await Product.insertMany(docs, session ? { session } : {});
  } catch (err) {
    // {shop, branch, code} is unique and includes deleted rows. A product
    // deleted before deletes started renaming the code still holds it.
    if (err?.code === 11000) {
      throw operationalError(
        'গন্তব্য শাখায় একই কোডের একটি পুরোনো (মুছে ফেলা) পণ্য আছে। ওই শাখায় পণ্যটি নিজে যোগ করুন বা কোড বদলান।',
        409
      );
    }
    throw err;
  }
};

/**
 * Count the photo references new copies hold.
 *
 * A copy points at the SAME R2 objects as its original. `refCount` is what the
 * reclaim sweep reads to decide a photo is unused, so a copy that never counted
 * its references makes the original the only holder: delete the original and
 * the sweep takes the photos out from under the copy, weeks later, with
 * nothing to connect the two events.
 *
 * Run after commit — `reconcileRefs` writes outside any transaction and never
 * throws, so running it inside would count a reference for a copy a rollback
 * then removed.
 *
 * @param {Array} cloned    inserted product documents
 * @param {Array} appended  `{ target, variants }` — variants pushed onto an
 *                          existing product
 */
const attachClonedMedia = async (shopId, cloned = [], appended = []) => {
  for (const p of cloned) {
    await mediaService.reconcileRefs(shopId, [], mediaService.mediaIdsOfProduct(p));
  }
  for (const { target, variants } of appended) {
    const before = mediaService.mediaIdsOfProduct(target);
    await mediaService.reconcileRefs(
      shopId, before, [...before, ...variants.map((v) => v.imageMediaId)]
    );
  }
};

module.exports = {
  plainOf,
  findCounterpart,
  findCounterpartsBatch,
  cloneDocFor,
  cloneIntoBranch,
  attachClonedMedia,
};
