const mongoose = require('mongoose');
const { ALL_UNITS, DEFAULT_UNIT } = require('../config/units');

/**
 * Codes and barcodes are barcode payloads, so they are ASCII or they are
 * nothing.
 *
 * The product form used to build a code from the category name —
 * `category.name.slice(0, 3)` — and every category in this app is named in
 * Bengali, so it produced codes like `কলম0042`. CODE128 encodes ASCII 0–127
 * and nothing else, so the label sheet drew no bars at all: it printed the code
 * as text and skipped the symbol. Nobody inspects a label for bars. They print
 * forty, stick them on forty boxes, and discover it at the counter.
 *
 * The form is fixed (`hisaab-frontend/lib/productCode.js`), but the form is not
 * the only way in — imports, the API and future screens all reach this model.
 * So the rule lives here too.
 *
 * VALIDATOR, NOT SETTER, ON PURPOSE. A setter would quietly rewrite `কলম0042`
 * to `0042`, which is a different product identity assigned during whatever
 * unrelated save happened to touch the document. Rejecting says what is wrong
 * and changes nothing.
 *
 * THE RULE IS "CODE128 CAN ENCODE IT", NOT AN ALPHABET SOMEONE PICKED
 * -------------------------------------------------------------------
 * CODE128 encodes printable ASCII, 0x20–0x7E. That is the whole constraint, and
 * the validator is exactly that test.
 *
 * An earlier version of this used `[A-Z0-9-]`, reasoning that codes ought to be
 * tidy. Tidy is not the invariant, and narrowing to it broke two real things at
 * once: supplier SKUs legitimately contain `/`, `.` and `_`, so editing such a
 * product was refused; and `deleteProduct` renames the code to
 * `<code>~DEL~<ts>` to free the unique index, so `~` failed the test and NO
 * PRODUCT COULD BE DELETED AT ALL — including products whose codes were pure
 * ASCII and had nothing to do with the Bengali problem this was written for.
 * Enforce encodability. Anything past that is a form's business, not the
 * database's.
 *
 * TWO EXEMPTIONS, BOTH LOAD-BEARING — READ BEFORE SIMPLIFYING
 * -----------------------------------------------------------
 * 1. UNMODIFIED VALUES. Mongoose does NOT validate only modified paths on an
 *    existing document: `_getPathsToValidate` unions the `modify` paths with
 *    the `init` paths, and a document hydrated by `findOne()` has every field
 *    in `init`. So deducting stock — which touches `stock` and nothing else —
 *    revalidates `code`. Without this guard, a legacy Bengali code would make
 *    `save()` throw in the middle of a sale. Rows written before this rule
 *    existed stay saveable until `scripts/normalize-product-codes.js` converts
 *    them.
 *
 * 2. DELETED PRODUCTS. A soft-deleted product's code is a tombstone, not a
 *    payload — nothing prints a label for it. Deleting a legacy Bengali-coded
 *    product necessarily writes a Bengali-derived tombstone, and refusing that
 *    would leave the shopkeeper unable to delete exactly the products this
 *    change is about.
 *
 * Under `runValidators` on an update `this` is the Query, which has no
 * `isModified`; that falls through to the check, which is right, because an
 * update IS a write.
 */
const CODE128_ENCODABLE = /^[\x20-\x7E]+$/;

const asciiCodeValidator = (label, path) => ({
  validator: function (v) {
    if (v === undefined || v === null || v === '') return true;

    if (this && typeof this.isModified === 'function') {
      // Variant SKUs validate on the subdocument; the flag lives on the parent.
      const owner = typeof this.ownerDocument === 'function' ? this.ownerDocument() : this;
      if (owner && owner.isDeleted) return true;
      if (!this.isNew && !this.isModified(path)) return true;
    }

    return CODE128_ENCODABLE.test(v);
  },
  message: `${label} ইংরেজি অক্ষর, সংখ্যা বা চিহ্ন দিয়ে লিখুন — বারকোডে বাংলা ছাপা যায় না`,
});


const variantSchema = new mongoose.Schema({
  sku: {
    type: String,
    required: true,
    trim: true,
    // No `uppercase` here — variant SKUs are matched against stored values by
    // several call sites, and folding case would change what those match.
    validate: asciiCodeValidator('ভ্যারিয়েন্টের SKU', 'sku'),
  },
  attributes: {
    size: String,
    color: String,
    weight: String,
    material: String,
    style: String,
    custom: mongoose.Schema.Types.Mixed
  },
  buyingPrice: {
    type: Number,
    required: [true, 'ক্রয় মূল্য দিন'],
    min: [0, 'ক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  sellingPrice: {
    type: Number,
    required: [true, 'বিক্রয় মূল্য দিন'],
    min: [0, 'বিক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  // Wholesale rate for this variant. See the top-level `wholesalePrice` below —
  // same meaning, same fallback, same feature gate. Absent on ~every variant.
  wholesalePrice: {
    type: Number,
    min: [0, 'পাইকারি মূল্য ০ এর কম হতে পারবে না']
  },
  stock: {
    type: Number,
    default: 0,
    min: [0, 'স্টক ০ এর কম হতে পারবে না']
  },
  barcode: {
    type: String,
    trim: true,
    validate: asciiCodeValidator('বারকোড', 'barcode'),
  },
  // The variant's photo URL. Stays a plain string — `product.service` reads
  // `v.image` straight through to the client and turning it into an object
  // would break every existing caller for no gain.
  image: {
    type: String
  },
  // Set only when `image` points at something in our own R2 pool. Null means
  // "an external URL, or nothing" — either way, not our bytes to reclaim.
  imageMediaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ShopMedia',
    default: null
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { _id: true });

/**
 * How this product is PACKED, as opposed to how it is stocked.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE INVARIANT, AND EVERYTHING ELSE FOLLOWS FROM IT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     `stock`, `buyingPrice` and `sellingPrice` are ALWAYS in `unit` — the
 *     base unit. The pack never touches them.
 *
 * A shop buys 5 cartons of oil at 20 bottles each and sells bottles one at a
 * time. `unit` is `piece`, `stock` is 100, and packaging says "a carton is 20
 * pieces". Sell one carton and stock goes to 80 — the SAME subtraction the
 * sale path has always done, because the carton was converted to 20 pieces
 * before it reached the stock guard.
 *
 * That is why this is additive rather than a second stock column. A
 * `stockInPacks` field would need reconciling on every write, would go stale
 * the moment a supplier changed 12-per-pack to 10-per-pack, and would make
 * "how many do I actually have" a question with two answers.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS STORED AT ALL — the purchase helper used to just multiply
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The original design (see PackQuantityInput) treated the pack as a pure
 * calculator: the client multiplied 5 x 20 and posted 100, and nothing about
 * the pack survived. That was right for purchases and wrong for everything
 * else, because three real questions have no answer without a stored pack size:
 *
 *   - "sell me a whole carton"  — the POS cannot offer a carton button when it
 *     does not know what a carton is
 *   - "how many cartons are left" — 100 pieces is not an answer a shopkeeper
 *     counting shelves can use
 *   - the invoice line — a customer who bought 5 cartons wants to read
 *     "৫ কার্টন", not "১০০ পিস"
 *
 * So the size is stored once, on the product, and every quantity in the system
 * stays in the base unit. `sizeAtSale` snapshots on the sale/purchase line, so
 * changing this later never rewrites history.
 *
 * Only ONE level is supported (pack -> base). Carton -> packet -> piece is
 * deliberately out of scope; see AGENT_WORKFLOW.md 13.9.
 */
const packagingSchema = new mongoose.Schema({
  enabled: {
    type: Boolean,
    default: false
  },
  // A `pack`-group unit (কার্টন, বস্তা, প্যাকেট) or a larger unit from the base
  // unit's own group (ডজন over পিস). Validated against `outerUnitsFor(unit)` in
  // the service layer — the enum here has to accept the whole registry for the
  // same reason `unit`'s does.
  packUnit: {
    type: String,
    enum: ALL_UNITS
  },
  // How many base units are in one pack. Fractional on purpose: half a kg per
  // packet is a real thing (spice sachets), and 12.5 metres per than is a real
  // bolt of cloth.
  unitsPerPack: {
    type: Number,
    min: [0.001, 'প্রতি মোড়কে পরিমাণ ০ এর বেশি হতে হবে']
  },
  // Cost of one whole pack, if the supplier quotes it that way. Purely a
  // convenience for purchase entry — `buyingPrice` (per base unit) stays the
  // number every profit calculation reads.
  packBuyingPrice: {
    type: Number,
    min: [0, 'ক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  // Price of one whole pack. Left empty this is `unitsPerPack x sellingPrice`,
  // which is the common case; set it to give a wholesale discount on full
  // cartons without touching the retail price.
  packSellingPrice: {
    type: Number,
    min: [0, 'বিক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  // Which buttons the POS offers. Both default on: a shop that packs a product
  // normally sells it both ways, and turning one off is the exception (a carton
  // of loose rice is not sellable as a carton; a strip of tablets often is not
  // splittable).
  sellByPack: {
    type: Boolean,
    default: true
  },
  sellByUnit: {
    type: Boolean,
    default: true
  }
}, { _id: false });

/**
 * One component of a combo product ("Eid Pack = 1x shampoo + 2x soap").
 *
 * ── WHY A COMBO IS A PRODUCT AND NOT ITS OWN COLLECTION ──────────────────────
 * The whole sale pipeline is keyed on Product: POS search, barcode lookup,
 * `Sale.items.product` (a required ref), per-branch scoping, soft delete, RBAC.
 * A separate Combo collection would need parallel wiring at every one of those
 * points. So a combo is `type: 'combo'` on this model, and `comboItems` below
 * is what it is made of.
 *
 * ── A COMBO HAS NO STOCK OF ITS OWN ──────────────────────────────────────────
 * `stock` on a combo product is inert (kept at 0). How many combos can be sold
 * is DERIVED at read time — min(component stock / quantity) — and enforced at
 * sale time by the same $gte-guarded bulk ops every ordinary line uses, one op
 * per component. There is exactly one stock number per component product, so a
 * combo can never disagree with the shelf.
 *
 * The name/sku fields here are DISPLAY snapshots refreshed on combo save so the
 * builder and POS can render without a populate. They are NOT the sale-time
 * record — `Sale.items[].comboComponents` freezes its own copy at checkout,
 * which is what keeps history immune to combo edits and deletions.
 */
const comboItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: [true, 'কম্বোর পণ্য নির্বাচন করুন']
  },
  /**
   * WHICH sellable thing this slot draws from.
   *
   * 'fixed'  — `variantId` names one variant (or the product itself, when it
   *            has none). The till cannot substitute: a combo priced for the
   *            400ml shampoo must not go out with the 200ml.
   * 'choose' — every ACTIVE variant of the component is eligible and the
   *            cashier picks one while billing. `variantId` is null.
   *
   * 'choose' is what stops a 6-variant shirt from needing 6 separate combo
   * products. A customer picks a colour at the counter, not the shopkeeper at
   * build time — so the choice belongs at the till.
   *
   * The mode is EXPLICIT rather than inferred from `variantId: null`, and that
   * matters: a component that GREW variants after the combo was built also has
   * no variantId, and its product-level stock stops meaning anything the moment
   * variants appear. Such a row stays 'fixed' and still fails loudly at sale
   * time (see sale.service.js) instead of silently deducting from an arbitrary
   * variant. Default 'fixed' so a payload that omits the field keeps the
   * variant it named.
   */
  variantMode: {
    type: String,
    enum: ['fixed', 'choose'],
    default: 'fixed'
  },
  // Set only when `variantMode === 'fixed'` and the component has variants —
  // enforced in product.service._validateComboItems, where the component
  // document is in hand. Null means "the product itself", or, under 'choose',
  // "decided at the till".
  variantId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  // Display snapshots (refreshed on every combo save; see the block comment).
  productName: { type: String },
  productCode: { type: String },
  variantSku: { type: String },
  variantAttributes: { type: mongoose.Schema.Types.Mixed },
  unit: { type: String },
  // How many base units of the component go into ONE combo. Buy-1-get-1 of the
  // same item is a single row with quantity 2.
  quantity: {
    type: Number,
    required: [true, 'পরিমাণ দিন'],
    min: [0.001, 'পরিমাণ ০ এর বেশি হতে হবে']
  }
}, { _id: true });

const productSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  // Each branch manages its own catalogue with its own prices and its own
  // stock. `null` = single-branch shop, where this field is inert and the
  // {shop, branch, code} unique index collapses to {shop, code} — exactly the
  // behaviour these shops have today.
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  // Set when a product was copied into a new branch. Kept as lineage so stock
  // transfers can match the same item across branches even if a code is later
  // edited; `code` remains the primary match key.
  clonedFrom: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    default: null
  },
  code: {
    type: String,
    required: [true, 'পণ্যের কোড দিন'],
    trim: true,
    uppercase: true,
    validate: asciiCodeValidator('পণ্যের কোড', 'code'),
  },
  barcode: {
    type: String,
    trim: true,
    validate: asciiCodeValidator('বারকোড', 'barcode'),
  },
  name: {
    type: String,
    required: [true, 'পণ্যের নাম দিন'],
    trim: true,
    maxlength: [200, 'পণ্যের নাম ২০০ অক্ষরের বেশি হতে পারবে না']
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category'
  },
  subcategory: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category'
  },
  description: {
    type: String,
    maxlength: [2000, 'বিবরণ ২০০০ অক্ষরের বেশি হতে পারবে না']
  },
  /**
   * The shop's own brand, when `features.brands` is on.
   *
   * A reference, not the free-text string this used to be. The field had
   * existed as a `String` since the beginning and was never once written — no
   * form collected it, and a census of production found 0 of 51 products
   * carrying a value — so there is no data to migrate and nothing that reads a
   * name here.
   *
   * A ref is what the requirement actually asks for: the shop MANAGES a brand
   * list and PICKS from it, which means renaming "Squre" to "Square" has to fix
   * every product at once rather than leaving the typo scattered across the
   * catalogue.
   */
  brand: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    default: null
  },
  // The unit this product's `stock`, `buyingPrice` and `sellingPrice` are
  // expressed in. Historically a cosmetic label; with `shop.features.packaging`
  // on it also carries a decimal precision (see config/units.js).
  //
  // The enum is the FULL registry for every shop, on purpose: which units a shop
  // may *choose* is gated in the service layer via `unitsForShop(flag)`, not
  // here. Gating the enum instead would make an existing product unsaveable the
  // moment an admin turned the flag back off — the enum has to accept anything
  // already stored.
  unit: {
    type: String,
    default: DEFAULT_UNIT,
    enum: ALL_UNITS
  },
  // Optional outer pack — see `packagingSchema` above. Absent for every product
  // that is simply sold as it is stocked, which is most of them.
  packaging: {
    type: packagingSchema,
    default: undefined
  },
  // 'standard' = an ordinary product. 'combo' = a bundle of other products —
  // see the block comment on `comboItemSchema`. Immutable after create
  // (enforced in product.service): a product with sale history changing kind
  // would orphan either its stock or its components.
  type: {
    type: String,
    enum: ['standard', 'combo'],
    default: 'standard'
  },
  // Only when `type === 'combo'`. `default: undefined` so the ~100% of
  // ordinary products carry no empty array at all.
  comboItems: {
    type: [comboItemSchema],
    default: undefined
  },
  hasVariants: {
    type: Boolean,
    default: false
  },
  // For non-variant products
  buyingPrice: {
    type: Number,
    min: [0, 'ক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  sellingPrice: {
    type: Number,
    min: [0, 'বিক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  /**
   * What a WHOLESALE customer pays, per base unit. Optional, and absent for
   * most products even in a shop that has the feature.
   *
   * ── Absent means "charge retail", NOT "free" ────────────────────────────────
   *
   * This is the whole reason it is optional rather than required. A shop turns
   * the feature on with a thousand products already priced; asking for a second
   * price on every one of them before the first wholesale sale can be rung up
   * would make the feature unusable on day one. So a product with no wholesale
   * price sells to a wholesale customer at `sellingPrice`, silently and
   * correctly, and the shopkeeper fills these in as they go.
   *
   * `0` is treated as absent for the same reason `packSellingPrice` is (see
   * packaging.util): a number input that has been cleared reads as 0, and
   * charging ৳0 for a carton of rice because someone emptied a box is not a
   * price, it is a bug. Only a positive figure overrides.
   *
   * Never compare against this directly — `pricing.util.sellingPriceFor` is the
   * one place the fallback lives, and it is what keeps a shop without
   * `features.wholesale` from ever being billed off this column.
   *
   * Deliberately NOT validated against `sellingPrice`. A wholesale rate ABOVE
   * retail is a data-entry mistake, but it is also occasionally deliberate
   * (a small pack surcharge), and refusing it at the database means a shop
   * cannot record what it actually charges. The product form warns instead.
   */
  wholesalePrice: {
    type: Number,
    min: [0, 'পাইকারি মূল্য ০ এর কম হতে পারবে না']
  },
  stock: {
    type: Number,
    default: 0,
    min: [0, 'স্টক ০ এর কম হতে পারবে না']
  },
  minStock: {
    type: Number,
    default: 5,
    min: [0, 'নূন্যতম স্টক ০ এর কম হতে পারবে না']
  },
  /**
   * Batch / expiry tracking. Opt-in per PRODUCT, never per variant — a shop
   * that tracks the expiry of ডানো গুঁড়ো দুধ tracks it for the ৫০০ গ্রাম packet
   * and the ২ কেজি packet alike. There is no case for half a product being
   * date-controlled, and a per-variant flag would only create one more way for
   * the two halves to disagree.
   */
  trackBatches: {
    type: Boolean,
    default: false,
  },
  /**
   * ── WHY `variantId` LIVES ON THE BATCH AND NOT THE OTHER WAY ROUND ──────────
   *
   * Every real batch belongs to one sellable thing. For a plain product that is
   * the product; for a variant product it is ONE variant — the ৫০০ গ্রাম packets
   * that came in January expire in June, and the ১ কেজি packets that came in
   * March expire in December. Those are two different dates against two
   * different stock pools, and before this field there was nowhere to put the
   * second one.
   *
   * The obvious alternative is a `batches[]` INSIDE `variantSchema`. It was
   * rejected for three concrete reasons, all of which have already bitten this
   * file:
   *
   *   1. MIGRATION. `variantId: null` reads as "the whole product", which is
   *      exactly what every batch written before today already meant. Nothing
   *      to backfill, and a single-branch non-variant shop is byte-identical
   *      (I-1/I-6).
   *
   *   2. THE VARIANTS ARRAY IS REBUILT WHOLESALE ON EVERY EDIT.
   *      `product.service._formatVariants` reconstructs each row from the
   *      client payload, and the frontend `VariantBuilder` regenerates rows
   *      from attribute combinations. Anything living inside a variant survives
   *      only if BOTH remember to carry it forward — see the `wholesalePrice`
   *      rescue in `updateProduct`, which exists because that exact thing was
   *      forgotten once. Batch history is not something to stake on a rebuild
   *      remembering it.
   *
   *   3. ONE FEFO, ONE INDEX. The sale path, the expiry report and the purchase
   *      push all read one array and one `batches.expiryDate` index rather than
   *      a product-level path and a nested-in-variant path that must be kept in
   *      step forever.
   *
   * Read this through `batchesFor(variantId)` below rather than filtering by
   * hand — `null`, `undefined` and an ObjectId all have to compare equal to
   * "the product level", and `String(null) === String(undefined)` is false.
   */
  batches: [{
    // null / absent = the product itself (no variants, or a legacy row).
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    batchNumber: { type: String, required: true, trim: true },
    expiryDate: { type: Date },
    quantity: { type: Number, required: true, min: 0 },
    costPrice: { type: Number, min: 0 },
    receivedDate: { type: Date, default: Date.now },
    purchaseRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase' },
  }],
  // Serial / IMEI Number tracking (electronics, mobile shops)
  trackSerials: {
    type: Boolean,
    default: false,
  },
  serials: [{
    type: String,
    trim: true,
  }],
  // ── For variant products ───────────────────────────────────────────────────
  //
  // `variantSchema` is declared at the top of this file and was never attached
  // here. The comment above marked the spot; the path itself was missing.
  //
  // Everything else in the codebase assumed it existed: the two virtuals below
  // call `this.variants.some(...)` and `.filter(...)`, the instance methods call
  // `this.variants.id(...)`, `sale.service` deducts variant stock through it,
  // and two indexes are declared on `variants.sku` / `variants.barcode`.
  //
  // Undeclared, Mongoose's strict mode silently DROPPED the key on every write,
  // and every hydrated document had `variants === undefined`. The list screens
  // never noticed because they all read through `.lean()`, which skips virtuals
  // and hands back whatever the raw document holds. The barcode lookup is not
  // lean — it hydrates and calls `toObject({ virtuals: true })` — so scanning a
  // variant product ran `undefined.some(...)` and returned a 500 that surfaced
  // at the till as "Cannot read properties of undefined (reading 'some')".
  variants: [variantSchema],
  images: [mongoose.Schema.Types.Mixed],
  /**
   * Catalog photos.
   *
   * `mediaId` is the ONLY new thing here and it is optional on purpose. Rows
   * written by the original ImgBB endpoint (`POST /products/:id/images`) have
   * no `mediaId` and keep working exactly as before — they are just URLs on a
   * host we do not manage. Rows written by the R2 pipeline carry one, and that
   * is what makes them reclaimable: refCounting, dedupe, quota accounting and
   * the URL-rewrite script all key off it.
   *
   * So "does this image cost us storage?" is answered by `mediaId != null`,
   * never by the URL. Do not backfill the old rows with a fake id.
   */
  catalogImages: [{
    mediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShopMedia', default: null },
    url: { type: String, required: true },
    thumbnail: { type: String },
    isPrimary: { type: Boolean, default: false }
  }],
  tags: [{
    type: String,
    trim: true
  }],
  // Sales tracking
  totalSold: {
    type: Number,
    default: 0
  },
  lastSold: {
    type: Date
  },
  isActive: {
    type: Boolean,
    default: true
  },
  // Soft delete — distinct from isActive (deactivate). Deleted products are
  // hidden from every listing/lookup but the document is kept so historical
  // sales, purchases and stock transactions keep resolving.
  isDeleted: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  // Online Selling
  /**
   * Whether this product is offered online. Gated by `Shop.features.onlineSelling`.
   *
   * ── WHY THE DEFAULT IS `false` ──────────────────────────────────────────────
   * It used to be `true`, and that was a real bug rather than a preference. The
   * online section of the product form was hidden behind a build-time constant,
   * so the form stopped SENDING this field — and every product created after
   * that silently landed as online, in shops that do not sell online at all and
   * whose owners were never shown a control to say otherwise.
   *
   * A flag nobody was asked about must not default to the permissive answer.
   * Opting a product into a public surface is a decision, so it is now stored
   * only when somebody actually made it. `product.service` forces this false for
   * any shop without the capability, so the client cannot set it either.
   */
  isAvailableOnline: {
    type: Boolean,
    default: false
  },
  onlinePrice: {
    type: Number,
    min: [0, 'অনলাইন বিক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  onlineDescription: {
    type: String,
    maxlength: [2000, 'অনলাইন বিবরণ ২০০০ অক্ষরের বেশি হতে পারবে না']
  },
  isFeaturedOnline: {
    type: Boolean,
    default: false
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes - Optimized for scalability
// Essential indexes only - removed redundant and rarely-used indexes
// Product codes are unique per branch, not per shop: two branches legitimately
// stock the same item under the same code as two separate documents. For
// single-branch shops `branch` is always null, so this is equivalent to the
// previous {shop, code} unique index — no behaviour change for them.
productSchema.index({ shop: 1, branch: 1, code: 1 }, { unique: true });
productSchema.index({ shop: 1, branch: 1, createdAt: -1 }); // Branch listing by date
productSchema.index({ shop: 1, code: 1 }); // Cross-branch code match (stock transfer)
productSchema.index({ shop: 1, name: 1 }); // Search: lets name-regex $or clauses run as shop-bounded index scans
productSchema.index({ shop: 1, category: 1, isActive: 1 }); // Category listing with active filter
productSchema.index({ shop: 1, 'variants.sku': 1 }, { sparse: true }); // Variant SKU lookup
productSchema.index({ shop: 1, 'variants.barcode': 1 }, { sparse: true }); // Variant barcode scan
// Top-level barcode scan. The variant equivalent above has always existed; this
// one did not, because `getProductByCode` never actually queried `barcode` —
// see the note there. Sparse for the same reason: most products carry no
// barcode at all, and indexing their nulls buys nothing.
productSchema.index({ shop: 1, barcode: 1 }, { sparse: true });
productSchema.index({ shop: 1, createdAt: -1 }); // Listing by date
productSchema.index({ shop: 1, isAvailableOnline: 1, isActive: 1 }); // Online product listing
// Best-sellers-first ordering for the POS product grid. `isDeleted` is the
// leading filter on every listing query, so including it here keeps the sort
// index-backed rather than falling back to an in-memory sort.
productSchema.index({ shop: 1, isDeleted: 1, totalSold: -1 }); // Popular-first listing
// Expiry sweep. `getExpiringBatches` matches on {shop, branch, isDeleted,
// trackBatches} and then unwinds, so the leading keys carry the whole match and
// the trailing `batches.expiryDate` keeps the "soonest first" ordering
// index-backed. Sparse: batch tracking is off for the overwhelming majority of
// products, and indexing their absent arrays buys nothing.
//
// This screen used to have no index at all because it had no query — the client
// pulled 200 products and filtered them in the browser, which is why product
// 201's expiry was invisible.
productSchema.index({ shop: 1, trackBatches: 1, 'batches.expiryDate': 1 }, { sparse: true });
// "Which combos contain this product?" — the delete-guard on a component and
// the availability recompute both ask it. Sparse: only combo products carry the
// array at all.
productSchema.index({ shop: 1, 'comboItems.product': 1 }, { sparse: true });
// Cross-shop, admin-only — same reasoning as the bare {createdAt} index on
// Sale. The console's recent-uploads feed and GET /api/admin/products carry no
// shop predicate, so none of the compound indexes above can serve them.
productSchema.index({ createdAt: -1 });
// Note: Text search removed for scalability - use regex or external search (Elasticsearch) for large datasets

/*
 * Both virtuals guard `variants` rather than trusting `hasVariants`.
 *
 * These run inside `toObject({ virtuals: true })`, which means they run on
 * every hydrated document that gets serialised — including error paths and
 * response bodies. A throw here is not a wrong number, it is a 500 on whatever
 * request happened to touch the product, and the caller sees a stack-trace
 * fragment instead of a product. That is exactly how the missing `variants`
 * path above showed up: as "Cannot read properties of undefined (reading
 * 'some')" on a barcode scan at the till.
 *
 * `hasVariants` is a flag a human sets; `variants` is the data. When they
 * disagree, believe the data and degrade quietly.
 */

// Virtual: Is low stock
productSchema.virtual('isLowStock').get(function() {
  if (this.hasVariants && Array.isArray(this.variants) && this.variants.length) {
    return this.variants.some(v => v.isActive && v.stock <= this.minStock);
  }
  return (this.stock || 0) <= this.minStock;
});

// Virtual: Total stock (for variant products)
productSchema.virtual('totalStock').get(function() {
  if (this.hasVariants && Array.isArray(this.variants) && this.variants.length) {
    return this.variants
      .filter(v => v.isActive)
      .reduce((sum, v) => sum + (v.stock || 0), 0);
  }
  return this.stock || 0;
});

/**
 * Base units in one pack, or `null` when this product has no pack.
 *
 * Read this rather than `product.packaging.unitsPerPack` — packaging is
 * `default: undefined`, so the direct read throws on the ~95% of products that
 * have none, and a cached document from before the field existed has no
 * `packaging` key at all.
 */
productSchema.methods.packSize = function() {
  const p = this.packaging;
  if (!p || !p.enabled) return null;
  const n = Number(p.unitsPerPack);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Price of one whole pack. Falls back to `unitsPerPack x sellingPrice`, which
 * is what a shopkeeper means when they leave the pack price empty.
 */
productSchema.methods.packPrice = function() {
  const size = this.packSize();
  if (size == null) return null;
  const explicit = Number(this.packaging.packSellingPrice);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return (this.sellingPrice || 0) * size;
};

/**
 * Virtual: stock expressed in packs, for the "কত কার্টন আছে" reading.
 *
 * Deliberately NOT rounded to a whole pack — 100 pieces at 30 per carton is
 * 3.33 cartons, and reporting "3" would hide a third of a carton of stock. The
 * UI shows it as "৩ কার্টন + ১০ পিস"; this is the raw number behind that.
 */
productSchema.virtual('stockInPacks').get(function() {
  const size = this.packSize();
  if (size == null) return null;
  return (this.hasVariants ? this.totalStock : this.stock) / size;
});

// Virtual: Profit margin
productSchema.virtual('profitMargin').get(function() {
  if (!this.hasVariants && this.sellingPrice && this.buyingPrice) {
    return ((this.sellingPrice - this.buyingPrice) / this.sellingPrice * 100).toFixed(2);
  }
  return null;
});

// Static: Find by code
productSchema.statics.findByCode = function(shopId, code, branchId = null) {
  const filter = { shop: shopId, code: code.toUpperCase(), isActive: true };
  if (branchId) filter.branch = branchId;
  return this.findOne(filter);
};

// Static: Find by barcode
productSchema.statics.findByBarcode = function(shopId, barcode, branchId = null) {
  return this.findOne({
    shop: shopId,
    ...(branchId ? { branch: branchId } : {}),
    isActive: true,
    $or: [
      { barcode },
      { 'variants.barcode': barcode }
    ]
  });
};

// Static: Get low stock products
productSchema.statics.getLowStockProducts = function(shopId, threshold = 5, branchId = null) {
  return this.find({
    shop: shopId,
    ...(branchId ? { branch: branchId } : {}),
    isActive: true,
    $or: [
      { hasVariants: false, stock: { $lte: threshold } },
      { hasVariants: true, 'variants.stock': { $lte: threshold } }
    ]
  }).sort({ stock: 1 });
};

// Static: Search products
productSchema.statics.searchProducts = function(shopId, query, options = {}) {
  const { page = 1, limit = 20, category, sortBy = 'name', sortOrder = 1 } = options;

  const filter = {
    shop: shopId,
    isActive: true,
    $or: [
      { name: { $regex: query, $options: 'i' } },
      { code: { $regex: query, $options: 'i' } },
      { barcode: { $regex: query, $options: 'i' } }
    ]
  };

  if (category) {
    filter.$or.push({ category }, { subcategory: category });
  }

  return this.find(filter)
    .sort({ [sortBy]: sortOrder })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('category', 'name')
    .populate('subcategory', 'name');
};

// Method: Update stock
productSchema.methods.updateStock = async function(quantity, variantId = null) {
  if (this.hasVariants && variantId) {
    const variant = this.variants.id(variantId);
    if (variant) {
      variant.stock = Math.max(0, variant.stock + quantity);
    }
  } else {
    this.stock = Math.max(0, this.stock + quantity);
  }
  await this.save();
};

// Method: Record sale
productSchema.methods.recordSale = async function(quantity, variantId = null) {
  await this.updateStock(-quantity, variantId);
  this.totalSold += quantity;
  this.lastSold = new Date();
  await this.save();
};

/**
 * Do two batch owners refer to the same sellable thing?
 *
 * `null`, `undefined` and `''` all mean "the product itself", and an ObjectId
 * has to compare equal to its own string form because one side comes from the
 * document and the other from a request body. `String(null) === String(undefined)`
 * is FALSE ('null' vs 'undefined'), so the naive stringify comparison silently
 * treats a legacy batch as belonging to no variant anyone can name — which
 * would hide it from FEFO and leak it into every variant's expiry list at once.
 *
 * Exported as a static so the sale, purchase, return and transfer paths all
 * decide this the same way.
 */
productSchema.statics.sameBatchOwner = function(a, b) {
  const norm = (v) => (v === null || v === undefined || v === '' ? null : String(v));
  return norm(a) === norm(b);
};

/**
 * This product's batches for one variant, or for the product itself when
 * `variantId` is null. Sorted FEFO — soonest expiry first, undated last, which
 * is the order every consumer wants and none of them should re-derive.
 *
 * An undated batch sorts LAST rather than first on purpose: "no expiry recorded"
 * is not "expires never", it is "nobody typed it in", and draining those before
 * a batch with a real date three weeks out would leave the short-dated stock on
 * the shelf — the exact outcome FEFO exists to prevent.
 */
productSchema.methods.batchesFor = function(variantId = null) {
  if (!Array.isArray(this.batches)) return [];
  const Model = this.constructor;
  return this.batches
    .filter((b) => Model.sameBatchOwner(b.variantId, variantId))
    .sort((a, b) => {
      if (!a.expiryDate && !b.expiryDate) return 0;
      if (!a.expiryDate) return 1;
      if (!b.expiryDate) return -1;
      return new Date(a.expiryDate) - new Date(b.expiryDate);
    });
};

// Method: Get variant by ID
productSchema.methods.getVariant = function(variantId) {
  if (!this.hasVariants) return null;
  return this.variants.id(variantId);
};

// Method: Get variant by SKU
productSchema.methods.getVariantBySKU = function(sku) {
  if (!this.hasVariants) return null;
  return this.variants.find(v => v.sku === sku);
};

const Product = mongoose.model('Product', productSchema);

module.exports = Product;
