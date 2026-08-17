const { Joi, commonSchemas } = require('../middleware/validate.middleware');
const { SHOP_TYPES } = require('../config/constants');

// Meta Pixel attribution forwarded by the browser. The frontend and the API are
// on different domains, so the _fbp / _fbc cookies never reach us on their own —
// the client reads them from document.cookie and posts them here. Purely
// additive: absent or malformed values just lower Meta's match quality.
const tracking = Joi.object({
  fbp: Joi.string().trim().max(200),
  fbc: Joi.string().trim().max(500),
  eventSourceUrl: Joi.string().trim().uri().max(500)
}).unknown(false);

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
  shopPhone: commonSchemas.phone,
  tracking
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
  }),
  tracking
});

const login = Joi.object({
  phone: commonSchemas.phone.required(),
  password: Joi.string().required().messages({
    'any.required': 'Password is required'
  }),
  shopSlug: Joi.string().trim() // Optional - for team members
});

/**
 * `confirmPassword` is OPTIONAL, and that is the fix for a real outage.
 *
 * It used to be `.required()`, while the only client — the settings page's
 * security tab — posts `{ currentPassword, newPassword }`. Every password
 * change from the dashboard therefore died in this schema, and the user got the
 * generic "তথ্য যাচাই ব্যর্থ" from `validate.middleware`, which names no field
 * and is indistinguishable from a server fault. The form collects a confirm box
 * and checks it before submitting; it simply never sent it.
 *
 * The client now sends it, but requiring it again would be re-arming the same
 * trap for the next caller. Confirming a password is a TYPO GUARD, and a typo
 * guard belongs where the typing happens — repeating it here buys no security
 * (an attacker posts whatever pair of matching strings they like) and costs an
 * API that breaks when a caller reasonably omits a field it does not need.
 *
 * Validated when present, so a client that does send it still gets told when
 * the two boxes disagree.
 */
const changePassword = Joi.object({
  currentPassword: Joi.string().required().messages({
    'any.required': 'Current password is required'
  }),
  newPassword: commonSchemas.password.required().messages({
    'any.required': 'New password is required'
  }),
  confirmPassword: Joi.string().valid(Joi.ref('newPassword')).messages({
    'any.only': 'Passwords do not match'
  })
});

/* ── Forgot password ─────────────────────────────────────────────────────── */

const forgotPassword = Joi.object({
  phone: commonSchemas.phone.required()
});

const verifyPasswordResetCode = Joi.object({
  phone: commonSchemas.phone.required(),
  otp: Joi.string().length(6).pattern(/^\d+$/).required().messages({
    'string.length': 'OTP must be 6 digits',
    'string.pattern.base': 'OTP must contain only numbers',
    'any.required': 'OTP is required'
  })
});

const resetPassword = Joi.object({
  phone: commonSchemas.phone.required(),
  // 32 random bytes, hex — issued by the verify step. Length-pinned so a
  // malformed value is refused here rather than reaching a hash comparison.
  resetToken: Joi.string().length(64).hex().required().messages({
    'string.length': 'Invalid reset token',
    'string.hex': 'Invalid reset token',
    'any.required': 'Reset token is required'
  }),
  newPassword: commonSchemas.password.required().messages({
    'any.required': 'New password is required'
  }),
  // Optional for the same reason as in `changePassword` above.
  confirmPassword: Joi.string().valid(Joi.ref('newPassword')).messages({
    'any.only': 'Passwords do not match'
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
  forgotPassword,
  verifyPasswordResetCode,
  resetPassword,
  adminLogin,
  updateProfile
};
