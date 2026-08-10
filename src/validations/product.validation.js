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
  isActive: Joi.boolean().default(true),
  attributes: Joi.object().unknown(true),
}).unknown(true);

const baseProduct = {
  code: Joi.string().trim().uppercase().max(100),
  barcode: Joi.string().trim().max(100).allow('', null),
  name: Joi.string().trim().min(1).max(200).required(),
  category: commonSchemas.objectId.required(),
  subcategory: commonSchemas.objectId.allow(null, ''),
  description: Joi.string().trim().max(2000).allow('', null),
  brand: Joi.string().trim().max(100).allow('', null),
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
  buyingPrice: Joi.number().min(0).required(),
  sellingPrice: Joi.number().min(0).required(),
  // Structural bounds ONLY, exactly like `unit` and `packaging` above. Joi
  // cannot see the shop's `features.wholesale` flag, so the ENTITLEMENT
  // decision lives in `pricing.util.normalizeWholesalePrice`, which does. `''`
  // is accepted because that is what a cleared money box posts, and it is
  // normalised to "no wholesale rate" rather than to ৳0.
  wholesalePrice: Joi.number().min(0).allow(null, ''),
  stock: quantityField.default(0),
  minStock: quantityField.default(5),
  hasVariants: Joi.boolean().default(false),
  variants: Joi.when('hasVariants', {
    is: true,
    then: Joi.array().items(variant).min(1).required(),
    otherwise: Joi.array().items(variant).max(0).optional(),
  }),
  images: Joi.array().items(Joi.string().uri()).default([]),
  tags: Joi.array().items(Joi.string().trim().max(50)).default([]),
  isAvailableOnline: Joi.boolean().default(true),
  onlinePrice: Joi.number().min(0).allow(null, ''),
  onlineDescription: Joi.string().trim().max(2000).allow('', null),
  isFeaturedOnline: Joi.boolean().default(false),
  trackBatches: Joi.boolean().default(false),
  batches: Joi.array().items(Joi.object({
    batchNumber: Joi.string().trim().required(),
    expiryDate: Joi.date().allow('', null),
    quantity: quantityField.required(),
    costPrice: Joi.number().min(0).optional(),
  })).default([]),
  trackSerials: Joi.boolean().default(false),
  serials: Joi.array().items(Joi.string().trim()).default([]),
};


const createProduct = Joi.object(baseProduct).custom((value, helpers) => {
  if (!value.hasVariants && value.stock === undefined) {
    return helpers.error('any.custom', { message: 'Stock is required for non-variant products' });
  }
  return value;
});

const updateProduct = Joi.object({
  ...baseProduct,
  name: baseProduct.name.optional(),
  category: commonSchemas.objectId.optional(),
  buyingPrice: Joi.number().min(0),
  sellingPrice: Joi.number().min(0),
}).min(1);

const updateStock = Joi.object({
  quantity: quantityField.required(),
  type: Joi.string().valid('set', 'add', 'subtract').default('add'),
  variantId: commonSchemas.objectId.allow(null, ''),
  notes: Joi.string().trim().max(500).allow('', null),
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
};
