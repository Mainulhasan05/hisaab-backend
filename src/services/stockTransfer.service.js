const mongoose = require('mongoose');
const StockTransfer = require('../models/StockTransfer.model');
const StockTransaction = require('../models/StockTransaction.model');
const Product = require('../models/Product.model');
const Branch = require('../models/Branch.model');
const { runInTransaction } = require('../utils/transaction.util');
const { STOCK_TRANSACTION_TYPES } = require('../config/constants');
const { isActiveBranch, isAllBranchesView, isMultiBranch } = require('../utils/branchScope.util');
const { storageUnit, quantize } = require('../utils/quantity.util');
const { buildDateMatch } = require('../utils/reportScope.util');
const { takeBatches, addBatches, batchWriteOp } = require('../utils/batch.util');
const { assertNotCombo } = require('../utils/combo.util');
const { assertTracked, TRACKED_FILTER } = require('../utils/stockTracking.util');
const { hasPermission } = require('../middleware/permission.middleware');
const {
  plainOf, findCounterpartsBatch, cloneIntoBranch, attachClonedMedia,
  findNameMatches, linkToSource,
} = require('../utils/branchClone.util');

/**
 * A refusal this service authored, in Bengali, with a status code.
 *
 * `isOperational` is the important line and it was missing. The global error
 * handler sends `messageBn` through to the client ONLY for operational errors;
 * everything else is treated as a crash and answered with the generic
 * "কিছু একটা সমস্যা হয়েছে। আবার চেষ্টা করুন।" So in production every carefully
 * worded refusal in this file — insufficient stock, wrong branch, product not
 * stocked at the destination — arrived as that one useless sentence, and the
 * status code was ignored too. Development was unaffected, which is why it went
 * unnoticed: `sendErrorDev` sends the Bengali regardless.
 */
const createError = (message, statusCode = 400) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.messageBn = message;
  err.isOperational = true;
  return err;
};

/**
 * The `reference` block every transfer ledger row carries.
 *
 * `StockTransaction.reference` is an OBJECT — `{ type, id, invoiceNo }` — and
 * this file used to write `reference: transfer._id` beside a `referenceModel`
 * key the schema does not declare, `performedBy` instead of the required
 * `createdBy`, and `note` instead of `notes`. Three of those are silently
 * dropped; the fourth is required, so EVERY approve, receive and reject died on
 * `insertMany` with a validation error — after `Product.bulkWrite` had already
 * moved the stock. The batching tests never caught it because they stub
 * `StockTransaction.insertMany`, so no schema ever ran.
 *
 * The transfer number goes in `invoiceNo` for the same reason a purchase puts
 * its invoice there: it is the human-readable handle a stock history row is
 * looked up by.
 */
const transferLedgerRef = (transfer) => ({
  reference: {
    type: 'transfer',
    id: transfer._id,
    invoiceNo: transfer.transferNo,
  },
});

/**
 * Stock transfer is the one place cross-branch access is intentional, so it
 * cannot just be filtered by the active branch — it needs a rule per action
 * (product decision #9):
 *
 *   create / approve / reject → the SOURCE branch acts
 *   receive                   → the DESTINATION branch acts
 *
 * An owner viewing "All Branches" is not acting as any branch, so they must
 * pick one first — same rule as every other write. Single-branch shops never
 * reach this (isMultiBranch is false, so it is a no-op).
 */
const assertActingBranch = (req, branchId, role) => {
  if (!req || !isMultiBranch(req)) return;

  if (isAllBranchesView(req)) {
    throw createError(
      role === 'destination'
        ? 'ট্রান্সফার গ্রহণ করতে গন্তব্য শাখা নির্বাচন করুন'
        : 'ট্রান্সফার পরিচালনা করতে উৎস শাখা নির্বাচন করুন',
      400
    );
  }

  if (!isActiveBranch(req, branchId)) {
    throw createError(
      role === 'destination'
        ? 'শুধুমাত্র গন্তব্য শাখা এই ট্রান্সফার গ্রহণ করতে পারে'
        : 'শুধুমাত্র উৎস শাখা এই ট্রান্সফার পরিচালনা করতে পারে',
      403
    );
  }
};

/** Does this product actually carry variants, whatever the flag says? */
const hasRealVariants = (product) =>
  Array.isArray(product?.variants) && product.variants.length > 0;

/** One variant subdocument by id, on a hydrated doc or a plain object. */
const variantById = (product, variantId) => {
  if (!variantId) return null;
  return (typeof product?.variants?.id === 'function'
    ? product.variants.id(variantId)
    : product?.variants?.find((x) => String(x._id) === String(variantId))) || null;
};

/**
 * A short human label — "XL / লাল" — for error messages.
 *
 * Takes either a variant subdocument (`attributes`, `sku`) or a transfer line
 * (`variantAttributes`, `variantSku`), because both sides of a receipt need to
 * name the same thing and only one of them holds a variant document.
 */
const variantLabel = (src) => {
  const a = src?.attributes || src?.variantAttributes || {};
  const parts = [a.size, a.color, a.weight, a.material, a.style].filter(Boolean);
  return parts.join(' / ') || src?.sku || src?.variantSku || '';
};

/**
 * A transfer line on a variant product MUST name its variant.
 *
 * Without this the line moved `product.stock`, which on a variant product is
 * the ROLL-UP of `variants[].stock`. The source was written with a total one
 * unit lower than its own variants sum to, the destination one unit higher, and
 * the next thing to recompute either rollup silently undid the whole transfer.
 * Nothing errored; the stock simply came back. (See the rollup-drift repair
 * this repo already carries a script for.)
 *
 * Checked on the product DATA rather than `hasVariants`, for the reason the
 * Product model spells out: the flag is set by a human and the array is the
 * truth.
 */
const assertVariantChosen = (product, item) => {
  if (!hasRealVariants(product)) return;
  if (!item.variantId) {
    throw createError(
      `"${item.productName || product.name}" এর ভ্যারিয়েন্ট নির্বাচন করুন`,
      400
    );
  }
  if (!variantById(product, item.variantId)) {
    throw createError(
      `"${item.productName || product.name}" এর নির্বাচিত ভ্যারিয়েন্ট উৎস শাখায় নেই`,
      400
    );
  }
};

/**
 * The DESTINATION branch's variant for a transfer line.
 *
 * Variant `_id`s are subdocument ids, so they belong to the product document
 * that holds them. They happen to match across branches for a catalogue seeded
 * by the admin clone (it copies each variant object wholesale, `_id` included)
 * and do NOT match for a branch whose products were entered by hand. The old
 * code assumed the first case always held, so every hand-built branch rejected
 * an arriving variant line with "ভ্যারিয়েন্ট গন্তব্য শাখায় নেই" and the goods
 * could never be received.
 *
 * SKU is the real cross-branch key — the clone preserves it and a shopkeeper
 * typing the catalogue in twice uses the same one — with the attribute triple
 * as the last resort for a SKU that was later edited on one side.
 */
const resolveDestinationVariant = (target, item) => {
  const byId = variantById(target, item.variantId);
  if (byId) return byId;

  const list = Array.isArray(target?.variants) ? target.variants : [];
  if (item.variantSku) {
    const bySku = list.find(
      (v) => v.sku && String(v.sku).toLowerCase() === String(item.variantSku).toLowerCase()
    );
    if (bySku) return bySku;
  }

  const want = item.variantAttributes || {};
  const keys = ['size', 'color', 'weight', 'material', 'style'].filter((k) => want[k]);
  if (keys.length) {
    const byAttrs = list.find((v) =>
      keys.every((k) => String(v.attributes?.[k] || '') === String(want[k]))
    );
    if (byAttrs) return byAttrs;
  }

  return null;
};

/** Read a product's stock for a variant (or the product itself). */
const readStock = (product, variantId) => {
  if (!variantId) return product.stock || 0;
  const v = typeof product.variants?.id === 'function'
    ? product.variants.id(variantId)
    : product.variants?.find((x) => String(x._id) === String(variantId));
  return v?.stock || 0;
};

/**
 * Apply a delta to a product's stock (variant-aware) and return the new value.
 *
 * Quantized at the product's own precision. A transfer is a deduct on one
 * document and an add on another, and the two products are separate documents
 * with separately-drifting stock — without the rounding, moving 1.1 kg back and
 * forth a few hundred times leaves both branches holding a residue and the
 * shop-wide total no longer adding up.
 *
 * `storageUnit` is flag-independent by design: a transfer created while
 * packaging was on must still settle correctly if it is switched off before the
 * receiving branch accepts it.
 */
const applyStock = (product, variantId, delta) => {
  const stkUnit = storageUnit(product);
  if (variantId) {
    const v = typeof product.variants?.id === 'function'
      ? product.variants.id(variantId)
      : product.variants?.find((x) => String(x._id) === String(variantId));
    if (!v) return null;
    v.stock = quantize(Math.max(0, quantize((v.stock || 0) + delta, stkUnit)), stkUnit);
    return v.stock;
  }
  product.stock = quantize(Math.max(0, quantize((product.stock || 0) + delta, stkUnit)), stkUnit);
  return product.stock;
};

/**
 * Load every product referenced by `items` in ONE query, keyed by id string.
 *
 * Replaces the `await Product.findOne(...)` that used to sit inside each of the
 * loops below — one round trip per line item, sequential, inside an open
 * transaction. A 20-line transfer cost 20 reads for information a single `$in`
 * returns (PERFORMANCE_AUDIT.md H-3).
 */
const loadProductsFor = async (items, filter, session = null) => {
  const ids = [...new Set(items.map((i) => String(i.product)))];
  const docs = await Product.find({ ...filter, _id: { $in: ids } }).session(session || null);
  return new Map(docs.map((d) => [String(d._id), d]));
};

/**
 * A bulkWrite op that persists the stock value already computed by `applyStock`.
 *
 * `$set` — not `$inc` — on purpose. `applyStock` quantizes at the product's own
 * precision in JS, and the previous code persisted that result with
 * `product.save()`. Writing the computed value keeps this refactor
 * behaviour-preserving; switching to `$inc` would change the rounding and the
 * concurrency semantics at the same time, which is not what a batching change
 * should do. (The sale path uses `$inc` with a `$gte` guard because it needs
 * atomic oversell protection; transfers guard by explicit pre-validation.)
 */
const stockWriteOp = (product, variantId, newStock) => {
  if (!variantId) {
    return {
      updateOne: {
        filter: { _id: product._id },
        update: { $set: { stock: newStock } },
      },
    };
  }

  // Cast, for the reason `buildVariantStockUpdate` spells out: `$eq` inside a
  // pipeline compares BSON types, so a string id matches no element and stage 1
  // becomes a silent no-op — the transfer would report success having moved
  // nothing. `arrayFilters` was forgiving about this; a pipeline is not.
  const vid = new mongoose.Types.ObjectId(variantId);

  return {
    updateOne: {
      filter: { _id: product._id },
      // Two stages for the reason `buildVariantStockUpdate` documents: the
      // product-level `stock` on a variant product IS the sum across
      // `variants[]`, so writing the element without the rollup leaves the
      // stored total reading whatever it did before the transfer.
      //
      // Stage 1 keeps `$set` of the absolute value rather than a delta —
      // `applyStock` has already quantized it at the product's precision, and
      // this op exists to persist that exact figure (see above). Stage 2 then
      // sums the array stage 1 just wrote, so the rollup is derived on the
      // server from post-write state and cannot be computed from a stale read.
      update: [
        {
          $set: {
            variants: {
              $map: {
                input: { $ifNull: ['$variants', []] },
                as: 'v',
                in: {
                  $cond: [
                    { $eq: ['$$v._id', vid] },
                    { $mergeObjects: ['$$v', { stock: newStock }] },
                    '$$v',
                  ],
                },
              },
            },
          },
        },
        {
          $set: {
            stock: {
              $cond: [
                { $gt: [{ $size: { $ifNull: ['$variants', []] } }, 0] },
                { $sum: { $map: { input: '$variants', as: 'v', in: { $ifNull: ['$$v.stock', 0] } } } },
                '$stock',
              ],
            },
          },
        },
      ],
    },
  };
};

/** Flush queued stock writes and ledger rows — at most two round trips. */
const flushStockOps = async (stockOps, txns, sessionOpt) => {
  if (stockOps.length > 0) await Product.bulkWrite(stockOps, sessionOpt);
  if (txns.length > 0) await StockTransaction.insertMany(txns, sessionOpt);
};

/**
 * ── Can the DESTINATION receive these lines as they stand? ──────────────────
 *
 * Each branch owns its own product documents, and a branch only gets a copy of
 * the catalogue once — when the admin creates it. Every product added since
 * exists in the branch it was entered in and nowhere else. The receive step
 * used to be the first place that noticed: the source had already deducted the
 * stock, the goods were on the van, and the destination was told
 * "গন্তব্য শাখায় নেই" with no way to take them. The transfer then had to be
 * rejected and started again after someone typed the product in by hand.
 *
 * So the question is asked at create time, and answered in three buckets:
 *
 *   missingProducts  no counterpart at all          → can be cloned
 *   missingVariants  product there, variant not     → can be appended
 *   blocked          a shape mismatch nobody should guess at (one side has
 *                    variants and the other does not) → refused, by name
 *
 * The variant probe is built from the SOURCE variant, never from the request:
 * receive matches the destination variant by sku/attributes, and a hand-built
 * body naming the wrong sku would otherwise credit the wrong size.
 */
const planDestination = async (items, productMap, shopId, toBranch, session = null, linkTargets = new Map()) => {
  const counterparts = await findCounterpartsBatch(
    [...productMap.values()], shopId, toBranch, session
  );

  const missingProducts = new Map();   // source id → source product
  const missingVariants = [];          // { target, variant, item }
  const blocked = [];                  // { item, message }
  const linked = new Map();            // source id → { source, target } — confirmed by the user
  const seenVariant = new Set();

  for (const item of items) {
    const src = productMap.get(String(item.product));
    if (!src) continue;
    const name = item.productName || src.name;
    // A real counterpart always wins; a link the user chose is used only where
    // there is none, so a request can never re-point an existing match.
    let target = counterparts.get(String(src._id));
    if (!target && linkTargets.has(String(src._id))) {
      target = linkTargets.get(String(src._id));
      linked.set(String(src._id), { source: src, target });
    }

    if (!target) {
      missingProducts.set(String(src._id), src);
      continue;
    }

    if (!item.variantId) {
      // Crediting `stock` on a variant product writes the ROLL-UP, which the
      // next recompute silently undoes — the mirror of `assertVariantChosen`.
      if (hasRealVariants(target)) {
        blocked.push({
          item,
          message: `"${name}" গন্তব্য শাখায় ভ্যারিয়েন্টসহ আছে, কিন্তু এখানে ভ্যারিয়েন্ট ছাড়া। দুই শাখায় পণ্যটি একরকম করুন।`,
        });
      }
      continue;
    }

    const srcVariant = variantById(src, item.variantId);
    const probe = {
      variantId: item.variantId,
      variantSku: srcVariant?.sku || item.variantSku,
      variantAttributes: srcVariant?.attributes || item.variantAttributes,
    };
    if (resolveDestinationVariant(target, probe)) continue;

    // Appending a variant to a plain product would turn its stock into a
    // roll-up of one zero-stock variant and lose what it holds.
    if (!hasRealVariants(target) || !srcVariant) {
      blocked.push({
        item,
        message: `"${name}" গন্তব্য শাখায় ভ্যারিয়েন্ট ছাড়া আছে। দুই শাখায় পণ্যটি একরকম করুন।`,
      });
      continue;
    }

    const key = `${target._id}:${srcVariant._id}`;
    if (seenVariant.has(key)) continue;
    seenVariant.add(key);
    missingVariants.push({ target, variant: srcVariant, item });
  }

  // Same name, different code — see branchClone.util. Offered, never applied.
  const nameMatches = await findNameMatches([...missingProducts.values()], shopId, toBranch, session);

  return {
    missingProducts: [...missingProducts.values()],
    missingVariants,
    blocked,
    linked: [...linked.values()],
    nameMatches,
  };
};

/**
 * The destination products a request asked to link to, validated: each must be
 * a live, non-combo product of the DESTINATION branch, and each source must be
 * a line of this transfer.
 *
 * @param {Array<{product, target}>} links  as posted
 * @returns {Map<string, Product>} source id → destination product
 */
const loadLinkTargets = async (links, productMap, shopId, toBranch, session = null) => {
  const out = new Map();
  if (!Array.isArray(links) || links.length === 0) return out;

  const ids = [...new Set(links.map((l) => String(l?.target || '')).filter((x) => mongoose.isValidObjectId(x)))];
  const docs = ids.length
    ? await Product.find({ shop: shopId, branch: toBranch, isDeleted: { $ne: true }, _id: { $in: ids } }).session(session || null)
    : [];
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  for (const l of links) {
    const src = productMap.get(String(l?.product));
    const target = byId.get(String(l?.target));
    if (!src || !target || target.type === 'combo') {
      throw createError('মিলানোর জন্য বাছাই করা পণ্যটি গন্তব্য শাখায় পাওয়া যায়নি', 400);
    }
    out.set(String(src._id), target);
  }
  return out;
};

/**
 * What to do about each line the destination cannot take as it stands — and
 * the refusal, by name, for any line nobody decided about.
 *
 *   linked      the user confirmed "same item" → link (needs products.update)
 *   name match  a destination product has the same name: NEVER cloned silently.
 *               Either linked, or listed in `createNew` ("it is a different
 *               item") — the guard that stops a second "ইষ্ট ৫০০ গ্রাম" being
 *               made beside the first
 *   missing     nothing by code or name → cloned when `createMissing`
 *               (needs products.create)
 *   variants    appended when `createMissing`
 *
 * Pure decision; throws before anything is written.
 */
const decideDestination = (plan, { createMissing = false, createNew = new Set() } = {}, req = null) => {
  if (plan.blocked.length > 0) throw createError(plan.blocked[0].message, 400);

  const toClone = [];
  const ambiguous = [];
  const unresolved = [];
  for (const src of plan.missingProducts) {
    const id = String(src._id);
    const hit = plan.nameMatches.get(id);
    if (hit && !createNew.has(id)) { ambiguous.push({ src, hit }); continue; }
    if (createMissing || createNew.has(id)) { toClone.push(src); continue; }
    unresolved.push(src.name);
  }

  if (ambiguous.length > 0) {
    const { src, hit } = ambiguous[0];
    const more = ambiguous.length > 1 ? ` (আরও ${ambiguous.length - 1}টি এমন পণ্য আছে)` : '';
    const err = createError(
      `"${src.name}" গন্তব্য শাখায় একই নামে আছে (কোড ${hit.code}), কিন্তু কোড আলাদা। পণ্যটি মিলিয়ে নিন, বা আলাদা পণ্য হলে নতুন তৈরি করুন।${more}`,
      409
    );
    err.code = 'TRANSFER_NAME_MATCH';
    throw err;
  }

  const variantsToAppend = createMissing ? plan.missingVariants : [];
  if (!createMissing) {
    unresolved.push(...plan.missingVariants.map(({ item, variant }) =>
      `${item.productName || variant.sku} (${variantLabel(variant)})`));
  }
  if (unresolved.length > 0) {
    const err = createError(
      `${nameList(unresolved)} গন্তব্য শাখায় নেই। ওই শাখায় পণ্যটি যোগ করুন, বা তৈরি করে নিন।`,
      409
    );
    err.code = 'TRANSFER_MISSING_AT_DESTINATION';
    throw err;
  }

  if (plan.linked.length > 0 && req && !hasPermission(req, 'products', 'update')) {
    throw createError('দুই শাখার পণ্য মিলানোর অনুমতি আপনার নেই — মালিককে বলুন', 403);
  }
  if ((toClone.length > 0 || variantsToAppend.length > 0) && req && !hasPermission(req, 'products', 'create')) {
    throw createError('গন্তব্য শাখায় পণ্য তৈরি করার অনুমতি আপনার নেই', 403);
  }

  return { toLink: plan.linked, toClone, variantsToAppend };
};

/** A same-name candidate as the client sees it — enough to decide by. */
const describeMatch = (hit, src) => ({
  _id: hit._id,
  name: hit.name,
  code: hit.code,
  unit: hit.unit || 'piece',
  stock: hit.stock || 0,
  // পিস here, প্যাক there: linking still credits 1 for 1, so say so.
  unitDiffers: (hit.unit || 'piece') !== (src.unit || 'piece'),
});

/** Whether a decision writes anything (and so needs the transaction). */
const decisionWrites = (d) => d.toLink.length + d.toClone.length + d.variantsToAppend.length > 0;

/** Carry out a decision inside the caller's transaction. */
const applyDestination = async (decision, shopId, toBranch, session = null) => {
  await linkToSource(decision.toLink, shopId, session);
  const cloned = await cloneIntoBranch(decision.toClone, toBranch, session);
  const appended = await appendMissingVariants(decision.variantsToAppend, shopId, session);
  return { cloned, appended };
};

/** `createNew` as posted — source ids the user says are a DIFFERENT item. */
const idSet = (raw) => new Set((Array.isArray(raw) ? raw : []).map(String));

/**
 * Append the missing variants to destination products that already carry
 * variants, at zero stock. One op per destination product.
 *
 * The subdocument `_id` is kept, as the admin clone keeps it, so receive finds
 * it by id first. It cannot collide: a destination variant with that id would
 * have been the match, and this variant would not be missing.
 */
const appendMissingVariants = async (missingVariants, shopId, session = null) => {
  if (missingVariants.length === 0) return [];

  const byTarget = new Map();
  for (const mv of missingVariants) {
    const key = String(mv.target._id);
    if (!byTarget.has(key)) byTarget.set(key, { target: mv.target, variants: [] });
    byTarget.get(key).variants.push({ ...plainOf(mv.variant), stock: 0 });
  }

  const groups = [...byTarget.values()];
  await Product.bulkWrite(
    groups.map(({ target, variants }) => ({
      updateOne: {
        filter: { _id: target._id, shop: shopId },
        update: { $push: { variants: { $each: variants } } },
      },
    })),
    session ? { session } : {}
  );
  return groups;
};

/** "চাল, ডাল ও আরও ৩টি" — names for a refusal without a wall of text. */
const nameList = (names) => {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length <= 3) return unique.join(', ');
  return `${unique.slice(0, 3).join(', ')} ও আরও ${unique.length - 3}টি`;
};

/** May this request receive at the destination without switching to it? */
const mayReceiveNow = (req) => !req || req.isAdmin === true || req.user?.isOwner === true;

/** A variant counts as low below this when its product sets no minimum — the
 *  same figure the product list's কম স্টক filter uses for variants. */
const VARIANT_LOW_DEFAULT = 5;

/** At most this many suggestions — a list longer than this is not read. */
const SUGGESTION_LIMIT = 100;

/**
 * Preview a transfer before it is created: which lines the destination does
 * not stock yet, which cannot be sent as they stand, and which of the
 * one-step options this user may use. Writes nothing.
 */
exports.previewTransfer = async (data, req = null) => {
  const { shop, fromBranch, toBranch } = data;
  const items = Array.isArray(data.items) ? data.items : [];

  assertActingBranch(req, fromBranch, 'source');
  if (String(fromBranch) === String(toBranch)) {
    throw createError('উৎস ও গন্তব্য শাখা একই হতে পারবে না', 400);
  }
  const destBranch = await Branch.validateBranchOwnership(toBranch, shop);
  if (!destBranch) throw createError('গন্তব্য শাখা পাওয়া যায়নি', 404);

  const productMap = items.length
    ? await loadProductsFor(items, { shop, branch: fromBranch, isDeleted: { $ne: true } })
    : new Map();
  const plan = await planDestination(items, productMap, shop, toBranch);

  const missing = [];
  for (const item of items) {
    const src = productMap.get(String(item.product));
    if (src && plan.missingProducts.some((p) => String(p._id) === String(src._id))) {
      const hit = plan.nameMatches.get(String(src._id));
      missing.push({
        product: item.product, variantId: item.variantId || null,
        productName: src.name, kind: 'product',
        // Same name, different code: offered for linking, never auto-applied.
        nameMatch: hit ? describeMatch(hit, src) : null,
      });
    }
  }
  for (const { variant, item } of plan.missingVariants) {
    missing.push({
      product: item.product, variantId: item.variantId,
      productName: item.productName || productMap.get(String(item.product))?.name,
      variantLabel: variantLabel(variant), kind: 'variant',
    });
  }

  // The source's CURRENT stock per line. A repeated transfer or a suggestion
  // arrives with quantities but no stock figure; the form clamps against this.
  // A line whose product left the source is blocked here rather than at submit.
  const lines = [];
  const notAtSource = [];
  for (const item of items) {
    const src = productMap.get(String(item.product));
    if (!src) {
      notAtSource.push({
        product: item.product, variantId: item.variantId || null,
        message: `"${item.productName || 'পণ্য'}" এই শাখায় আর নেই`,
      });
      continue;
    }
    if (item.variantId && !variantById(src, item.variantId)) {
      notAtSource.push({
        product: item.product, variantId: item.variantId,
        message: `"${src.name}" এর এই ভ্যারিয়েন্ট এই শাখায় আর নেই`,
      });
      continue;
    }
    lines.push({
      product: item.product,
      variantId: item.variantId || null,
      stock: readStock(src, item.variantId || null),
    });
  }

  return {
    missing,
    lines,
    blocked: [
      ...notAtSource,
      ...plan.blocked.map(({ item, message }) => ({
        product: item.product, variantId: item.variantId || null, message,
      })),
    ],
    canCreateMissing: !req || hasPermission(req, 'products', 'create'),
    canLink: !req || hasPermission(req, 'products', 'update'),
    canDispatch: !req || hasPermission(req, 'stock_transfers', 'update'),
    canReceiveNow: mayReceiveNow(req),
  };
};

/**
 * ── Before "মাল বুঝে নিন": can every line land? ───────────────────────────────
 *
 * The destination's view of an arriving transfer, line by line:
 *
 *   ok         a counterpart exists — it will be credited
 *   nameMatch  a product with the same name exists under another code — the
 *              receiver confirms it is the same item (one click, remembered)
 *   missing    nothing by code or name — the receiver may create it here
 *   variant    the product is here, this size/colour is not — may be added
 *   blocked    a shape mismatch nobody should guess at
 *
 * This is what un-sticks a transfer created before the create-time check
 * existed: every one of them failed here with a refusal and no way forward.
 * Writes nothing.
 */
exports.getReceiveCheck = async (transferId, shopId, req = null) => {
  const transfer = await StockTransfer.findOne({ _id: transferId, shop: shopId }).session(null);
  if (!transfer) throw createError('ট্রান্সফার পাওয়া যায়নি', 404);
  assertActingBranch(req, transfer.toBranch, 'destination');

  const sourceMap = await loadProductsFor(transfer.items, { shop: shopId });
  const plan = await planDestination(transfer.items, sourceMap, shopId, transfer.toBranch);

  const missingIds = new Set(plan.missingProducts.map((p) => String(p._id)));
  const variantKeys = new Set(plan.missingVariants.map(({ item }) => String(item._id)));
  const blockedBy = new Map(plan.blocked.map(({ item, message }) => [String(item._id), message]));

  const lines = transfer.items.map((item) => {
    const src = sourceMap.get(String(item.product));
    const base = { itemId: item._id, product: item.product, productName: item.productName };
    if (!src) return { ...base, status: 'blocked', message: `"${item.productName}" পাঠানো শাখায় আর নেই` };
    if (blockedBy.has(String(item._id))) return { ...base, status: 'blocked', message: blockedBy.get(String(item._id)) };
    if (missingIds.has(String(src._id))) {
      const hit = plan.nameMatches.get(String(src._id));
      return hit
        ? { ...base, status: 'nameMatch', nameMatch: describeMatch(hit, src) }
        : { ...base, status: 'missing' };
    }
    if (variantKeys.has(String(item._id))) return { ...base, status: 'variant' };
    return { ...base, status: 'ok' };
  });

  return {
    lines,
    canLink: !req || hasPermission(req, 'products', 'update'),
    canCreateMissing: !req || hasPermission(req, 'products', 'create'),
  };
};

/**
 * ── What does the destination need? ─────────────────────────────────────────
 *
 * Lines the destination is running low on that THIS branch can spare, with a
 * quantity already worked out — so restocking a branch is a review-and-send,
 * not a walk through the shelves with a notepad.
 *
 *   low        destination stock below its own minStock (a variant: below the
 *              product's minStock, or VARIANT_LOW_DEFAULT when none is set)
 *   suggested  enough to bring it to TWICE that minimum — one minimum would
 *              leave it on the reorder line the day it arrives — but never
 *              more than the source holds above its OWN minimum. Restocking
 *              one branch by emptying the other is not a suggestion anyone
 *              wants.
 *
 * Owner only. It reads the other branch's stock figures, and multi-branch
 * visibility is the owner's (I-1); a cashier at the source has no business
 * reading the destination's shelves.
 *
 * Uncounted products and combos never appear: neither has stock to be low on.
 */
exports.getTransferSuggestions = async (shopId, query = {}, req = null) => {
  if (!mayReceiveNow(req)) {
    throw createError('কম স্টকের প্রস্তাব শুধু দোকান মালিক দেখতে পারেন', 403);
  }
  const fromBranch = req?.branchId || query.fromBranch;
  const { toBranch } = query;
  assertActingBranch(req, fromBranch, 'source');
  if (!fromBranch) throw createError('আগে একটি শাখা নির্বাচন করুন', 400);
  if (!toBranch) throw createError('গন্তব্য শাখা নির্বাচন করুন', 400);
  if (String(fromBranch) === String(toBranch)) {
    throw createError('উৎস ও গন্তব্য শাখা একই হতে পারবে না', 400);
  }
  const destBranch = await Branch.validateBranchOwnership(toBranch, shopId);
  if (!destBranch) throw createError('গন্তব্য শাখা পাওয়া যায়নি', 404);

  // Plain products already below their minimum, plus every variant product —
  // a per-variant comparison is not something a query can express here, so
  // those are filtered below. Same collection scan the low-stock list does.
  const destProducts = await Product.find({
    shop: shopId,
    branch: toBranch,
    isDeleted: { $ne: true },
    isActive: { $ne: false },
    type: { $ne: 'combo' },
    ...TRACKED_FILTER,
    $or: [
      { $expr: { $lt: ['$stock', '$minStock'] } },
      { 'variants.0': { $exists: true } },
    ],
  }).select('name code clonedFrom unit stock minStock variants hasVariants type trackStock');

  const lows = [];
  for (const d of destProducts) {
    if (hasRealVariants(d)) {
      const threshold = d.minStock > 0 ? d.minStock : VARIANT_LOW_DEFAULT;
      for (const v of d.variants) {
        if (v.isActive === false) continue;
        if ((v.stock || 0) < threshold) lows.push({ dest: d, destVariant: v, threshold, destStock: v.stock || 0 });
      }
    } else if ((d.minStock || 0) > 0 && (d.stock || 0) < d.minStock) {
      lows.push({ dest: d, destVariant: null, threshold: d.minStock, destStock: d.stock || 0 });
    }
  }
  if (lows.length === 0) return { suggestions: [], total: 0 };

  // Walk back from each low destination shelf to THIS branch's copy. The
  // matching rule is symmetric (see branchClone.util).
  const uniqueDest = [...new Map(lows.map((l) => [String(l.dest._id), l.dest])).values()];
  const sources = await findCounterpartsBatch(uniqueDest, shopId, fromBranch);

  const suggestions = [];
  for (const { dest, destVariant, threshold, destStock } of lows) {
    const src = sources.get(String(dest._id));
    if (!src || src.isActive === false || src.type === 'combo' || src.trackStock === false) continue;

    let srcVariant = null;
    if (destVariant) {
      if (!hasRealVariants(src)) continue;
      srcVariant = resolveDestinationVariant(src, {
        variantId: destVariant._id,
        variantSku: destVariant.sku,
        variantAttributes: destVariant.attributes,
      });
      if (!srcVariant || srcVariant.isActive === false) continue;
    } else if (hasRealVariants(src)) {
      continue; // shapes disagree — the create would refuse it anyway
    }

    const unit = storageUnit(src);
    const sourceStock = readStock(src, srcVariant?._id || null);
    // What the source can give without becoming "low" itself, by the SAME
    // definition the destination was judged by.
    const reserve = srcVariant
      ? (src.minStock > 0 ? src.minStock : VARIANT_LOW_DEFAULT)
      : (src.minStock || 0);
    const spare = quantize(sourceStock - reserve, unit);
    const wanted = quantize(threshold * 2 - destStock, unit);
    const suggested = quantize(Math.min(spare, wanted), unit);
    if (!(suggested > 0)) continue;

    const attrs = srcVariant?.attributes;
    suggestions.push({
      product: src._id,
      productName: src.name,
      productCode: src.code,
      variantId: srcVariant?._id || null,
      variantSku: srcVariant?.sku || '',
      variantAttributes: attrs ? (typeof attrs.toObject === 'function' ? attrs.toObject() : attrs) : null,
      variantLabel: srcVariant ? variantLabel(srcVariant) : '',
      unit: src.unit || 'piece',
      sourceStock,
      destStock,
      threshold,
      suggested,
    });
  }

  // Emptiest shelf first, relative to what it should hold.
  suggestions.sort((a, b) => (a.destStock / a.threshold) - (b.destStock / b.threshold));
  return {
    suggestions: suggestions.slice(0, SUGGESTION_LIMIT),
    total: suggestions.length,
  };
};

/**
 * Create a new stock transfer — and, when asked, finish it in the same
 * transaction.
 *
 *   createMissing  clone what the destination does not stock (products.create)
 *   dispatchNow    approve at once: deduct the source  (stock_transfers.update)
 *   receiveNow     also receive in full at the destination        (owner only)
 *
 * Each flag is `=== true`; absent, the request is the pending transfer it has
 * always been. The steps reuse `approveTransfer` and `receiveTransfer` inside
 * this transaction rather than re-implementing either, so a one-step transfer
 * writes exactly the rows a three-step one does.
 */
exports.createTransfer = async (data, userId, req = null) => {
  const { shop, fromBranch, toBranch, items, notes } = data;
  const createMissing = data.createMissing === true;
  const receiveNow = data.receiveNow === true;
  const dispatchNow = data.dispatchNow === true || receiveNow;

  assertActingBranch(req, fromBranch, 'source');

  if (createMissing && req && !hasPermission(req, 'products', 'create')) {
    throw createError('গন্তব্য শাখায় পণ্য তৈরি করার অনুমতি আপনার নেই', 403);
  }
  if (dispatchNow && req && !hasPermission(req, 'stock_transfers', 'update')) {
    throw createError('ট্রান্সফার পাঠানোর অনুমতি আপনার নেই', 403);
  }
  if (receiveNow && !mayReceiveNow(req)) {
    throw createError('সরাসরি গ্রহণ শুধু দোকান মালিক করতে পারেন', 403);
  }

  if (fromBranch === toBranch || String(fromBranch) === String(toBranch)) {
    throw createError('উৎস ও গন্তব্য শাখা একই হতে পারবে না', 400);
  }

  // Validate branches belong to shop
  const [sourceBranch, destBranch] = await Promise.all([
    Branch.validateBranchOwnership(fromBranch, shop),
    Branch.validateBranchOwnership(toBranch, shop),
  ]);
  if (!sourceBranch) throw createError('উৎস শাখা পাওয়া যায়নি', 404);
  if (!destBranch) throw createError('গন্তব্য শাখা পাওয়া যায়নি', 404);

  // Validate stock availability against the source branch's own products.
  // One read for the whole catalogue; the checks below are then in-memory and
  // fail on the same line, with the same message, as the per-item loop did.
  const productMap = await loadProductsFor(items, {
    shop, branch: fromBranch, isDeleted: { $ne: true },
  });

  for (const item of items) {
    const product = productMap.get(String(item.product));
    if (!product) {
      throw createError(`${item.productName || 'পণ্য'} উৎস শাখায় পাওয়া যায়নি`, 404);
    }
    // A combo has no stock to move between branches — transfer its components.
    assertNotCombo(product, 'শাখা স্থানান্তর');
    assertTracked(product, 'শাখা স্থানান্তর');
    assertVariantChosen(product, item);
    const available = readStock(product, item.variantId || null);
    if (available < item.quantity) {
      throw createError(`${item.productName || 'পণ্য'} এর স্টক অপর্যাপ্ত (আছে: ${available}, চাহিদা: ${item.quantity})`, 400);
    }
  }

  // The destination is checked HERE, before any stock moves — see
  // `planDestination` and `decideDestination`. Read outside the transaction;
  // the receive step re-checks inside it, so a product deleted in between still
  // fails closed.
  const linkTargets = await loadLinkTargets(data.links, productMap, shop, toBranch);
  const plan = await planDestination(items, productMap, shop, toBranch, null, linkTargets);
  const decision = decideDestination(plan, { createMissing, createNew: idSet(data.createNew) }, req);

  // Only the fields a request may set. The body used to be handed to `create`
  // whole, so a hand-built request could seed `received` or `batches` — and a
  // seeded `batches` array survives an approval that takes no batches, then
  // gets replayed at the destination as dated stock nobody dispatched. `unit`
  // is the server's, from the product, never the client's.
  //
  // `variantSku` / `variantAttributes` come from the SOURCE variant when there
  // is one: receive matches the destination's variant by them, so a client-sent
  // sku that disagreed would credit a different size.
  const lines = items.map((item) => {
    const product = productMap.get(String(item.product));
    const srcVariant = variantById(product, item.variantId);
    const attrs = srcVariant?.attributes;
    return {
      product: item.product,
      productName: item.productName || product.name,
      productCode: item.productCode || product.code,
      variantId: item.variantId || null,
      variantSku: srcVariant?.sku || item.variantSku,
      variantAttributes: attrs
        ? (typeof attrs.toObject === 'function' ? attrs.toObject() : attrs)
        : item.variantAttributes,
      unit: product.unit || 'piece',
      quantity: item.quantity,
    };
  });

  const doc = {
    shop, fromBranch, toBranch, items: lines, notes,
    requestedBy: userId,
    status: 'pending',
  };

  // A plain request writes one document, exactly as it always has — no
  // transaction is opened for it.
  const needsWrites = decisionWrites(decision);
  if (!needsWrites && !dispatchNow) {
    return StockTransfer.create(doc);
  }

  let cloned = [];
  let appended = [];

  const transfer = await runInTransaction(async (session) => {
    if (needsWrites) {
      ({ cloned, appended } = await applyDestination(decision, shop, toBranch, session));
    }

    let created = session
      ? (await StockTransfer.create([doc], { session }))[0]
      : await StockTransfer.create(doc);

    if (dispatchNow) {
      created = await exports.approveTransfer(created._id, shop, userId, req, { session });
    }
    if (receiveNow) {
      created = await exports.receiveTransfer(
        created._id, shop, userId, null, req, { session, skipActingBranch: true }
      );
    }
    return created;
  });

  await attachClonedMedia(shop, cloned, appended);

  return transfer;
};

/**
 * Approve transfer — deduct stock from source branch, set status to in_transit
 *
 * `options.session` joins a caller's transaction (createTransfer's one-step
 * path); without it this is its own atomic unit, as it always was.
 */
exports.approveTransfer = async (transferId, shopId, userId, req = null, options = {}) => {
  return runInTransaction(async (session) => {
    const transfer = await StockTransfer.findOne({ _id: transferId, shop: shopId }).session(session);
    if (!transfer) throw createError('ট্রান্সফার পাওয়া যায়নি', 404);
    assertActingBranch(req, transfer.fromBranch, 'source');
    if (transfer.status !== 'pending') throw createError('শুধুমাত্র পেন্ডিং ট্রান্সফার অনুমোদন করা যায়', 400);

    // Deduct from the source branch's own product documents.
    //
    // Two passes on purpose. The loop this replaced validated and wrote line by
    // line, so a shortage on line 5 left lines 1-4 already deducted and their
    // ledger rows written. A real transaction rolled that back — but
    // `runInTransaction` hands back a NULL SESSION on a standalone server, and
    // on that topology the partial deduction stuck. Validating everything
    // before writing anything makes the all-or-nothing guarantee hold whether
    // or not the deployment can actually do transactions.
    const sessionOpt = session ? { session } : {};
    const productMap = await loadProductsFor(
      transfer.items, { shop: shopId, branch: transfer.fromBranch }, session
    );

    const stockOps = [];
    const txns = [];

    for (const item of transfer.items) {
      const product = productMap.get(String(item.product));
      if (!product) {
        throw createError(`${item.productName || 'পণ্য'} উৎস শাখায় পাওয়া যায়নি`, 404);
      }

      // Re-checked here, not only at create time: a line saved before this
      // guard existed (or before the product grew variants) would otherwise
      // move the roll-up and quietly undo itself. Such a transfer can still be
      // cancelled — it just cannot be approved as it stands.
      assertVariantChosen(product, item);

      const previousStock = readStock(product, item.variantId || null);
      if (previousStock < item.quantity) {
        throw createError(`${item.productName || 'পণ্য'} এর স্টক অপর্যাপ্ত`, 400);
      }

      // Mutates the in-memory doc, so two lines against the same product see
      // each other's deduction — exactly as the sequential loop did.
      const newStock = applyStock(product, item.variantId || null, -item.quantity);
      stockOps.push(stockWriteOp(product, item.variantId || null, newStock));

      // ── The dated goods leaving this branch ─────────────────────────────
      //
      // FEFO picks them, and WHICH ones is recorded on the transfer line so the
      // receiving branch can recreate them with their real expiry dates. Before
      // this, `batches` was not mentioned anywhere in this file: dispatch
      // removed stock but not batches (so the source over-reported what it had
      // left), and receipt added plain undated stock (so the expiry vanished at
      // the branch boundary). Short-dated goods could be moved between branches
      // until nobody was warned about them at all.
      const { changed, taken } = takeBatches(product, item.variantId || null, item.quantity);
      if (changed) {
        item.batches = taken;
        stockOps.push(batchWriteOp(product));
      }

      txns.push({
        shop: shopId,
        branch: transfer.fromBranch,
        product: item.product,
        productName: item.productName,
        productCode: item.productCode,
        variantId: item.variantId,
        variantSku: item.variantSku,
        variantAttributes: item.variantAttributes,
        type: STOCK_TRANSACTION_TYPES.TRANSFER_OUT,
        quantity: -item.quantity,
        previousStock,
        newStock,
        ...transferLedgerRef(transfer),
        createdBy: userId,
        notes: `ট্রান্সফার #${transfer.transferNo} — শাখা থেকে পাঠানো`,
      });
    }

    await flushStockOps(stockOps, txns, sessionOpt);

    transfer.status = 'in_transit';
    transfer.approvedBy = userId;
    transfer.approvedAt = new Date();
    await transfer.save({ session });

    return transfer;
  }, { session: options.session });
};

/**
 * Receive transfer — add stock to destination branch
 *
 * `options.skipActingBranch` is set ONLY by createTransfer's owner-only
 * `receiveNow` path, which has already checked the owner and the source
 * branch. The route never passes options, so a request cannot reach it.
 */
exports.receiveTransfer = async (transferId, shopId, userId, receivedItems, req = null, options = {}) => {
  let cloned = [];
  let appended = [];

  const result = await runInTransaction(async (session) => {
    // runInTransaction falls back to a null session when the topology can't do
    // transactions, so options are built the same way as in sale/salesReturn.
    const sessionOpt = session ? { session } : {};
    const transfer = await StockTransfer.findOne({ _id: transferId, shop: shopId }).session(session);
    if (!transfer) throw createError('ট্রান্সফার পাওয়া যায়নি', 404);
    if (!options.skipActingBranch) assertActingBranch(req, transfer.toBranch, 'destination');
    if (transfer.status !== 'in_transit') throw createError('শুধুমাত্র ট্রানজিটে থাকা ট্রান্সফার গ্রহণ করা যায়', 400);

    // Two batched reads for the whole transfer: the source products, then the
    // destination branch's counterparts for all of them at once. This loop used
    // to cost a findById PLUS up to three findOne calls (findCounterpart tries
    // three matching rules in turn) PLUS a save PLUS a ledger insert — per line.
    const sourceMap = await loadProductsFor(transfer.items, { shop: shopId }, session);

    // The receiver's decisions from the receive screen — link a same-name
    // product, create a missing one — applied in THIS transaction, before the
    // counterparts are read, so the lines they resolve are credited below.
    // Absent (the route without a body, or the one-step path), nothing changes.
    if (options.resolve) {
      const linkTargets = await loadLinkTargets(
        options.resolve.links, sourceMap, shopId, transfer.toBranch, session
      );
      const plan = await planDestination(
        transfer.items, sourceMap, shopId, transfer.toBranch, session, linkTargets
      );
      const decision = decideDestination(plan, {
        createMissing: options.resolve.createMissing === true,
        createNew: idSet(options.resolve.createNew),
      }, req);
      if (decisionWrites(decision)) {
        ({ cloned, appended } = await applyDestination(decision, shopId, transfer.toBranch, session));
      }
    }

    const counterparts = await findCounterpartsBatch(
      [...sourceMap.values()], shopId, transfer.toBranch, session
    );

    const stockOps = [];
    const txns = [];

    for (const item of transfer.items) {
      // Find matching received quantity (default to full quantity).
      //
      // Bounded, because the number comes from the destination branch's own
      // form. An unbounded figure let a branch receive more than was ever
      // dispatched — the source deducted 10, the destination credited 100, and
      // the shop-wide total grew by 90 units nobody bought. Negative is refused
      // for the mirror reason.
      const rawQty = receivedItems
        ? (receivedItems.find(r => String(r.itemId) === String(item._id))?.received ?? item.quantity)
        : item.quantity;
      const parsedQty = Number(rawQty);
      if (!Number.isFinite(parsedQty) || parsedQty < 0) {
        throw createError(`"${item.productName || 'পণ্য'}" এর গৃহীত পরিমাণ সঠিক নয়`, 400);
      }
      if (parsedQty > item.quantity) {
        throw createError(
          `"${item.productName || 'পণ্য'}" পাঠানো হয়েছে ${item.quantity}, তার বেশি গ্রহণ করা যাবে না`,
          400
        );
      }
      const receivedQty = parsedQty;

      item.received = receivedQty;

      // Resolve the destination branch's own copy of this product — a
      // different document with its own price and stock — and credit it.
      const sourceProduct = sourceMap.get(String(item.product));
      if (!sourceProduct) {
        throw createError(`${item.productName || 'পণ্য'} পাওয়া যায়নি`, 404);
      }

      const target = counterparts.get(String(sourceProduct._id));
      if (!target) {
        const err = createError(
          `"${item.productName || sourceProduct.name}" গন্তব্য শাখায় পাওয়া যায়নি। গ্রহণের পাতায় পণ্যটি মিলিয়ে নিন বা তৈরি করুন।`,
          409
        );
        err.code = 'TRANSFER_MISSING_AT_DESTINATION';
        throw err;
      }

      // The destination's OWN variant id, which is not necessarily the one the
      // line carries — see `resolveDestinationVariant`. Everything below uses
      // this id, so the stock write lands on the element that exists in the
      // document being written.
      let destVariantId = null;
      if (item.variantId) {
        const destVariant = resolveDestinationVariant(target, item);
        if (!destVariant) {
          const label = variantLabel(item) || item.variantSku || '';
          throw createError(
            `"${item.productName || sourceProduct.name}"${label ? ` (${label})` : ''} এর ভ্যারিয়েন্ট গন্তব্য শাখায় নেই। আগে ওই শাখায় যোগ করুন।`,
            400
          );
        }
        destVariantId = destVariant._id;
      }

      const previousStock = readStock(target, destVariantId);
      const newStock = applyStock(target, destVariantId, receivedQty);
      if (newStock === null) {
        throw createError(
          `"${item.productName || sourceProduct.name}" এর ভ্যারিয়েন্ট গন্তব্য শাখায় নেই`,
          400
        );
      }
      stockOps.push(stockWriteOp(target, destVariantId, newStock));

      // ── Replay the dispatched batches at the destination ────────────────
      //
      // The destination is a DIFFERENT product document with its own batch
      // array, so the dates have to be carried across explicitly — see
      // `item.batches` on the transfer model.
      //
      // A partial receipt takes them soonest-first (the order dispatch stored
      // them in), so if 20 of 30 arrive it is the short-dated 20 that are
      // credited. Crediting the long-dated ones instead would leave the branch
      // holding goods it is not warned about.
      //
      // Only when the DESTINATION product tracks batches. Two branches can
      // legitimately configure the same item differently, and `addBatches`
      // fails closed on that rather than forcing tracking on a branch that has
      // not asked for it.
      if (Array.isArray(item.batches) && item.batches.length) {
        let left = receivedQty;
        const arriving = [];
        for (const b of item.batches) {
          if (left <= 0) break;
          const take = Math.min(left, Number(b.quantity) || 0);
          if (take > 0) arriving.push({ ...(b.toObject ? b.toObject() : b), quantity: take });
          left -= take;
        }
        if (addBatches(target, destVariantId, arriving)) {
          stockOps.push(batchWriteOp(target));
        }
      }

      txns.push({
        shop: shopId,
        branch: transfer.toBranch,
        product: target._id,
        productName: item.productName,
        productCode: item.productCode,
        // The DESTINATION's variant id, matching `product: target._id` above.
        // A row that named the source's subdocument id was unreachable from
        // the destination product's own stock history.
        variantId: destVariantId || undefined,
        variantSku: item.variantSku,
        variantAttributes: item.variantAttributes,
        type: STOCK_TRANSACTION_TYPES.TRANSFER_IN,
        quantity: receivedQty,
        previousStock,
        newStock,
        ...transferLedgerRef(transfer),
        createdBy: userId,
        notes: `ট্রান্সফার #${transfer.transferNo} — শাখায় গৃহীত`,
      });
    }

    await flushStockOps(stockOps, txns, sessionOpt);

    transfer.status = 'received';
    transfer.receivedBy = userId;
    transfer.receivedAt = new Date();
    await transfer.save({ session });

    return transfer;
  }, { session: options.session });

  // After commit — see `attachClonedMedia`. Only the receive-screen path can
  // have cloned anything here.
  await attachClonedMedia(shopId, cloned, appended);
  return result;
};

/**
 * Reject transfer — reverse source stock if in_transit
 */
exports.rejectTransfer = async (transferId, shopId, userId, reason, req = null) => {
  return runInTransaction(async (session) => {
    const transfer = await StockTransfer.findOne({ _id: transferId, shop: shopId }).session(session);
    if (!transfer) throw createError('ট্রান্সফার পাওয়া যায়নি', 404);
    assertActingBranch(req, transfer.fromBranch, 'source');
    if (!['pending', 'in_transit'].includes(transfer.status)) {
      throw createError('শুধুমাত্র পেন্ডিং বা ট্রানজিট ট্রান্সফার বাতিল করা যায়', 400);
    }

    // If in_transit, reverse the source deduction
    if (transfer.status === 'in_transit') {
      const sessionOpt = session ? { session } : {};
      const productMap = await loadProductsFor(
        transfer.items, { shop: shopId, branch: transfer.fromBranch }, session
      );

      const stockOps = [];
      const txns = [];

      for (const item of transfer.items) {
        const product = productMap.get(String(item.product));
        // A line whose product has since been removed is skipped rather than
        // failing the rejection — unchanged from the per-item loop. A rejection
        // that cannot complete would strand the transfer in_transit forever.
        if (!product) continue;

        const previousStock = readStock(product, item.variantId || null);
        const newStock = applyStock(product, item.variantId || null, item.quantity);
        stockOps.push(stockWriteOp(product, item.variantId || null, newStock));

        // The goods never left, so put their batches back exactly as dispatched
        // rather than as undated stock. `addBatches` merges by batch number and
        // date, so a rejected transfer restores the source to the state it was
        // in before approval instead of leaving a duplicate row beside the
        // original.
        if (Array.isArray(item.batches) && item.batches.length) {
          const restored = item.batches.map(b => (b.toObject ? b.toObject() : b));
          if (addBatches(product, item.variantId || null, restored)) {
            stockOps.push(batchWriteOp(product));
          }
        }

        txns.push({
          shop: shopId,
          branch: transfer.fromBranch,
          product: item.product,
          productName: item.productName,
          productCode: item.productCode,
          variantId: item.variantId,
          type: STOCK_TRANSACTION_TYPES.TRANSFER_IN,
          quantity: item.quantity,
          previousStock,
          newStock,
          ...transferLedgerRef(transfer),
          createdBy: userId,
          notes: `ট্রান্সফার #${transfer.transferNo} বাতিল — স্টক ফেরত`,
        });
      }

      await flushStockOps(stockOps, txns, sessionOpt);
    }

    transfer.status = 'rejected';
    transfer.rejectionReason = reason || '';
    await transfer.save({ session });

    return transfer;
  });
};

/**
 * Fill `items[].unit` on lines written before the field existed, from the
 * product each line names — ONE query for every line of every transfer given.
 *
 * Mutates lean docs in place and returns them. A line whose product has since
 * been deleted falls back to পিস, which is what every screen showed for it
 * before this function existed. A line that already carries a unit is never
 * touched: the snapshot wins over the product's CURRENT unit, for the reason a
 * sale line's does (CLAUDE.md §13.3 — changing a unit does not restate history).
 */
const fillLineUnits = async (transfers, shopId) => {
  const missing = new Set();
  for (const t of transfers) {
    for (const item of t.items || []) {
      if (!item.unit && item.product) missing.add(String(item.product._id || item.product));
    }
  }
  if (missing.size === 0) return transfers;

  const products = await Product.find({ shop: shopId, _id: { $in: [...missing] } })
    .select('unit')
    .lean();
  const unitOf = new Map(products.map((p) => [String(p._id), p.unit]));

  for (const t of transfers) {
    for (const item of t.items || []) {
      if (!item.unit) item.unit = unitOf.get(String(item.product?._id || item.product)) || 'piece';
    }
  }
  return transfers;
};

/** Who the list and the চালান name, and which branch fields they print. */
const BRANCH_FIELDS = 'name code address phone';
const withParties = (query) => query
  .populate('fromBranch', BRANCH_FIELDS)
  .populate('toBranch', BRANCH_FIELDS)
  .populate('requestedBy', 'name')
  .populate('approvedBy', 'name')
  .populate('receivedBy', 'name');

/**
 * Get transfers list with filters
 */
exports.getTransfers = async (shopId, query = {}, req = null) => {
  const { status, fromBranch, toBranch, page = 1, limit = 20 } = query;
  const filter = { shop: shopId };
  if (status) filter.status = status;
  if (fromBranch) filter.fromBranch = fromBranch;
  if (toBranch) filter.toBranch = toBranch;

  // A branch sees transfers it is either end of — incoming and outgoing. The
  // owner in "All Branches" sees all of them. Previously every user saw the
  // whole shop's transfers regardless of branch (FEATURE_AUDIT.md H-8).
  if (req?.branchId) {
    filter.$or = [{ fromBranch: req.branchId }, { toBranch: req.branchId }];
  }

  const [transfers, total] = await Promise.all([
    withParties(StockTransfer.find(filter))
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    StockTransfer.countDocuments(filter),
  ]);

  await fillLineUnits(transfers, shopId);

  return { data: transfers, total, page: Number(page), totalPages: Math.ceil(total / limit) };
};

/**
 * Get single transfer by ID
 */
exports.getTransferById = async (transferId, shopId, req = null) => {
  const scope = { _id: transferId, shop: shopId };
  if (req?.branchId) {
    scope.$or = [{ fromBranch: req.branchId }, { toBranch: req.branchId }];
  }

  const transfer = await withParties(StockTransfer.findOne(scope))
    .populate('items.product', 'name code unit')
    .lean();

  // `AppError` is not imported in this file — this threw ReferenceError (500)
  // instead of the intended 404 whenever a transfer was not found.
  if (!transfer) throw createError('ট্রান্সফার পাওয়া যায়নি', 404);
  await fillLineUnits([transfer], shopId);
  return transfer;
};

// ─────────────────────────────────────────────────────────────────────────────
// THE DETAILED TRANSFER REPORT — which product, how much, from where to where
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many transfers one report may cover. A shop moving stock daily between
 * three branches writes ~1,000 a year; past this the paper is not a report
 * anyone reads, and `truncated` tells the screen to say so.
 */
const REPORT_MAX_TRANSFERS = 2000;

const REPORT_STATUSES = ['pending', 'in_transit', 'received', 'rejected'];

/**
 * What one line MEANS, by the status of the transfer it sits on.
 *
 *   pending     asked for; nothing has moved
 *   in_transit  left the source; not yet counted in anywhere
 *   received    left the source; `received` of it arrived, the rest is ঘাটতি
 *   rejected    nothing moved (a rejected in-transit transfer was put back)
 *
 * `short` is the number this report exists to surface. The source was debited
 * `quantity` and the destination credited `received`; the difference is stock
 * the shop no longer has and no sale, expense or adjustment accounts for.
 */
const lineFigures = (status, item, unit) => {
  const qty = Number(item.quantity) || 0;
  const zero = { requested: qty, sent: 0, received: 0, short: 0, inTransit: 0, pending: 0, rejected: 0 };
  switch (status) {
    case 'pending': return { ...zero, pending: qty };
    case 'in_transit': return { ...zero, sent: qty, inTransit: qty };
    case 'received': {
      const got = Math.min(qty, Number(item.received) || 0);
      return { ...zero, sent: qty, received: got, short: quantize(qty - got, unit) };
    }
    case 'rejected': return { ...zero, rejected: qty };
    default: return zero;
  }
};

/**
 * The cross-branch identity of a line. Each branch owns its own product
 * documents, so the source's `_id` differs from the destination's — the key is
 * the code (the rule `findCounterpart` matches by), then the variant.
 */
const productKey = (item) => {
  const base = item.productCode || item.productName || String(item.product?._id || item.product);
  const a = item.variantAttributes || {};
  const variant = item.variantSku
    || [a.size, a.color, a.weight, a.material, a.style].filter(Boolean).join('/');
  return variant ? `${base}::${variant}` : base;
};

const FIGURE_KEYS = ['requested', 'sent', 'received', 'short', 'inTransit', 'pending', 'rejected'];

/**
 * Pure: transfers (lean, with `items[].unit` filled) → the report's two views.
 *
 * `lines` is one row per product per transfer, newest transfer first — the
 * register. `products` rolls the same lines up per product — the summary.
 * Sums are re-quantized at the line's STORAGE precision, so 0.1 kg sent ten
 * times reads 1, not 0.9999999999999999.
 *
 * Quantities are never summed ACROSS products: kg and pieces do not add up,
 * so there is deliberately no grand-total quantity in the output.
 */
exports.summariseTransferLines = (transfers) => {
  const lines = [];
  const byProduct = new Map();
  const statusCount = Object.fromEntries(REPORT_STATUSES.map((s) => [s, 0]));

  for (const t of transfers) {
    if (statusCount[t.status] !== undefined) statusCount[t.status] += 1;

    (t.items || []).forEach((item, index) => {
      const unit = storageUnit({ unit: item.unit });
      const figures = lineFigures(t.status, item, unit);

      lines.push({
        transferId: t._id,
        transferNo: t.transferNo,
        status: t.status,
        createdAt: t.createdAt,
        approvedAt: t.approvedAt || null,
        receivedAt: t.receivedAt || null,
        fromBranch: t.fromBranch || null,
        toBranch: t.toBranch || null,
        requestedBy: t.requestedBy?.name || null,
        receivedBy: t.receivedBy?.name || null,
        lineNo: index + 1,
        productName: item.productName,
        productCode: item.productCode || '',
        variantSku: item.variantSku || '',
        variantAttributes: item.variantAttributes || null,
        unit: item.unit || 'piece',
        ...figures,
      });

      const key = productKey(item);
      let row = byProduct.get(key);
      if (!row) {
        row = {
          key,
          productName: item.productName,
          productCode: item.productCode || '',
          variantSku: item.variantSku || '',
          variantAttributes: item.variantAttributes || null,
          unit: item.unit || 'piece',
          transfers: 0,
          ...Object.fromEntries(FIGURE_KEYS.map((k) => [k, 0])),
        };
        byProduct.set(key, row);
      }
      row.transfers += 1;
      for (const k of FIGURE_KEYS) row[k] = quantize(row[k] + figures[k], unit);
    });
  }

  // Most-moved first: the summary is read top-down for "what did we move".
  const products = [...byProduct.values()].sort(
    (a, b) => b.sent - a.sent
      || b.requested - a.requested
      || String(a.productName || '').localeCompare(String(b.productName || ''))
  );

  return {
    lines,
    products,
    totals: {
      transfers: transfers.length,
      lines: lines.length,
      products: products.length,
      byStatus: statusCount,
      // Counts of lines, not quantities — see the note above on mixed units.
      shortLines: lines.filter((l) => l.short > 0).length,
      inTransitLines: lines.filter((l) => l.inTransit > 0).length,
    },
  };
};

/**
 * GET /stock-transfers/report
 *
 * Query: startDate, endDate (YYYY-MM-DD, Bangladesh days, on `createdAt`),
 *        status, branch (owner in All Branches only), direction ('in'|'out').
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 * Same rule as the list (H-8): a user pinned to a branch sees transfers that
 * branch is either END of. `branch` from the query is honoured only when the
 * request is NOT already pinned — so staff, who are always pinned, cannot
 * widen or move their view with it. `direction` narrows to one end.
 *
 * `find`, not `aggregate`, on purpose: every id in this filter is cast by
 * Mongoose, so the I-3 trap (an uncast string matching nothing) cannot arise.
 */
exports.getTransferReport = async (shopId, query = {}, req = null) => {
  if (!shopId) throw createError('দোকান পাওয়া যায়নি', 400); // I-5: never an unscoped read

  const filter = { shop: shopId };

  const range = buildDateMatch(query.startDate, query.endDate);
  if (range) {
    const invalid = (d) => d && Number.isNaN(d.getTime());
    if (invalid(range.$gte) || invalid(range.$lte)) throw createError('তারিখ সঠিক নয়', 400);
    filter.createdAt = range;
  }

  if (query.status) {
    if (!REPORT_STATUSES.includes(query.status)) throw createError('অবস্থা সঠিক নয়', 400);
    filter.status = query.status;
  }

  let branch = req?.branchId || null;
  if (!branch && query.branch) {
    if (!mongoose.isValidObjectId(query.branch)) throw createError('শাখা সঠিক নয়', 400);
    branch = query.branch;
  }

  const direction = query.direction || '';
  if (direction && !['in', 'out'].includes(direction)) throw createError('দিক সঠিক নয়', 400);

  if (branch) {
    if (direction === 'out') filter.fromBranch = branch;
    else if (direction === 'in') filter.toBranch = branch;
    else filter.$or = [{ fromBranch: branch }, { toBranch: branch }];
  }

  const found = await withParties(StockTransfer.find(filter))
    .sort({ createdAt: -1 })
    .limit(REPORT_MAX_TRANSFERS + 1)
    .lean();

  const truncated = found.length > REPORT_MAX_TRANSFERS;
  const transfers = truncated ? found.slice(0, REPORT_MAX_TRANSFERS) : found;
  await fillLineUnits(transfers, shopId);

  return {
    ...exports.summariseTransferLines(transfers),
    truncated,
    maxTransfers: REPORT_MAX_TRANSFERS,
  };
};
