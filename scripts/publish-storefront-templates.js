#!/usr/bin/env node
/**
 * Publish the seeded storefront templates.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS THE SECOND HALF OF "ALL TEMPLATES ON BY DEFAULT"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Shop.storefront.allowedTemplates` is now a RESTRICTION, and an empty one
 * means the shop may pick any template — so no shop needs granting any more
 * (`utils/storefrontTemplates.util`).
 *
 * But "any template" means any **published** one, and
 * `seed-storefront-templates.js` deliberately inserts every template as
 * `draft`. That is correct on its own terms: a draft is unfinished, and a
 * gallery tile with no thumbnail is a template nobody picks. It does mean that
 * a platform which has seeded but never published still shows every shop an
 * empty picker — the same symptom the grant change just fixed, from a different
 * cause.
 *
 * This script closes that gap in one command instead of five trips through the
 * admin UI.
 *
 * ── IT ENFORCES THE SAME GATE THE ADMIN ROUTE DOES ──────────────────────────
 *
 * `adminStorefront.publishTemplate` refuses a template with no thumbnail. This
 * refuses it too by default, and says which — rather than publishing a bare
 * tile because it happened to be running as a script instead of as a click. A
 * silent bypass would make the UI's rule a suggestion.
 *
 * ── THE OVERRIDE, AND WHY IT IS A SEPARATE FLAG ─────────────────────────────
 *
 * `--allow-missing-thumbnail` publishes anyway. It exists because the gate is a
 * QUALITY rule and not a technical one: the shop's gallery already falls back
 * to a palette icon when `thumbnail` is empty, so a template without one
 * renders as a plain named tile rather than a broken image.
 *
 * The trade is real and belongs to whoever runs this, which is why it is a flag
 * and not the default: a shopkeeper picking from named tiles is choosing a
 * design they cannot see. Used on 2026-09-08 to open poshak / jontro / oushodh
 * / khabar before their preview images existed, on the owner's explicit call.
 *
 * The admin route keeps its gate. Relaxing that one too would mean nobody is
 * ever again told that a template is unfinished.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/publish-storefront-templates.js            # report only
 *   node scripts/publish-storefront-templates.js --apply    # publish
 *   node scripts/publish-storefront-templates.js --apply --allow-missing-thumbnail
 *
 * Idempotent: an already-published template is left exactly as it is, including
 * its original `publishedAt`. Retired templates are NOT resurrected — retiring
 * one is a deliberate act and un-retiring it should be too.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const StorefrontTemplate = require('../src/models/StorefrontTemplate.model');

const apply = process.argv.includes('--apply');
const allowNoThumb = process.argv.includes('--allow-missing-thumbnail');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);

  const templates = await StorefrontTemplate.find({}).sort({ sortOrder: 1, key: 1 });

  if (!templates.length) {
    console.log('No templates at all — run `node scripts/seed-storefront-templates.js --apply` first.');
    await mongoose.disconnect();
    return;
  }

  const published = [];
  const publishable = [];
  const blocked = [];
  const retired = [];
  /** Published despite having no preview image — reported loudly at the end. */
  const noThumb = [];

  for (const t of templates) {
    if (t.status === 'published') { published.push(t); continue; }
    if (t.status === 'retired') { retired.push(t); continue; }
    if (!t.thumbnail && !allowNoThumb) { blocked.push(t); continue; }
    if (!t.thumbnail) noThumb.push(t.key);
    publishable.push(t);
  }

  for (const t of published) console.log(`  ok       ${t.key} — already published`);
  for (const t of retired) console.log(`  skip     ${t.key} — retired, left alone`);
  for (const t of blocked) console.log(`  BLOCKED  ${t.key} — no thumbnail`);
  for (const t of publishable) {
    const warn = t.thumbnail ? '' : '   ← no preview image';
    console.log(`  ${apply ? 'publish ' : 'would   '} ${t.key} — "${t.nameBn || t.name}"${warn}`);
  }

  if (apply && publishable.length) {
    for (const t of publishable) {
      t.status = 'published';
      t.publishedAt = t.publishedAt || new Date();
      t.retiredAt = null;
      await t.save();
    }
  }

  const liveAfter = published.length + (apply ? publishable.length : 0);
  console.log(`\ntemplates    : ${templates.length}`);
  console.log(`published    : ${liveAfter}${apply ? '' : ` (would be ${published.length + publishable.length})`}`);
  console.log(`blocked      : ${blocked.length}`);

  if (blocked.length) {
    console.log('\nAdd a thumbnail to these in অ্যাডমিন → স্টোরফ্রন্ট → টেমপ্লেট, then re-run:');
    for (const t of blocked) console.log(`  · ${t.key}`);
  }

  if (liveAfter === 0) {
    console.log('\nWARNING: no published templates. Every shop\'s picker will be empty,');
    console.log('however their grants are set.');
  } else {
    console.log(`\nEvery shop with the storefront feature and no explicit restriction`);
    console.log(`can now choose from ${liveAfter} template(s).`);
  }

  if (noThumb.length) {
    console.log(`\n${noThumb.length} template(s) ${apply ? 'published' : 'would publish'} WITHOUT a preview image:`);
    console.log(`  ${noThumb.join(', ')}`);
    console.log('Shops choose these by name until a thumbnail is added in');
    console.log('অ্যাডমিন → স্টোরফ্রন্ট → টেমপ্লেট. Adding one later needs no re-publish.');
  }

  if (!apply) console.log('\nDry run — nothing written. Re-run with --apply.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(`\npublish-storefront-templates failed: ${err.message}`);
  process.exitCode = 1;
  mongoose.disconnect().catch(() => {});
});
