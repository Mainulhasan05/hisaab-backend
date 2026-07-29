const mongoose = require('mongoose');

/**
 * Treatment Model — tracks a client's treatment plan and individual sessions
 * (e.g., 6-session laser hair removal course)
 *
 * A Treatment links a Customer to a Service (or package) and tracks
 * session-by-session progress, machine settings, therapist notes, and photos.
 */

const sessionSchema = new mongoose.Schema({
  sessionNumber: {
    type: Number,
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  // Who performed this session
  provider: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  // Machine/equipment used
  equipment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Equipment'
  },
  // Machine settings for this session
  machineSettings: {
    energy: String,        // e.g., "40J/cm²"
    pulseWidth: String,    // e.g., "30ms"
    spotSize: String,      // e.g., "12mm"
    frequency: String,     // e.g., "3Hz"
    custom: mongoose.Schema.Types.Mixed  // any extra settings
  },
  // Area treated
  treatedArea: {
    type: String,
    trim: true
  },
  // Session notes
  notes: {
    type: String,
    trim: true
  },
  // Reaction/feedback
  clientReaction: {
    type: String,
    enum: ['none', 'mild', 'moderate', 'severe'],
    default: 'none'
  },
  // Status
  status: {
    type: String,
    enum: ['scheduled', 'completed', 'missed', 'cancelled'],
    default: 'scheduled'
  },
  // Before/After photo references
  beforePhotos: [{ type: String }],
  afterPhotos: [{ type: String }],
  // Linked appointment
  appointment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment'
  },
  completedAt: {
    type: Date
  }
}, { _id: true, timestamps: true });

const treatmentSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true
  },
  // Client
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: [true, 'ক্লায়েন্ট নির্বাচন করুন']
  },
  // Service/Package
  service: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
    required: [true, 'সেবা নির্বাচন করুন']
  },
  // Treatment plan name (may differ from service name)
  name: {
    type: String,
    required: [true, 'ট্রিটমেন্ট নাম দিন'],
    trim: true
  },
  // Target area
  targetArea: {
    type: String,
    trim: true
  },
  // Total sessions planned
  totalSessions: {
    type: Number,
    required: true,
    min: 1
  },
  // Individual sessions
  sessions: [sessionSchema],
  // Overall status
  status: {
    type: String,
    enum: ['active', 'completed', 'paused', 'cancelled'],
    default: 'active'
  },
  // Start/end dates
  startDate: {
    type: Date,
    default: Date.now
  },
  completedDate: {
    type: Date
  },
  // Interval between sessions (days)
  sessionInterval: {
    type: Number,
    default: 30,
    min: 1
  },
  // General notes
  notes: {
    type: String,
    trim: true
  },
  // Payment tracking
  totalCost: {
    type: Number,
    min: 0
  },
  paidAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  linkedSale: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Indexes
treatmentSchema.index({ shop: 1, customer: 1 });
treatmentSchema.index({ shop: 1, status: 1 });
treatmentSchema.index({ shop: 1, service: 1 });

// Virtual: completed session count
treatmentSchema.virtual('completedSessions').get(function() {
  return (this.sessions || []).filter(s => s.status === 'completed').length;
});

// Virtual: progress percentage
treatmentSchema.virtual('progress').get(function() {
  if (!this.totalSessions) return 0;
  return Math.round((this.completedSessions / this.totalSessions) * 100);
});

// Virtual: remaining balance
treatmentSchema.virtual('remainingBalance').get(function() {
  return (this.totalCost || 0) - (this.paidAmount || 0);
});

treatmentSchema.set('toJSON', { virtuals: true });
treatmentSchema.set('toObject', { virtuals: true });

const Treatment = mongoose.model('Treatment', treatmentSchema);

module.exports = Treatment;
