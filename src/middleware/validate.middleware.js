const Joi = require('joi');
const ApiResponse = require('../utils/response.util');

/**
 * Validation middleware factory
 * @param {Joi.Schema} schema - Joi validation schema
 * @param {string} property - Request property to validate (body, query, params)
 */
const validate = (schema, property = 'body') => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message,
        messageBn: translateValidationMessage(detail)
      }));

      return ApiResponse.badRequest(res, {
        message: 'Validation failed',
        messageBn: 'তথ্য যাচাই ব্যর্থ',
        errors
      });
    }

    // Replace request property with validated and sanitized value
    req[property] = value;
    next();
  };
};

/**
 * Translate validation messages to Bengali
 */
const translateValidationMessage = (detail) => {
  const { type, context } = detail;

  const translations = {
    'string.empty': 'এই ফিল্ডটি খালি রাখা যাবে না',
    'string.min': `কমপক্ষে ${context?.limit} অক্ষর হতে হবে`,
    'string.max': `সর্বোচ্চ ${context?.limit} অক্ষর হতে পারবে`,
    'string.email': 'বৈধ ইমেইল দিন',
    'string.pattern.base': 'বৈধ ফরম্যাট নয়',
    'number.base': 'একটি সংখ্যা হতে হবে',
    'number.min': `কমপক্ষে ${context?.limit} হতে হবে`,
    'number.max': `সর্বোচ্চ ${context?.limit} হতে পারবে`,
    'number.positive': 'ধনাত্মক সংখ্যা হতে হবে',
    'any.required': 'এই ফিল্ডটি আবশ্যক',
    'any.only': 'অবৈধ মান',
    'array.min': `কমপক্ষে ${context?.limit}টি আইটেম হতে হবে`,
    'array.max': `সর্বোচ্চ ${context?.limit}টি আইটেম হতে পারবে`,
    'object.unknown': 'অপরিচিত ফিল্ড'
  };

  return translations[type] || detail.message;
};

/**
 * Common validation schemas
 */
const commonSchemas = {
  // Phone number validation
  phone: Joi.string()
    .pattern(/^(0|88|\+88)?1[3-9]\d{8}$/)
    .messages({
      'string.pattern.base': 'Please enter a valid Bangladesh phone number',
      'string.empty': 'Phone number is required'
    }),

  // Password validation
  password: Joi.string()
    .min(6)
    .max(50)
    .messages({
      'string.min': 'Password must be at least 6 characters',
      'string.max': 'Password cannot exceed 50 characters',
      'string.empty': 'Password is required'
    }),

  // MongoDB ObjectId validation
  objectId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .messages({
      'string.pattern.base': 'Invalid ID format'
    }),

  // Pagination
  pagination: {
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20)
  },

  // Date range
  dateRange: {
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso().min(Joi.ref('startDate'))
  }
};

module.exports = {
  validate,
  commonSchemas,
  Joi
};
