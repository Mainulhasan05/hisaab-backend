const mongoose = require('mongoose');

/**
 * Equipment Model — tracks machines/devices used in treatments
 * (e.g., laser machines, derma rollers, hydrafacial devices)
 *
 * Stores default settings that can be overridden per-session in Treatment.
 */
const equipmentSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: [true, 'যন্ত্রের নাম দিন'],
    trim: true
  },
  brand: {
    type: String,
    trim: true
  },
  model: {
    type: String,
    trim: true
  },
  serialNumber: {
    type: String,
    trim: true
  },
  // Default machine settings (template for sessions)
  defaultSettings: {
    energy: String,
    pulseWidth: String,
    spotSize: String,
    frequency: String,
    custom: mongoose.Schema.Types.Mixed
  },
  // Which services this equipment is used for
  linkedServices: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service'
  }],
  // Maintenance
  purchaseDate: {
    type: Date
  },
  lastMaintenanceDate: {
    type: Date
  },
  nextMaintenanceDate: {
    type: Date
  },
  maintenanceNotes: {
    type: String,
    trim: true
  },
  // Status
  status: {
    type: String,
    enum: ['active', 'maintenance', 'retired'],
    default: 'active'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  // Image
  image: {
    type: String
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

equipmentSchema.index({ shop: 1, isActive: 1 });
equipmentSchema.index({ shop: 1, status: 1 });

const Equipment = mongoose.model('Equipment', equipmentSchema);

module.exports = Equipment;
