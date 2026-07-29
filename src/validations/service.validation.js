const Joi = require('joi');

const createService = Joi.object({
  name: Joi.string().trim().required().messages({
    'string.empty': 'সেবার নাম দিন',
    'any.required': 'সেবার নাম বাধ্যতামূলক',
  }),
  description: Joi.string().trim().allow('', null),
  category: Joi.string().hex().length(24).allow(null),
  duration: Joi.number().integer().min(5).default(30).messages({
    'number.min': 'সর্বনিম্ন ৫ মিনিট',
  }),
  price: Joi.number().min(0).required().messages({
    'number.min': 'মূল্য ০ এর কম হতে পারবে না',
    'any.required': 'সেবার মূল্য দিন',
  }),
  memberPrice: Joi.number().min(0).allow(null),
  isPackage: Joi.boolean().default(false),
  packageSessions: Joi.when('isPackage', {
    is: true,
    then: Joi.number().integer().min(1).required().messages({
      'any.required': 'প্যাকেজ সেশন সংখ্যা দিন',
    }),
    otherwise: Joi.number().allow(null),
  }),
  packagePrice: Joi.when('isPackage', {
    is: true,
    then: Joi.number().min(0).required().messages({
      'any.required': 'প্যাকেজ মূল্য দিন',
    }),
    otherwise: Joi.number().allow(null),
  }),
  consumables: Joi.array().items(
    Joi.object({
      product: Joi.string().hex().length(24).required(),
      quantityPerSession: Joi.number().min(0).default(1),
    })
  ).default([]),
  assignedProviders: Joi.array().items(
    Joi.string().hex().length(24)
  ).default([]),
  images: Joi.array().items(Joi.string()).default([]),
  isActive: Joi.boolean().default(true),
  sortOrder: Joi.number().integer().default(0),
});

const updateService = Joi.object({
  name: Joi.string().trim(),
  description: Joi.string().trim().allow('', null),
  category: Joi.string().hex().length(24).allow(null),
  duration: Joi.number().integer().min(5),
  price: Joi.number().min(0),
  memberPrice: Joi.number().min(0).allow(null),
  isPackage: Joi.boolean(),
  packageSessions: Joi.number().integer().min(1).allow(null),
  packagePrice: Joi.number().min(0).allow(null),
  consumables: Joi.array().items(
    Joi.object({
      product: Joi.string().hex().length(24).required(),
      quantityPerSession: Joi.number().min(0).default(1),
    })
  ),
  assignedProviders: Joi.array().items(
    Joi.string().hex().length(24)
  ),
  images: Joi.array().items(Joi.string()),
  isActive: Joi.boolean(),
  sortOrder: Joi.number().integer(),
}).min(1);

const toggleStatus = Joi.object({});

module.exports = {
  createService,
  updateService,
  toggleStatus,
};
