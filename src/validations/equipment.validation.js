const Joi = require('joi');

const createEquipment = Joi.object({
  name: Joi.string().trim().required().messages({ 'any.required': 'যন্ত্রের নাম দিন' }),
  brand: Joi.string().trim().allow('', null),
  model: Joi.string().trim().allow('', null),
  serialNumber: Joi.string().trim().allow('', null),
  defaultSettings: Joi.object({
    energy: Joi.string().allow('', null),
    pulseWidth: Joi.string().allow('', null),
    spotSize: Joi.string().allow('', null),
    frequency: Joi.string().allow('', null),
    custom: Joi.any(),
  }).allow(null),
  linkedServices: Joi.array().items(Joi.string().hex().length(24)).default([]),
  purchaseDate: Joi.date().allow(null),
  image: Joi.string().allow('', null),
});

const updateEquipment = Joi.object({
  name: Joi.string().trim(),
  brand: Joi.string().trim().allow('', null),
  model: Joi.string().trim().allow('', null),
  serialNumber: Joi.string().trim().allow('', null),
  defaultSettings: Joi.object({
    energy: Joi.string().allow('', null),
    pulseWidth: Joi.string().allow('', null),
    spotSize: Joi.string().allow('', null),
    frequency: Joi.string().allow('', null),
    custom: Joi.any(),
  }),
  linkedServices: Joi.array().items(Joi.string().hex().length(24)),
  purchaseDate: Joi.date().allow(null),
  lastMaintenanceDate: Joi.date().allow(null),
  nextMaintenanceDate: Joi.date().allow(null),
  maintenanceNotes: Joi.string().trim().allow('', null),
  status: Joi.string().valid('active', 'maintenance', 'retired'),
  isActive: Joi.boolean(),
  image: Joi.string().allow('', null),
}).min(1);

module.exports = { createEquipment, updateEquipment };
