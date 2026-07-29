const Joi = require('joi');

const createAppointment = Joi.object({
  customer: Joi.string().hex().length(24).required().messages({
    'any.required': 'ক্লায়েন্ট নির্বাচন করুন',
  }),
  service: Joi.string().hex().length(24).required().messages({
    'any.required': 'সেবা নির্বাচন করুন',
  }),
  provider: Joi.string().hex().length(24).allow(null),
  date: Joi.date().required().messages({
    'any.required': 'তারিখ দিন',
  }),
  startTime: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d)$/).required().messages({
    'string.pattern.base': 'সময় HH:MM ফরম্যাটে দিন',
    'any.required': 'শুরুর সময় দিন',
  }),
  endTime: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d)$/).allow(null, ''),
  serviceDuration: Joi.number().integer().min(5).allow(null),
  notes: Joi.string().trim().allow('', null),
  color: Joi.string().allow(null, ''),
  branch: Joi.string().hex().length(24).allow(null),
});

const updateAppointment = Joi.object({
  customer: Joi.string().hex().length(24),
  service: Joi.string().hex().length(24),
  provider: Joi.string().hex().length(24).allow(null),
  date: Joi.date(),
  startTime: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d)$/),
  endTime: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d)$/).allow(null, ''),
  status: Joi.string().valid('scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'),
  notes: Joi.string().trim().allow('', null),
  cancellationReason: Joi.string().trim().allow('', null),
  color: Joi.string().allow(null, ''),
  linkedSale: Joi.string().hex().length(24).allow(null),
  linkedTreatment: Joi.string().hex().length(24).allow(null),
}).min(1);

const updateStatus = Joi.object({
  status: Joi.string().valid('scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show').required(),
  cancellationReason: Joi.string().trim().allow('', null),
});

module.exports = {
  createAppointment,
  updateAppointment,
  updateStatus,
};
