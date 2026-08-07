/**
 * Unit Registry — the single source of truth for measurement units.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE TOUCHING THIS FILE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Product.unit` has existed since day one as a **cosmetic label** — a string
 * printed on the invoice when `shop.settings.showUnitOnInvoice` is on. Nothing
 * ever did arithmetic with it.
 *
 * The packaging feature (`shop.features.packaging`) gives some of these units
 * *behaviour*: a decimal precision, and a pre-fill factor for the purchase-entry
 * "× how many" helper. That behaviour is **flag-gated**. A shop without the flag
 * sees exactly the 13 units it always saw, integer-only, unchanged.
 *
 * THREE RULES:
 *
 *   1. NEVER remove or rename a key. `Product.unit` documents in production
 *      store these strings. A removed key fails enum validation on every future
 *      save of that product, and the product becomes uneditable.
 *
 *   2. `decimals: 0` means the unit is countable and fractions are REFUSED, even
 *      with the flag on. You cannot sell 0.5 of a box — you sell the pieces
 *      inside it instead. This is what keeps `Sale.items.quantity` an integer
 *      for every shop that never sells by weight.
 *
 *   3. `decimals` may never exceed MAX_DECIMALS (3). The no-drift guarantee in
 *      `utils/quantity.util.js` is arithmetic, not a hope, and it is derived
 *      from that number. Raising it silently shrinks the exact-arithmetic range.
 *
 * `LEGACY_UNITS` is the set that existed before this file. Any unit outside it
 * must not be offered to a shop without the packaging flag — see
 * `unitsForShop()`. That is invariant I-6.
 */

/**
 * Decimal places are capped here, not per-unit.
 *
 * Why 3: `Product.stock` is a IEEE-754 double. A double's spacing at magnitude M
 * is M x 2^-52, so rounding to 3 decimals is unambiguous while
 *
 *     M x 2^-52  <  0.0005      →      M  <  2.25 x 10^12
 *
 * i.e. up to ~2.25 trillion kg, gram-level arithmetic is exact. Every stock
 * write re-rounds to this precision (see quantity.util.js), so error is clamped
 * on every operation instead of accumulating. Raising this to 6 would drop the
 * exact range to ~2.25 billion — still large, but the guarantee changes, and
 * `SAFE_QUANTITY_MAX` below must change with it.
 */
const MAX_DECIMALS = 3;

/** Largest quantity for which MAX_DECIMALS rounding is provably unambiguous. */
const SAFE_QUANTITY_MAX = 2_000_000_000_000; // 2 x 10^12, under the 2.25e12 bound

/**
 * Unit groups. `canonical` is the unit every member converts through.
 * Groups with `canonical: null` hold units that have no fixed size in the real
 * world — a "packet" is whatever the supplier decided this week.
 */
const UNIT_GROUPS = {
  count:  { bn: 'গণনা',      canonical: 'piece' },
  weight: { bn: 'ওজন',       canonical: 'kg' },
  volume: { bn: 'আয়তন',     canonical: 'liter' },
  length: { bn: 'দৈর্ঘ্য',    canonical: 'meter' },
  area:   { bn: 'ক্ষেত্রফল',  canonical: 'sqft' },
  solid:  { bn: 'ঘনফল',      canonical: 'cft' },
  pack:   { bn: 'মোড়ক',      canonical: null },
  time:   { bn: 'সময়',       canonical: 'hour' },
};

/**
 * Unit definitions.
 *
 *   bn        Bengali label shown in every picker and on every invoice.
 *   group     key of UNIT_GROUPS.
 *   decimals  0 = countable, fractions refused. 1..3 = divisible.
 *   value     size in the group's canonical unit. null = no fixed size.
 *   legacy    true = existed before the packaging feature; visible to every shop.
 *   approx    true = the factor is a market convention, not a definition. These
 *             pre-fill the purchase helper but the shopkeeper can overwrite it.
 */
const UNITS = {
  // ── গণনা ─────────────────────────────────────────────────────────────────
  piece:  { bn: 'পিস',    group: 'count', decimals: 0, value: 1,   legacy: true },
  pair:   { bn: 'জোড়া',  group: 'count', decimals: 0, value: 2 },
  hali:   { bn: 'হালি',   group: 'count', decimals: 0, value: 4 },
  dozen:  { bn: 'ডজন',    group: 'count', decimals: 0, value: 12,  legacy: true },
  kuri:   { bn: 'কুড়ি',   group: 'count', decimals: 0, value: 20 },
  gross:  { bn: 'গ্রোস',  group: 'count', decimals: 0, value: 144 },

  // ── ওজন ──────────────────────────────────────────────────────────────────
  // `mg`/`gram` are decimals: 0 on purpose — they are already the smallest
  // practical division, and allowing 0.001 gram invites float noise for nothing.
  mg:     { bn: 'মিলিগ্রাম', group: 'weight', decimals: 0, value: 0.000001 },
  gram:   { bn: 'গ্রাম',     group: 'weight', decimals: 0, value: 0.001, legacy: true },
  kg:     { bn: 'কেজি',      group: 'weight', decimals: 3, value: 1,     legacy: true },
  ser:    { bn: 'সের',       group: 'weight', decimals: 3, value: 0.9331 },
  // মণ: officially 40 ser = 37.324 kg, but Bangladeshi market practice is a
  // flat 40 kg and that is what a shopkeeper means when they say it. Pre-filled
  // with the market figure, overridable — see `approx`.
  maund:  { bn: 'মণ',        group: 'weight', decimals: 3, value: 40, approx: true },
  pound:  { bn: 'পাউন্ড',    group: 'weight', decimals: 3, value: 0.453592 },
  ton:    { bn: 'টন',        group: 'weight', decimals: 3, value: 1000 },

  // ── আয়তন ────────────────────────────────────────────────────────────────
  ml:     { bn: 'মিলিলিটার', group: 'volume', decimals: 0, value: 0.001, legacy: true },
  liter:  { bn: 'লিটার',     group: 'volume', decimals: 3, value: 1,     legacy: true },
  gallon: { bn: 'গ্যালন',    group: 'volume', decimals: 3, value: 3.78541 },

  // ── দৈর্ঘ্য ──────────────────────────────────────────────────────────────
  mm:     { bn: 'মিলিমিটার', group: 'length', decimals: 0, value: 0.001 },
  cm:     { bn: 'সেন্টিমিটার', group: 'length', decimals: 1, value: 0.01 },
  inch:   { bn: 'ইঞ্চি',     group: 'length', decimals: 2, value: 0.0254, legacy: true },
  feet:   { bn: 'ফুট',       group: 'length', decimals: 2, value: 0.3048, legacy: true },
  hat:    { bn: 'হাত',       group: 'length', decimals: 2, value: 0.4572, approx: true },
  yard:   { bn: 'গজ',        group: 'length', decimals: 2, value: 0.9144 },
  meter:  { bn: 'মিটার',     group: 'length', decimals: 2, value: 1,      legacy: true },
  km:     { bn: 'কিলোমিটার', group: 'length', decimals: 3, value: 1000 },

  // ── ক্ষেত্রফল ────────────────────────────────────────────────────────────
  sqft:   { bn: 'বর্গফুট',   group: 'area', decimals: 2, value: 1 },
  sqm:    { bn: 'বর্গমিটার', group: 'area', decimals: 2, value: 10.7639 },

  // ── ঘনফল ────────────────────────────────────────────────────────────────
  cft:    { bn: 'ঘনফুট',     group: 'solid', decimals: 2, value: 1 },
  cbm:    { bn: 'ঘনমিটার',   group: 'solid', decimals: 3, value: 35.3147 },

  // ── মোড়ক — no fixed size, so no `value`. These drive the ad-hoc helper. ──
  pack:   { bn: 'প্যাকেট',   group: 'pack', decimals: 0, value: null, legacy: true },
  box:    { bn: 'বক্স',      group: 'pack', decimals: 0, value: null, legacy: true },
  set:    { bn: 'সেট',       group: 'pack', decimals: 0, value: null, legacy: true },
  sack:   { bn: 'বস্তা',     group: 'pack', decimals: 0, value: null, legacy: true },
  carton: { bn: 'কার্টন',    group: 'pack', decimals: 0, value: null },
  bundle: { bn: 'বান্ডিল',   group: 'pack', decimals: 0, value: null },
  strip:  { bn: 'পাতা',      group: 'pack', decimals: 0, value: null },
  bottle: { bn: 'বোতল',      group: 'pack', decimals: 0, value: null },
  can:    { bn: 'ক্যান',     group: 'pack', decimals: 0, value: null },
  jar:    { bn: 'জার',       group: 'pack', decimals: 0, value: null },
  tube:   { bn: 'টিউব',      group: 'pack', decimals: 0, value: null },
  roll:   { bn: 'রোল',       group: 'pack', decimals: 0, value: null },
  coil:   { bn: 'কয়েল',     group: 'pack', decimals: 0, value: null },
  reem:   { bn: 'রিম',       group: 'pack', decimals: 0, value: null },
  tray:   { bn: 'ট্রে',      group: 'pack', decimals: 0, value: null },
  crate:  { bn: 'ক্রেট',     group: 'pack', decimals: 0, value: null },
  basket: { bn: 'ঝুড়ি',     group: 'pack', decimals: 0, value: null },
  bunch:  { bn: 'আঁটি',      group: 'pack', decimals: 0, value: null },
  than:   { bn: 'থান',       group: 'pack', decimals: 0, value: null },
  bag:    { bn: 'ব্যাগ',     group: 'pack', decimals: 0, value: null },
  drum:   { bn: 'ড্রাম',     group: 'pack', decimals: 0, value: null },

  // ── অন্যান্য ─────────────────────────────────────────────────────────────
  unit:   { bn: 'একক',      group: 'count', decimals: 0, value: 1 },
  hour:   { bn: 'ঘণ্টা',    group: 'time',  decimals: 2, value: 1 },
  day:    { bn: 'দিন',      group: 'time',  decimals: 1, value: 24 },
};

/** Default when a product has no unit set, and the fallback for unknown keys. */
const DEFAULT_UNIT = 'piece';

/**
 * The 13 units that existed before the packaging feature. A shop WITHOUT
 * `features.packaging` must be offered exactly these and nothing more — that is
 * what makes the flag invisible rather than merely inert. Frozen forever; never
 * add to this list.
 */
const LEGACY_UNITS = Object.freeze([
  'piece', 'kg', 'gram', 'liter', 'ml', 'meter', 'inch',
  'feet', 'dozen', 'pack', 'box', 'set', 'sack',
]);

/** Every key — this is what `Product.unit`'s enum is built from. */
const ALL_UNITS = Object.freeze(Object.keys(UNITS));

/** Shown first in the picker. Covers what most shops actually sell in. */
const COMMON_UNITS = Object.freeze(['piece', 'kg', 'liter', 'pack', 'dozen', 'meter']);

/**
 * Definition for a unit key, falling back to `piece` for anything unrecognised.
 * Never throws: an old document with a unit we somehow do not know must still
 * render, not 500.
 *
 * @param {string} unit
 * @returns {{bn:string, group:string, decimals:number, value:?number}}
 */
function unitDef(unit) {
  return UNITS[unit] || UNITS[DEFAULT_UNIT];
}

/**
 * Decimal places allowed for a unit — 0 means integers only.
 * Callers must not read `UNITS[x].decimals` directly; unknown keys would give
 * `undefined`, and `undefined` decimals silently disables rounding.
 *
 * @param {string} unit
 * @returns {number} 0..MAX_DECIMALS
 */
function unitDecimals(unit) {
  const d = unitDef(unit).decimals;
  return Math.min(Number.isFinite(d) ? d : 0, MAX_DECIMALS);
}

/** True when this unit may carry a fraction at all. */
function isDivisible(unit) {
  return unitDecimals(unit) > 0;
}

/** Bengali label, for pickers, invoices and receipts. */
function unitLabel(unit) {
  return unitDef(unit).bn;
}

/**
 * How many `to` units are in one `from` unit — the pre-fill for the
 * purchase-entry "× how many" box.
 *
 * Returns null when there is no universal answer (either unit has no fixed
 * size, or they belong to different groups). Null is not an error: it is the
 * signal that the shopkeeper must type the number themselves, which is the
 * normal case for প্যাকেট / বস্তা / কার্টন.
 *
 * The returned value is ALWAYS a suggestion. The UI pre-fills it and leaves the
 * box editable — `approx: true` units (মণ, হাত) are regional conventions rather
 * than definitions, and locking them would book the wrong stock for anyone
 * using the other convention.
 *
 * @param {string} from  e.g. 'maund'
 * @param {string} to    e.g. 'kg'
 * @returns {number|null} e.g. 40
 */
function conversionFactor(from, to) {
  if (!from || !to || from === to) return from === to ? 1 : null;

  const a = UNITS[from];
  const b = UNITS[to];
  if (!a || !b) return null;
  if (a.group !== b.group) return null;
  if (a.value == null || b.value == null) return null;
  if (!(b.value > 0)) return null;

  // Round the factor itself — 0.9144 / 0.3048 must come out 3, not 2.9999999996.
  return Math.round((a.value / b.value) * 1e6) / 1e6;
}

/**
 * Units a shop may choose from.
 *
 * WITHOUT the packaging flag this returns the original 13, in the original
 * order, so the product-form dropdown is byte-identical to what it has always
 * been (I-6). Do not "improve" this by returning everything — the larger list
 * is part of the paid feature, and an ungated unit like `maund` would let a
 * shop store a quantity the rest of their UI cannot interpret.
 *
 * @param {boolean} packagingEnabled
 * @returns {string[]}
 */
function unitsForShop(packagingEnabled) {
  return packagingEnabled ? ALL_UNITS.slice() : LEGACY_UNITS.slice();
}

/**
 * Picker payload: units grouped, with labels and precision, ready to render.
 * @param {boolean} packagingEnabled
 */
function unitCatalogue(packagingEnabled) {
  const allowed = new Set(unitsForShop(packagingEnabled));
  const groups = [];

  for (const [key, meta] of Object.entries(UNIT_GROUPS)) {
    const items = ALL_UNITS
      .filter(u => allowed.has(u) && UNITS[u].group === key)
      .map(u => ({
        value: u,
        label: UNITS[u].bn,
        decimals: unitDecimals(u),
        divisible: isDivisible(u),
      }));
    if (items.length) groups.push({ key, label: meta.bn, units: items });
  }

  return {
    groups,
    common: COMMON_UNITS.filter(u => allowed.has(u)),
    defaultUnit: DEFAULT_UNIT,
  };
}

module.exports = {
  UNITS,
  UNIT_GROUPS,
  ALL_UNITS,
  LEGACY_UNITS,
  COMMON_UNITS,
  DEFAULT_UNIT,
  MAX_DECIMALS,
  SAFE_QUANTITY_MAX,
  unitDef,
  unitDecimals,
  isDivisible,
  unitLabel,
  conversionFactor,
  unitsForShop,
  unitCatalogue,
};
