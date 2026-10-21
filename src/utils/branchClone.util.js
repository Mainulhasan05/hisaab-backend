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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SAME NAME, DIFFERENT CODE — the case that stranded a whole shop's transfers
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A product's code is the category's letters plus a RANDOM four digits
 * (`lib/productCode.js`). A branch whose catalogue was typed in by hand, rather
 * than cloned by the admin, therefore holds every shared item under a
 * DIFFERENT code. In production (2026-10-22) one shop had 18 items in both
 * branches by name and 0 by code, and every transfer it ever sent — four, back
 * to August — sat in transit forever: the source deducted, the destination
 * could never receive.
 *
 * Matching by name automatically would be wrong the other way (two different
 * items can share a name, and the units can differ — পিস here, প্যাক there).
 * So a name match is only ever a SUGGESTION, and the shopkeeper confirms it
 * once. Confirming writes `clonedFrom` on the destination product, which is
 * the lineage rule `findCounterpartsBatch` already follows, so every later
 * transfer — in either direction — matches with no further question. Nothing
 * the shopkeeper sees changes: not the code, not the price, not the barcode.
 */

/** Compare names as a shopkeeper would: spacing, case and zero-width marks ignored. */
const normName = (s) => String(s || '')
  .normalize('NFC')
  .replace(/[​-‍﻿]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

/** The lineage id every linked copy of `p` points at. */
const rootOf = (p) => p.clonedFrom || p._id;

/**
 * For each source product with NO counterpart in `branchId`, the destination
 * product carrying the same name — offered, never applied.
 *
 * Offered only when it is unambiguous and free to link: exactly one live
 * destination product by that name, not a combo, and not already linked to a
 * DIFFERENT item.
 *
 * Reads only names and a few fields, and only when there is something to look
 * for.
 *
 * @returns {Map<string, Product>} keyed by the SOURCE product's id
 */
const findNameMatches = async (sources, shopId, branchId, session = null) => {
  const out = new Map();
  if (sources.length === 0) return out;

  const rows = await Product.find({ shop: shopId, branch: branchId, isDeleted: { $ne: true } })
    .select('name code unit stock clonedFrom type trackStock hasVariants variants')
    .session(session || null);

  const byName = new Map();
  for (const r of rows) {
    const k = normName(r.name);
    if (!k) continue;
    byName.set(k, [...(byName.get(k) || []), r]);
  }

  for (const src of sources) {
    const hits = byName.get(normName(src.name)) || [];
    if (hits.length !== 1) continue;
    const [hit] = hits;
    if (hit.type === 'combo' || String(hit._id) === String(src._id)) continue;
    if (hit.clonedFrom && String(hit.clonedFrom) !== String(rootOf(src))) continue;
    out.set(String(src._id), hit);
  }
  return out;
};

/**
 * Confirm "these are the same item": point each destination product's lineage
 * at its source. Returns the number linked; refuses as a whole if any target
 * cannot be linked, so a transfer never half-resolves.
 *
 * Refused when the target is already the ROOT other copies point at — re-
 * pointing it would cut those copies loose — or already linked elsewhere.
 *
 * @param {Array<{source: Product, target: Product}>} pairs
 */
const linkToSource = async (pairs, shopId, session = null) => {
  if (pairs.length === 0) return 0;
  const sessionOpt = session ? { session } : {};

  const targetIds = pairs.map((p) => p.target._id);
  const isRoot = await Product.find({ shop: shopId, clonedFrom: { $in: targetIds } })
    .select('clonedFrom name')
    .session(session || null);
  if (isRoot.length > 0) {
    const name = pairs.find((p) => String(p.target._id) === String(isRoot[0].clonedFrom))?.target.name;
    throw operationalError(`"${name || 'পণ্যটি'}" আগে থেকেই অন্য শাখার একটি পণ্যের সাথে যুক্ত, এটাকে আবার মিলানো যাবে না।`, 409);
  }

  const res = await Product.bulkWrite(pairs.map(({ source, target }) => ({
    updateOne: {
      filter: {
        _id: target._id,
        shop: shopId,
        isDeleted: { $ne: true },
        $or: [{ clonedFrom: null }, { clonedFrom: rootOf(source) }],
      },
      update: { $set: { clonedFrom: rootOf(source) } },
    },
  })), sessionOpt);

  const matched = res?.matchedCount ?? res?.nMatched ?? pairs.length;
  if (matched < pairs.length) {
    throw operationalError('একটি পণ্য এর মধ্যে অন্য পণ্যের সাথে যুক্ত হয়ে গেছে। পেজটি রিফ্রেশ করে আবার চেষ্টা করুন।', 409);
  }
  // Mirror the write on the in-memory docs, so a caller that re-plans in the
  // same request sees the link.
  for (const { source, target } of pairs) target.clonedFrom = rootOf(source);
  return pairs.length;
};

module.exports = {
  plainOf,
  normName,
  rootOf,
  findCounterpart,
  findCounterpartsBatch,
  findNameMatches,
  linkToSource,
  cloneDocFor,
  cloneIntoBranch,
  attachClonedMedia,
};
