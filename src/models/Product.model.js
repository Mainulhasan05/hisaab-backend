const mongoose = require('mongoose');
const { ALL_UNITS, DEFAULT_UNIT } = require('../config/units');


const variantSchema = new mongoose.Schema({
  sku: {
    type: String,
    required: true,
    trim: true
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
  stock: {
    type: Number,
    default: 0,
    min: [0, 'স্টক ০ এর কম হতে পারবে না']
  },
  barcode: {
    type: String,
    trim: true
  },
  image: {
    type: String
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
    uppercase: true
  },
  barcode: {
    type: String,
    trim: true
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
  brand: {
    type: String,
    trim: true
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
  // Batch / Expiry tracking (opt-in per product)
  trackBatches: {
    type: Boolean,
    default: false,
  },
  batches: [{
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
  catalogImages: [{
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
  isAvailableOnline: {
    type: Boolean,
    default: true
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
