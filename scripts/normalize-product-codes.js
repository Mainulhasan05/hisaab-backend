/**
 * Romanise product codes, barcodes and variant SKUs that were stored in Bengali.
 *
 *   node scripts/normalize-product-codes.js                  # dry-run, all shops
 *   node scripts/normalize-product-codes.js --shop <id>      # dry-run, one shop
 *   node scripts/normalize-product-codes.js --shop <id> --apply
 *   node scripts/normalize-product-codes.js --apply          # all shops, writes
 *
 * WHY
 * ---
 * The product form built codes as `category.name.slice(0, 3)`, and every
 * category in this app is named in Bengali, so it produced codes like
 * `কলম0042`. CODE128 encodes ASCII 0–127 and nothing else: the label sheet
 * printed the code as text and drew no bars at all. Nobody inspects a label for
 * bars — they print forty, stick them on forty boxes, and find out at the
 * counter that the scanner is silent on every one.
 *
 * The form no longer does this (`hisaab-frontend/lib/productCode.js`) and the
 * model now refuses it (`Product.model.js`). This script is for the rows
 * written before either landed.
 *
 * WHAT IT DOES TO A CODE
 * ----------------------
 * Romanises rather than strips: `কলম0042` becomes `KLM0042`, not `0042`. The
 * digits are the part a shopkeeper may already have written on a shelf tag or
 * read out over the phone, so they survive, and the prefix stays recognisable
 * instead of collapsing to a number that could collide with anything.
 *
 * DETERMINISTIC ON PURPOSE
 * ------------------------
 * The fallback for a code that romanises to nothing is derived from the
 * document `_id`, not from `Math.random()`. A dry-run that printed one code and
 * an `--apply` that wrote a different one would make the preview worthless —
 * and the preview is the only thing standing between you and renaming every
 * product in a shop.
 *
 * COLLISIONS
 * ----------
 * `code` is unique per {shop, branch}. Two Bengali codes can romanise onto the
 * same string, and a romanised code can land on one that already exists. Both
 * are resolved by appending `-2`, `-3`, … and both are reported. `barcode` and
 * `variants.sku` carry no uniqueness constraint and are converted in place.
 *
 * WHAT THIS CHANGES THAT YOU SHOULD KNOW ABOUT
 * --------------------------------------------
 * A product's code is its human-facing identity: it appears on labels already
 * printed, in exports, and in whatever the shopkeeper wrote in a ledger. This
 * rewrites it. The labels it invalidates are labels that never had bars on them
 * in the first place, which is the whole reason for the change — but read the
 * dry-run for a shop before applying it to that shop, rather than running the
 * whole estate in one go.
 *
 * Stock, sales history and every reference by ObjectId are untouched: nothing
 * in the schema joins on `code`. The one place it is used as a match key is
 * stock transfers between branches, which fall back to `clonedFrom` lineage —
 * so a renamed product still matches its sibling.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { isValidProductCode, romaniseExistingCode } = require('../src/utils/productCode.util');

const APPLY = process.argv.includes('--apply');
const shopArgIdx = process.argv.indexOf('--shop');
const SHOP_ARG = shopArgIdx !== -1 ? process.argv[shopArgIdx + 1] : null;

/** True for a value that needs converting — present, a string, and not ASCII. */
const needsWork = (v) => typeof v === 'string' && v.trim() !== '' && !isValidProductCode(v.trim());

/**
 * Four digits derived from the document id, so the same product always gets the
 * same fallback code. See DETERMINISTIC ON PURPOSE above.
 */
const idDigits = (id) => {
  const hex = String(id).slice(-5);
  return String(parseInt(hex, 16) % 10000).padStart(4, '0');
};

const fallbackCode = (id) => `PRD${idDigits(id)}`;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
  });

  const db = mongoose.connection.db;
  console.log(`Connected to ${mongoose.connection.host}/${db.databaseName} (${APPLY ? 'APPLY' : 'DRY-RUN'})\n`);

  const filter = {};
  if (SHOP_ARG) filter.shop = new mongoose.Types.ObjectId(SHOP_ARG);

  const products = await db
    .collection('products')
    .find(filter)
    .project({ shop: 1, branch: 1, code: 1, barcode: 1, name: 1, variants: 1 })
    .toArray();

  console.log(`Scanned ${products.length} product(s).\n`);

  /* Every code already in use, per {shop, branch}, so a romanised code cannot
     be dropped on top of a product that is not being touched. Seeded with the
     current state and updated as codes are assigned, which is also what makes
     two products romanising onto the same string resolve against each other. */
  const taken = new Map();
  const scopeKey = (p) => `${p.shop}|${p.branch || 'null'}`;
  for (const p of products) {
    const key = scopeKey(p);
    if (!taken.has(key)) taken.set(key, new Set());
    if (typeof p.code === 'string') taken.get(key).add(p.code.toUpperCase());
  }

  const claim = (product, desired) => {
    const used = taken.get(scopeKey(product));
    used.delete(String(product.code || '').toUpperCase()); // the old one is being freed
    let candidate = desired;
    let n = 1;
    while (used.has(candidate)) {
      n += 1;
      candidate = `${desired}-${n}`;
    }
    used.add(candidate);
    return { code: candidate, collided: n > 1 };
  };

  const updates = [];
  let codeCount = 0;
  let barcodeCount = 0;
  let skuCount = 0;
  let collisions = 0;
  let emptied = 0;

  for (const product of products) {
    const set = {};

    if (needsWork(product.code)) {
      const romanised = romaniseExistingCode(product.code);
      let desired = romanised;
      if (!desired) {
        desired = fallbackCode(product._id);
        emptied += 1;
      }
      const { code, collided } = claim(product, desired);
      if (collided) collisions += 1;
      set.code = code;
      codeCount += 1;
      console.log(
        `  code    ${String(product.code).padEnd(16)} -> ${code.padEnd(16)}` +
        `${collided ? ' (collision resolved)' : ''}  ${product.name || ''}`
      );
    }

    if (needsWork(product.barcode)) {
      const romanised = romaniseExistingCode(product.barcode);
      if (romanised) {
        set.barcode = romanised;
        barcodeCount += 1;
        console.log(`  barcode ${String(product.barcode).padEnd(16)} -> ${romanised}`);
      } else {
        /* A barcode that romanises to nothing was never a barcode. Clearing it
           is honest — an unscannable string in this field is worse than an
           empty one, because the label falls back to `code`, which is now
           valid. */
        set.barcode = '';
        barcodeCount += 1;
        console.log(`  barcode ${String(product.barcode).padEnd(16)} -> (cleared, nothing encodable)`);
      }
    }

    if (Array.isArray(product.variants)) {
      product.variants.forEach((variant, i) => {
        if (!needsWork(variant?.sku)) return;
        const romanised = romaniseExistingCode(variant.sku) || `${fallbackCode(product._id)}-V${i + 1}`;
        set[`variants.${i}.sku`] = romanised;
        skuCount += 1;
        console.log(`  sku     ${String(variant.sku).padEnd(16)} -> ${romanised}`);
      });
    }

    if (Object.keys(set).length > 0) {
      updates.push({ updateOne: { filter: { _id: product._id }, update: { $set: set } } });
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Products needing changes: ${updates.length}`);
  console.log(`  codes:    ${codeCount}${collisions ? ` (${collisions} collision(s) resolved)` : ''}`);
  console.log(`  barcodes: ${barcodeCount}`);
  console.log(`  variant SKUs: ${skuCount}`);
  if (emptied) console.log(`  ${emptied} code(s) romanised to nothing and got an id-derived PRD code`);

  if (updates.length === 0) {
    console.log('\nEverything is already ASCII. Nothing to do.');
    await mongoose.connection.close();
    return;
  }

  if (!APPLY) {
    console.log('\nDRY-RUN — nothing written. Re-run with --apply.');
    await mongoose.connection.close();
    return;
  }

  const res = await db.collection('products').bulkWrite(updates, { ordered: false });
  console.log(`\nWritten: ${res.modifiedCount} product document(s).`);

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
