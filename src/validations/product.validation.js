const { Joi, commonSchemas } = require('../middleware/validate.middleware');
const { ALL_UNITS, SAFE_QUANTITY_MAX } = require('../config/units');

/**
 * Quantity/stock fields used to be `Joi.number().integer()`. They are not any
 * more, and that is deliberate.
 *
 * Joi runs before the service layer, so it can see neither the shop's
 * `features.packaging` flag nor the product's unit — it cannot tell a
 * legitimate 0.5 kg from an illegitimate 0.5 piece. Enforcing integers here
 * would make the feature impossible; enforcing nothing would let fractions into
 * a shop that has not enabled it.
 *
 * So this layer keeps only the STRUCTURAL bounds (finite, non-negative, within
 * the safe-precision ceiling) and the ENTITLEMENT decision moves to
 * `utils/quantity.util.parseQuantity`, which has the flag and the unit in hand
 * and refuses a fraction on any `decimals: 0` unit.
 *
 * Do not "restore" `.integer()` here. It will look like a tightening and will
 * instead break every shop selling by weight.
 */
const quantityField = Joi.number().min(0).max(SAFE_QUANTITY_MAX);

const variant = Joi.object({
  _id: commonSchemas.objectId.optional(),
  id: Joi.alternatives().try(commonSchemas.objectId, Joi.string().trim()).optional(),
  sku: Joi.string().trim().max(100).required(),
  barcode: Joi.string().trim().max(100).allow('', null),
  buyingPrice: Joi.number().min(0).required(),
  sellingPrice: Joi.number().min(0).required(),
  // Optional, and structural bounds only — see the note on the product-level
  // field below. Not `required()` even alongside a required `sellingPrice`:
  // most variants never get a wholesale rate.
  wholesalePrice: Joi.number().min(0).allow(null, ''),
  stock: quantityField.default(0),
  image: Joi.string().uri().allow('', null),
  // Present only when the photo came from our own R2 pool. Structural check
  // only — whether the shop OWNS this media is decided in
  // `product.service._applyImageRefs`, which is the layer that knows the shop.
  imageMediaId: commonSchemas.objectId.allow(null, ''),
  isActive: Joi.boolean().default(true),
  attributes: Joi.object().unknown(true),
  /**
   * The opening batch for THIS variant, on create only.
   *
   * It rides on the variant row rather than in the product-level `batches`
   * array because the client cannot name the variant it belongs to: variant
   * `_id`s are minted server-side in `_formatVariants`, so a payload written
   * before that call has no id to point at. Position is the only handle both
   * sides share, and a nested object makes that correspondence structural
   * rather than a parallel array someone can get out of step.
   *
   * Quantity and cost are NOT accepted here — they are the variant's own
   * `stock` and `buyingPrice` by definition. Letting a client send a third
   * number would immediately allow "৩০ pieces in stock, opening batch of ৫০",
   * and there is no honest way to resolve that disagreement afterwards.
   *
   * NOTE for `_formatVariants`: this key is consumed by `createProduct` and
   * must be in that function's exclusion list, or it lands in
   * `attributes.custom` and renders on the invoice next to size and colour.
   */
  openingBatch: Joi.object({
    batchNumber: Joi.string().trim().max(100).allow('', null),
    expiryDate: Joi.date().allow('', null),
  }).allow(null),
}).unknown(true);

/**
 * One component of a combo product. Structural bounds only — whether the
 * component exists, belongs to this shop and branch, is itself not a combo,
 * and whether `variantId` is required (component has variants) or forbidden
 * (it does not) are all decided in `product.service._validateComboItems`,
 * which has the component documents in hand. Joi cannot ask any of that.
 */
const comboItem = Joi.object({
  _id: commonSchemas.objectId.optional(),
  product: commonSchemas.objectId.required(),
  // 'choose' = the cashier picks a variant at the till. The pairing rule
  // (a 'choose' row may not also name a variant) is enforced in the service,
  // which knows whether the component has variants at all.
  variantMode: Joi.string().valid('fixed', 'choose'),
  variantId: commonSchemas.objectId.allow(null, ''),
  quantity: Joi.number().positive().max(SAFE_QUANTITY_MAX).required(),
}).unknown(true); // display snapshots round-trip from the edit form

/**
 * One batch, as the batch endpoints accept it. `variantId` is which sellable
 * thing it belongs to — absent/null means the product itself, which is what
 * every batch written before per-variant expiry existed already meant.
 */
const batchBody = {
  batchNumber: Joi.string().trim().min(1).max(100).required(),
  expiryDate: Joi.date().allow('', null),
  quantity: quantityField.required(),
  costPrice: Joi.number().min(0).allow(null, ''),
  variantId: commonSchemas.objectId.allow(null, ''),
};

/**
 * An OPENING batch, as the create form posts it. Same shape as `batchBody` with
 * one deliberate difference: THE BATCH NUMBER IS OPTIONAL.
 *
 * An expiry date with no batch number is the ordinary case in a small shop — the
 * date is printed on the packet, the batch code often is not legible or is not
 * worth typing. Every other layer already agrees on that:
 * `product.service._buildOpeningBatches` generates `B-<CODE>-<n>` for exactly
 * this row, `variants[].openingBatch` accepts a blank number, and the create
 * form's own hint under the field reads «না দিলেও চলবে — তারিখটাই আসল».
 *
 * This schema used to reuse `batchBody`, so Joi rejected that payload with
 * «"batches[0].batchNumber" is not allowed to be empty» BEFORE the generator
 * could run. Filling in only the expiry date — the thing the form tells you to
 * do — failed to save the product at all, and the only way through was to invent
 * a batch code. `batchBody` keeps its `required()` because the batch endpoints
 * name an EXISTING batch, where an unnamed one would be unaddressable.
 *
 * `variantId` is absent by design, not by omission: on create the client has no
 * variant ids yet (they are minted in `_formatVariants`), and
 * `_buildOpeningBatches` forces `null` on this path so a client cannot smuggle
 * one onto a product with no variants. A variant's opening batch travels on
 * `variants[].openingBatch` instead.
 */
const openingBatchBody = {
  batchNumber: Joi.string().trim().max(100).allow('', null),
  expiryDate: Joi.date().allow('', null),
  quantity: quantityField.required(),
  costPrice: Joi.number().min(0).allow(null, ''),
};

const baseProduct = {
  code: Joi.string().trim().uppercase().max(100),
  barcode: Joi.string().trim().max(100).allow('', null),
  name: Joi.string().trim().min(1).max(200).required(),
  category: commonSchemas.objectId.required(),
  subcategory: commonSchemas.objectId.allow(null, ''),
  description: Joi.string().trim().max(2000).allow('', null),
  // A Brand id, not a name. Empty string and null both mean "no brand" — the
  // product form sends '' for an untouched picker. Ownership and the
  // `features.brands` gate are enforced in `product.service._resolveBrand`,
  // where the shop and the flag are known.
  brand: commonSchemas.objectId.allow('', null),
  // Accepts the full registry; which units this particular shop may CHOOSE is
  // enforced in `product.service._assertUnitAllowed`, where the flag is known.
  unit: Joi.string().valid(...ALL_UNITS),
  // Shape only. Whether `packUnit` may hold `unit`, whether the shop is
  // entitled to packaging at all, and the precision of `unitsPerPack` are all
  // decided in `packaging.util.normalizePackaging`, which — unlike Joi — has
  // the base unit and the feature flag in hand. Joi cannot do it: the rule is
  // cross-field AND depends on the request's shop.
  packaging: Joi.object({
    enabled: Joi.boolean().default(false),
    packUnit: Joi.string().valid(...ALL_UNITS).allow('', null),
    unitsPerPack: Joi.number().positive().allow(null, ''),
    packBuyingPrice: Joi.number().min(0).allow(null, ''),
    packSellingPrice: Joi.number().min(0).allow(null, ''),
    sellByPack: Joi.boolean().default(true),
    sellByUnit: Joi.boolean().default(true),
  }).allow(null),
  // 'combo' turns this product into a bundle of others — see comboItems below.
  // Immutability after create is enforced in the service, not here.
  type: Joi.string().valid('standard', 'combo'),
  comboItems: Joi.when('type', {
    is: 'combo',
    then: Joi.array().items(comboItem).min(1).max(20).required(),
    otherwise: Joi.array().max(0),
  }),
  // A combo's cost is DERIVED from its components at sale time, so the field
  // is optional there; an ordinary product still has to state what it cost.
  buyingPrice: Joi.when('type', {
    is: 'combo',
    then: Joi.number().min(0),
    otherwise: Joi.number().min(0).required(),
  }),
  sellingPrice: Joi.number().min(0).required(),
  // Structural bounds ONLY, exactly like `unit` and `packaging` above. Joi
  // cannot see the shop's `features.wholesale` flag, so the ENTITLEMENT
  // decision lives in `pricing.util.normalizeWholesalePrice`, which does. `''`
  // is accepted because that is what a cleared money box posts, and it is
  // normalised to "no wholesale rate" rather than to ৳0.
  wholesalePrice: Joi.number().min(0).allow(null, ''),
  stock: quantityField,
  minStock: quantityField,
  hasVariants: Joi.boolean(),
  variants: Joi.when('hasVariants', {
    is: true,
    then: Joi.array().items(variant).min(1).required(),
    otherwise: Joi.array().items(variant).max(0).optional(),
  }),
  images: Joi.array().items(Joi.string().uri()),
  /**
   * Catalogue photos.
   *
   * A row is either OURS (`mediaId`, bytes in the R2 pool) or EXTERNAL (`url`
   * only, written by the older ImgBB endpoint). `.or()` demands one of the two
   * so a row that identifies nothing cannot be stored.
   *
   * The URLs are accepted but not trusted: for a row with a `mediaId` the
   * service overwrites them from the ShopMedia document, since a client able to
   * pair our media id with an arbitrary URL could point a product anywhere while
   * the row still looked like ours. They are declared here only because a row
   * WITHOUT a mediaId has nothing else to go on, and because the edit form round-
   * trips existing rows verbatim.
   *
   * No `.max()`: the per-product ceiling is enforced in the service, over our
   * images only, so a legacy product carrying seven ImgBB photos stays editable.
   * No `.default()` either — see the CREATE_DEFAULTS note below.
   */
  catalogImages: Joi.array().items(
    Joi.object({
      mediaId: commonSchemas.objectId.allow(null, ''),
      url: Joi.string().uri().allow('', null),
      thumbnail: Joi.string().uri().allow('', null),
      isPrimary: Joi.boolean(),
    }).or('mediaId', 'url')
  ),
  tags: Joi.array().items(Joi.string().trim().max(50)),
  isAvailableOnline: Joi.boolean(),
  onlinePrice: Joi.number().min(0).allow(null, ''),
  onlineDescription: Joi.string().trim().max(2000).allow('', null),
  isFeaturedOnline: Joi.boolean(),
  trackBatches: Joi.boolean(),
  // Create only — `updateProduct` forbids this key outright. A variant
  // product's opening batches arrive on `variants[].openingBatch` instead,
  // because the client has no variant id to reference yet.
  batches: Joi.array().items(Joi.object(openingBatchBody)),
  trackSerials: Joi.boolean(),
  serials: Joi.array().items(Joi.string().trim()),
};

/**
 * ── A DEFAULT ON AN UPDATE SCHEMA IS A DELETE INSTRUCTION ───────────────────
 *
 * `validate.middleware` runs `schema.validate(req.body)` and then assigns the
 * RESULT back over `req.body`. Joi fills in every `.default()` for a key the
 * client did not send. So while these defaults lived on `baseProduct` — which
 * BOTH schemas spread — a `PUT /products/:id` that said nothing about batches
 * became a request that said `batches: []`, and `updateProduct`'s
 * `Object.assign(product, …)` duly persisted the empty array.
 *
 * What that cost, measured against the real edit form (which sends name,
 * category, prices, stock, minStock and nothing else): correcting a price wiped
 * every batch and expiry date on the product, flipped `trackBatches` back to
 * false, emptied `images`, `tags` and `serials`, and reset the two online flags.
 * No error, no warning — the expiry-alerts screen simply went quiet for a
 * product the shopkeeper had just edited, which is the worst possible failure
 * for a screen whose whole job is to be trusted.
 *
 * `wholesalePrice` and `brand` already had bespoke `in`-guards in the service
 * for exactly this hazard (see `product.service.updateProduct`). These fields
 * did not, because their defaults lived here rather than there.
 *
 * So the defaults are declared ONCE, here, and applied ONLY to the create
 * schema. `baseProduct` above is now defaults-free, which means the failure
 * mode is inverted: forgetting to add a new field to this map makes CREATE
 * miss a default (visible immediately, harmless), where before forgetting to
 * strip one made UPDATE destroy data (silent, permanent).
 *
 * On an update, ABSENT MEANS "LEAVE IT ALONE". Do not reintroduce `.default()`
 * into `baseProduct`.
 */
const CREATE_DEFAULTS = {
  stock: 0,
  minStock: 5,
  hasVariants: false,
  images: [],
  tags: [],
  // Offline unless somebody says otherwise — see the note on the model field.
  isAvailableOnline: false,
  isFeaturedOnline: false,
  trackBatches: false,
  batches: [],
  trackSerials: false,
  serials: [],
};

const withCreateDefaults = (schema) => {
  const out = { ...schema };
  for (const [key, value] of Object.entries(CREATE_DEFAULTS)) {
    if (!out[key]) {
      throw new Error(`CREATE_DEFAULTS names "${key}", which is not a field of baseProduct`);
    }
    out[key] = out[key].default(value);
  }
  return out;
};


const createProduct = Joi.object(withCreateDefaults(baseProduct)).custom((value, helpers) => {
  if (!value.hasVariants && value.stock === undefined) {
    return helpers.error('any.custom', { message: 'Stock is required for non-variant products' });
  }
  return value;
});

// Spreads `baseProduct` as-is — which is now defaults-free. See CREATE_DEFAULTS
// above for why that matters and what it cost when it was not.
const updateProduct = Joi.object({
  ...baseProduct,
  name: baseProduct.name.optional(),
  category: commonSchemas.objectId.optional(),
  buyingPrice: Joi.number().min(0),
  sellingPrice: Joi.number().min(0),
  // Batches are NOT editable through the product form. They carry stock
  // quantities that must stay reconciled with `stock`, and a whole-array
  // overwrite from a form that never displayed them is how they got destroyed
  // above. `PUT /products/:id/batches/...` is the sanctioned path.
  batches: Joi.forbidden(),
}).min(1);

const updateStock = Joi.object({
  quantity: quantityField.required(),
  type: Joi.string().valid('set', 'add', 'subtract').default('add'),
  variantId: commonSchemas.objectId.allow(null, ''),
  notes: Joi.string().trim().max(500).allow('', null),
});

// ── Batch endpoints ─────────────────────────────────────────────────────────
//
// Separate from the product form on purpose. A batch carries a QUANTITY, and
// the sum of a variant's batch quantities must not exceed that variant's stock
// — a rule the service enforces and a whole-array PUT from a product form
// cannot. See `updateProduct`'s `batches: Joi.forbidden()`.
const addBatch = Joi.object(batchBody);

// Everything optional: correcting a typo'd expiry date must not require
// re-sending the quantity. `.min(1)` refuses an empty body rather than
// performing a silent no-op the caller reads as success.
const updateBatch = Joi.object({
  batchNumber: Joi.string().trim().min(1).max(100),
  expiryDate: Joi.date().allow('', null),
  quantity: quantityField,
  costPrice: Joi.number().min(0).allow(null, ''),
}).min(1);

const expiringBatches = Joi.object({
  // The alerts screen offers ৭ / ৩০ / ৬০ / ৯০; the bound is generous rather
  // than an enum so a report can ask for a year without a schema change.
  days: Joi.number().integer().min(0).max(3650).default(30),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(50),
  // 'all' includes batches that have already expired, which is the default the
  // screen wants: expired stock on the shelf is the most urgent row of all.
  includeExpired: Joi.boolean().default(true),
});

const toggleStatus = Joi.object({
  isActive: Joi.boolean().required(),
});

const bulkUpdateStock = Joi.object({
  updates: Joi.array().items(Joi.object({
    productId: commonSchemas.objectId.required(),
    quantity: quantityField.required(),
    type: Joi.string().valid('set', 'add', 'subtract').default('add'),
    variantId: commonSchemas.objectId.allow(null, ''),
    notes: Joi.string().trim().max(500).allow('', null),
  })).min(1).required(),
});

const bulkImportProducts = Joi.object({
  products: Joi.array().items(Joi.object({
    name: Joi.string().trim().min(1).max(200).required(),
    code: Joi.string().trim().max(100).allow('', null),
    barcode: Joi.string().trim().max(100).allow('', null),
    categoryName: Joi.string().trim().max(100).allow('', null),
    buyingPrice: Joi.number().min(0).default(0),
    costPrice: Joi.number().min(0).optional(),
    sellingPrice: Joi.number().min(0).default(0),
    stock: quantityField.default(0),
    unit: Joi.string().trim().allow('', null).default('piece'),
    minStock: quantityField.default(5),
    description: Joi.string().trim().max(2000).allow('', null),
    trackBatches: Joi.boolean().default(false),
    batchNumber: Joi.string().trim().allow('', null),
    expiryDate: Joi.date().allow('', null),
  })).min(1).max(2000).required(),
});

module.exports = {
  createProduct,
  updateProduct,
  updateStock,
  toggleStatus,
  bulkUpdateStock,
  bulkImportProducts,
  addBatch,
  updateBatch,
  expiringBatches,
};
