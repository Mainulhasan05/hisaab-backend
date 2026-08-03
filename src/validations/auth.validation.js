const { Joi, commonSchemas } = require('../middleware/validate.middleware');
const { SHOP_TYPES } = require('../config/constants');

const register = Joi.object({
  phone: commonSchemas.phone.required(),
  password: commonSchemas.password.required(),
  name: Joi.string().trim().min(2).max(100).required().messages({
    'string.min': 'Name must be at least 2 characters',
    'string.max': 'Name cannot exceed 100 characters',
    'any.required': 'Name is required'
  }),
  shopName: Joi.string().trim().min(2).max(100).required().messages({
    'string.min': 'Shop name must be at least 2 characters',
    'string.max': 'Shop name cannot exceed 100 characters',
    'any.required': 'Shop name is required'
  }),
  shopType: Joi.string().trim().default('other'),
  shopAddress: Joi.string().trim().max(500).allow(''),
  shopPhone: commonSchemas.phone
});

const sendOTP = Joi.object({
  phone: commonSchemas.phone.required()
});

const verifyOTP = Joi.object({
  phone: commonSchemas.phone.required(),
  otp: Joi.string().length(6).pattern(/^\d+$/).required().messages({
    'string.length': 'OTP must be 6 digits',
    'string.pattern.base': 'OTP must contain only numbers',
    'any.required': 'OTP is required'
  })
});

const login = Joi.object({
  phone: commonSchemas.phone.required(),
  password: Joi.string().required().messages({
    'any.required': 'Password is required'
  }),
  shopSlug: Joi.string().trim() // Optional - for team members
});

const changePassword = Joi.object({
  currentPassword: Joi.string().required().messages({
    'any.required': 'Current password is required'
  }),
  newPassword: commonSchemas.password.required().messages({
    'any.required': 'New password is required'
  }),
  confirmPassword: Joi.string().valid(Joi.ref('newPassword')).required().messages({
    'any.only': 'Passwords do not match',
    'any.required': 'Confirm password is required'
  })
});

const adminLogin = Joi.object({
  phone: commonSchemas.phone.required(),
  password: Joi.string().required()
});

const updateProfile = Joi.object({
  name: Joi.string().trim().min(2).max(100).messages({
    'string.min': 'Name must be at least 2 characters',
    'string.max': 'Name cannot exceed 100 characters'
  }),
  avatar: Joi.string().uri().allow('').messages({
    'string.uri': 'Avatar must be a valid URL'
  })
});

module.exports = {
  register,
  sendOTP,
  verifyOTP,
  login,
  changePassword,
  adminLogin,
  updateProfile
};
