/**
 * Move one shop's storefront to a new public address.
 *
 *   node scripts/rename-shop-slug.js --phone 01741203293 --to student-hub
 *   node scripts/rename-shop-slug.js --phone 01741203293 --to student-hub --apply
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SCRIPT EXISTS WHEN THE ADMIN PANEL CAN ALSO DO THIS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The panel is the way to do it from now on. This exists for the FIRST one —
 * the shop that asked before the panel shipped — and for the case the panel is
 * bad at: a rename that has to be timed against a deploy, where the operator
 * wants to see exactly what will change before anything does.
 *
 * ── RUN IT AFTER THE BACKEND IS RELOADED, NOT BEFORE ────────────────────────
 *
 * The old address only keeps working because `resolveStorefront` queries
 * `previousSlugs`, and that code has to be LIVE first. Rename before the pm2
 * reload and there is a window where every link the shop has ever shared 404s.
 * The script refuses to guess whether that has happened, so the ordering is
 * yours to get right:
 *
 *     1. deploy + pm2 reload          (alias resolution goes live)
 *     2. npm run sync-indexes:apply   (index on previousSlugs)
 *     3. this script --apply
 *
 * ── It goes through the service, not a raw $set ─────────────────────────────
 *
 * Same code path as the admin panel, so the rename gets the same uniqueness
 * check, the same audit row and the same two cache invalidations. A hand-rolled
 * `updateOne` here would skip all three and leave the shop's own /online panel
 * printing the old URL until its sessions expired.
 */

require('dotenv').config();
const mongoose = require('mongoose');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  const phone = arg('phone');
  const to = arg('to');
  const apply = process.argv.includes('--apply');

  if (!phone || !to) {
    console.error('Usage: node scripts/rename-shop-slug.js --phone <owner phone> --to <slug> [--apply]');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const Shop = require('../src/models/Shop.model');
  const User = require('../src/models/User.model');
  const Admin = require('../src/models/Admin.model');
  const { validateSlug } = require('../src/utils/shopSlug.util');

  // The owner's phone is what a support conversation actually carries; a shop
  // id is something someone has to look up first and can transcribe wrong.
  const owner = await User.findOne({ phone }).select('name phone shop').lean();
  if (!owner?.shop) {
    console.error(`No user with phone ${phone}, or that user has no shop.`);
    process.exit(1);
  }

  const shop = await Shop.findById(owner.shop).select('name slug previousSlugs').lean();
  const check = validateSlug(to);

  console.log(`Owner : ${owner.name} (${owner.phone})`);
  console.log(`Shop  : ${shop.name}`);
  console.log(`From  : /s/${shop.slug}`);
  console.log(`To    : /s/${check.slug}${check.valid ? '' : `  ← REJECTED: ${check.reason}`}`);
  console.log(`Kept  : ${[...(shop.previousSlugs || []), shop.slug].map((s) => `/s/${s}`).join(', ')}`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply once the backend reload is done.');
    await mongoose.connection.close();
    return;
  }

  // Attributed to a real admin so the audit row names someone. Any admin will
  // do — the row is about WHAT changed and when; who ran the script is in the
  // shell history either way.
  const admin = await Admin.findOne({}).select('_id name').lean();
  if (!admin) {
    console.error('No admin account exists to attribute the change to.');
    process.exit(1);
  }

  const service = require('../src/services/adminStorefront.service');
  const res = await service.setShopSlug(String(shop._id), admin._id, to);

  console.log(res.changed
    ? `\nDone. Live at /s/${res.slug}; still answering on ${res.previousSlugs.map((s) => `/s/${s}`).join(', ')}.`
    : '\nNo change — the shop already had that address.');

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
