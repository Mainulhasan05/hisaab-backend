const { Joi, commonSchemas } = require('../middleware/validate.middleware');

const createStaff = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  phone: commonSchemas.phone.required(),
  password: commonSchemas.password.required(),
  roleId: commonSchemas.objectId.required(),
  branchId: commonSchemas.objectId.allow(null, ''),
});

const updateStaff = Joi.object({
  name: Joi.string().trim().min(2).max(100),
  phone: commonSchemas.phone,
  roleId: commonSchemas.objectId,
  branchId: commonSchemas.objectId.allow(null, ''),
  isActive: Joi.boolean(),
});

module.exports = { createStaff, updateStaff };
