#!/usr/bin/env node
/**
 * Rewrite the browser's copies of the geography from the server's.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM `fetch-bd-geo.js` ───────────────────────
 *
 * `fetch-bd-geo.js` goes to the network. That is right when the UPSTREAM
 * changes, and wrong for everything else — our own corrections
 * (`bdCityAreas.json`) change without the upstream moving, and a data fix
 * should not require the machine applying it to be able to reach GitHub.
 *
 * So this script has no network at all. It renders whatever `bdGeo.util`
 * currently resolves to — upstream plus our corrections, through the same merge
 * the server itself reads — into the two static files the browser fetches. One
 * source, two consumers, no third opinion about what a district is.
 *
 *   node scripts/sync-bd-geo-frontend.js            # dry run: report only
 *   node scripts/sync-bd-geo-frontend.js --apply    # write the files
 *
 * ── THE TWO OUTPUTS ─────────────────────────────────────────────────────────
 *
 * `bd-geo.json`       divisions, districts, upazilas, city areas. Loaded by the
 *                     public checkout, so its size is a customer's 3G bill —
 *                     see STOREFRONT_DESIGN_REF's mobile mandate.
 *
 * `bd-localities.json` post offices, keyed by district, in a positional shape
 *                     (`[name, postCode, upazila]`) rather than objects. The
 *                     keys would otherwise be ~40% of the file for no
 *                     information. Fetched lazily, only when a customer opens
 *                     the locality suggestions, so the checkout's first paint
 *                     never pays for it.
 */

const fs = require('fs');
const path = require('path');

const bdGeo = require('../src/utils/bdGeo.util');
const postcodeFile = require('../src/data/bdPostcodes.json');

const OUT_DIR = path.join(__dirname, '..', '..', 'hisaab-frontend', 'public', 'data');
const OUT_GEO = path.join(OUT_DIR, 'bd-geo.json');
const OUT_LOCALITIES = path.join(OUT_DIR, 'bd-localities.json');

const apply = process.argv.includes('--apply');

function buildGeo() {
  const tree = bdGeo.fullTree();
  return {
    _source: 'hisaab-backend/src/utils/bdGeo.util.js (upstream + src/data/bdCityAreas.json)',
    _note: 'Generated. Do not edit by hand — run scripts/sync-bd-geo-frontend.js --apply.',
    _generatedAt: new Date().toISOString(),
    ...tree,
  };
}

/**
 * Post offices grouped by district.
 *
 * Deduped on the post-office NAME within a district: the upstream lists the
 * same office under two spellings of its upazila in a handful of places, and a
 * suggestion list that offers "Sapura" twice reads as a broken form.
 */
function buildLocalities() {
  const rows = postcodeFile.postcodes || [];
  const byDistrict = {};
  const seen = new Set();

  for (const row of rows) {
    const key = String(row.districtId);
    const dedupeKey = `${key}|${String(row.postOffice).toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (!byDistrict[key]) byDistrict[key] = [];
    byDistrict[key].push([row.postOffice, row.postCode, row.upazila]);
  }

  for (const list of Object.values(byDistrict)) {
    list.sort((a, b) => a[0].localeCompare(b[0]));
  }

  return {
    _source: postcodeFile._source,
    _license: postcodeFile._license,
    _note: 'Generated. Rows are [postOffice, postCode, upazila], keyed by district id.',
    _generatedAt: new Date().toISOString(),
    byDistrict,
  };
}

function report(label, file, payload) {
  const json = JSON.stringify(payload);
  const kb = (Buffer.byteLength(json, 'utf8') / 1024).toFixed(1);
  const existed = fs.existsSync(file);
  console.log(`${label.padEnd(16)} ${String(kb).padStart(7)} KB  ${existed ? 'replaces' : 'creates '} ${path.relative(process.cwd(), file)}`);
  return json;
}

function main() {
  if (!fs.existsSync(OUT_DIR)) {
    console.error(`Frontend public/data not found at ${OUT_DIR} — run this from hisaab-backend inside the monorepo.`);
    process.exit(1);
  }

  const geo = buildGeo();
  const localities = buildLocalities();

  console.log(`districts   ${geo.districts.length}`);
  console.log(`upazilas    ${geo.upazilas.length}`);
  console.log(`cityAreas   ${geo.cityAreas.length}  (dhakaAreas ${geo.dhakaAreas.length})`);
  console.log(`localities  ${Object.values(localities.byDistrict).reduce((n, l) => n + l.length, 0)} across ${Object.keys(localities.byDistrict).length} districts\n`);

  // Every district must offer something selectable. A district whose only rows
  // were replaced by a city corporation is precisely the failure this whole
  // change exists to fix, so it is asserted rather than assumed.
  const empty = geo.districts.filter(
    (d) => !geo.upazilas.some((u) => u.districtId === d.id)
      && !geo.cityAreas.some((a) => a.districtId === d.id)
  );
  if (empty.length) {
    console.error(`REFUSING: ${empty.length} district(s) have nothing to select: ${empty.map((d) => d.name).join(', ')}`);
    process.exit(1);
  }

  const geoJson = report('bd-geo', OUT_GEO, geo);
  const locJson = report('bd-localities', OUT_LOCALITIES, localities);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }

  fs.writeFileSync(OUT_GEO, geoJson);
  fs.writeFileSync(OUT_LOCALITIES, locJson);
  console.log('\nWritten.');
}

main();
