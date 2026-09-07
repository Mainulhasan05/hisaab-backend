#!/usr/bin/env node
/**
 * Backfill the delivery zone → place mapping on existing storefronts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS MUST RUN BEFORE THE DEPLOY, NOT AFTER
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `order.service.resolveDelivery` no longer takes a zone from the browser. It
 * derives the zone from the customer's district, using `zones[].districts` and
 * `zones[].areas` — two fields that do not exist on any storefront created
 * before this change.
 *
 * A shop with no mapping still takes orders (everything falls through to
 * `defaultZoneKey`), but every one of them is charged the fallback rate. For
 * the seeded two-zone shop that means EVERY Dhaka order is billed ৳১২০ instead
 * of ৳৬০ — an overcharge on the shop's busiest route, visible only as
 * customers complaining that delivery got expensive.
 *
 * So this is not optional cleanup. Order of operations on deploy:
 *
 *     node scripts/backfill-delivery-zone-map.js --apply
 *     pm2 reload <app>
 *
 * Same shape as the other migrations here: dry run by default, `--apply` to
 * write, idempotent, and it never overwrites a mapping a shop has already set.
 *
 * ── WHAT IT CAN AND CANNOT INFER ────────────────────────────────────────────
 *
 * It recognises the two SEEDED zones by key — `inside-dhaka` and
 * `outside-dhaka` — because those it can map with confidence. A shop that has
 * added "চট্টগ্রাম শহর ৳৮০" gets nothing for that zone, and that is deliberate:
 * guessing which districts a shop meant by a name it typed itself would be
 * inventing prices. Those zones are REPORTED at the end so somebody can tell
 * the shop to finish the mapping, and until they do those addresses land on
 * the default zone — the same behaviour as before this change, not worse.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Storefront = require('../src/models/Storefront.model');
// Registered because this script populates `shop` — Mongoose resolves a ref by
// model NAME at populate time, and a model nobody required is a model nobody
// registered.
require('../src/models/Shop.model');
const { DHAKA_CITY_AREA_NAMES } = require('../src/utils/bdGeo.util');

const apply = process.argv.includes('--apply');

/**
 * The seeded zones, and what each covers.
 *
 * `inside-dhaka` gets the CITY AREAS only. Dhaka district's rural upazilas
 * (Savar, Dhamrai, Keraniganj, Dohar, Nawabganj) are deliberately absent —
 * virtually every shop prices those as outside Dhaka, and seeding them into
 * the ৳৬০ zone would silently undercharge every one of those parcels.
 */
const SEEDED = {
  'inside-dhaka': { areas: DHAKA_CITY_AREA_NAMES, districts: [] },
};

/** Preferred fallback, in order: the seeded outside zone, else the dearest. */
function pickDefaultZone(zones) {
  const outside = zones.find((z) => z.key === 'outside-dhaka' && z.isActive !== false);
  if (outside) return outside.key;
  // The most expensive active zone. If the fallback is going to be wrong, it
  // should be wrong in the direction a shop can refund rather than absorb.
  const active = zones.filter((z) => z.isActive !== false);
  if (!active.length) return null;
  return active.reduce((a, b) => ((Number(b.charge) || 0) > (Number(a.charge) || 0) ? b : a)).key;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);

  const storefronts = await Storefront.find({}).select('shop delivery').populate('shop', 'name');

  let mapped = 0;
  let defaulted = 0;
  let skipped = 0;
  const unmappedZones = [];

  for (const sf of storefronts) {
    const shopName = sf.shop?.name || String(sf.shop);
    const zones = sf.delivery?.zones || [];
    if (!zones.length) { skipped += 1; continue; }

    let touched = false;

    // Resolved before the loop: the fallback zone is the one place an address
    // is SUPPOSED to land without matching a district, so reporting it as
    // "could not be inferred" would send somebody to fix a thing that is
    // already correct.
    const fallbackKey = sf.delivery?.defaultZoneKey || pickDefaultZone(zones);

    for (const zone of zones) {
      const seed = SEEDED[zone.key];
      const hasMapping = (zone.districts?.length || 0) > 0 || (zone.areas?.length || 0) > 0;

      if (hasMapping) continue;              // the shop already decided — never overwrite
      if (!seed) {
        if (zone.key !== fallbackKey) {
          unmappedZones.push(`${shopName}: "${zone.nameBn || zone.name}" (${zone.key})`);
        }
        continue;
      }
      zone.areas = [...seed.areas];
      zone.districts = [...seed.districts];
      touched = true;
      mapped += 1;
    }

    if (!sf.delivery.defaultZoneKey) {
      const key = pickDefaultZone(zones);
      if (key) {
        sf.delivery.defaultZoneKey = key;
        touched = true;
        defaulted += 1;
      }
    }

    if (touched) {
      console.log(`${apply ? 'update' : 'would update'}  ${shopName}  → default "${sf.delivery.defaultZoneKey}"`);
      if (apply) await sf.save();
    } else {
      skipped += 1;
    }
  }

  console.log(`\nstorefronts   : ${storefronts.length}`);
  console.log(`zones mapped  : ${mapped}`);
  console.log(`defaults set  : ${defaulted}`);
  console.log(`unchanged     : ${skipped}`);

  if (unmappedZones.length) {
    console.log(`\n${unmappedZones.length} custom zone(s) could not be inferred — these fall back to the`);
    console.log('default zone until the shop maps them in অনলাইন → সেটিংস:');
    for (const z of unmappedZones) console.log(`  · ${z}`);
  }

  if (!apply) console.log('\nDry run — nothing written. Re-run with --apply.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(`\nbackfill failed: ${err.message}`);
  process.exitCode = 1;
  mongoose.disconnect().catch(() => {});
});
