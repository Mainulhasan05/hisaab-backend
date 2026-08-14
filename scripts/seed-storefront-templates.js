/**
 * Seed the storefront template catalogue.
 *
 *   node scripts/seed-storefront-templates.js           # dry-run
 *   node scripts/seed-storefront-templates.js --apply   # write
 *
 * Templates are platform-owned rows an admin grants to shops. Without at least
 * one, the grant checklist is empty and `features.storefront` has nothing to
 * hand over — so this runs once before the first shop is switched on.
 *
 * ── IDEMPOTENT, AND NON-DESTRUCTIVE ─────────────────────────────────────────
 *
 * Re-running never overwrites a template that already exists. `key` is the
 * identity and it is immutable once published — every grant and every live
 * storefront stores that string, so a script that rewrote rows in place could
 * silently change what a shop's website looks like. New keys are inserted;
 * existing keys are reported and left alone.
 *
 * ── THEY ARE SEEDED AS `draft`, NOT `published` ─────────────────────────────
 *
 * A template only becomes grantable once an admin publishes it, and publishing
 * requires a thumbnail (adminStorefront.service.publishTemplate). That gate is
 * deliberate: these rows carry no artwork yet, and a gallery tile with no image
 * is a template nobody picks. Upload thumbnails, then publish from the admin
 * panel.
 *
 * The renderers themselves live in the frontend, keyed by `key`. Seeding a row
 * whose React component does not exist yet is safe precisely because of the
 * draft gate — nothing can select it.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const StorefrontTemplate = require('../src/models/StorefrontTemplate.model');
const { SLOT_KEYS } = require('../src/models/StorefrontTemplate.model');

/**
 * The launch set, by vertical. See STOREFRONT_DESIGN_REF.md for the visual
 * brief behind each one, and ECOMMERCE_PLAN.md §4.7 for why these five.
 *
 * `bazar` and `poshak` are the P1 build targets — two is enough to prove the
 * architectural claim that switching templates is lossless. The other three are
 * content once the slot vocabulary holds.
 */
const TEMPLATES = [
  {
    key: 'bazar',
    name: 'Bazar',
    nameBn: 'বাজার',
    vertical: 'grocery',
    description:
      'Search-first grocery layout: dense product grid, category rails, ' +
      'savings badges and combo shelves. Modelled on the Bangladeshi grocery ' +
      'storefronts customers already know.',
    descriptionBn:
      'মুদি ও নিত্যপ্রয়োজনীয় পণ্যের জন্য — খোঁজার সুবিধা, ক্যাটাগরি সারি, ছাড়ের ব্যাজ।',
    // No `hero` aside or lookbook — this template leads with search and
    // category rails, not with a large image.
    slots: [
      'identity', 'hero', 'promo', 'collections', 'featured',
      'newArrivals', 'topSelling', 'trust', 'contact', 'policies', 'social', 'seo',
    ],
    themeDefaults: {
      primary: '#F47C20',
      accent: '#16A34A',
      surface: '#FDF9F3',
      radius: 12,
      density: 'compact',
      productCardStyle: 'bordered',
    },
    sortOrder: 10,
  },
  {
    key: 'poshak',
    name: 'Poshak',
    nameBn: 'পোশাক',
    vertical: 'fashion',
    description:
      'Image-led fashion layout: large hero, variant swatches, generous ' +
      'product cards and a size-guide slot.',
    descriptionBn:
      'পোশাক, জুতা ও ব্যাগের জন্য — বড় ছবি, সাইজ ও রঙের অপশন, সাজানো লুক।',
    // No `topSelling`: a fashion catalogue turns over too fast for a
    // best-seller rail to stay meaningful, and the content is kept rather than
    // deleted if the shop switches here from `bazar`.
    slots: [
      'identity', 'hero', 'promo', 'collections', 'featured',
      'newArrivals', 'trust', 'contact', 'policies', 'social', 'seo',
    ],
    themeDefaults: {
      primary: '#111827',
      accent: '#D97706',
      surface: '#FFFFFF',
      radius: 8,
      density: 'comfortable',
      productCardStyle: 'flat',
    },
    sortOrder: 20,
  },
  {
    key: 'jontro',
    name: 'Jontro',
    nameBn: 'যন্ত্র',
    vertical: 'electronics',
    description:
      'Electronics layout: spec tables, brand filtering, warranty badges and ' +
      'comparison-friendly cards.',
    descriptionBn:
      'ইলেকট্রনিক্স ও মোবাইলের জন্য — স্পেসিফিকেশন, ব্র্যান্ড ফিল্টার, ওয়ারেন্টি।',
    slots: [
      'identity', 'hero', 'collections', 'featured', 'newArrivals',
      'topSelling', 'trust', 'contact', 'policies', 'social', 'seo',
    ],
    themeDefaults: {
      primary: '#1D4ED8',
      accent: '#0EA5E9',
      surface: '#F8FAFC',
      radius: 8,
      density: 'compact',
      productCardStyle: 'elevated',
    },
    // Brand filtering is the point of this one, so it needs the brand list.
    minFeatures: ['storefront', 'brands'],
    sortOrder: 30,
  },
  {
    key: 'oushodh',
    name: 'Oushodh',
    nameBn: 'ঔষধ',
    vertical: 'pharmacy',
    description:
      'Pharmacy layout: search-first, strict stock display, pack/strip aware ' +
      'pricing and a prescription-upload slot.',
    descriptionBn:
      'ফার্মেসি ও কসমেটিকসের জন্য — খোঁজার সুবিধা, সঠিক স্টক, প্যাক অনুযায়ী দাম।',
    slots: [
      'identity', 'hero', 'collections', 'featured',
      'trust', 'contact', 'policies', 'social', 'seo',
    ],
    themeDefaults: {
      primary: '#059669',
      accent: '#0891B2',
      surface: '#F7FDFB',
      radius: 12,
      density: 'compact',
      productCardStyle: 'bordered',
    },
    // Strips, packs and half-boxes are the whole vocabulary of a pharmacy
    // shelf — this template is wrong without `packaging`. See AGENT_WORKFLOW §13.
    minFeatures: ['storefront', 'packaging'],
    sortOrder: 40,
  },
  {
    key: 'khabar',
    name: 'Khabar',
    nameBn: 'খাবার',
    vertical: 'food',
    description:
      'Menu layout for bakeries, sweet shops and restaurants: sectioned menu, ' +
      'add-ons, and no stock display.',
    descriptionBn:
      'বেকারি, মিষ্টি ও রেস্টুরেন্টের জন্য — মেনু আকারে সাজানো, স্টক দেখানো হয় না।',
    // No `newArrivals` and no `topSelling`: a menu is a menu.
    slots: [
      'identity', 'hero', 'promo', 'collections', 'featured',
      'trust', 'contact', 'policies', 'social', 'seo',
    ],
    themeDefaults: {
      primary: '#B45309',
      accent: '#DC2626',
      surface: '#FFFBF5',
      radius: 16,
      density: 'comfortable',
      productCardStyle: 'elevated',
    },
    sortOrder: 50,
  },
];

async function main() {
  const apply = process.argv.includes('--apply');

  // Fail loudly on a slot typo before anything touches the database. A slot
  // only one template understands is content a shop loses when it switches
  // away, so the vocabulary is checked here as well as on the schema.
  for (const t of TEMPLATES) {
    const unknown = (t.slots || []).filter((s) => !SLOT_KEYS.includes(s));
    if (unknown.length) {
      throw new Error(`Template "${t.key}" declares unknown slots: ${unknown.join(', ')}`);
    }
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
  });
  console.log(`Connected to ${mongoose.connection.host} (${apply ? 'APPLY' : 'DRY-RUN'})`);

  const existing = await StorefrontTemplate.find({
    key: { $in: TEMPLATES.map((t) => t.key) },
  }).select('key status').lean();
  const existingKeys = new Set(existing.map((t) => t.key));

  const toInsert = TEMPLATES.filter((t) => !existingKeys.has(t.key));

  for (const t of existing) {
    console.log(`  skip   ${t.key} — already exists (${t.status}), left untouched`);
  }
  for (const t of toInsert) {
    console.log(`  insert ${t.key} — "${t.nameBn}" (${t.vertical}), status: draft`);
  }

  if (!toInsert.length) {
    console.log('\nNothing to insert.');
  } else if (apply) {
    await StorefrontTemplate.insertMany(
      toInsert.map((t) => ({ ...t, status: 'draft' }))
    );
    console.log(`\n${toInsert.length} template(s) inserted as DRAFT.`);
    console.log('Next: add a thumbnail to each, then publish from the admin panel.');
    console.log('A draft template cannot be granted to a shop or selected by one.');
  } else {
    console.log(`\n${toInsert.length} template(s) would be inserted. Re-run with --apply.`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
