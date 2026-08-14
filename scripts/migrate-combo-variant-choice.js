/**
 * Open existing combo components up to "any variant, chosen at the till".
 *
 *   node scripts/migrate-combo-variant-choice.js                 # dry-run, all shops
 *   node scripts/migrate-combo-variant-choice.js --shop <id>     # dry-run, one shop
 *   node scripts/migrate-combo-variant-choice.js --apply
 *
 * WHY THIS IS NEEDED
 * ------------------
 * Until now a combo component HAD to name one variant when the combo was
 * built. A shirt sold in six colours therefore needed six combo products —
 * which is the bug, not a feature: the customer picks a colour at the counter,
 * and no shopkeeper can make that choice in advance.
 *
 * Components now carry `variantMode`:
 *
 *   'fixed'  — variantId names one variant; the till cannot substitute
 *   'choose' — every active variant is eligible; the cashier picks at billing
 *
 * The schema defaults to 'fixed' so a payload that omits the field keeps the
 * variant it named. This script converts the STORED rows, which were all
 * written under the old constraint.
 *
 * WHAT IT CONVERTS
 * ----------------
 * A `comboItems` row where `variantId` is set AND the component product still
 * `hasVariants`:
 *
 *     { variantId: <id>, variantMode: 'fixed' } -> { variantId: null, variantMode: 'choose' }
 *
 * WHAT IT LEAVES ALONE, AND REPORTS INSTEAD
 * -----------------------------------------
 *  - Rows with no `variantId`. Already product-level; there is nothing to widen.
 *  - Rows whose component no longer `hasVariants` — the variant was removed
 *    after the combo was built. Converting these would aim a slot at an empty
 *    variant pool, turning a combo that is merely BROKEN into one that is
 *    broken AND silently unsellable. They are listed for a human.
 *  - Rows already on 'choose'. Idempotent: a second run is a no-op.
 *
 * Two rows of one product pinned to different variants ("1 blue + 1 red")
 * become two identical 'choose' slots. That is exactly the slot model — each
 * gets its own pick at the till — and needs no dedupe.
 *
 * WHAT IT CANNOT FIX, AND SO MUST REPORT LOUDLY
 * ---------------------------------------------
 * The workaround this change exists to kill is SIX SEPARATE COMBO PRODUCTS,
 * one per variant. Converting each one's component leaves six now-identical
 * combos in the catalogue. This script must not merge or delete them: each is
 * its own Product with its own code, barcode and sale history, and
 * `Sale.items.product` points at them. So it groups combos within a shop by
 * their resulting component set and prints the collisions, leaving the owner
 * to deactivate the extras from the products screen.
 *
 * THE COST OF RUNNING THIS
 * ------------------------
 * A combo that genuinely meant one variant ("Eid Pack = shampoo 400ml") is
 * opened up too — this script cannot read intent, and every stored row looks
 * the same. Until someone re-pins it from the edit screen, the till will sell
 * the 200ml at the 400ml's price. The dry-run list below IS the list to review.
 *
 * Reversible only from a backup (`scripts/backup-db.js`) — the old variantId is
 * what gets nulled and no shadow copy is kept, because a half-remembered
 * "previous variant" on a live combo is worse than a clean restore.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const shopArgIdx = process.argv.indexOf('--shop');
const SHOP_ARG = shopArgIdx !== -1 ? process.argv[shopArgIdx + 1] : null;

/** The component set a combo resolves to AFTER conversion, as a stable string. */
function componentSignature(comboItems, willConvert) {
  return (comboItems || [])
    .map((ci, idx) => {
      const opened = willConvert.has(idx);
      const mode = opened || ci.variantMode === 'choose' ? 'choose' : 'fixed';
      const variant = mode === 'choose' ? '*' : String(ci.variantId || '');
      return `${String(ci.product)}:${variant}:${ci.quantity}`;
    })
    .sort()
    .join('|');
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 20000,
  });

  const db = mongoose.connection.db;
  const mode = APPLY ? 'APPLY' : 'DRY-RUN';
  console.log(`Connected to ${mongoose.connection.host}/${db.databaseName} (${mode})\n`);

  const match = { type: 'combo' };
  if (SHOP_ARG) match.shop = new mongoose.Types.ObjectId(SHOP_ARG);

  const combos = await db.collection('products')
    .find(match, { projection: { name: 1, code: 1, shop: 1, comboItems: 1, isDeleted: 1, isActive: 1 } })
    .toArray();

  console.log(`${combos.length} combo product(s) found\n`);
  if (!combos.length) return;

  // One batched read for every component any combo references — the same union
  // the availability decorator takes, projected to what the decision needs.
  const componentIds = [...new Set(
    combos.flatMap((c) => (c.comboItems || []).map((ci) => String(ci.product)))
  )].map((s) => new mongoose.Types.ObjectId(s));

  const components = await db.collection('products')
    .find({ _id: { $in: componentIds } }, { projection: { name: 1, hasVariants: 1, variants: 1 } })
    .toArray();
  const compMap = new Map(components.map((c) => [String(c._id), c]));

  const converted = [];   // rows this run opens up
  const skippedNoVariants = [];
  const ops = [];

  for (const combo of combos) {
    const items = combo.comboItems || [];
    const willConvert = new Set();

    items.forEach((ci, idx) => {
      if (ci.variantMode === 'choose') return;      // already open — idempotent
      if (!ci.variantId) return;                    // product-level; nothing to widen

      const comp = compMap.get(String(ci.product));
      if (!comp || !comp.hasVariants || !(comp.variants || []).some((v) => v.isActive !== false)) {
        skippedNoVariants.push({
          combo: `${combo.code} — ${combo.name}`,
          component: comp?.name || String(ci.product),
          why: comp ? 'component has no active variant left' : 'component product missing',
        });
        return;
      }
      willConvert.add(idx);
      converted.push({
        combo: `${combo.code} — ${combo.name}`,
        component: comp.name,
        wasVariant: (comp.variants || []).find((v) => String(v._id) === String(ci.variantId))?.sku
          || String(ci.variantId),
        nowEligible: (comp.variants || []).filter((v) => v.isActive !== false).length,
      });
    });

    combo._signature = componentSignature(items, willConvert);

    if (!willConvert.size) continue;

    // Positional writes rather than replacing the array: a whole-array $set
    // would rewrite rows this run deliberately left alone, and any row a
    // future schema adds a field to would be silently truncated to what this
    // script happened to read.
    const update = { $set: {}, $unset: {} };
    for (const idx of willConvert) {
      update.$set[`comboItems.${idx}.variantMode`] = 'choose';
      update.$set[`comboItems.${idx}.variantId`] = null;
    }
    delete update.$unset;
    ops.push({ updateOne: { filter: { _id: combo._id }, update } });
  }

  // ── Report ────────────────────────────────────────────────────────────────

  console.log(`── Rows to open up: ${converted.length} ─────────────────────────`);
  for (const row of converted) {
    console.log(`  ${row.combo}`);
    console.log(`      ${row.component}: was pinned to "${row.wasVariant}" -> any of ${row.nowEligible} variants`);
  }
  if (!converted.length) console.log('  (none — nothing stored is still variant-bound)');

  if (skippedNoVariants.length) {
    console.log(`\n── Left alone, needs a human: ${skippedNoVariants.length} ─────────`);
    for (const row of skippedNoVariants) {
      console.log(`  ${row.combo}`);
      console.log(`      ${row.component}: ${row.why} — this combo is already broken; fix or retire it`);
    }
  }

  // Combos that end up identical — the six-combos-per-variant workaround.
  const bySignature = new Map();
  for (const combo of combos) {
    if (combo.isDeleted) continue;
    const key = `${String(combo.shop)}::${combo._signature}`;
    if (!bySignature.has(key)) bySignature.set(key, []);
    bySignature.get(key).push(combo);
  }
  const collisions = [...bySignature.values()].filter((group) => group.length > 1);

  if (collisions.length) {
    console.log(`\n── Now-identical combos: ${collisions.length} group(s) ───────────`);
    console.log('   These were the "one combo per variant" workaround. They are NOT merged or');
    console.log('   deleted here — each has its own code, barcode and sale history. Keep one and');
    console.log('   deactivate the rest from the products screen.\n');
    for (const group of collisions) {
      console.log(`  ${group.length} identical:`);
      for (const c of group) {
        console.log(`      ${c.code} — ${c.name}${c.isActive === false ? '  (already inactive)' : ''}`);
      }
    }
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(60)}`);
  if (!APPLY) {
    console.log(`DRY-RUN: ${ops.length} combo document(s) would be updated.`);
    console.log('Review the list above, then re-run with --apply.');
    console.log('Take a backup first: node scripts/backup-db.js');
    return;
  }

  if (!ops.length) {
    console.log('Nothing to write.');
    return;
  }

  const res = await db.collection('products').bulkWrite(ops, { ordered: false });
  console.log(`APPLIED: ${res.modifiedCount} combo document(s) updated.`);
  if (res.modifiedCount !== ops.length) {
    console.log(`WARNING: expected ${ops.length} — re-run the dry-run to see what is left.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
