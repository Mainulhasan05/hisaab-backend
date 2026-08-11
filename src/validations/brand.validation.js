const Joi = require('joi');

/**
 * A brand name is a DISPLAY string, so Bengali is expected and no romanisation
 * happens anywhere near it. Contrast `product.validation`'s `code` and the
 * variant `sku`, which are CODE128 payloads and ASCII-only — see
 * `lib/productCode.js` for why that distinction is load-bearing.
 */
const name = Joi.string().trim().min(1).max(100).messages({
  'string.empty': 'ব্র্যান্ডের নাম দিন',
  'any.required': 'ব্র্যান্ডের নাম দিন',
  'string.max': 'ব্র্যান্ডের নাম ১০০ অক্ষরের বেশি হতে পারবে না',
});

const createBrand = Joi.object({
  name: name.required(),
  description: Joi.string().trim().max(500).allow('', null),
  order: Joi.number().integer().min(0).default(0),
});

const updateBrand = Joi.object({
  name,
  description: Joi.string().trim().max(500).allow('', null),
  order: Joi.number().integer().min(0),
  isActive: Joi.boolean(),
}).min(1);

module.exports = {
  createBrand,
  updateBrand,
};
