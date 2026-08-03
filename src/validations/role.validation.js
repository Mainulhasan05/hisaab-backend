const { Joi } = require('../middleware/validate.middleware');

// permissions: { moduleKey: { actionKey: boolean } }
// Key validity against the MODULES matrix is enforced in role.service
// (_assertKnownPermissionKeys) so the error can name the offending key.
const permissionsSchema = Joi.object().pattern(
  Joi.string().max(50),
  Joi.object().pattern(Joi.string().max(50), Joi.boolean())
);

const createRole = Joi.object({
  name: Joi.string().trim().min(2).max(50).required(),
  permissions: permissionsSchema,
});

const updateRole = Joi.object({
  name: Joi.string().trim().min(2).max(50),
  permissions: permissionsSchema,
});

module.exports = { createRole, updateRole };
