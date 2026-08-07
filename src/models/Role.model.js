const mongoose = require('mongoose');
const { MODULE_KEYS, MODULES } = require('../config/permissions');

// Build the permissions sub-schema dynamically from MODULES config
const permissionActionSchema = {};
for (const [key, mod] of Object.entries(MODULES)) {
  const actionFields = {};
  for (const action of mod.actions) {
    actionFields[action] = { type: Boolean, default: false };
  }
  permissionActionSchema[key] = actionFields;
}

const roleSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  name: {
    type: String,
    required: [true, 'ভূমিকার নাম দিন'],
    trim: true,
    maxlength: [50, 'নাম ৫০ অক্ষরের বেশি হতে পারবে না']
  },
  permissions: permissionActionSchema,
  isDefault: {
    type: Boolean,
    default: false
  },
  // Which ROLE_PRESETS revision this role has been brought up to. Roles created
  // before presets were versioned default to 0, so the first upgrade pass
  // catches them. See PRESET_UPGRADES in config/permissions.js.
  presetVersion: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Compound unique index: role name unique per shop
roleSchema.index({ shop: 1, name: 1 }, { unique: true });
roleSchema.index({ shop: 1, isActive: 1 });

const Role = mongoose.model('Role', roleSchema);

module.exports = Role;
