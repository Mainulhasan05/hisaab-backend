/**
 * Rewrite stored image URLs after a bucket's public hostname changes.
 *
 *   node scripts/rewrite-media-urls.js                    # dry-run, every account
 *   node scripts/rewrite-media-urls.js --account <id>     # dry-run, one account
 *   node scripts/rewrite-media-urls.js --apply            # do it
 *
 * ── WHY THIS EXISTS ON DAY ONE ───────────────────────────────────────────────
 * We launched on `https://pub-<hash>.r2.dev` URLs because a custom domain was
 * deferred. Cloudflare is explicit that r2.dev is rate-limited and not for
 * production, so moving to `cdn1.hisaab.app` is a matter of when, not if. That
 * move touches four places, because image URLs are denormalised for the product
 * list's sake:
 *
 *   ShopMedia.url / thumbUrl / mediumUrl
 *   Product.catalogImages[].url / .thumbnail   (rows with a mediaId)
 *   Product.variants[].image                   (rows with an imageMediaId)
 *   Category.image                             (rows with an imageMediaId)
 *
 * Rows WITHOUT a media id are left strictly alone. Those are the original
 * ImgBB-hosted images: not our bytes, not our hostname, not ours to rewrite.
 *
 * Writing this script only when the domain is finally bought is how a two-hour
 * job becomes a bad afternoon. It ships with the storage layer and is exercised
 * in dry-run mode from the start, so the day it matters it is already known to
 * work.
 *
 * ── HOW IT WORKS ─────────────────────────────────────────────────────────────
 * URLs are never parsed or string-replaced. Every one is REBUILT from
 * `account.publicBaseUrl + objectKey`, which is precisely why those two fields
 * are stored separately. So the correct order of operations is:
 *
 *   1. point the bucket at the new domain in Cloudflare
 *   2. edit publicBaseUrl on the account in the admin panel
 *   3. run this with --apply
 *
 * Idempotent: a second run reports zero changes. Safe to re-run after a partial
 * failure.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
};

async function main() {
  const apply = process.argv.includes('--apply');
  const onlyAccount = argOf('--account');

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
  });

  require('../src/models');
  const R2Account = mongoose.model('R2Account');
  const ShopMedia = mongoose.model('ShopMedia');
  const Product = mongoose.model('Product');
  const Category = mongoose.model('Category');

  console.log(`Connected to ${mongoose.connection.host} (${apply ? 'APPLY' : 'DRY-RUN'})`);

  const accountFilter = onlyAccount ? { _id: onlyAccount } : {};
  const accounts = await R2Account.find(accountFilter).select('_id name publicBaseUrl').lean();

  if (accounts.length === 0) {
    console.log('No storage accounts found — nothing to do.');
    return;
  }

  const base = new Map(accounts.map((a) => [String(a._id), String(a.publicBaseUrl).replace(/\/+$/, '')]));
  const join = (accountId, key) => {
    const prefix = base.get(String(accountId));
    if (!prefix || !key) return null;
    return `${prefix}/${String(key).replace(/^\/+/, '')}`;
  };

  const stats = { media: 0, products: 0, categories: 0, skipped: 0 };
  const samples = [];

  // ── 1. ShopMedia — the source of truth every other row is copied from ──────
  const mediaCursor = ShopMedia.find(
    onlyAccount ? { account: onlyAccount } : {}
  ).select('_id account objectKey thumbKey mediumKey url thumbUrl mediumUrl').cursor();

  // mediaId -> the URLs a product row SHOULD now carry
  const desired = new Map();

  for await (const media of mediaCursor) {
    const next = {
      url: join(media.account, media.objectKey),
      thumbUrl: join(media.account, media.thumbKey),
      mediumUrl: join(media.account, media.mediumKey),
    };

    if (!next.url) {
      // An account row we could not resolve. Leaving the old URL in place is
      // strictly better than writing a null over a working link.
      stats.skipped += 1;
      continue;
    }

    desired.set(String(media._id), next);

    const changed =
      media.url !== next.url ||
      (media.thumbKey && media.thumbUrl !== next.thumbUrl) ||
      (media.mediumKey && media.mediumUrl !== next.mediumUrl);

    if (!changed) continue;

    if (samples.length < 5) samples.push({ from: media.url, to: next.url });
    stats.media += 1;

    if (apply) {
      await ShopMedia.updateOne({ _id: media._id }, {
        $set: {
          url: next.url,
          ...(media.thumbKey ? { thumbUrl: next.thumbUrl } : {}),
          ...(media.mediumKey ? { mediumUrl: next.mediumUrl } : {}),
        },
      });
    }
  }

  // ── 2. Product.catalogImages[] and variants[].image ───────────────────────
  // Only documents carrying at least one of OUR media ids. An ImgBB-only
  // product never matches this filter and is never rewritten.
  const productCursor = Product.find({
    $or: [
      { 'catalogImages.mediaId': { $ne: null } },
      { 'variants.imageMediaId': { $ne: null } },
    ],
  }).select('_id catalogImages variants').cursor();

  for await (const product of productCursor) {
    let touched = false;

    for (const img of product.catalogImages || []) {
      const next = desired.get(String(img?.mediaId));
      if (!next) continue;                       // no mediaId → foreign image
      if (img.url !== next.url || img.thumbnail !== next.thumbUrl) {
        img.url = next.url;
        img.thumbnail = next.thumbUrl;
        touched = true;
      }
    }

    for (const variant of product.variants || []) {
      const next = desired.get(String(variant?.imageMediaId));
      if (!next) continue;
      if (variant.image !== next.url) {
        variant.image = next.url;
        touched = true;
      }
    }

    if (!touched) continue;
    stats.products += 1;
    if (apply) {
      await Product.updateOne(
        { _id: product._id },
        { $set: { catalogImages: product.catalogImages, variants: product.variants } }
      );
    }
  }

  // ── 3. Category.image ─────────────────────────────────────────────────────
  const categoryCursor = Category.find({ imageMediaId: { $ne: null } })
    .select('_id image imageMediaId').cursor();

  for await (const category of categoryCursor) {
    const next = desired.get(String(category.imageMediaId));
    if (!next || category.image === next.url) continue;

    stats.categories += 1;
    if (apply) {
      await Category.updateOne({ _id: category._id }, { $set: { image: next.url } });
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`Accounts in scope : ${accounts.map((a) => a.name).join(', ')}`);
  console.log(`ShopMedia rows    : ${stats.media}`);
  console.log(`Products          : ${stats.products}`);
  console.log(`Categories        : ${stats.categories}`);
  if (stats.skipped) console.log(`Skipped (no base) : ${stats.skipped}`);

  if (samples.length) {
    console.log('\nSample rewrites:');
    samples.forEach((s) => console.log(`  ${s.from}\n  → ${s.to}\n`));
  }

  const total = stats.media + stats.products + stats.categories;
  if (total === 0) {
    console.log('\nEverything already matches the current publicBaseUrl values.');
  } else if (!apply) {
    console.log(`\nDRY-RUN — nothing written. Re-run with --apply to update ${total} document(s).`);
  } else {
    console.log(`\nDone. ${total} document(s) updated.`);
  }
}

main()
  .catch((err) => {
    console.error('rewrite-media-urls failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
