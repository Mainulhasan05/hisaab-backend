/**
 * Bangladesh administrative geography — the server's copy, and the authority.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE SERVER NEEDS THIS AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The checkout used to take a `zoneKey` from the browser. It validated that the
 * key EXISTED in the shop's zone table and charged accordingly — which meant a
 * customer in Rangpur could tick "ঢাকার ভিতরে ৳৬০" and be charged ৳৬০. The
 * server had no way to know better, because it never learned where the customer
 * actually was.
 *
 * Now the customer names a place, and the SERVER decides which zone that place
 * falls in (`order.service.resolveDelivery`). For that to be safe, the place
 * itself has to be checked against a real list — otherwise "Dhaka" becomes a
 * free-text field that anybody can type "Dhaka " into and land in the cheap
 * zone by accident or on purpose.
 *
 * This is the same rule as I-10, applied one level further out: the storefront
 * never receives a price from the client, and now it does not receive a
 * delivery ZONE either. It receives a district, and derives the rest.
 *
 * ── NAMES, NOT IDS, ARE THE CONTRACT ────────────────────────────────────────
 *
 * Everything public — the checkout body, the shop's zone mapping, the order
 * snapshot — is keyed on the ENGLISH name. The numeric ids in `bdGeo.json`
 * belong to the upstream dataset (see `scripts/fetch-bd-geo.js`) and could in
 * principle be renumbered by a refresh; district names are real places and do
 * not move. Ids are used only to join the three lists inside this file.
 *
 * ── MATCHING IS DELIBERATELY FORGIVING ON INPUT, EXACT ON OUTPUT ────────────
 *
 * `findDistrict` accepts a Bangla name, an English name, and either with odd
 * spacing or casing — a real form posts all three at different times, and an
 * apostrophe in "Cox's Bazar" survives at least two encodings. What it RETURNS
 * is always the canonical record, and that canonical `name` is what gets
 * stored and compared. Forgiving in, exact out.
 */

const geo = require('../data/bdGeo.json');

const DIVISIONS = Object.freeze(geo.divisions);
const DISTRICTS = Object.freeze(geo.districts);
const UPAZILAS = Object.freeze(geo.upazilas);
const DHAKA_AREAS = Object.freeze(geo.dhakaAreas);

/**
 * Normalise a name for comparison only.
 *
 * Lowercased, apostrophes and punctuation dropped, whitespace collapsed. This
 * is what makes "cox's bazar", "Coxs Bazar" and "COX'S  BAZAR" one key. Bangla
 * text passes through unchanged apart from spacing, which is correct: Bangla
 * has no case and the dataset's spellings are the canonical ones.
 */
const norm = (v) =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/\s+/g, ' ');

/** name (en + bn) -> record, built once at require time. */
function indexBy(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(norm(row.name), row);
    if (row.bn) map.set(norm(row.bn), row);
  }
  return map;
}

const DISTRICT_INDEX = indexBy(DISTRICTS);
const DIVISION_BY_ID = new Map(DIVISIONS.map((d) => [d.id, d]));
const DISTRICT_BY_ID = new Map(DISTRICTS.map((d) => [d.id, d]));

/**
 * Sub-district lookup is scoped BY DISTRICT, not global.
 *
 * There are two Nawabganj upazilas and several Sadar-something names repeated
 * across the country; a global index would resolve "Sadar" to whichever one
 * happened to be inserted last. Scoping to the district the customer already
 * chose makes the ambiguity impossible rather than unlikely.
 */
const SUBS_BY_DISTRICT = new Map();
for (const u of UPAZILAS) {
  if (!SUBS_BY_DISTRICT.has(u.districtId)) SUBS_BY_DISTRICT.set(u.districtId, []);
  SUBS_BY_DISTRICT.get(u.districtId).push({ ...u, kind: 'upazila' });
}
for (const a of DHAKA_AREAS) {
  if (!SUBS_BY_DISTRICT.has(a.districtId)) SUBS_BY_DISTRICT.set(a.districtId, []);
  SUBS_BY_DISTRICT.get(a.districtId).push({
    id: null,
    districtId: a.districtId,
    name: a.name,
    bn: a.bn,
    kind: 'area',
    cityCorporation: a.cityCorporation,
  });
}
for (const [, list] of SUBS_BY_DISTRICT) {
  // City areas first, then upazilas: in Dhaka the areas are what almost every
  // customer wants, and a list that opens with Dhamrai reads as the wrong list.
  list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'area' ? -1 : 1));
}

const SUB_INDEX_BY_DISTRICT = new Map(
  [...SUBS_BY_DISTRICT.entries()].map(([id, list]) => [id, indexBy(list)])
);

/**
 * Global sub-district index — canonical name for any upazila or city area.
 *
 * Used ONLY when validating a shop's zone coverage list, which is a flat list
 * with no district context. It is deliberately not used at checkout: there,
 * `findSubdistrict` scopes the lookup to the district the customer chose, so a
 * name shared by two districts can never resolve to the wrong one.
 */
const ALL_SUBS_INDEX = new Map();
for (const list of SUBS_BY_DISTRICT.values()) {
  for (const row of list) {
    if (!ALL_SUBS_INDEX.has(norm(row.name))) ALL_SUBS_INDEX.set(norm(row.name), row.name);
    if (row.bn && !ALL_SUBS_INDEX.has(norm(row.bn))) ALL_SUBS_INDEX.set(norm(row.bn), row.name);
  }
}

/** @returns {string|null} canonical English name of an upazila/area, or null. */
function findAreaAnywhere(name) {
  if (!name) return null;
  return ALL_SUBS_INDEX.get(norm(name)) || null;
}

/** @returns {object|null} the canonical district record, or null. */
function findDistrict(name) {
  if (!name) return null;
  return DISTRICT_INDEX.get(norm(name)) || null;
}

/**
 * Find an upazila or Dhaka-city area WITHIN a district.
 *
 * @param {object|number} district  a district record or its id
 * @returns {object|null} `{ name, bn, kind: 'upazila'|'area', cityCorporation? }`
 */
function findSubdistrict(district, name) {
  if (!district || !name) return null;
  const districtId = typeof district === 'object' ? district.id : Number(district);
  const index = SUB_INDEX_BY_DISTRICT.get(districtId);
  return index ? index.get(norm(name)) || null : null;
}

/** Every upazila + city area of one district, ordered for a dropdown. */
function subdistrictsOf(district) {
  const districtId = typeof district === 'object' ? district.id : Number(district);
  return SUBS_BY_DISTRICT.get(districtId) || [];
}

/**
 * Validate a submitted delivery address against the real geography.
 *
 * Throws nothing — returns `{ ok, district, subdistrict, error }` so the caller
 * decides the status code and the Bangla message. `subdistrict` is optional:
 * some shops only price by district, and forcing a thana out of a customer who
 * does not know theirs costs orders for no gain.
 */
function resolveAddress({ district, subdistrict } = {}, { requireSubdistrict = true } = {}) {
  const d = findDistrict(district);
  if (!d) {
    return { ok: false, error: 'জেলা বেছে নিন', district: null, subdistrict: null };
  }
  if (!subdistrict) {
    /**
     * Defaulting to "district only" is not safe for the district that matters
     * most. Dhaka district contains both Dhanmondi (৳৬০) and Savar (৳১২০), so
     * an order that names only "Dhaka" cannot be priced — it falls through to
     * the default zone and a Dhanmondi customer is quoted the outside-Dhaka
     * rate. Asking for one more dropdown is cheaper than that.
     *
     * Manual entry opts out (`requireSubdistrict: false`): shop staff taking a
     * phone order often genuinely do not know the thana yet, and refusing to
     * record the order at all would be worse than pricing it by district.
     */
    if (requireSubdistrict) {
      return { ok: false, error: 'আপনার এলাকা/উপজেলা বেছে নিন', district: d, subdistrict: null };
    }
    return { ok: true, district: d, subdistrict: null };
  }
  const s = findSubdistrict(d, subdistrict);
  if (!s) {
    // Named but unknown is a refusal, not a shrug. Silently dropping it would
    // route the order by district alone and could charge the wrong zone.
    return { ok: false, error: 'এলাকা/উপজেলা সঠিক নয়', district: d, subdistrict: null };
  }
  return { ok: true, district: d, subdistrict: s };
}

/** Division record for a district — used for the order snapshot. */
function divisionOf(district) {
  if (!district) return null;
  return DIVISION_BY_ID.get(district.divisionId) || null;
}

/**
 * The whole tree, shaped for a dropdown and safe to cache hard.
 *
 * Public, identical for every shop, and ~57KB — so the public route that serves
 * it sets a long max-age rather than making every checkout pay for it.
 */
function fullTree() {
  return {
    divisions: DIVISIONS.map((d) => ({ id: d.id, name: d.name, bn: d.bn })),
    districts: DISTRICTS.map((d) => ({ id: d.id, divisionId: d.divisionId, name: d.name, bn: d.bn })),
    upazilas: UPAZILAS.map((u) => ({ districtId: u.districtId, name: u.name, bn: u.bn })),
    dhakaAreas: DHAKA_AREAS.map((a) => ({
      districtId: a.districtId, name: a.name, bn: a.bn, cityCorporation: a.cityCorporation,
    })),
  };
}

/**
 * Dhaka city area names, for seeding a new shop's "inside Dhaka" zone.
 *
 * Exported as a list rather than left for callers to filter, because the
 * filter is the subtle part: Dhaka district's rural upazilas (Savar, Dhamrai,
 * Keraniganj, Dohar, Nawabganj) must NOT be in it — almost every shop prices
 * those as outside Dhaka, and seeding them into the ৳৬০ zone would quietly
 * undercharge every one of those orders from day one.
 */
const DHAKA_CITY_AREA_NAMES = Object.freeze(DHAKA_AREAS.map((a) => a.name));

module.exports = {
  DIVISIONS,
  DISTRICTS,
  DHAKA_CITY_AREA_NAMES,
  findDistrict,
  findAreaAnywhere,
  findSubdistrict,
  subdistrictsOf,
  resolveAddress,
  divisionOf,
  fullTree,
  DISTRICT_BY_ID,
  _norm: norm,
};
