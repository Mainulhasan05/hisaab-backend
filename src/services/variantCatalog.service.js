const mongoose = require('mongoose');
const Product = require('../models/Product.model');
const cacheService = require('./cache.service');
const logger = require('../utils/logger.util');
// `branchMatch`, not `branchFilter`: `$match` needs real ObjectIds, and the
// filter variant hands back whatever the request carried.
const { branchMatch } = require('../utils/branchScope.util');

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS SHOP ACTUALLY CALLS ITS VARIANTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 *
 * The variant option lists were a hardcoded constant on the CLIENT, identical
 * for every shop on the platform: Size was S/M/L/XL, Storage was 128GB/256GB,
 * Shade was ফেয়ার/লাইট/মিডিয়াম. A shop selling চাল saw phone storage. A shop
 * selling পাঞ্জাবি needed waist 34/36/38 and got shirt sizes.
 *
 * There WAS an escape hatch — an "অন্যান্য" box that let them type any value —
 * and it worked. It just forgot. The typed value went into React state for the
 * product being edited, and that was the end of it: next product, type it
 * again. Every product, forever. The typing was never the problem; the
 * forgetting was.
 *
 * ── Why this derives rather than stores ─────────────────────────────────────
 *
 * The obvious fix is a per-shop options table the shopkeeper fills in first.
 * It is the wrong shape twice over:
 *
 *   1. IT PUTS A FORM IN FRONT OF THE WORK. A shop wanting to add one product
 *      with one new size should not first have to find a settings screen,
 *      understand what a "variant option" is, and add it there. The moment a
 *      catalogue can be incomplete, it is a thing that blocks you.
 *
 *   2. IT IS A SECOND SOURCE OF TRUTH FOR SOMETHING ALREADY RECORDED. Every
 *      value a shop has ever used is sitting in `Product.variants[].attributes`
 *      right now. A separate table can only ever agree with that or drift from
 *      it, and this codebase has been bitten by exactly that shape before —
 *      see `reallocateCustomerInvoices` on why an allocation is derived from
 *      scratch rather than maintained as a delta.
 *
 * So the option list is a VIEW over the products. Type "৩৬" into the box, save
 * the product, and it is a button on the next one — not because anything was
 * written to a catalogue, but because the product IS the record. It self-heals:
 * a value stops being offered when nothing uses it any more, and a shop that
 * imports two thousand products arrives with its whole vocabulary already
 * populated and no migration to run.
 *
 * The three things derivation genuinely cannot know — a type the shop invented,
 * a type they want renamed, and a typo they want forgotten — live on
 * `Shop.settings.variantCatalog`, which is small, bounded, and written only
 * from the settings screen. See the note on that field.
 *
 * ── Where the merging happens ───────────────────────────────────────────────
 *
 * NOT here. This returns raw usage; the built-in presets stay in ONE place,
 * `hisaab-frontend/lib/data/variants.js`, and the client merges. Copying the
 * preset lists onto the server to merge them here would make a fourth copy of
 * a list that already exists in three — and the two that exist today have
 * already drifted from each other.
 */

/** How many distinct values one type may report. */
const MAX_VALUES_PER_TYPE = 60;

/**
 * How long a shop's vocabulary is cached.
 *
 * Long, because it changes only when a product is written and every one of
 * those paths already invalidates it explicitly (`invalidate` below). The TTL
 * is the backstop for a path that forgets, not the mechanism.
 */
const CACHE_TTL_SECONDS = 15 * 60;

const cacheKey = (shopId, branchId) =>
  `variantOptions:${shopId}:${branchId || 'all'}`;

/**
 * The five attribute names `variantSchema` declares as real columns. Everything
 * else a variant carries lives one level down under `attributes.custom` — see
 * `_formatVariants`, which is what puts it there.
 */
const KNOWN_KEYS = ['size', 'color', 'weight', 'material', 'style'];

/**
 * Every distinct variant attribute value this shop's products use, by type.
 *
 * ── Reading the pipeline ────────────────────────────────────────────────────
 *
 * The awkward part is that a variant's attributes live in two shapes at once:
 * five named paths, and a free-form `custom` sub-document. `$objectToArray`
 * flattens the second into the same `{k, v}` pairs the first is built into by
 * hand, after which one `$group` counts both together.
 *
 * `$ifNull` around `custom` is load-bearing: `$objectToArray` raises an error
 * on a missing or null input, which would take out the whole aggregation for
 * every shop whose products predate custom attributes — that is most of them.
 * The `$type` guard is for the same class of problem from the other side: the
 * field is `Mixed`, so nothing at the schema level stops a bad client writing a
 * string or an array where an object belongs.
 *
 * @param {ObjectId|string} shopId
 * @param {Object|null} req  branch scope, when a branch is selected
 * @returns {Promise<Object<string, string[]>>} `{ size: ['36','34'], ... }`,
 *   each list ordered by how many variants use it, commonest first.
 */
async function readUsedValues(shopId, req = null) {
  // Branch-scoped when a branch is selected, shop-wide otherwise — the same
  // rule every other product read follows. A branch that has never sold ৫০০ml
  // should not be offered it as though it were part of their own range.
  //
  // `shop` is set explicitly rather than left to `branchMatch`, because this is
  // also called with no `req` at all (the cache warmer, and the tests).
  const match = branchMatch(req || {}, {
    shop: new mongoose.Types.ObjectId(String(shopId)),
    isActive: true,
  });

  const rows = await Product.aggregate([
    { $match: match },
    // Products with no variants contribute nothing and are dropped here rather
    // than surviving as empty rows through four more stages.
    { $match: { 'variants.0': { $exists: true } } },
    { $unwind: '$variants' },
    {
      $project: {
        pairs: {
          $concatArrays: [
            KNOWN_KEYS.map((k) => ({ k, v: `$variants.attributes.${k}` })),
            {
              $cond: [
                { $eq: [{ $type: '$variants.attributes.custom' }, 'object'] },
                { $objectToArray: { $ifNull: ['$variants.attributes.custom', {}] } },
                [],
              ],
            },
          ],
        },
      },
    },
    { $unwind: '$pairs' },
    // A variant that has a size but no colour carries `color: null`, and an
    // empty string is a value the form should never have accepted. Neither is
    // an option anybody chose.
    { $match: { 'pairs.v': { $type: 'string', $ne: '' } } },
    { $group: { _id: { k: '$pairs.k', v: '$pairs.v' }, uses: { $sum: 1 } } },
    // Commonest first, so the chip a shop reaches for most is the one nearest
    // their thumb. Ties break on the value so the order is stable between
    // loads — a list of buttons that reshuffles is unusable.
    { $sort: { uses: -1, '_id.v': 1 } },
    {
      $group: {
        _id: '$_id.k',
        values: { $push: '$_id.v' },
      },
    },
  ]).option({ maxTimeMS: 10000 });

  const used = {};
  for (const row of rows) {
    if (!row?._id) continue;
    used[row._id] = (row.values || []).slice(0, MAX_VALUES_PER_TYPE);
  }
  return used;
}

/**
 * The cached read. This is on the product form's critical path — it is fetched
 * while the shopkeeper is looking at an empty form — so it must not wait on an
 * aggregation over every product they own.
 */
async function getUsedValues(shopId, req = null) {
  const branchId = req?.branchId || null;
  const key = cacheKey(shopId, branchId);

  const cached = await cacheService.get(key);
  if (cached) return cached;

  /**
   * A failure here degrades to `{}` rather than to a 500.
   *
   * That is not defensive habit, it is the correct behaviour for this
   * particular read: `{}` is a real and complete answer — a shop with no
   * variant products — and the client renders the built-in presets on it. So
   * the worst case of anything going wrong in the aggregation above is the
   * behaviour this feature replaced, which is a shop typing its sizes again.
   *
   * The alternative is a product form that will not open because an option
   * list could not be computed, and no option list is worth that.
   */
  let used;
  try {
    used = await readUsedValues(shopId, req);
  } catch (err) {
    logger.error(`Variant options: could not read shop vocabulary: ${err.message}`);
    return {};
  }

  await cacheService.set(key, used, CACHE_TTL_SECONDS);
  return used;
}

/**
 * Drop the cached vocabulary for a shop.
 *
 * Called from every path that writes a product. It has to be every path and not
 * just "create", because the value a shop wants back as a chip is just as
 * likely to have been typed into an EDIT — and a shopkeeper who adds ৩৬ to an
 * existing পাঞ্জাবি and does not see it on the next product has been told the
 * feature does not work.
 *
 * Fire-and-forget at the call sites: a stale option list is a cosmetic problem
 * for at most `CACHE_TTL_SECONDS`, and failing a product save over it would
 * turn that into a real one.
 */
async function invalidate(shopId) {
  await cacheService.deletePattern(`variantOptions:${shopId}:*`);
}

module.exports = {
  getUsedValues,
  readUsedValues,
  invalidate,
  KNOWN_KEYS,
  MAX_VALUES_PER_TYPE,
};
