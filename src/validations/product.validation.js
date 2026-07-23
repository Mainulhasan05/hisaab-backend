const { Joi, commonSchemas } = require('../middleware/validate.middleware');

const variant = Joi.object({
  _id: commonSchemas.objectId.optional(),
  id: Joi.alternatives().try(commonSchemas.objectId, Joi.string().trim()).optional(),
  sku: Joi.string().trim().max(100).required(),
  barcode: Joi.string().trim().max(100).allow('', null),
  buyingPrice: Joi.number().min(0).required(),
  sellingPrice: Joi.number().min(0).required(),
  stock: Joi.number().integer().min(0).default(0),
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
  unit: Joi.string().valid('piece', 'kg', 'gram', 'liter', 'ml', 'meter', 'inch', 'feet', 'dozen', 'pack', 'box', 'set', 'sack'),
  buyingPrice: Joi.number().min(0).required(),
  sellingPrice: Joi.number().min(0).required(),
  stock: Joi.number().integer().min(0).default(0),
  minStock: Joi.number().integer().min(0).default(5),
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
  quantity: Joi.number().integer().min(0).required(),
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
    quantity: Joi.number().integer().min(0).required(),
    type: Joi.string().valid('set', 'add', 'subtract').default('add'),
    variantId: commonSchemas.objectId.allow(null, ''),
    notes: Joi.string().trim().max(500).allow('', null),
  })).min(1).required(),
});

module.exports = {
  createProduct,
  updateProduct,
  updateStock,
  toggleStatus,
  bulkUpdateStock,
};
