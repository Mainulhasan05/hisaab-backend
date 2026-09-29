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
const { assertTracked } = require('../utils/stockTracking.util');

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

/**
 * Resolve the destination branch's copy of a product.
 *
 * Each branch owns its own product documents, so "the same item" in another
 * branch is a different document. They are matched by `code` — the clone that
 * seeds a new branch keeps the code identical — with `clonedFrom` lineage as a
 * fallback for products whose code was later edited.
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
 * destination-branch copy in ONE query instead of up to three per line.
 *
 * `findCounterpart` is kept above because it is still the clearest statement of
 * the matching RULE, and the precedence here is a faithful copy of it:
 *
 *   1. same `code` in the destination branch   (the clone keeps the code)
 *   2. same `clonedFrom` lineage               (code was edited since)
 *   3. the destination product IS the original the source was cloned from
 *
 * Candidates for all three arms are fetched together, then resolved in memory
 * in that same order. If you change the rule, change both — or delete the
 * single-item version and route its callers here.
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
 * Create a new stock transfer request
 */
exports.createTransfer = async (data, userId, req = null) => {
  const { shop, fromBranch, toBranch, items, notes } = data;

  assertActingBranch(req, fromBranch, 'source');

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

  // Only the fields a request may set. The body used to be handed to `create`
  // whole, so a hand-built request could seed `received` or `batches` — and a
  // seeded `batches` array survives an approval that takes no batches, then
  // gets replayed at the destination as dated stock nobody dispatched. `unit`
  // is the server's, from the product, never the client's.
  const lines = items.map((item) => {
    const product = productMap.get(String(item.product));
    return {
      product: item.product,
      productName: item.productName || product.name,
      productCode: item.productCode || product.code,
      variantId: item.variantId || null,
      variantSku: item.variantSku,
      variantAttributes: item.variantAttributes,
      unit: product.unit || 'piece',
      quantity: item.quantity,
    };
  });

  const transfer = await StockTransfer.create({
    shop, fromBranch, toBranch, items: lines, notes,
    requestedBy: userId,
    status: 'pending',
  });

  return transfer;
};

/**
 * Approve transfer — deduct stock from source branch, set status to in_transit
 */
exports.approveTransfer = async (transferId, shopId, userId, req = null) => {
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
  });
};

/**
 * Receive transfer — add stock to destination branch
 */
exports.receiveTransfer = async (transferId, shopId, userId, receivedItems, req = null) => {
  return runInTransaction(async (session) => {
    // runInTransaction falls back to a null session when the topology can't do
    // transactions, so options are built the same way as in sale/salesReturn.
    const sessionOpt = session ? { session } : {};
    const transfer = await StockTransfer.findOne({ _id: transferId, shop: shopId }).session(session);
    if (!transfer) throw createError('ট্রান্সফার পাওয়া যায়নি', 404);
    assertActingBranch(req, transfer.toBranch, 'destination');
    if (transfer.status !== 'in_transit') throw createError('শুধুমাত্র ট্রানজিটে থাকা ট্রান্সফার গ্রহণ করা যায়', 400);

    // Two batched reads for the whole transfer: the source products, then the
    // destination branch's counterparts for all of them at once. This loop used
    // to cost a findById PLUS up to three findOne calls (findCounterpart tries
    // three matching rules in turn) PLUS a save PLUS a ledger insert — per line.
    const sourceMap = await loadProductsFor(transfer.items, { shop: shopId }, session);
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
        throw createError(
          `"${item.productName || sourceProduct.name}" গন্তব্য শাখায় নেই। আগে ওই শাখায় পণ্যটি যোগ করুন।`,
          400
        );
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
  });
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
