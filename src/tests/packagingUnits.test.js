/**
 * Packaging / units — the invariants that keep fractional quantities from
 * silently corrupting stock.
 *
 * Three groups, and it matters which is which (AGENT_WORKFLOW.md §7.1):
 *
 *   A. FLAG-OFF IDENTITY — supposed to pass both before and after this feature.
 *      They are guards: they fail only if someone later widens the feature to
 *      shops that did not enable it.
 *
 *   B. DRIFT / PRECISION — fail against the old code, because the old code had
 *      no rounding at all. These are the regression tests proper.
 *
 *   C. ENTITLEMENT — fail against the old code, which had no flag.
 */

const mongoose = require('mongoose');
const {
  quantize,
  quantizeMoney,
  isEffectivelyZero,
  parseQuantity,
  quantityUnit,
  storageUnit,
  formatQuantity,
  formatQuantityWithUnit,
  buildStockUpdate,
  buildVariantStockUpdate,
  buildVariantStockRollupUpdate,
} = require('../utils/quantity.util');
const {
  UNITS,
  ALL_UNITS,
  LEGACY_UNITS,
  MAX_DECIMALS,
  SAFE_QUANTITY_MAX,
  unitDecimals,
  isDivisible,
  conversionFactor,
  unitsForShop,
  unitCatalogue,
} = require('../config/units');
const { hasFeature, shopHasFeature, featureMap, FEATURE_KEYS } = require('../utils/features.util');

const SHOP = new mongoose.Types.ObjectId();

/** A shop that has never had a capability switched on. */
const plainReq = () => ({ shop: { _id: SHOP } });
/** A shop with packaging explicitly off. */
const offReq = () => ({ shop: { _id: SHOP, features: { packaging: false } } });
/** A shop with packaging on. */
const onReq = () => ({ shop: { _id: SHOP, features: { packaging: true } } });

const kgProduct = { unit: 'kg', name: 'চাল' };
const pieceProduct = { unit: 'piece', name: 'কলম' };

/* ════════════════════════════════════════════════════════════════════════
 * A. FLAG-OFF IDENTITY — a shop without packaging must behave as before
 * ════════════════════════════════════════════════════════════════════════ */
describe('A. flag off — nothing changes', () => {
  test('a missing features object reads as OFF, not as truthy', () => {
    // `req.shop` is rehydrated from Redis; a shop cached before the field
    // existed has no `features` at all. Reading that as enabled would hand the
    // feature to every shop on the platform at once.
    expect(hasFeature(plainReq(), 'packaging')).toBe(false);
    expect(hasFeature(offReq(), 'packaging')).toBe(false);
    expect(hasFeature(undefined, 'packaging')).toBe(false);
    expect(hasFeature({}, 'packaging')).toBe(false);
    expect(shopHasFeature(null, 'packaging')).toBe(false);
    expect(shopHasFeature({ features: { packaging: 'yes' } }, 'packaging')).toBe(false);
  });

  test('an unknown flag key throws at call time rather than reading as off', () => {
    // A typo that silently returns false is a feature that never turns on and
    // never explains why.
    expect(() => hasFeature(onReq(), 'packagin')).toThrow(/Unknown feature/);
  });

  test('featureMap always lists every key as a real boolean', () => {
    const map = featureMap({ features: {} });
    for (const key of FEATURE_KEYS) {
      expect(typeof map[key]).toBe('boolean');
    }
    expect(featureMap(null).packaging).toBe(false);
  });

  test('quantityUnit ignores the product unit entirely when the flag is off', () => {
    expect(quantityUnit(offReq(), kgProduct)).toBe('piece');
    expect(quantityUnit(plainReq(), kgProduct)).toBe('piece');
    expect(quantityUnit(null, kgProduct)).toBe('piece');
    expect(quantityUnit(onReq(), kgProduct)).toBe('kg');
  });

  test('a fraction is refused for a kg product when the flag is off', () => {
    expect(() => parseQuantity(0.5, quantityUnit(offReq(), kgProduct))).toThrow();
    expect(parseQuantity(3, quantityUnit(offReq(), kgProduct))).toBe(3);
  });

  test('countable units refuse fractions even with the flag ON', () => {
    // The flag buys fractional WEIGHT, not half a box. `decimals: 0` is the
    // policy and it applies regardless of entitlement.
    expect(() => parseQuantity(0.5, quantityUnit(onReq(), pieceProduct))).toThrow();
    for (const u of ['piece', 'dozen', 'pack', 'box', 'set', 'sack', 'carton', 'strip']) {
      expect(isDivisible(u)).toBe(false);
      expect(() => parseQuantity(1.5, u)).toThrow();
    }
  });

  test('integer units keep the original $inc update, byte for byte', () => {
    // This is the hot path for ~every product in ~every shop. If it ever
    // becomes a pipeline, the "single-branch shop is untouched" claim in I-6
    // stops being true at the query level.
    //
    // PRODUCT-level only. The variant update below is deliberately no longer
    // part of this claim — see the test that follows.
    expect(buildStockUpdate(-3, 'piece')).toEqual({ $inc: { stock: -3 } });
    expect(buildStockUpdate(5, 'piece')).toEqual({ $inc: { stock: 5 } });
  });

  test('the variant update is a pipeline at every unit, and carries the rollup', () => {
    // It used to return a positional `$inc` for integer units, which touched
    // `variants.$.stock` and NOTHING else. But `stock` on a variant product is
    // defined as the sum across `variants[]` — every read-time aggregation
    // recomputes it that way — so writing the element alone left the stored
    // rollup reading whatever it did before the sale, drifting up by the
    // quantity sold. Found live: a product reading `stock: 74` against variants
    // summing 64.
    //
    // The cheap `$inc` cannot express "and then re-sum the array", so integer
    // units join the pipeline. The cost is one document update either way.
    const vid = new mongoose.Types.ObjectId();
    const update = buildVariantStockUpdate(vid, -2, 'piece');

    expect(Array.isArray(update)).toBe(true);
    expect(update).toHaveLength(2);

    // Stage 1: the element.
    expect(update[0].$set.variants.$map.in.$cond[0].$eq[1]).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(update[0].$set.variants.$map.in.$cond[1].$mergeObjects[1].stock.$round[0].$add[1]).toBe(-2);

    // Stage 2: the rollup, summed from the array stage 1 just wrote.
    expect(update[1].$set.stock.$cond[1].$round[0].$sum.$map.input).toBe('$variants');
  });

  test('the rollup stage cannot zero a product that has no variants', () => {
    // `$sum` over an empty `$map` is 0, so an unguarded stage 2 would turn a
    // stock update into stock DESTRUCTION the moment it reached a variantless
    // product — a filter that stops matching is all it would take. The guard
    // makes that unreachable regardless of the caller's filter.
    const update = buildVariantStockUpdate(new mongoose.Types.ObjectId(), 5, 'piece');
    const rollup = update[1].$set.stock.$cond;

    expect(rollup[0]).toEqual({ $gt: [{ $size: { $ifNull: ['$variants', []] } }, 0] });
    expect(rollup[2]).toBe('$stock'); // no variants → leave it exactly as it was
  });

  test('buildVariantStockRollupUpdate is the same function under its old name', () => {
    // The returns path calls it by that name because it reads better there.
    // Both must stay the same update, or the sale and return paths go back to
    // maintaining `stock` differently — which is the drift this fixed.
    const vid = new mongoose.Types.ObjectId();
    expect(buildVariantStockRollupUpdate(vid, 3, 'kg'))
      .toEqual(buildVariantStockUpdate(vid, 3, 'kg'));
  });

  test('storageUnit collapses non-divisible units so they keep the cheap path', () => {
    expect(storageUnit(pieceProduct)).toBe('piece');
    expect(storageUnit({ unit: 'sack' })).toBe('piece');
    expect(storageUnit({ unit: 'dozen' })).toBe('piece');
    expect(storageUnit(kgProduct)).toBe('kg');
    expect(storageUnit(null)).toBe('piece');
  });

  test('storageUnit does NOT consult the flag', () => {
    // A shop whose packaging was switched off while holding fractional stock
    // must still round its writes, or the drift this feature prevents returns
    // months later on data nobody is watching.
    expect(storageUnit(kgProduct)).toBe('kg');
  });

  test('a shop without the flag is offered exactly the original 13 units', () => {
    expect(unitsForShop(false)).toEqual([
      'piece', 'kg', 'gram', 'liter', 'ml', 'meter', 'inch',
      'feet', 'dozen', 'pack', 'box', 'set', 'sack',
    ]);
    expect(unitsForShop(false)).toHaveLength(13);
    expect(unitsForShop(true).length).toBeGreaterThan(13);
  });

  test('the legacy list is a subset of the registry and never loses a member', () => {
    for (const u of LEGACY_UNITS) {
      expect(ALL_UNITS).toContain(u);
      expect(UNITS[u].legacy).toBe(true);
    }
    // Any unit marked legacy must be in the list, and vice versa.
    const marked = ALL_UNITS.filter((u) => UNITS[u].legacy);
    expect(marked.sort()).toEqual([...LEGACY_UNITS].sort());
  });

  test('the flag-off catalogue offers no unit outside the legacy set', () => {
    const offered = unitCatalogue(false).groups.flatMap((g) => g.units.map((u) => u.value));
    expect(offered.sort()).toEqual([...LEGACY_UNITS].sort());
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * B. DRIFT AND PRECISION — the reason this feature needed a util at all
 * ════════════════════════════════════════════════════════════════════════ */
describe('B. no float drift', () => {
  test('quantize clears the classic 0.1 + 0.2 residue', () => {
    expect(0.1 + 0.2).not.toBe(0.3);           // the problem
    expect(quantize(0.1 + 0.2, 'kg')).toBe(0.3); // the fix
  });

  test('a thousand 0.1 kg sales land exactly on zero, not 1.4e-14', () => {
    // The scenario that leaves a sold-out product permanently "in stock".
    let stock = 100;
    for (let i = 0; i < 1000; i++) {
      stock = quantize(stock - 0.1, 'kg');
    }
    expect(stock).toBe(0);
    expect(isEffectivelyZero(stock, 'kg')).toBe(true);
  });

  test('ten thousand mixed operations stay exact', () => {
    let stock = 0;
    for (let i = 0; i < 10000; i++) {
      stock = quantize(stock + 0.001, 'kg');
    }
    expect(stock).toBe(10);
  });

  test('repeated add/remove of the same amount returns to the start', () => {
    let stock = 250;
    for (let i = 0; i < 500; i++) {
      stock = quantize(stock - 0.333, 'kg');
      stock = quantize(stock + 0.333, 'kg');
    }
    expect(stock).toBe(250);
  });

  test('quantize rounds 2.675-style values the way a human expects', () => {
    // 2.675 * 100 is 267.49999999999997 — a bare Math.round sends it down.
    expect(quantize(2.675, 'kg')).toBe(2.675);
    expect(quantize(1.0005, 'kg')).toBe(1.001);
    expect(quantizeMoney(2.675)).toBe(2.68);
    expect(quantizeMoney(70 * 0.333)).toBe(23.31);
  });

  test('very large quantities keep gram-level precision', () => {
    // The headroom claim: 3-decimal rounding is unambiguous below ~2.25e12.
    const big = 1_000_000_000; // a billion kg
    expect(quantize(big + 0.001, 'kg')).toBe(big + 0.001);
    expect(quantize(big + 0.1 + 0.2, 'kg')).toBe(quantize(big + 0.3, 'kg'));
  });

  test('SAFE_QUANTITY_MAX sits inside the range where the rounding is provable', () => {
    // M x 2^-52 < 0.0005  =>  M < 2.25e12
    const bound = 0.5 / Math.pow(10, MAX_DECIMALS) * Math.pow(2, 52);
    expect(SAFE_QUANTITY_MAX).toBeLessThan(bound);
  });

  test('quantities beyond the safe ceiling are refused, not silently mangled', () => {
    expect(() => parseQuantity(SAFE_QUANTITY_MAX * 2, 'kg')).toThrow();
    expect(() => parseQuantity(Infinity, 'kg')).toThrow();
    expect(() => parseQuantity(NaN, 'kg')).toThrow();
    expect(() => parseQuantity('abc', 'kg')).toThrow();
    expect(() => parseQuantity(-1, 'kg')).toThrow();
    expect(() => parseQuantity(0, 'kg')).toThrow();
    expect(parseQuantity(0, 'kg', { allowZero: true })).toBe(0);
  });

  test('no unit declares more precision than the drift guarantee covers', () => {
    for (const u of ALL_UNITS) {
      expect(unitDecimals(u)).toBeLessThanOrEqual(MAX_DECIMALS);
    }
  });
});

describe('B2. the fractional stock update', () => {
  test('a divisible unit re-rounds inside the same atomic update', () => {
    const update = buildStockUpdate(-0.25, 'kg');
    expect(Array.isArray(update)).toBe(true);
    expect(update[0].$set.stock.$round[1]).toBe(3);
    // $ifNull guards a product whose stock field is somehow absent — without
    // it the pipeline would write null and the document would fail its own
    // `min: 0` on the next save.
    expect(update[0].$set.stock.$round[0].$add[0]).toEqual({ $ifNull: ['$stock', 0] });
    expect(update[0].$set.stock.$round[0].$add[1]).toBe(-0.25);
  });

  test('the variant pipeline casts the id — an uncast one matches nothing', () => {
    // Same trap as I-3: inside a pipeline `$eq` compares BSON types, so a
    // string id would rebuild the array unchanged and the update would report
    // success while changing nothing.
    const vid = new mongoose.Types.ObjectId();
    const update = buildVariantStockUpdate(vid.toString(), -0.5, 'kg');
    const cond = update[0].$set.variants.$map.in.$cond;
    expect(cond[0].$eq[1]).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(cond[0].$eq[1])).toBe(String(vid));
  });

  test('the variant pipeline preserves the untouched elements', () => {
    const update = buildVariantStockUpdate(new mongoose.Types.ObjectId(), 1.5, 'kg');
    const map = update[0].$set.variants.$map;
    // `$ifNull`-wrapped rather than bare `$variants`: stage 1 is now reachable
    // on a document whose array is absent (the rollup guard in stage 2 is what
    // keeps that harmless), and `$map` over null is an error, not a no-op.
    expect(map.input).toEqual({ $ifNull: ['$variants', []] });
    expect(map.in.$cond[2]).toBe('$$v');                 // non-matching → as-is
    expect(map.in.$cond[1].$mergeObjects[0]).toBe('$$v'); // matching → merged
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C. DISPLAY — where "৩৩.৩৩৩৩৩৩৩৩৩৩৩" reaches a receipt
 * ════════════════════════════════════════════════════════════════════════ */
describe('C. formatting', () => {
  test('trailing zeros are stripped', () => {
    expect(formatQuantity(99.5, 'kg')).toBe('৯৯.৫');
    expect(formatQuantity(100, 'kg')).toBe('১০০');
    expect(formatQuantity(100.0, 'kg')).toBe('১০০');
    expect(formatQuantity(0.25, 'kg')).toBe('০.২৫');
  });

  test('float residue never reaches the screen', () => {
    expect(formatQuantity(0.1 + 0.2, 'kg')).toBe('০.৩');
    expect(formatQuantity(99.99999999999999, 'kg')).toBe('১০০');
    expect(formatQuantity(1 / 3, 'kg')).toBe('০.৩৩৩');
    expect(formatQuantity(100 / 3, 'kg')).toBe('৩৩.৩৩৩');
    // The headline symptom, gone:
    expect(formatQuantity(100 / 3, 'kg')).not.toContain('৩৩৩৩৩৩');
  });

  test('large numbers group the Bangladeshi way', () => {
    expect(formatQuantity(1234567.25, 'kg')).toBe('১২,৩৪,৫৬৭.২৫');
    expect(formatQuantity(100000, 'piece')).toBe('১,০০,০০০');
  });

  test('integers render identically to before for countable units', () => {
    expect(formatQuantity(1, 'piece')).toBe('১');
    expect(formatQuantity(98, 'piece')).toBe('৯৮');
    expect(formatQuantity(0, 'piece')).toBe('০');
  });

  test('bad input degrades to ০ rather than NaN', () => {
    expect(formatQuantity(undefined, 'kg')).toBe('০');
    expect(formatQuantity(null, 'kg')).toBe('০');
    expect(formatQuantity('abc', 'kg')).toBe('০');
  });

  test('the unit label is Bengali', () => {
    expect(formatQuantityWithUnit(99.5, 'kg')).toBe('৯৯.৫ কেজি');
    expect(formatQuantityWithUnit(5, 'maund')).toBe('৫ মণ');
    expect(formatQuantityWithUnit(2, 'sack')).toBe('২ বস্তা');
  });

  test('an unrecognised unit falls back instead of throwing', () => {
    // An old document with a unit we somehow do not know must still render.
    expect(formatQuantity(5, 'zzz')).toBe('৫');
    expect(unitDecimals('zzz')).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * D. UNIT CONVERSION — the purchase-entry pre-fill
 * ════════════════════════════════════════════════════════════════════════ */
describe('D. conversion factors', () => {
  test('universally-known ratios resolve', () => {
    expect(conversionFactor('maund', 'kg')).toBe(40);
    expect(conversionFactor('ton', 'kg')).toBe(1000);
    expect(conversionFactor('kg', 'gram')).toBe(1000);
    expect(conversionFactor('liter', 'ml')).toBe(1000);
    expect(conversionFactor('dozen', 'piece')).toBe(12);
    expect(conversionFactor('hali', 'piece')).toBe(4);
    expect(conversionFactor('kuri', 'piece')).toBe(20);
    expect(conversionFactor('pair', 'piece')).toBe(2);
    expect(conversionFactor('gross', 'piece')).toBe(144);
  });

  test('length conversions come out clean, not 2.9999999996', () => {
    expect(conversionFactor('yard', 'feet')).toBe(3);
    expect(conversionFactor('feet', 'inch')).toBe(12);
    expect(conversionFactor('meter', 'cm')).toBe(100);
  });

  test('packaging units have no universal size — null, and that is correct', () => {
    // This is the whole reason no pack size is stored: a প্যাকেট is 12 in one
    // shop and 24 in the next, and 10 next month.
    for (const u of ['pack', 'sack', 'carton', 'box', 'bundle', 'strip', 'tray']) {
      expect(conversionFactor(u, 'piece')).toBeNull();
      expect(conversionFactor(u, 'kg')).toBeNull();
    }
  });

  test('cross-group conversions are refused', () => {
    expect(conversionFactor('kg', 'liter')).toBeNull();
    expect(conversionFactor('meter', 'piece')).toBeNull();
    expect(conversionFactor('kg', 'meter')).toBeNull();
  });

  test('unknown units and self-conversion behave', () => {
    expect(conversionFactor('kg', 'kg')).toBe(1);
    expect(conversionFactor('zzz', 'kg')).toBeNull();
    expect(conversionFactor(null, 'kg')).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * E. THE REGISTRY ITSELF
 * ════════════════════════════════════════════════════════════════════════ */
describe('E. registry integrity', () => {
  test('every unit has the fields the rest of the code assumes', () => {
    for (const key of ALL_UNITS) {
      const def = UNITS[key];
      expect(typeof def.bn).toBe('string');
      expect(def.bn.length).toBeGreaterThan(0);
      expect(typeof def.group).toBe('string');
      expect(Number.isInteger(def.decimals)).toBe(true);
      expect(def.decimals).toBeGreaterThanOrEqual(0);
    }
  });

  test('no two units share a Bengali label', () => {
    // Two identically-labelled options in a dropdown is an unwinnable choice.
    const labels = ALL_UNITS.map((u) => UNITS[u].bn);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('units with a fixed size sit in a group that has a canonical unit', () => {
    const { UNIT_GROUPS } = require('../config/units');
    for (const key of ALL_UNITS) {
      const def = UNITS[key];
      if (def.value != null) {
        expect(UNIT_GROUPS[def.group].canonical).toBeTruthy();
        expect(def.value).toBeGreaterThan(0);
      }
    }
  });

  test('a real shopping basket of Bangladeshi units is covered', () => {
    // The concrete cases this feature was asked for, plus the ones a general
    // store hits next.
    for (const u of [
      'kg', 'gram', 'maund', 'ton', 'liter', 'ml',        // ওজন / আয়তন
      'piece', 'dozen', 'hali', 'kuri', 'pair',           // গণনা
      'meter', 'feet', 'inch', 'yard', 'hat',             // কাপড় / দৈর্ঘ্য
      'sqft', 'cft',                                      // টাইলস / বালি
      'pack', 'sack', 'carton', 'strip', 'bottle', 'reem', // মোড়ক
    ]) {
      expect(ALL_UNITS).toContain(u);
    }
  });
});
