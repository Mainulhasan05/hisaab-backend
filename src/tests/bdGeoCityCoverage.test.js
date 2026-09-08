/**
 * Every district must offer a place the customer actually lives in.
 *
 * ── THE BUG THIS IS THE GUARD FOR ───────────────────────────────────────────
 *
 * A city corporation REPLACES the sadar upazila rather than sitting inside it,
 * so the upstream upazila table has no row for Rajshahi, Chattogram or Khulna
 * city — only their rural upazilas. Reported from Rajshahi: pick the district
 * and the options are Bagha, Bagmara, Charghat … none of which is the city.
 * There was nothing to select, so the order could not be placed at the right
 * charge, or at all.
 *
 * Dhaka had already been given this level upstream (`dhakaAreas`). The other
 * three had not. `src/data/bdCityAreas.json` is that fill, and these tests are
 * what stop a future dataset refresh from quietly dropping it again — the
 * failure mode is invisible from the server's side: no error, no log, just a
 * dropdown that does not contain the customer's home.
 */

const {
  DISTRICTS,
  findDistrict,
  findSubdistrict,
  subdistrictsOf,
  resolveAddress,
  fullTree,
} = require('../utils/bdGeo.util');

describe('city corporations are selectable', () => {
  /**
   * REGRESSION — the reported one, named as reported. Fails against the old
   * data: Rajshahi's sub-district list held only the nine rural upazilas.
   */
  it('Rajshahi city resolves — Boalia is a real answer, in either language', () => {
    const byEnglish = resolveAddress({ district: 'Rajshahi', subdistrict: 'Boalia' });
    expect(byEnglish.ok).toBe(true);
    expect(byEnglish.subdistrict.name).toBe('Boalia');
    expect(byEnglish.subdistrict.kind).toBe('area');

    expect(resolveAddress({ district: 'রাজশাহী', subdistrict: 'বোয়ালিয়া' }).ok).toBe(true);
  });

  it.each([
    ['Rajshahi', ['Boalia', 'Rajpara', 'Motihar', 'Shah Makhdum']],
    ['Chattogram', ['Kotwali', 'Panchlaish', 'Halishahar', 'Patenga']],
    ['Khulna', ['Sonadanga', 'Khalishpur', 'Daulatpur']],
  ])('%s city thanas are all selectable', (district, thanas) => {
    const d = findDistrict(district);
    for (const thana of thanas) {
      expect(findSubdistrict(d, thana)).not.toBeNull();
    }
  });

  /**
   * The invariant, stated over the whole country rather than the three we
   * happened to notice. A district with nothing to select is a district whose
   * customers cannot check out.
   */
  it('no district anywhere is left with an empty picker', () => {
    const empty = DISTRICTS.filter((d) => subdistrictsOf(d).length === 0);
    expect(empty.map((d) => d.name)).toEqual([]);
  });

  it('every district offers something inside its own town, not only its outskirts', () => {
    // Each of the four city-corporation districts must carry `kind: 'area'`
    // rows — the level the upazila table structurally cannot hold.
    for (const name of ['Dhaka', 'Rajshahi', 'Chattogram', 'Khulna']) {
      const areas = subdistrictsOf(findDistrict(name)).filter((s) => s.kind === 'area');
      expect(areas.length).toBeGreaterThan(0);
    }
  });
});

describe('the curated rows stay subordinate to the upstream', () => {
  it('never shadows an upazila of the same name in the same district', () => {
    for (const d of DISTRICTS) {
      const seen = new Set();
      for (const sub of subdistrictsOf(d)) {
        const key = sub.name.toLowerCase();
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it('points every curated row at a district that exists', () => {
    const ids = new Set(DISTRICTS.map((d) => d.id));
    for (const a of fullTree().cityAreas) {
      expect(ids.has(a.districtId)).toBe(true);
    }
  });

  it('carries a Bangla name on every row — a Bangla checkout must not show English', () => {
    for (const a of fullTree().cityAreas) {
      expect(typeof a.bn === 'string' && a.bn.length > 0).toBe(true);
    }
  });
});

describe('fullTree — what the browser is served', () => {
  /**
   * `dhakaAreas` is kept beside `cityAreas` on purpose: a browser holding the
   * previous cached file and one fetching the new must both render a working
   * picker. Removing it is a silent break for exactly as long as the old file
   * lives in someone's cache.
   */
  it('serves cityAreas as a superset of dhakaAreas, and keeps both', () => {
    const tree = fullTree();
    expect(tree.dhakaAreas.length).toBeGreaterThan(0);
    expect(tree.cityAreas.length).toBeGreaterThan(tree.dhakaAreas.length);

    const cityKeys = new Set(tree.cityAreas.map((a) => `${a.districtId}|${a.name}`));
    for (const a of tree.dhakaAreas) {
      expect(cityKeys.has(`${a.districtId}|${a.name}`)).toBe(true);
    }
  });
});
