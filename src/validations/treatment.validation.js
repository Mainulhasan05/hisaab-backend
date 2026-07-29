const Joi = require('joi');

const createTreatment = Joi.object({
  customer: Joi.string().hex().length(24).required().messages({ 'any.required': 'ক্লায়েন্ট নির্বাচন করুন' }),
  service: Joi.string().hex().length(24).required().messages({ 'any.required': 'সেবা নির্বাচন করুন' }),
  name: Joi.string().trim().required().messages({ 'any.required': 'ট্রিটমেন্ট নাম দিন' }),
  targetArea: Joi.string().trim().allow('', null),
  totalSessions: Joi.number().integer().min(1).required().messages({ 'any.required': 'মোট সেশন সংখ্যা দিন' }),
  sessionInterval: Joi.number().integer().min(1).default(30),
  notes: Joi.string().trim().allow('', null),
  totalCost: Joi.number().min(0).allow(null),
  paidAmount: Joi.number().min(0).default(0),
});

const updateTreatment = Joi.object({
  name: Joi.string().trim(),
  targetArea: Joi.string().trim().allow('', null),
  totalSessions: Joi.number().integer().min(1),
  status: Joi.string().valid('active', 'completed', 'paused', 'cancelled'),
  sessionInterval: Joi.number().integer().min(1),
  notes: Joi.string().trim().allow('', null),
  totalCost: Joi.number().min(0),
  paidAmount: Joi.number().min(0),
}).min(1);

const addSession = Joi.object({
  date: Joi.date().required(),
  provider: Joi.string().hex().length(24).allow(null),
  equipment: Joi.string().hex().length(24).allow(null),
  machineSettings: Joi.object({
    energy: Joi.string().allow('', null),
    pulseWidth: Joi.string().allow('', null),
    spotSize: Joi.string().allow('', null),
    frequency: Joi.string().allow('', null),
    custom: Joi.any(),
  }).allow(null),
  treatedArea: Joi.string().trim().allow('', null),
  notes: Joi.string().trim().allow('', null),
  clientReaction: Joi.string().valid('none', 'mild', 'moderate', 'severe').default('none'),
  status: Joi.string().valid('scheduled', 'completed', 'missed', 'cancelled').default('completed'),
  beforePhotos: Joi.array().items(Joi.string()).default([]),
  afterPhotos: Joi.array().items(Joi.string()).default([]),
  appointment: Joi.string().hex().length(24).allow(null),
});

const updateSession = Joi.object({
  date: Joi.date(),
  provider: Joi.string().hex().length(24).allow(null),
  equipment: Joi.string().hex().length(24).allow(null),
  machineSettings: Joi.object({
    energy: Joi.string().allow('', null),
    pulseWidth: Joi.string().allow('', null),
    spotSize: Joi.string().allow('', null),
    frequency: Joi.string().allow('', null),
    custom: Joi.any(),
  }),
  treatedArea: Joi.string().trim().allow('', null),
  notes: Joi.string().trim().allow('', null),
  clientReaction: Joi.string().valid('none', 'mild', 'moderate', 'severe'),
  status: Joi.string().valid('scheduled', 'completed', 'missed', 'cancelled'),
  beforePhotos: Joi.array().items(Joi.string()),
  afterPhotos: Joi.array().items(Joi.string()),
}).min(1);

module.exports = { createTreatment, updateTreatment, addSession, updateSession };
