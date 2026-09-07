#!/usr/bin/env node
/**
 * Regenerate the Bangladesh administrative-geography dataset.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVENANCE IS THE POINT OF THIS FILE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Division / district / upazila / post-office names are public government
 * record — facts, not anyone's intellectual property. But "it's public data"
 * is only a defence you can actually make if you can SHOW where yours came
 * from. That is what this script is: the generated JSON carries the source
 * URL, the licence and the upstream commit, so the provenance of every row is
 * answerable years from now without anyone having to remember.
 *
 * This is the opposite of copying a competitor's dropdown. A scraped list
 * carries that site's coverage gaps, its spellings and its typos — and those
 * idiosyncrasies are exactly what makes copied data identifiable. A cited
 * upstream carries none of that risk and is more complete besides.
 *
 * ── WHY ONE UPSTREAM AND NOT TWO ────────────────────────────────────────────
 *
 * `nuhil/bangladesh-geocode` is the better-known dataset, but it has no
 * postcodes, and its numeric ids do NOT agree with any postcode source — in
 * nuhil's tables division 1 is Chattagram, while every postcode set numbers
 * Barishal first. Mixing the two silently mis-files ~1,300 post offices under
 * the wrong districts, and nothing about the result LOOKS wrong.
 *
 * So all four tables come from a single upstream whose ids are internally
 * consistent, and that consistency is asserted below rather than assumed.
 *
 * ── ID STABILITY — READ BEFORE STORING AN ID ────────────────────────────────
 *
 * These ids belong to the upstream, not to us. A future refresh could in
 * principle renumber them. Therefore anything we PERSIST (an order's delivery
 * address) must snapshot the NAMES, exactly as `Order.deliveryCharge`
 * snapshots the charge rather than pointing at the zone table. Ids are for
 * joining the three lists inside one request, never for long-term reference.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/fetch-bd-geo.js            # dry run: fetch, verify, report
 *   node scripts/fetch-bd-geo.js --apply    # also write the two output files
 *
 * Follows the repo's `--apply` convention: it changes nothing without it.
 */

const fs = require('fs');
const path = require('path');

const REPO = 'ifahimreza/bangladesh-geojson';
const BRANCH = 'master';
const LICENSE = 'MIT';
const BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/src/data`;

const SOURCES = {
  divisions: `${BASE}/bd-divisions.json`,
  districts: `${BASE}/bd-districts.json`,
  upazilas: `${BASE}/bd-upazilas.json`,
  postcodes: `${BASE}/bd-postcodes.json`,
  dhakaAreas: `${BASE}/dhaka-city.json`,
};

/** Where the two outputs land. Both written by this script so they cannot drift. */
const OUT_GEO = path.join(__dirname, '..', 'src', 'data', 'bdGeo.json');
const OUT_POSTCODES = path.join(__dirname, '..', 'src', 'data', 'bdPostcodes.json');
/** The frontend copy — same bytes, fetched lazily by the checkout form. */
const OUT_GEO_FRONTEND = path.join(
  __dirname, '..', '..', 'hisaab-frontend', 'public', 'data', 'bd-geo.json'
);

const apply = process.argv.includes('--apply');

/** Expected row counts. A silent upstream truncation is the failure to catch. */
const EXPECT = { divisions: 8, districts: 64, upazilas: 494 };

/**
 * ── UPSTREAM DEFECT: 12 post offices carry a district NAME, not an id ────────
 *
 * Every Chapai Nawabganj row in `bd-postcodes.json` has `district:
 * "Chapinawabganj"` where every other row has `district_id`. Dropping them
 * would quietly lose a whole district's post offices, and a customer in
 * Chapai Nawabganj would find their own town missing from the checkout with
 * no error anywhere to explain it.
 *
 * Repaired by name rather than by patching a copy of the upstream file, so a
 * refresh does not silently re-break it — and so that if the upstream ever
 * fixes this, the assertion below tells us the entry is now dead code.
 */
const POSTCODE_DISTRICT_BY_NAME = { Chapinawabganj: 22 };

/**
 * ── OUR CORRECTIONS TO THE UPSTREAM ─────────────────────────────────────────
 *
 * Kept as an explicit, reviewable table rather than edits to the fetched data,
 * for the same reason as above: a refresh must not undo them silently.
 *
 * District 22 is the important one. The upstream calls it "Nawabganj"
 * /"নবাবগঞ্জ", but that is ambiguous — Nawabganj is also an upazila of Dhaka
 * district — and the official name has been Chapai Nawabganj since 1984. A
 * customer there types "চাঁপাইনবাবগঞ্জ" and would otherwise find nothing.
 *
 * The rest are spelling: the standard Bangla for নারায়ণগঞ্জ has no আ after
 * রায়, কক্সবাজার is one word, and Sirajganj is the official romanisation.
 */
const DISTRICT_FIXES = {
  22: { name: 'Chapai Nawabganj', bn: 'চাঁপাইনবাবগঞ্জ' },
  25: { name: 'Sirajganj' },
  11: { bn: 'নারায়ণগঞ্জ' },
  45: { bn: 'কক্সবাজার' },
};

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

/** Upstream files are either a bare array or a single-key wrapper. */
const rowsOf = (j) => (Array.isArray(j) ? j : Object.values(j)[0]);

const num = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`bad id: ${JSON.stringify(v)}`);
  return n;
};

const str = (v) => String(v ?? '').trim();

/**
 * Drop repeated names within one parent.
 *
 * The upstream lists 16 Dhaka areas twice (Uttara, Banani, Mirpur Cantonment …)
 * and two Natore upazilas twice. In a dropdown that renders as the same place
 * appearing twice in a row, which reads to the customer as a broken form — and
 * worse, the two rows are indistinguishable, so whichever they pick is a
 * coin-flip that the zone lookup then has to resolve.
 *
 * Deduped here rather than at read time so BOTH copies of the dataset — the
 * server's and the browser's — are clean from the same pass.
 */
function dedupe(rows, keyOf, label, report) {
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const row of rows) {
    const k = keyOf(row);
    if (seen.has(k)) { dropped += 1; continue; }
    seen.add(k);
    kept.push(row);
  }
  if (dropped) report.push(`${label}: dropped ${dropped} duplicate name(s)`);
  return kept;
}

async function main() {
  console.log(`Source : https://github.com/${REPO} (${BRANCH}), licence ${LICENSE}\n`);

  const [divRaw, distRaw, upzRaw, pcRaw, dhakaRaw] = await Promise.all([
    getJson(SOURCES.divisions),
    getJson(SOURCES.districts),
    getJson(SOURCES.upazilas),
    getJson(SOURCES.postcodes),
    getJson(SOURCES.dhakaAreas),
  ]);

  const divisions = rowsOf(divRaw).map((d) => ({
    id: num(d.id),
    name: str(d.name),
    bn: str(d.bn_name),
  }));

  const appliedFixes = [];
  const districts = rowsOf(distRaw).map((d) => {
    const id = num(d.id);
    const fix = DISTRICT_FIXES[id] || {};
    if (fix.name || fix.bn) appliedFixes.push(`${id} ${d.name}/${d.bn_name} → ${fix.name || d.name}/${fix.bn || d.bn_name}`);
    return {
      id,
      divisionId: num(d.division_id),
      name: fix.name || str(d.name),
      bn: fix.bn || str(d.bn_name),
    };
  });

  const dedupeReport = [];
  const nameKey = (r) => `${r.districtId}|${r.name.toLowerCase()}`;

  const upazilas = dedupe(
    rowsOf(upzRaw).map((u) => ({
      id: num(u.id),
      districtId: num(u.district_id),
      name: str(u.name),
      bn: str(u.bn_name),
    })),
    nameKey,
    'upazilas',
    dedupeReport
  );

  let repairedByName = 0;
  const postcodes = rowsOf(pcRaw).map((p) => {
    let districtId = p.district_id;
    if (districtId === undefined) {
      districtId = POSTCODE_DISTRICT_BY_NAME[str(p.district)];
      if (districtId === undefined) {
        throw new Error(`postcode ${p.postCode} (${p.postOffice}) has neither district_id nor a known district name (${p.district})`);
      }
      repairedByName += 1;
    }
    return {
      districtId: num(districtId),
      upazila: str(p.upazila),
      postOffice: str(p.postOffice),
      postCode: str(p.postCode),
    };
  });

  /**
   * ── DHAKA CITY AREAS — WITHOUT THESE THE CHECKOUT IS BROKEN FOR MOST ORDERS
   *
   * Dhaka DISTRICT has only five upazilas (Dhamrai, Dohar, Keraniganj,
   * Nawabganj, Savar) — all of them rural. None of them is Dhanmondi, Gulshan
   * or Mirpur, because Dhaka city is not divided into upazilas at all.
   *
   * So a district → upazila cascade, correct as it is, leaves a customer in
   * the single highest-volume delivery area in the country with nothing to
   * pick. These 142 areas are that missing level, and the city corporation
   * (North / South) comes with them because it is the natural boundary a
   * shop's inside-Dhaka delivery zone is drawn on.
   */
  const dhakaAreas = dedupe(
    rowsOf(dhakaRaw).map((a) => ({
      districtId: num(a.district_id),
      cityCorporation: str(a.city_corporation),
      name: str(a.name),
      bn: str(a.bn_name),
    })),
    nameKey,
    'dhakaAreas',
    dedupeReport
  );

  // ── Verification ──────────────────────────────────────────────────────────
  //
  // Every check below has failed for somebody at some point. Referential
  // integrity is the one that matters most: a district pointing at a division
  // that does not exist renders as an empty dropdown, which reads to the
  // customer as a broken checkout rather than as missing data.

  const problems = [];

  // Counted on the RAW upstream rows, before dedupe — otherwise a genuine
  // upstream truncation and our own duplicate-removal are indistinguishable.
  const rawCounts = {
    divisions: rowsOf(divRaw).length,
    districts: rowsOf(distRaw).length,
    upazilas: rowsOf(upzRaw).length,
  };
  for (const [key, expected] of Object.entries(EXPECT)) {
    if (rawCounts[key] !== expected) {
      problems.push(`${key}: upstream had ${rawCounts[key]} rows, expected ${expected}`);
    }
  }

  const divIds = new Set(divisions.map((d) => d.id));
  const distIds = new Set(districts.map((d) => d.id));

  for (const d of districts) {
    if (!divIds.has(d.divisionId)) problems.push(`district ${d.name}: unknown divisionId ${d.divisionId}`);
  }
  for (const u of upazilas) {
    if (!distIds.has(u.districtId)) problems.push(`upazila ${u.name}: unknown districtId ${u.districtId}`);
  }
  const orphanPostcodes = postcodes.filter((p) => !distIds.has(p.districtId));
  if (orphanPostcodes.length) {
    problems.push(`${orphanPostcodes.length} postcodes reference an unknown districtId`);
  }

  // Bangla names are not optional in this app — an English-only row would
  // surface untranslated in a Bangla checkout.
  const missingBn = [...divisions, ...districts, ...upazilas, ...dhakaAreas].filter((r) => !r.bn);
  if (missingBn.length) problems.push(`${missingBn.length} rows have no Bangla name`);

  for (const a of dhakaAreas) {
    if (!distIds.has(a.districtId)) problems.push(`Dhaka area ${a.name}: unknown districtId ${a.districtId}`);
  }
  if (!dhakaAreas.length) problems.push('no Dhaka city areas — the busiest delivery area would have no options');

  // The id-scheme sanity check the header warns about: if this ever passes
  // with Chattagram first, the upstream changed and the postcode joins are
  // no longer trustworthy.
  const firstDivision = divisions.find((d) => d.id === 1);
  if (firstDivision && firstDivision.name !== 'Barishal') {
    problems.push(`division id 1 is "${firstDivision.name}", expected "Barishal" — id scheme changed, RE-VERIFY postcode joins`);
  }

  // Every district should have at least one upazila.
  const withUpazilas = new Set(upazilas.map((u) => u.districtId));
  for (const d of districts) {
    if (!withUpazilas.has(d.id)) problems.push(`district ${d.name} has no upazilas`);
  }

  console.log(`divisions : ${divisions.length}`);
  console.log(`districts : ${districts.length}`);
  console.log(`upazilas  : ${upazilas.length}`);
  console.log(`postcodes : ${postcodes.length} post offices`);
  console.log(`dhakaAreas: ${dhakaAreas.length} city areas`);
  console.log('');

  for (const f of appliedFixes) console.log(`fix  district ${f}`);
  for (const d of dedupeReport) console.log(`fix  ${d}`);
  if (repairedByName > 0) {
    console.log(`fix  ${repairedByName} postcodes joined by district NAME (upstream defect)`);
  } else {
    // Not a failure — but somebody should delete the table rather than leave a
    // repair in place for a defect that no longer exists.
    console.log('note POSTCODE_DISTRICT_BY_NAME matched nothing — upstream appears fixed, the table can go');
  }
  console.log('');

  if (problems.length) {
    console.error('FAILED verification:');
    for (const p of problems) console.error(`  · ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log('All checks passed.\n');

  const meta = {
    _source: `https://github.com/${REPO}`,
    _license: LICENSE,
    _note: 'Public administrative geography of Bangladesh. Names snapshotted on orders; ids are join keys only. Regenerate with scripts/fetch-bd-geo.js',
    _generatedAt: new Date().toISOString(),
  };

  const geo = { ...meta, divisions, districts, upazilas, dhakaAreas };
  const pc = { ...meta, postcodes };

  if (!apply) {
    console.log('Dry run — nothing written. Re-run with --apply to write:');
    console.log(`  ${OUT_GEO}`);
    console.log(`  ${OUT_POSTCODES}`);
    console.log(`  ${OUT_GEO_FRONTEND}`);
    return;
  }

  for (const [file, data] of [
    [OUT_GEO, geo],
    [OUT_POSTCODES, pc],
    [OUT_GEO_FRONTEND, geo],
  ]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    const kb = (fs.statSync(file).size / 1024).toFixed(1);
    console.log(`wrote ${file}  (${kb} KB)`);
  }
}

main().catch((err) => {
  console.error(`\nfetch-bd-geo failed: ${err.message}`);
  process.exitCode = 1;
});
